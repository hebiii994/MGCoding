/*---------------------------------------------------------------------------------------------
 *  MGCoding - vista chat: sessioni multiple, modalità Vibe/Spec, Markdown, reasoning, tool
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgent } from '../agent/agentLoop';
import { track } from '../analytics/analytics';
import { ProviderRegistry } from '../llm/registry';
import { ChatMessage } from '../llm/types';

interface ProviderOption {
	id: string;
	label: string;
}

type ChatMode = 'vibe' | 'spec';

interface Session {
	id: string;
	title: string;
	mode: ChatMode;
	messages: ChatMessage[];
}

const SPEC_MODE_PROMPT = `MODALITÀ SPEC (spec-driven): pianifica prima di implementare.
Se non esiste già una spec adatta in .mg/specs/, proponi e crea con write_file: prima requirements.md (user story + criteri EARS), poi design.md, poi tasks.md in .mg/specs/<feature>/, chiedendo conferma tra una fase e l'altra. Se la spec esiste, aggiornala. Non scrivere codice finché i task non sono approvati.`;

const VIBE_MODE_PROMPT = `MODALITÀ VIBE: esplora e implementa rapidamente, iterando. Puoi modificare il codice direttamente con i tool quando opportuno.`;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'mgcoding.chat';

	private view?: vscode.WebviewView;
	private sessions: Session[] = [];
	private activeId = '';
	private abort?: AbortController;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly registry: ProviderRegistry,
		private readonly memento: vscode.Memento
	) {
		this.sessions = this.memento.get<Session[]>('mgcoding.sessions', []);
		this.activeId = this.memento.get<string>('mgcoding.activeSession', '');
		if (this.sessions.length === 0) {
			this.sessions.push(this.makeSession());
		}
		if (!this.sessions.find(s => s.id === this.activeId)) {
			this.activeId = this.sessions[0].id;
		}
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('mgcoding')) {
				void this.sendState();
			}
		}));
	}

	private makeSession(): Session {
		return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: 'Nuova sessione', mode: 'vibe', messages: [] };
	}

	private active(): Session {
		return this.sessions.find(s => s.id === this.activeId) ?? this.sessions[0];
	}

	private async save(): Promise<void> {
		await this.memento.update('mgcoding.sessions', this.sessions.slice(-30));
		await this.memento.update('mgcoding.activeSession', this.activeId);
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = this.getHtml();

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; id?: string; mode?: ChatMode; images?: string[] }) => {
			switch (msg.type) {
				case 'ready':
					await this.sendState();
					this.post({ type: 'restore', messages: this.active().messages });
					break;
				case 'send':
					if (msg.text || (msg.images && msg.images.length)) {
						await this.handleSend(msg.text ?? '', msg.images);
					}
					break;
				case 'attachImage':
					{
						const picks = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Immagini: ['png', 'jpg', 'jpeg', 'gif', 'webp'] } });
						for (const uri of picks ?? []) {
							try {
								const bytes = await vscode.workspace.fs.readFile(uri);
								const ext = uri.path.split('.').pop()?.toLowerCase() ?? 'png';
								const mt = ext === 'jpg' ? 'jpeg' : ext;
								const b64 = Buffer.from(bytes).toString('base64');
								this.post({ type: 'addImage', dataUrl: `data:image/${mt};base64,${b64}` });
							} catch {
								// ignora
							}
						}
					}
					break;
				case 'setProvider':
					if (msg.id) {
						const cfg = vscode.workspace.getConfiguration('mgcoding');
						if (msg.id.startsWith('ollama:')) {
							await cfg.update('ollama.model', msg.id.slice('ollama:'.length), vscode.ConfigurationTarget.Global);
							await cfg.update('provider', 'ollama', vscode.ConfigurationTarget.Global);
						} else if (msg.id.startsWith('openai:')) {
							await cfg.update('openai.model', msg.id.slice('openai:'.length), vscode.ConfigurationTarget.Global);
							await cfg.update('provider', 'openai', vscode.ConfigurationTarget.Global);
						} else {
							await cfg.update('provider', 'claude', vscode.ConfigurationTarget.Global);
						}
						track('provider_selected', { provider: msg.id.split(':')[0] });
						await this.sendState();
					}
					break;
				case 'setMode':
					if (msg.mode) {
						this.active().mode = msg.mode;
						await this.save();
						await this.sendState();
					}
					break;
				case 'toggleAutopilot':
					{
						const cfg = vscode.workspace.getConfiguration('mgcoding');
						await cfg.update('autoApprove', !cfg.get<boolean>('autoApprove', false), vscode.ConfigurationTarget.Global);
						await this.sendState();
					}
					break;
				case 'pickContext':
					await this.pickContext();
					break;
				case 'guidedSetup':
					await vscode.commands.executeCommand('mgcoding.guidedSetup');
					break;
				case 'newChat':
					{
						const s = this.makeSession();
						this.sessions.push(s);
						this.activeId = s.id;
						await this.save();
						await this.sendState();
						this.post({ type: 'restore', messages: [] });
					}
					break;
				case 'switchSession':
					if (msg.id && this.sessions.find(s => s.id === msg.id)) {
						this.activeId = msg.id;
						await this.save();
						await this.sendState();
						this.post({ type: 'restore', messages: this.active().messages });
					}
					break;
				case 'stop':
					this.abort?.abort();
					break;
				case 'insertCode':
					if (msg.text) {
						const editor = vscode.window.activeTextEditor;
						if (editor) {
							await editor.edit(e => e.insert(editor.selection.active, msg.text!));
						} else {
							vscode.window.showInformationMessage('Nessun editor attivo in cui inserire il codice.');
						}
					}
					break;
			}
		});
	}

	private async buildState(): Promise<{ current: string; options: ProviderOption[]; sessions: { id: string; title: string }[]; activeId: string; mode: ChatMode; autopilot: boolean; tokens: number }> {
		const c = vscode.workspace.getConfiguration('mgcoding');
		const claudeModel = c.get<string>('claude.model', 'claude-opus-4-8');
		const ollamaModel = c.get<string>('ollama.model', 'qwen2.5-coder:14b');
		const openaiModel = c.get<string>('openai.model', 'local-model');
		const provider = c.get<string>('provider', 'ollama');

		const options: ProviderOption[] = [{ id: 'claude', label: `Claude (API) · ${claudeModel}` }];
		const installed = await this.registry.listOllamaModels();
		const models = installed.length ? installed : [ollamaModel];
		if (!models.includes(ollamaModel)) {
			models.unshift(ollamaModel);
		}
		for (const m of models) {
			options.push({ id: `ollama:${m}`, label: `Ollama · ${m}` });
		}
		const oai = await this.registry.listOpenAIModels();
		const oaiModels = oai.length ? oai : [openaiModel];
		if (!oaiModels.includes(openaiModel)) {
			oaiModels.unshift(openaiModel);
		}
		for (const m of oaiModels) {
			options.push({ id: `openai:${m}`, label: `OpenAI-compat · ${m}` });
		}

		const current = provider === 'claude' ? 'claude' : provider === 'openai' ? `openai:${openaiModel}` : `ollama:${ollamaModel}`;
		const chars = this.active().messages.reduce((n, m) => n + m.content.length, 0);
		return {
			current,
			options,
			sessions: this.sessions.map(s => ({ id: s.id, title: s.title })),
			activeId: this.activeId,
			mode: this.active().mode,
			autopilot: c.get<boolean>('autoApprove', false),
			tokens: Math.round(chars / 4)
		};
	}

	private async sendState(): Promise<void> {
		this.post({ type: 'state', state: await this.buildState() });
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	/** Mostra un selettore di contesto (file) e inserisce il riferimento @percorso nel composer. */
	private async pickContext(): Promise<void> {
		const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,out-build,out-vscode,.build,dist,Library,Temp,Logs,obj,bin}/**', 1000);
		const items = uris
			.map(u => vscode.workspace.asRelativePath(u, false))
			.sort()
			.map(label => ({ label }));
		const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Aggiungi contesto: scegli un file da allegare (@)', matchOnDetail: true });
		if (picked) {
			this.post({ type: 'insertRef', text: `@${picked.label} ` });
		}
	}

	/** Allega il contenuto dei file citati con @percorso. */
	private async augmentWithMentions(text: string): Promise<string> {
		const mentions = text.match(/@([^\s]+)/g);
		if (!mentions) {
			return text;
		}
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return text;
		}
		const dec = new TextDecoder();
		const blocks: string[] = [];
		const seen = new Set<string>();
		for (const mention of mentions.slice(0, 5)) {
			const p = mention.slice(1).replace(/[.,;:)]+$/, '');
			if (seen.has(p)) {
				continue;
			}
			seen.add(p);
			let uri = vscode.Uri.joinPath(folders[0].uri, p);
			try {
				await vscode.workspace.fs.stat(uri);
			} catch {
				const found = await vscode.workspace.findFiles(`**/${p}`, '**/{node_modules,.git,out,Library}/**', 1);
				if (!found.length) {
					continue;
				}
				uri = found[0];
			}
			try {
				const content = dec.decode(await vscode.workspace.fs.readFile(uri)).slice(0, 8000);
				blocks.push(`Contenuto di ${vscode.workspace.asRelativePath(uri, false)}:\n\`\`\`\n${content}\n\`\`\``);
			} catch {
				// ignora
			}
		}
		return blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text;
	}

	private async handleSend(text: string, images?: string[]): Promise<void> {
		const session = this.active();
		track('chat_sent', { mode: session.mode, provider: vscode.workspace.getConfiguration('mgcoding').get<string>('provider', 'ollama'), hasImages: !!images?.length });
		if (session.title === 'Nuova sessione') {
			session.title = (text || 'Immagine').slice(0, 40);
		}
		const userMsg: ChatMessage = { role: 'user', content: await this.augmentWithMentions(text) };
		if (images?.length) {
			userMsg.images = images.slice(0, 4);
		}
		session.messages.push(userMsg);
		this.post({ type: 'busy', value: true });
		this.abort = new AbortController();
		const systemExtra = session.mode === 'spec' ? SPEC_MODE_PROMPT : VIBE_MODE_PROMPT;
		try {
			await runAgent(this.registry, session.messages, {
				onStreamStart: () => this.post({ type: 'streamStart' }),
				onStreamDelta: t => this.post({ type: 'streamDelta', text: t }),
				onStreamEnd: () => this.post({ type: 'streamEnd' }),
				onStreamCancel: () => this.post({ type: 'streamCancel' }),
				onAssistantText: t => this.post({ type: 'assistant', text: t }),
				onToolStart: call => this.post({ type: 'tool', name: call.tool, args: JSON.stringify(call.args) }),
				onToolResult: r => this.post({ type: 'toolResult', text: r })
			}, this.abort.signal, systemExtra);
		} catch (err) {
			this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
		} finally {
			this.abort = undefined;
			this.post({ type: 'busy', value: false });
			await this.save();
			await this.sendState();
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	private getHtml(): string {
		const nonce = String(Math.random()).slice(2);
		const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
	:root { --mg-accent: #3fb950; --mg-accent-2: #2c7a45; }
	html, body { height: 100%; }
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; }
	#topbar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
	#session { flex: 1 1 auto; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 6px; padding: 3px 6px; font-size: 12px; }
	.modebtn { flex: 0 0 auto; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
	.modebtn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	#newbtn { flex: 0 0 auto; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
	#log { flex: 1 1 auto; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
	.empty { margin: auto; text-align: center; opacity: 0.6; line-height: 1.7; padding: 16px; }
	.welcome { margin: auto; width: 100%; max-width: 520px; padding: 24px 18px; box-sizing: border-box; }
	.welcome-icon { text-align: center; font-size: 26px; line-height: 1; margin-bottom: 10px; }
	.welcome-title { text-align: center; font-size: 30px; font-weight: 700; margin: 0 0 6px; background: linear-gradient(90deg, var(--mg-accent), var(--mg-accent-2)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
	.welcome-sub { text-align: center; opacity: 0.7; font-size: 13px; margin-bottom: 20px; }
	.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.card { text-align: left; background: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 14px; cursor: pointer; transition: border-color .15s, background .15s; }
	.card:hover { border-color: var(--mg-accent); }
	.card.active { border-color: var(--mg-accent); background: color-mix(in srgb, var(--mg-accent) 14%, transparent); }
	.card .card-h { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 14px; margin-bottom: 6px; }
	.card .card-h .ic { color: var(--mg-accent); }
	.card p { margin: 0; font-size: 12px; opacity: 0.72; line-height: 1.5; }
	.greatfor { margin: 18px 0 0; padding-left: 12px; border-left: 2px solid var(--mg-accent); }
	.greatfor .gf-h { font-size: 12px; opacity: 0.8; margin-bottom: 6px; }
	.greatfor ul { margin: 0; padding-left: 18px; font-size: 12.5px; opacity: 0.85; line-height: 1.7; }
	.setup-link { display: block; margin: 18px auto 0; background: transparent; color: var(--mg-accent); border: 1px solid var(--mg-accent); border-radius: 8px; padding: 7px 14px; font-size: 12.5px; cursor: pointer; }
	.setup-link:hover { background: color-mix(in srgb, var(--mg-accent) 14%, transparent); }
	.msg { padding: 8px 10px; border-radius: 8px; word-wrap: break-word; overflow-wrap: anywhere; max-width: 100%; box-sizing: border-box; }
	.user { background: var(--vscode-input-background); align-self: flex-end; max-width: 92%; white-space: pre-wrap; }
	.assistant { background: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 100%; }
	.tool { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-focusBorder); font-family: var(--vscode-editor-font-family); font-size: 0.85em; align-self: stretch; }
	.tool .head { font-weight: 600; margin-bottom: 2px; }
	.tool .result { opacity: 0.85; max-height: 180px; overflow: auto; white-space: pre-wrap; }
	.error { color: var(--vscode-errorForeground); }
	.answer p { margin: 6px 0; }
	.answer h2, .answer h3, .answer h4 { margin: 8px 0 4px; }
	.answer ul, .answer ol { margin: 4px 0; padding-left: 20px; }
	.answer code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
	.answer a { color: var(--vscode-textLink-foreground); }
	pre.code { position: relative; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; overflow: auto; margin: 6px 0; }
	pre.code code { background: none; padding: 0; font-family: var(--vscode-editor-font-family); font-size: 0.88em; white-space: pre; }
	.code-tools { display: flex; gap: 4px; justify-content: flex-end; margin-bottom: 4px; }
	.code-tools button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
	.reason { margin-bottom: 6px; font-size: 0.85em; opacity: 0.85; }
	.reason summary { cursor: pointer; opacity: 0.8; }
	.reason-body { margin-top: 4px; padding: 6px 8px; border-left: 2px solid var(--vscode-panel-border); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); opacity: 0.8; max-height: 240px; overflow: auto; }
	#composer { flex: 0 0 auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: var(--vscode-sideBar-background); }
	.field { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 12px; background: var(--vscode-input-background); padding: 8px 10px 6px; transition: border-color .15s; }
	.field:focus-within { border-color: var(--mg-accent); }
	#input { width: 100%; box-sizing: border-box; resize: none; min-height: 22px; max-height: 200px; background: transparent; color: var(--vscode-input-foreground); border: none; padding: 0 34px 0 0; font-family: inherit; font-size: 13px; line-height: 1.4; }
	#input:focus { outline: none; }
	#sendwrap { position: absolute; top: 6px; right: 6px; }
	#send, #stop { width: 28px; height: 28px; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1; border: none; cursor: pointer; }
	#send { background: var(--mg-accent); color: #06210f; font-weight: 700; }
	#send:hover { filter: brightness(1.08); }
	#stop { display: none; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	body.busy #stop { display: flex; }
	body.busy #send { display: none; }
	#row { display: flex; align-items: center; gap: 4px; padding: 0 2px; }
	.iconbtn { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; color: var(--vscode-foreground); border: none; border-radius: 7px; cursor: pointer; opacity: 0.75; font-size: 14px; }
	.iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.18)); opacity: 1; }
	#ctxpie { flex: 0 0 auto; display: flex; align-items: center; margin-left: 2px; }
	#ctxpie svg { display: block; }
	.spacer { flex: 1 1 auto; }
	#model { flex: 0 1 auto; max-width: 48%; min-width: 0; background: transparent; color: var(--vscode-foreground); border: none; border-radius: 7px; padding: 4px 4px; font-size: 12px; opacity: 0.85; cursor: pointer; text-overflow: ellipsis; }
	#model:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.18)); opacity: 1; }
	.toggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; padding: 3px 4px; border-radius: 7px; }
	.toggle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.18)); }
	.toggle .knob { width: 26px; height: 15px; border-radius: 9px; background: var(--vscode-input-border, #5a5a5a); position: relative; transition: background .15s; }
	.toggle .knob::after { content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: #fff; transition: left .15s; }
	.toggle.on .knob { background: var(--mg-accent); }
	.toggle.on .knob::after { left: 13px; }
	#thumbs { display: flex; gap: 4px; flex-wrap: wrap; }
	#thumbs span { position: relative; }
	#thumbs img { height: 46px; border-radius: 4px; display: block; }
	#thumbs .x { position: absolute; top: -6px; right: -6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 50%; width: 16px; height: 16px; font-size: 11px; line-height: 16px; text-align: center; cursor: pointer; }
	.msg img.thumb { max-height: 140px; border-radius: 6px; margin: 4px 4px 0 0; }
</style>
</head>
<body>
	<div id="topbar">
		<select id="session" title="Sessione"></select>
		<button id="newbtn" title="Nuova sessione">＋</button>
		<button class="modebtn" id="mode-vibe" title="Chat-first">Vibe</button>
		<button class="modebtn" id="mode-spec" title="Spec-driven">Spec</button>
	</div>
	<div id="log"></div>
	<div id="composer">
		<div id="thumbs"></div>
		<div class="field">
			<textarea id="input" rows="1" placeholder="Chiedi qualcosa o descrivi un task…"></textarea>
			<div id="sendwrap">
				<button id="send" title="Invia (Invio)">↑</button>
				<button id="stop" title="Interrompi">■</button>
			</div>
		</div>
		<div id="row">
			<button class="iconbtn" id="hash" title="Aggiungi contesto (file)">#</button>
			<button class="iconbtn" id="attach" title="Allega immagine">📎</button>
			<span id="ctxpie" title="Contesto utilizzato"></span>
			<span class="spacer"></span>
			<select id="model" title="Modello / provider"></select>
			<button class="toggle" id="auto" title="Autopilot: esegue senza conferme"><span class="knob"></span><span>Autopilot</span></button>
		</div>
	</div>
<script nonce="${nonce}">
	var vscode = acquireVsCodeApi();
	var log = document.getElementById('log');
	var input = document.getElementById('input');
	var sendBtn = document.getElementById('send');
	var model = document.getElementById('model');
	var stopBtn = document.getElementById('stop');
	var sessionSel = document.getElementById('session');
	var newBtn = document.getElementById('newbtn');
	var modeVibe = document.getElementById('mode-vibe');
	var modeSpec = document.getElementById('mode-spec');
	var hashBtn = document.getElementById('hash');
	var attachBtn = document.getElementById('attach');
	var autoBtn = document.getElementById('auto');
	var ctxPie = document.getElementById('ctxpie');
	var CTX_WINDOW = 128000;
	function renderCtxPie(tokens) {
		var pct = Math.max(0, Math.min(1, tokens / CTX_WINDOW));
		var r = 6, c = 2 * Math.PI * r, off = c * (1 - pct);
		var tokTxt = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : tokens;
		ctxPie.title = 'Contesto: ~' + tokTxt + ' token (' + Math.round(pct * 100) + '%)';
		ctxPie.innerHTML =
			'<svg width="16" height="16" viewBox="0 0 16 16">' +
			'<circle cx="8" cy="8" r="6" fill="none" stroke="var(--vscode-input-border,#5a5a5a)" stroke-width="3" opacity="0.4"/>' +
			'<circle cx="8" cy="8" r="6" fill="none" stroke="var(--mg-accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '" transform="rotate(-90 8 8)"/>' +
			'</svg>';
	}
	var thumbs = document.getElementById('thumbs');
	var pendingImages = [];
	var current = null;
	var lastToolResult = null;
	var currentMode = 'vibe';
	var BT = String.fromCharCode(96);
	var fenceRe = new RegExp(BT + BT + BT + '(\\\\w*)\\\\n?([\\\\s\\\\S]*?)' + BT + BT + BT, 'g');
	var inlineRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');

	function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
	function mdToHtml(src) {
		var blocks = [];
		var s = src.replace(fenceRe, function (m, lang, code) { blocks.push(code.replace(/\\n$/, '')); return '\\u0000' + (blocks.length - 1) + '\\u0000'; });
		s = esc(s);
		s = s.replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/^## (.*)$/gm, '<h3>$1</h3>').replace(/^# (.*)$/gm, '<h2>$1</h2>');
		s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
		s = s.replace(inlineRe, '<code>$1</code>');
		s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
		s = s.replace(/^(?:[-*] .*(?:\\n|$))+/gm, function (b) { return '<ul>' + b.trim().split('\\n').map(function (l) { return '<li>' + l.replace(/^[-*] /, '') + '</li>'; }).join('') + '</ul>'; });
		s = s.replace(/^(?:\\d+\\. .*(?:\\n|$))+/gm, function (b) { return '<ol>' + b.trim().split('\\n').map(function (l) { return '<li>' + l.replace(/^\\d+\\. /, '') + '</li>'; }).join('') + '</ol>'; });
		s = '<p>' + s.replace(/\\n{2,}/g, '</p><p>') + '</p>';
		s = s.replace(/\\n/g, '<br>');
		s = s.replace(/\\u0000(\\d+)\\u0000/g, function (m, i) { return '<pre class="code"><code>' + esc(blocks[i]) + '</code></pre>'; });
		return s;
	}
	function attachCodeTools(container) {
		var pres = container.querySelectorAll('pre.code');
		for (var i = 0; i < pres.length; i++) {
			(function (pre) {
				var codeText = pre.querySelector('code').textContent;
				var tools = document.createElement('div'); tools.className = 'code-tools';
				var copy = document.createElement('button'); copy.textContent = 'Copia';
				copy.addEventListener('click', function () { try { navigator.clipboard.writeText(codeText); copy.textContent = 'Copiato'; setTimeout(function () { copy.textContent = 'Copia'; }, 1200); } catch (e) {} });
				var ins = document.createElement('button'); ins.textContent = 'Inserisci';
				ins.addEventListener('click', function () { vscode.postMessage({ type: 'insertCode', text: codeText }); });
				tools.appendChild(copy); tools.appendChild(ins);
				pre.insertBefore(tools, pre.firstChild);
			})(pres[i]);
		}
	}
	function splitThink(raw) {
		var open = raw.indexOf('<think>');
		if (open < 0) { return { think: '', answer: raw, thinking: false }; }
		var close = raw.indexOf('</think>', open);
		if (close < 0) { return { think: raw.slice(open + 7), answer: raw.slice(0, open), thinking: true }; }
		return { think: raw.slice(open + 7, close), answer: raw.slice(0, open) + raw.slice(close + 8), thinking: false };
	}
	function showEmpty(txt) { log.innerHTML = '<div class="empty">' + txt + '</div>'; }
	function card(mode, icon, title, desc) {
		var c = document.createElement('div'); c.className = 'card' + (currentMode === mode ? ' active' : ''); c.setAttribute('data-mode', mode);
		var h = document.createElement('div'); h.className = 'card-h';
		var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon; h.appendChild(ic);
		var t = document.createElement('span'); t.textContent = title; h.appendChild(t);
		var p = document.createElement('p'); p.textContent = desc;
		c.appendChild(h); c.appendChild(p);
		c.addEventListener('click', function () { vscode.postMessage({ type: 'setMode', mode: mode }); input.focus(); });
		return c;
	}
	function showWelcome() {
		log.innerHTML = '';
		var w = document.createElement('div'); w.className = 'welcome';
		var icon = document.createElement('div'); icon.className = 'welcome-icon'; icon.textContent = '\\u2728';
		var title = document.createElement('div'); title.className = 'welcome-title'; title.textContent = "Let's build";
		var sub = document.createElement('div'); sub.className = 'welcome-sub'; sub.textContent = 'Pianifica, cerca o costruisci qualsiasi cosa';
		var cards = document.createElement('div'); cards.className = 'cards';
		cards.appendChild(card('vibe', '\\uD83D\\uDCAC', 'Vibe', 'Prima parli, poi costruisci. Esplora idee e itera mentre scopri cosa serve.'));
		cards.appendChild(card('spec', '\\uD83D\\uDCCB', 'Spec', 'Prima pianifichi, poi costruisci. Crea requisiti e design prima di scrivere codice.'));
		var gf = document.createElement('div'); gf.className = 'greatfor';
		var gfh = document.createElement('div'); gfh.className = 'gf-h'; gfh.textContent = 'Ottimo per:';
		var ul = document.createElement('ul');
		['Esplorazione e test rapidi', 'Costruire quando i requisiti non sono chiari', 'Implementare un task'].forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
		gf.appendChild(gfh); gf.appendChild(ul);
		var setup = document.createElement('button'); setup.className = 'setup-link'; setup.textContent = '\\u2699 Configura un modello';
		setup.addEventListener('click', function () { vscode.postMessage({ type: 'guidedSetup' }); });
		w.appendChild(icon); w.appendChild(title); w.appendChild(sub); w.appendChild(cards); w.appendChild(gf); w.appendChild(setup);
		log.appendChild(w);
	}
	function ensureCleared() { var e = log.querySelector('.empty'); if (e) { log.innerHTML = ''; } }
	function makeAssistant() {
		ensureCleared();
		var el = document.createElement('div'); el.className = 'msg assistant';
		var reason = document.createElement('details'); reason.className = 'reason'; reason.style.display = 'none';
		var sum = document.createElement('summary'); sum.textContent = '💭 Ragionamento'; reason.appendChild(sum);
		var rbody = document.createElement('div'); rbody.className = 'reason-body'; reason.appendChild(rbody);
		var ans = document.createElement('div'); ans.className = 'answer';
		el.appendChild(reason); el.appendChild(ans);
		log.appendChild(el); log.scrollTop = log.scrollHeight;
		return { el: el, reason: reason, rbody: rbody, ans: ans, raw: '' };
	}
	function renderAssistant(obj) {
		var parts = splitThink(obj.raw);
		if (parts.think) { obj.reason.style.display = 'block'; obj.rbody.textContent = parts.think; obj.reason.open = parts.thinking; }
		else { obj.reason.style.display = 'none'; }
		obj.ans.innerHTML = mdToHtml(parts.answer);
		attachCodeTools(obj.ans);
		log.scrollTop = log.scrollHeight;
	}
	function addStatic(cls, text) {
		ensureCleared();
		var el = document.createElement('div'); el.className = 'msg ' + cls;
		if (cls === 'assistant') { var a = document.createElement('div'); a.className = 'answer'; a.innerHTML = mdToHtml(text); el.appendChild(a); attachCodeTools(a); }
		else { el.textContent = text; }
		log.appendChild(el); log.scrollTop = log.scrollHeight;
		return el;
	}
	function addTool(name, args) {
		ensureCleared();
		var el = document.createElement('div'); el.className = 'msg tool';
		var head = document.createElement('div'); head.className = 'head';
		head.textContent = '🔧 ' + name + ' ' + (args && args.length < 120 ? args : '');
		el.appendChild(head);
		var res = document.createElement('div'); res.className = 'result';
		el.appendChild(res);
		log.appendChild(el); log.scrollTop = log.scrollHeight;
		return res;
	}
	function renderThumbs() {
		thumbs.innerHTML = '';
		pendingImages.forEach(function (d, idx) {
			var wrap = document.createElement('span');
			var im = document.createElement('img'); im.src = d; wrap.appendChild(im);
			var x = document.createElement('span'); x.className = 'x'; x.textContent = '×';
			x.addEventListener('click', function () { pendingImages.splice(idx, 1); renderThumbs(); });
			wrap.appendChild(x); thumbs.appendChild(wrap);
		});
	}
	function addThumbsTo(el, imgs) {
		for (var i = 0; i < imgs.length; i++) { var im = document.createElement('img'); im.className = 'thumb'; im.src = imgs[i]; el.appendChild(im); }
	}
	function send() {
		var text = input.value.trim();
		if (!text && pendingImages.length === 0) { return; }
		var el = addStatic('user', text || '(immagine)');
		if (pendingImages.length) { addThumbsTo(el, pendingImages); }
		input.value = ''; input.style.height = 'auto';
		vscode.postMessage({ type: 'send', text: text, images: pendingImages });
		pendingImages = []; renderThumbs();
	}
	sendBtn.addEventListener('click', send);
	stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'stop' }); });
	newBtn.addEventListener('click', function () { vscode.postMessage({ type: 'newChat' }); });
	modeVibe.addEventListener('click', function () { vscode.postMessage({ type: 'setMode', mode: 'vibe' }); });
	modeSpec.addEventListener('click', function () { vscode.postMessage({ type: 'setMode', mode: 'spec' }); });
	input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
	function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; }
	input.addEventListener('input', autoGrow);
	model.addEventListener('change', function () { vscode.postMessage({ type: 'setProvider', id: model.value }); });
	sessionSel.addEventListener('change', function () { vscode.postMessage({ type: 'switchSession', id: sessionSel.value }); });
	hashBtn.addEventListener('click', function () { vscode.postMessage({ type: 'pickContext' }); });
	attachBtn.addEventListener('click', function () { vscode.postMessage({ type: 'attachImage' }); });
	autoBtn.addEventListener('click', function () { vscode.postMessage({ type: 'toggleAutopilot' }); });
	input.addEventListener('paste', function (e) {
		var items = (e.clipboardData || {}).items || [];
		for (var i = 0; i < items.length; i++) {
			if (items[i].type && items[i].type.indexOf('image/') === 0) {
				var f = items[i].getAsFile();
				if (f) { var r = new FileReader(); r.onload = function () { pendingImages.push(r.result); renderThumbs(); }; r.readAsDataURL(f); }
			}
		}
	});

	window.addEventListener('message', function (event) {
		var m = event.data;
		if (m.type === 'state') {
			model.innerHTML = '';
			for (var i = 0; i < m.state.options.length; i++) {
				var o = m.state.options[i];
				var opt = document.createElement('option');
				opt.value = o.id; opt.textContent = o.label;
				if (o.id === m.state.current) { opt.selected = true; }
				model.appendChild(opt);
			}
			sessionSel.innerHTML = '';
			for (var j = 0; j < m.state.sessions.length; j++) {
				var s = m.state.sessions[j];
				var so = document.createElement('option');
				so.value = s.id; so.textContent = s.title || 'Sessione';
				if (s.id === m.state.activeId) { so.selected = true; }
				sessionSel.appendChild(so);
			}
			currentMode = m.state.mode;
			modeVibe.className = 'modebtn' + (m.state.mode === 'vibe' ? ' active' : '');
			modeSpec.className = 'modebtn' + (m.state.mode === 'spec' ? ' active' : '');
			var wcards = log.querySelectorAll('.welcome .card');
			for (var wc = 0; wc < wcards.length; wc++) { wcards[wc].className = 'card' + (wcards[wc].getAttribute('data-mode') === currentMode ? ' active' : ''); }
			autoBtn.className = 'toggle' + (m.state.autopilot ? ' on' : '');
			renderCtxPie(m.state.tokens || 0);
		}
		else if (m.type === 'insertRef') {
			var p = input.selectionStart || input.value.length;
			input.value = input.value.slice(0, p) + m.text + input.value.slice(p);
			input.focus();
		}
		else if (m.type === 'addImage') { pendingImages.push(m.dataUrl); renderThumbs(); }
		else if (m.type === 'restore') {
			log.innerHTML = '';
			if (!m.messages || m.messages.length === 0) { showWelcome(); }
			else {
				for (var k = 0; k < m.messages.length; k++) {
					var mm = m.messages[k];
					var el = addStatic(mm.role === 'assistant' ? 'assistant' : 'user', mm.content);
					if (mm.images && mm.images.length) { addThumbsTo(el, mm.images); }
				}
			}
		}
		else if (m.type === 'streamStart') { current = makeAssistant(); }
		else if (m.type === 'streamDelta') { if (current) { current.raw += m.text; renderAssistant(current); } }
		else if (m.type === 'streamEnd') { current = null; }
		else if (m.type === 'streamCancel') { if (current) { current.el.remove(); current = null; } }
		else if (m.type === 'assistant') { addStatic('assistant', m.text); }
		else if (m.type === 'tool') { lastToolResult = addTool(m.name, m.args); }
		else if (m.type === 'toolResult') { if (lastToolResult) { lastToolResult.textContent = m.text; log.scrollTop = log.scrollHeight; } }
		else if (m.type === 'error') { addStatic('error', '⚠ ' + m.text); }
		else if (m.type === 'busy') { document.body.classList.toggle('busy', m.value); }
	});

	showWelcome();
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
