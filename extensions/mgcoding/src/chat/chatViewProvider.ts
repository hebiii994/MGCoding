/*---------------------------------------------------------------------------------------------
 *  MGCoding - vista chat: sessioni multiple, modalità Vibe/Spec, Markdown, reasoning, tool
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgent } from '../agent/agentLoop';
import { complete, streamPure, buildGroundingContext } from '../agent/agent';
import { track } from '../analytics/analytics';
import { changedCount } from '../edit/checkpoint';
import { SPEC_SYS, slugify, specsRoot, writeAndOpen } from '../specs/specs';
import { splitThink } from '../util/parsing';
import { listSteeringNames } from '../steering/steering';
import { RunReporter } from '../run/runView';
import { WhisperEngine } from '../stt/whisperEngine';
import { ProviderRegistry } from '../llm/registry';
import { ChatMessage } from '../llm/types';

interface ProviderOption {
	id: string;
	label: string;
	/** Solo Ollama: il modello supporta il tool-use nativo. */
	tools?: boolean;
}

type ChatMode = 'vibe' | 'spec';

type SpecPhase = 'requirements' | 'design' | 'tasks' | 'done';

interface SpecState {
	name: string;
	slug: string;
	idea: string;
	phase: SpecPhase;
	kind?: 'feature' | 'bugfix';
	requirements?: string;
	design?: string;
	tasks?: string;
}

interface Session {
	id: string;
	title: string;
	mode: ChatMode;
	messages: ChatMessage[];
	spec?: SpecState;
	/** true se l'utente ha già rifiutato l'offerta di sessione Spec in questa chat. */
	specOfferDismissed?: boolean;
}

/** Nome leggibile del servizio in base all'endpoint OpenAI-compatibile. */
function openAiProviderLabel(endpoint: string): string {
	const e = (endpoint || '').toLowerCase();
	if (e.includes('generativelanguage.googleapis')) {
		return 'Gemini';
	}
	if (e.includes('api.openai.com')) {
		return 'ChatGPT';
	}
	if (e.includes('openrouter.ai')) {
		return 'OpenRouter';
	}
	if (e.includes('azure.com')) {
		return 'Azure';
	}
	return 'OpenAI-compat';
}

const SPEC_PHASE_TITLE: Record<Exclude<SpecPhase, 'done'>, string> = {
	requirements: '📋 Requisiti',
	design: '🏗 Design',
	tasks: '✅ Task'
};

const VIBE_MODE_PROMPT = `MODALITÀ VIBE: esplora e implementa rapidamente, iterando. Puoi modificare il codice direttamente con i tool quando opportuno.`;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'mgcoding.chat';

	private view?: vscode.WebviewView;
	private sessions: Session[] = [];
	private activeId = '';
	private abort?: AbortController;
	/** Testo in attesa di scelta (offerta sessione Spec / prioritizzazione). */
	private pendingSpecText = '';
	/** Spec estratte da un messaggio multi-spec, in attesa di scelta. */
	private pendingSpecs: { title: string; desc: string }[] = [];
	/** Spec rimanenti da generare dopo la prima (quando se ne chiedono più di una). */
	private specQueue: { title: string; desc: string }[] = [];
	/** Motore Whisper incluso (auto-avviato) per lo STT senza server esterno. */
	private readonly whisper: WhisperEngine;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly registry: ProviderRegistry,
		private readonly memento: vscode.Memento
	) {
		this.whisper = new WhisperEngine(vscode.Uri.joinPath(extensionUri, 'bin').fsPath);
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

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; id?: string; mode?: ChatMode; specMode?: string; images?: string[] }) => {
			switch (msg.type) {
				case 'ready':
					await this.sendState();
					this.post({ type: 'restore', messages: this.active().messages });
					this.post({ type: 'changes', count: changedCount() });
					break;
				case 'viewChanges':
					await vscode.commands.executeCommand('mgcoding.viewChanges');
					break;
				case 'revertChanges':
					await vscode.commands.executeCommand('mgcoding.revertChanges');
					this.post({ type: 'changes', count: changedCount() });
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
							// Se manca la chiave per questo endpoint, chiedila subito.
							if (!(await this.registry.hasOpenAIKey())) {
								await this.registry.setOpenAIKey();
							}
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
				case 'toggleNativeTools':
					{
						const cfg = vscode.workspace.getConfiguration('mgcoding');
						await cfg.update('ollama.nativeTools', !cfg.get<boolean>('ollama.nativeTools', false), vscode.ConfigurationTarget.Global);
						await this.sendState();
					}
					break;
				case 'pickContext':
					await this.pickContext();
					break;
				case 'refreshState':
					await this.sendState();
					break;
				case 'transcribe':
					if (msg.text) {
						await this.transcribeAudio(msg.text, (msg as { mime?: string }).mime);
					}
					break;
				case 'sttError':
					this.post({ type: 'error', text: `Microfono: ${msg.text ?? 'errore'}` });
					break;
				case 'guidedSetup':
					await vscode.commands.executeCommand('mgcoding.guidedSetup');
					break;
				case 'specMode':
					if (msg.specMode) {
						await this.startSpecMode(msg.specMode);
					}
					break;
				case 'specOfferChoice':
					await this.handleSpecOffer((msg as { choice?: string }).choice ?? '');
					break;
				case 'specPick':
					await this.pickSpec(Number((msg as { index?: number }).index ?? -1));
					break;
				case 'specApprove':
					await this.approveSpec();
					break;
				case 'specRegenerate':
					{
						const sp = this.active().spec;
						if (sp && sp.phase !== 'done') {
							await this.runSpecPhase(sp.phase, undefined);
						}
					}
					break;
				case 'specRunTasks':
					await this.runSpecTasksFromChat();
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

	private async buildState(): Promise<{ current: string; options: ProviderOption[]; sessions: { id: string; title: string }[]; activeId: string; mode: ChatMode; autopilot: boolean; tokens: number; nativeTools: boolean; voiceLang: string }> {
		const c = vscode.workspace.getConfiguration('mgcoding');
		const claudeModel = c.get<string>('claude.model', 'claude-opus-4-8');
		const ollamaModel = c.get<string>('ollama.model', 'qwen2.5-coder:14b');
		const openaiModel = c.get<string>('openai.model', 'local-model');
		const provider = c.get<string>('provider', 'ollama');

		const options: ProviderOption[] = [{ id: 'claude', label: `Claude (API) · ${claudeModel}` }];

		// Ollama: solo i modelli REALMENTE installati sulla macchina dell'utente.
		// (Se il provider attivo è Ollama, mostra comunque il modello selezionato.)
		const installed = await this.registry.listOllamaModels();
		const ollamaList = [...installed];
		if (provider === 'ollama' && ollamaModel && !ollamaList.includes(ollamaModel)) {
			ollamaList.unshift(ollamaModel);
		}
		// Rileva quali modelli Ollama supportano il tool-use nativo (cache lato provider).
		const toolCaps = await Promise.all(ollamaList.map(m => this.registry.ollamaModelSupportsTools(m).catch(() => false)));
		ollamaList.forEach((m, i) => {
			options.push({ id: `ollama:${m}`, label: `Ollama · ${m}`, tools: toolCaps[i] });
		});

		// OpenAI-compatibile: modelli esposti dall'endpoint configurato (Gemini/ChatGPT/…).
		const oaiLabel = openAiProviderLabel(c.get<string>('openai.endpoint', ''));
		const oai = await this.registry.listOpenAIModels();
		const oaiList = [...oai];
		if (provider === 'openai' && openaiModel && !oaiList.includes(openaiModel)) {
			oaiList.unshift(openaiModel);
		}
		for (const m of oaiList) {
			options.push({ id: `openai:${m}`, label: `${oaiLabel} · ${m}` });
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
			tokens: Math.round(chars / 4),
			nativeTools: c.get<boolean>('ollama.nativeTools', false),
			voiceLang: c.get<string>('voice.lang', 'it-IT')
		};
	}

	private async sendState(): Promise<void> {
		this.post({ type: 'state', state: await this.buildState() });
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	/** Selettore di contesto: file, codebase, problemi, git diff. Inserisce un token nel composer. */
	private async pickContext(): Promise<void> {
		const cat = await vscode.window.showQuickPick(
			[
				{ label: '$(file) File', detail: 'Allega il contenuto di un file (@percorso)', id: 'file' },
				{ label: '$(symbol-structure) Codebase', detail: 'Struttura del progetto (#codebase)', id: 'codebase' },
				{ label: '$(warning) Problemi', detail: 'Errori e warning correnti (#problems)', id: 'problems' },
				{ label: '$(git-compare) Git diff', detail: 'Modifiche non committate (#git)', id: 'git' }
			],
			{ placeHolder: 'Aggiungi contesto' }
		);
		if (!cat) {
			return;
		}
		if (cat.id === 'file') {
			const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,out-build,out-vscode,.build,dist,Library,Temp,Logs,obj,bin}/**', 1000);
			const items = uris.map(u => vscode.workspace.asRelativePath(u, false)).sort().map(label => ({ label }));
			const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Scegli un file (@)', matchOnDetail: true });
			if (picked) {
				this.post({ type: 'insertRef', text: `@${picked.label} ` });
			}
			return;
		}
		this.post({ type: 'insertRef', text: `#${cat.id} ` });
	}

	/** Trascrive l'audio registrato (base64) via endpoint STT OpenAI-compatibile. */
	private async transcribeAudio(audioB64: string, mime?: string): Promise<void> {
		const c = vscode.workspace.getConfiguration('mgcoding');
		let endpoint = c.get<string>('stt.endpoint', '').trim();
		this.post({ type: 'sttBusy', value: true });
		// Se non c'è un endpoint configurato, usa il motore Whisper incluso (auto-avviato).
		if (!endpoint && this.whisper.isAvailable()) {
			endpoint = (await this.whisper.ensureRunning()) ?? '';
		}
		if (!endpoint) {
			this.post({ type: 'sttBusy', value: false });
			this.post({ type: 'error', text: 'STT non disponibile: motore vocale non installato e nessun "mgcoding.stt.endpoint" configurato.' });
			return;
		}
		try {
			const buf = Buffer.from(audioB64, 'base64');
			const form = new FormData();
			form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.webm');
			form.append('model', c.get<string>('stt.model', 'whisper-1'));
			form.append('response_format', 'json');
			const headers: Record<string, string> = {};
			const key = c.get<string>('stt.apiKey', '').trim();
			if (key) {
				headers['authorization'] = `Bearer ${key}`;
			}
			const res = await fetch(endpoint, { method: 'POST', headers, body: form });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			// La risposta può essere JSON ({text}) o testo semplice (whisper.cpp).
			const body = (await res.text()).trim();
			let text = body;
			try {
				const j = JSON.parse(body) as { text?: string };
				if (typeof j.text === 'string') {
					text = j.text;
				}
			} catch {
				// non-JSON: usa il testo grezzo
			}
			text = text.trim();
			this.post({ type: 'sttResult', text, autoSend: c.get<boolean>('stt.autoSend', false) });
		} catch (err) {
			this.post({ type: 'error', text: `Trascrizione non riuscita: ${err instanceof Error ? err.message : String(err)}` });
		} finally {
			this.post({ type: 'sttBusy', value: false });
		}
	}

	/** Espande i token di contesto #codebase / #problems / #git in blocchi testuali. */
	private async augmentWithProviders(text: string): Promise<string> {
		const blocks: string[] = [];
		if (/#codebase\b/i.test(text)) {
			blocks.push(await this.codebaseContext());
		}
		if (/#problems\b/i.test(text)) {
			blocks.push(this.problemsContext());
		}
		if (/#git\b/i.test(text)) {
			blocks.push(await this.gitDiffContext());
		}
		const ok = blocks.filter(Boolean);
		return ok.length ? `${text}\n\n${ok.join('\n\n')}` : text;
	}

	private async codebaseContext(): Promise<string> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return '';
		}
		const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,out-build,out-vscode,.build,dist,Library,Temp,Logs,obj,bin}/**', 400);
		const list = uris.map(u => vscode.workspace.asRelativePath(u, false)).sort().slice(0, 400);
		return `Contesto #codebase (file del progetto, max 400):\n${list.join('\n')}`;
	}

	private problemsContext(): string {
		const out: string[] = [];
		for (const [uri, diags] of vscode.languages.getDiagnostics()) {
			for (const d of diags) {
				if (d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning) {
					const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
					out.push(`${sev} ${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1} ${d.message}`);
				}
			}
		}
		return out.length ? `Contesto #problems (${out.length}):\n${out.slice(0, 100).join('\n')}` : 'Contesto #problems: nessun errore/warning.';
	}

	private async gitDiffContext(): Promise<string> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return '';
		}
		try {
			const { execFile } = await import('child_process');
			const cwd = folders[0].uri.fsPath;
			const diff = await new Promise<string>((resolve) => {
				execFile('git', ['diff', '--stat', '--', '.'], { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
			});
			const full = await new Promise<string>((resolve) => {
				execFile('git', ['diff', '--', '.'], { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
			});
			const body = full.slice(0, 12000);
			return body ? `Contesto #git (git diff):\n${diff}\n\`\`\`diff\n${body}${full.length > 12000 ? '\n…(troncato)' : ''}\n\`\`\`` : 'Contesto #git: nessuna modifica non committata.';
		} catch {
			return '';
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
		// "Riprendi/continua la spec …" in linguaggio naturale (qualsiasi modalità).
		if (await this.tryResumeSpec(text)) {
			return;
		}
		if (session.mode === 'spec') {
			if (session.title === 'Nuova sessione') {
				session.title = (text || 'Spec').slice(0, 40);
			}
			const handled = await this.handleSpecMessage(text);
			if (handled) {
				return;
			}
			// Spec già completata e messaggio non legato ai task → prosegui come chat normale.
		} else if (!session.specOfferDismissed && this.shouldOfferSpec(text)) {
			// Vibe: il messaggio sembra "da Spec" → offri una sessione Spec.
			this.pendingSpecText = text;
			if (this.isMultiSpec(text)) {
				await this.offerMultiSpec(text);
			} else {
				this.post({ type: 'specOffer' });
			}
			return;
		}
		if (session.title === 'Nuova sessione') {
			session.title = (text || 'Immagine').slice(0, 40);
		}
		const withMentions = await this.augmentWithMentions(text);
		const userMsg: ChatMessage = { role: 'user', content: await this.augmentWithProviders(withMentions) };
		if (images?.length) {
			userMsg.images = images.slice(0, 4);
		}
		session.messages.push(userMsg);
		this.post({ type: 'busy', value: true });
		// Intestazione di turno con avatar + steering inclusi (trasparenza stile Kiro).
		const steering = await listSteeringNames();
		this.post({ type: 'steeringChips', names: steering });
		this.abort = new AbortController();
		const systemExtra = VIBE_MODE_PROMPT;
		try {
			await runAgent(this.registry, session.messages, {
				onStreamStart: () => this.post({ type: 'streamStart' }),
				onStreamDelta: t => this.post({ type: 'streamDelta', text: t }),
				onStreamEnd: () => this.post({ type: 'streamEnd' }),
				onStreamCancel: () => this.post({ type: 'streamCancel' }),
				onAssistantText: t => this.post({ type: 'assistant', text: t }),
				onToolStart: call => this.post({ type: 'tool', name: call.tool, args: JSON.stringify(call.args) }),
				onToolResult: r => this.post({ type: 'toolResult', text: r }),
				onPlan: steps => this.post({ type: 'plan', steps })
			}, this.abort.signal, systemExtra);
		} catch (err) {
			this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
		} finally {
			this.abort = undefined;
			this.post({ type: 'busy', value: false });
			this.post({ type: 'changes', count: changedCount() });
			await this.save();
			await this.sendState();
		}
	}

	// ---- Rilevamento intento: offerta/prioritizzazione Spec ----

	/** Euristica: il messaggio descrive una funzionalità adatta a una Spec? */
	private shouldOfferSpec(text: string): boolean {
		const t = text.toLowerCase();
		const long = text.length > 160;
		const kw = /(spec|funzional|implement|vorrei|servirebb|men[uù]|sistema|opzion|feature|gestione|workflow|crea(re)?\s+(un|una)\b)/.test(t);
		const multiSentence = (text.match(/[.!?]/g) || []).length >= 2 || text.split('\n').length >= 2;
		return long || (kw && multiSentence);
	}

	/** Estrae spec definite con blocchi espliciti "=== SPEC_START: Titolo === ... === SPEC_END ===". */
	private parseExplicitSpecs(text: string): { title: string; desc: string }[] {
		const out: { title: string; desc: string }[] = [];
		const re = /===\s*SPEC_START\s*:?\s*(.+?)\s*===([\s\S]*?)===\s*SPEC_END\s*===/gi;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const title = m[1].trim();
			const desc = m[2].trim();
			if (title) {
				out.push({ title, desc });
			}
		}
		return out;
	}

	/** Euristica: il messaggio descrive PIÙ spec distinte? */
	private isMultiSpec(text: string): boolean {
		if (this.parseExplicitSpecs(text).length >= 2) {
			return true;
		}
		const t = text.toLowerCase();
		// "spec" come parola e i delimitatori di blocco (SPEC_START contiene underscore,
		// quindi non è una parola intera: lo cerco a parte).
		const count = (t.match(/\bspec\b/g) || []).length;
		const blocks = (t.match(/spec_start/g) || []).length;
		const enumWords = /(due|tre|quattro)\s+(cose|funzional|spec|feature)|una per|l['e ]altra|un['a ]altra|la seconda|la terza|inoltre|\b[123][.)]\s/.test(t);
		return count >= 2 || blocks >= 2 || (enumWords && this.shouldOfferSpec(text));
	}

	/** Estrae l'elenco delle spec da un messaggio multi-spec e propone la prioritizzazione. */
	private async offerMultiSpec(text: string): Promise<void> {
		// 1) Blocchi espliciti (=== SPEC_START: ... ===): parse diretto, niente LLM.
		let specs: { title: string; desc: string }[] = this.parseExplicitSpecs(text);
		// 2) Altrimenti chiedo al modello di separarle.
		if (specs.length < 2) {
			this.post({ type: 'busy', value: true });
			try {
				const sys = `Dall'idea dell'utente estrai le SINGOLE funzionalità/spec distinte. Rispondi SOLO con JSON: {"specs":[{"title":"...","desc":"breve"}]} (2-5 voci). Nessun altro testo.`;
				const raw = await complete(this.registry, [{ role: 'user', content: text }], sys, undefined, undefined, true);
				const m = raw.match(/\{[\s\S]*\}/);
				if (m) {
					const obj = JSON.parse(m[0]) as { specs?: { title?: string; desc?: string }[] };
					specs = (obj.specs ?? []).filter(s => s.title).map(s => ({ title: String(s.title), desc: String(s.desc ?? '') }));
				}
			} catch {
				// fallback sotto
			}
			this.post({ type: 'busy', value: false });
		}
		specs = specs.slice(0, 5);
		if (specs.length < 2) {
			// Non sono riuscito a separarle: ripiego sull'offerta singola.
			this.post({ type: 'specOffer' });
			return;
		}
		this.pendingSpecs = specs;
		this.post({ type: 'assistant', text: `Ho individuato ${specs.length} spec distinte. Le creo tutte: quale vuoi per prima?` });
		this.post({ type: 'specPrioritize', specs });
	}

	/** Risposta all'offerta di sessione Spec (singola). */
	private async handleSpecOffer(choice: string): Promise<void> {
		const session = this.active();
		const text = this.pendingSpecText;
		this.pendingSpecText = '';
		if (choice === 'yes' && text) {
			const name = await this.conciseSpecName(text);
			session.mode = 'spec';
			session.spec = { name, slug: slugify(name), idea: text, phase: 'requirements' };
			await this.save();
			await this.sendState();
			this.post({ type: 'assistant', text: `📋 Spec «${name}». Come vuoi procedere?` });
			this.post({ type: 'specModeChoose' });
		} else if (choice === 'no' && text) {
			session.specOfferDismissed = true;
			await this.handleSend(text);
		}
		// cancel → nulla
	}

	/** Sceglie quale spec (tra quelle multiple) creare per prima. */
	private async pickSpec(index: number): Promise<void> {
		const session = this.active();
		const spec = this.pendingSpecs[index];
		if (!spec) {
			return;
		}
		// Le altre spec restano in coda: verranno generate dopo, con la stessa modalità.
		this.specQueue = this.pendingSpecs.filter((_, i) => i !== index);
		this.pendingSpecs = [];
		session.mode = 'spec';
		session.spec = { name: spec.title.slice(0, 60), slug: slugify(spec.title), idea: `${spec.title}: ${spec.desc}`, phase: 'requirements' };
		await this.save();
		await this.sendState();
		const queued = this.specQueue.length ? ` (poi le altre ${this.specQueue.length})` : '';
		this.post({ type: 'assistant', text: `📋 Spec «${spec.title}»${queued}. Come vuoi procedere?` });
		this.post({ type: 'specModeChoose' });
	}

	// ---- Workflow Spec guidato (requirements → design → tasks → esecuzione) ----

	/** Elenca le spec esistenti (.mg/specs) con lo stato dei documenti. */
	private async listSpecsWithState(): Promise<{ slug: string; dir: vscode.Uri; req: boolean; design: boolean; tasks: boolean; mtime: number }[]> {
		const root = specsRoot();
		if (!root) {
			return [];
		}
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(root);
		} catch {
			return [];
		}
		const has = async (dir: vscode.Uri, f: string): Promise<boolean> => {
			try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, f)); return true; } catch { return false; }
		};
		const out: { slug: string; dir: vscode.Uri; req: boolean; design: boolean; tasks: boolean; mtime: number }[] = [];
		for (const [name, t] of entries) {
			if (t !== vscode.FileType.Directory) {
				continue;
			}
			const dir = vscode.Uri.joinPath(root, name);
			let mtime = 0;
			try { mtime = (await vscode.workspace.fs.stat(dir)).mtime; } catch { /* ignora */ }
			out.push({ slug: name, dir, req: await has(dir, 'requirements.md'), design: await has(dir, 'design.md'), tasks: await has(dir, 'tasks.md'), mtime });
		}
		return out;
	}

	/** Se il messaggio chiede di riprendere/continuare una spec esistente, la carica. */
	private async tryResumeSpec(text: string): Promise<boolean> {
		const t = text.toLowerCase();
		const resumeIntent = /\b(riprend|riprist|continu|riapri|prosegu|complet|finisc|carica|recuper)\w*/.test(t)
			&& /(spec|precedent|ultim|prima|esistent|quell|lasciat|sospes|iniziat)/.test(t);
		if (!resumeIntent) {
			return false;
		}
		const specs = await this.listSpecsWithState();
		if (!specs.length) {
			return false;
		}
		// 1) match esplicito per nome nel messaggio; 2) "ultima/recente"; 3) una sola; 4) scelta.
		let chosen = specs.find(s => t.includes(s.slug.replace(/-/g, ' ')) || t.includes(s.slug.toLowerCase()));
		if (!chosen) {
			if (specs.length === 1 || /(ultim|recent|precedent|prima|sospes|lasciat)/.test(t)) {
				chosen = specs.slice().sort((a, b) => b.mtime - a.mtime)[0];
			} else {
				const pick = await vscode.window.showQuickPick(specs.map(s => s.slug), { placeHolder: 'Quale spec vuoi riprendere?' });
				if (!pick) {
					return true;
				}
				chosen = specs.find(s => s.slug === pick);
			}
		}
		if (!chosen) {
			return false;
		}
		await this.loadSpecIntoSession(chosen);
		return true;
	}

	/** Carica una spec esistente nella sessione e prosegue dalla fase mancante. */
	private async loadSpecIntoSession(s: { slug: string; dir: vscode.Uri; req: boolean; design: boolean; tasks: boolean }): Promise<void> {
		const session = this.active();
		const dec = new TextDecoder();
		const read = async (f: string): Promise<string> => {
			try { return dec.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(s.dir, f))); } catch { return ''; }
		};
		const requirements = await read('requirements.md');
		const design = await read('design.md');
		const phase: SpecPhase = !s.req ? 'requirements' : !s.design ? 'design' : !s.tasks ? 'tasks' : 'done';
		session.mode = 'spec';
		session.spec = { name: s.slug.replace(/-/g, ' '), slug: s.slug, idea: requirements.slice(0, 200) || s.slug, phase, requirements, design };
		await this.save();
		await this.sendState();
		const have = [s.req && 'requirements', s.design && 'design', s.tasks && 'tasks'].filter(Boolean).join(' + ') || 'nessun documento';
		this.post({ type: 'assistant', text: `📂 Ho ripreso la spec «${s.slug}» (presenti: ${have}).` });
		if (phase === 'done') {
			this.post({ type: 'assistant', text: 'La spec è completa. Vuoi eseguire i task o modificare un documento?' });
			this.post({ type: 'specActions', phase: 'done' });
		} else {
			this.post({ type: 'assistant', text: `Proseguo generando: ${SPEC_PHASE_TITLE[phase]}…` });
			await this.runSpecPhase(phase as Exclude<SpecPhase, 'done'>);
		}
	}

	/** Genera un titolo breve e sensato per la spec a partire dall'idea (fallback euristico). */
	private async conciseSpecName(idea: string): Promise<string> {
		const fallback = (idea.split('\n')[0] || 'Nuova funzionalità').replace(/^(ciao|ehi|hey|salve)[,!.\s]*/i, '').replace(/^(vorrei|voglio|potresti|puoi)\s+/i, '').slice(0, 50).trim() || 'Nuova funzionalità';
		try {
			const sys = 'Proponi un TITOLO BREVE (2-5 parole, in italiano) per la funzionalità o app descritta dal messaggio. Rispondi SOLO con il titolo, senza virgolette né punteggiatura finale.';
			const raw = await complete(this.registry, [{ role: 'user', content: idea }], sys, undefined, undefined, true);
			const name = splitThink(raw).answer.trim().split('\n')[0].replace(/^["'«»]+|["'«».]+$/g, '').slice(0, 50).trim();
			return name || fallback;
		} catch {
			return fallback;
		}
	}

	/** Gestisce un messaggio in modalità Spec. Ritorna false se va trattato come chat normale. */
	private async handleSpecMessage(text: string): Promise<boolean> {
		const session = this.active();
		if (session.spec && session.spec.phase === 'done') {
			// Spec completata: "continua/esegui i task" → esegue; altrimenti è una
			// domanda/azione normale → la gestisce l'agente (NON una nuova spec).
			if (/\b(continu|esegu|run|task|prosegu)/i.test(text)) {
				this.post({ type: 'assistant', text: `▶ Eseguo i task di «${session.spec.name}»…` });
				await this.runSpecTasksFromChat();
				return true;
			}
			return false;
		}
		if (!session.spec) {
			const name = await this.conciseSpecName(text.trim());
			session.spec = { name, slug: slugify(name), idea: text.trim(), phase: 'requirements' };
			// Chiede COME procedere (combo): passo-passo / veloce / singolo file.
			this.post({ type: 'assistant', text: `📋 Spec «${name}». Come vuoi procedere?` });
			this.post({ type: 'specModeChoose' });
			return true;
		}
		// Fase in corso: l'utente fornisce indicazioni → rigenero la fase corrente.
		await this.runSpecPhase(session.spec.phase as Exclude<SpecPhase, 'done'>, text.trim());
		return true;
	}

	/** Avvia la spec nella modalità scelta dall'utente. */
	private async startSpecMode(mode: string): Promise<void> {
		const spec = this.active().spec;
		if (!spec) {
			return;
		}
		if (mode === 'bugfix') {
			spec.kind = 'bugfix';
			await this.runSpecPhase('requirements');
			return;
		}
		spec.kind = 'feature';
		if (mode === 'step') {
			await this.runSpecPhase('requirements');
			return;
		}
		if (mode === 'fast') {
			for (const phase of ['requirements', 'design', 'tasks'] as const) {
				spec.phase = phase;
				await this.runSpecPhase(phase, undefined, false);
			}
			spec.phase = 'done';
			await this.save();
			this.post({ type: 'assistant', text: `✅ Spec «${spec.name}» generata (requirements + design + tasks) in \`.mg/specs/${spec.slug}/\`.` });
			if (!this.specQueue.length) {
				this.post({ type: 'specActions', phase: 'done' });
			}
			await this.advanceSpecQueue('fast');
			return;
		}
		if (mode.startsWith('single:')) {
			const file = mode.slice('single:'.length) as Exclude<SpecPhase, 'done'>;
			await this.runSpecPhase(file, undefined, false);
			spec.phase = 'done';
			await this.save();
			this.post({ type: 'assistant', text: `Documento ${file}.md generato per «${spec.name}».` });
			if (file === 'tasks' && !this.specQueue.length) {
				this.post({ type: 'specActions', phase: 'done' });
			}
			await this.advanceSpecQueue(mode);
		}
	}

	/** Passa alla prossima spec in coda (se presente) usando la stessa modalità. */
	private async advanceSpecQueue(mode: string): Promise<boolean> {
		const next = this.specQueue.shift();
		if (!next) {
			return false;
		}
		const session = this.active();
		session.mode = 'spec';
		session.spec = { name: next.title.slice(0, 60), slug: slugify(next.title), idea: `${next.title}: ${next.desc}`, phase: 'requirements' };
		await this.save();
		await this.sendState();
		this.post({ type: 'assistant', text: `➡️ Passo alla prossima spec «${next.title}»…` });
		await this.startSpecMode(mode);
		return true;
	}

	private async runSpecPhase(phase: Exclude<SpecPhase, 'done'>, feedback?: string, showActions = true): Promise<void> {
		const session = this.active();
		const spec = session.spec;
		const root = specsRoot();
		if (!spec) {
			return;
		}
		if (!root) {
			this.post({ type: 'error', text: 'Apri una cartella per usare il workflow Spec.' });
			return;
		}
		this.post({ type: 'busy', value: true });
		// Mostra gli steering inclusi (stile Kiro): trasparenza su cosa "legge".
		const steering = await listSteeringNames();
		if (steering.length) {
			this.post({ type: 'steeringChips', names: steering });
		}
		this.post({ type: 'assistant', text: `${SPEC_PHASE_TITLE[phase]} — sto generando per «${spec.name}»…` });
		try {
			let userPrompt: string;
			if (phase === 'requirements') {
				userPrompt = `Funzionalità: ${spec.name}\nDescrizione: ${spec.idea}`;
			} else if (phase === 'design') {
				userPrompt = `Funzionalità: ${spec.name}\nRequisiti:\n${spec.requirements ?? ''}`;
			} else {
				userPrompt = `Funzionalità: ${spec.name}\nDesign:\n${spec.design ?? ''}`;
			}
			if (feedback) {
				userPrompt += `\n\nIndicazioni di revisione dall'utente: ${feedback}\nRigenera il documento tenendone conto.`;
			}
			// Istruzioni del documento (bugfix per la fase requirements se kind=bugfix)
			// + contesto del progetto (struttura + steering) per ancorare la spec al codice reale.
			let docSys: string = SPEC_SYS[phase];
			if (phase === 'requirements' && spec.kind === 'bugfix') {
				docSys = SPEC_SYS.bugfix;
			}
			const grounding = await buildGroundingContext();
			const sys = grounding
				? `${docSys}\n\n# Contesto del progetto — rispetta SEMPRE le regole di steering qui sotto e i pattern esistenti:\n${grounding}`
				: docSys;
			// Streaming "puro" (solo doc + contesto, niente prompt agentico): il documento
			// compare in chat man mano che viene generato, invece di apparire tutto alla fine.
			this.post({ type: 'streamStart' });
			this.abort = new AbortController();
			let raw = '';
			try {
				raw = await streamPure(this.registry, [{ role: 'user', content: userPrompt }], sys, d => this.post({ type: 'streamDelta', text: d }), this.abort.signal);
			} finally {
				this.post({ type: 'streamEnd' });
			}
			// Rimuove l'eventuale ragionamento dei modelli "thinking" dal documento salvato.
			const content = splitThink(raw).answer.trim() || raw.trim();
			const dir = vscode.Uri.joinPath(root, spec.slug);
			await vscode.workspace.fs.createDirectory(dir);
			await writeAndOpen(vscode.Uri.joinPath(dir, `${phase}.md`), content);
			spec[phase] = content;
			if (showActions) {
				this.post({ type: 'specActions', phase });
			}
			await this.save();
		} catch (err) {
			this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
		} finally {
			this.post({ type: 'busy', value: false });
		}
	}

	private async approveSpec(): Promise<void> {
		const spec = this.active().spec;
		if (!spec) {
			return;
		}
		if (spec.phase === 'requirements') {
			spec.phase = 'design';
			await this.runSpecPhase('design');
		} else if (spec.phase === 'design') {
			spec.phase = 'tasks';
			await this.runSpecPhase('tasks');
		} else if (spec.phase === 'tasks') {
			spec.phase = 'done';
			await this.save();
			this.post({ type: 'assistant', text: `✅ Spec «${spec.name}» completata in \`.mg/specs/${spec.slug}/\`. Puoi eseguire i task qui sotto.` });
			if (!this.specQueue.length) {
				this.post({ type: 'specActions', phase: 'done' });
			}
			// Se c'erano più spec, prosegui con la prossima (sempre passo-passo).
			await this.advanceSpecQueue('step');
		}
	}

	/** Crea un nuovo AbortController per un'esecuzione e ne restituisce il signal (Stop della chat). */
	beginRun(): AbortSignal {
		this.abort = new AbortController();
		return this.abort.signal;
	}

	/** Reporter che mostra l'avanzamento dell'esecuzione task DENTRO la chat (a destra). */
	runReporter(): RunReporter {
		return {
			start: (title, steps) => {
				void vscode.commands.executeCommand('mgcoding.chat.focus');
				this.post({ type: 'busy', value: true });
				this.post({ type: 'run', phase: 'start', text: `${title} — ${steps.length} task` });
			},
			setStatus: () => { /* i dettagli arrivano via log */ },
			log: (line: string) => this.post({ type: 'run', phase: 'append', text: line }),
			summary: (markdown: string) => {
				// Report finale come messaggio markdown vero (non run-line).
				this.post({ type: 'run', phase: 'end' });
				this.post({ type: 'assistant', text: markdown });
			},
			finish: (message?: string) => {
				if (message) {
					this.post({ type: 'run', phase: 'append', text: message });
				}
				this.post({ type: 'run', phase: 'end' });
				this.post({ type: 'busy', value: false });
				this.post({ type: 'changes', count: changedCount() });
			}
		};
	}

	private async runSpecTasksFromChat(): Promise<void> {
		const spec = this.active().spec;
		const root = specsRoot();
		if (!spec || !root) {
			return;
		}
		await vscode.commands.executeCommand('mgcoding.runSpecTasks', { uri: vscode.Uri.joinPath(root, spec.slug) });
	}

	dispose(): void {
		this.whisper.dispose();
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
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; overflow-x: hidden; }
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
	.spec-actions { align-self: stretch; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 12px; border: 1px solid var(--mg-accent); border-radius: 10px; background: color-mix(in srgb, var(--mg-accent) 10%, transparent); }
	.spec-actions .sa-label { font-weight: 600; font-size: 12.5px; margin-right: 4px; }
	.spec-actions button { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-input-border, #5a5a5a); border-radius: 7px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
	.spec-actions button.primary { background: var(--mg-accent); color: #06210f; border-color: var(--mg-accent); font-weight: 600; }
	.spec-actions button:hover { filter: brightness(1.08); }
	.msg { padding: 8px 10px; border-radius: 8px; word-wrap: break-word; overflow-wrap: anywhere; max-width: 100%; box-sizing: border-box; }
	.user { background: var(--vscode-input-background); align-self: flex-end; max-width: 92%; white-space: pre-wrap; }
	.assistant { background: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 100%; }
	.steering-card { align-self: flex-start; max-width: 100%; margin: 2px 0; }
	.steering-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
	.mg-avatar { width: 22px; height: 22px; flex: 0 0 auto; display: inline-flex; }
	.mg-avatar svg { width: 22px; height: 22px; display: block; }
	.steering-title { font-weight: 600; opacity: 0.9; font-size: 0.92em; }
	.steering-chips { display: flex; flex-wrap: wrap; gap: 6px; }
	.steering-chip { font-size: 11px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; background: color-mix(in srgb, var(--mg-accent) 14%, transparent); border: 1px solid color-mix(in srgb, var(--mg-accent) 32%, transparent); }
	body.busy .mg-avatar { animation: mgavatar 1.2s ease-in-out infinite; }
	@keyframes mgavatar { 0%,100% { transform: scale(1); } 50% { transform: scale(1.15); } }
	.plan-card { align-self: stretch; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--mg-accent); border-radius: 6px; padding: 7px 10px; margin: 4px 0; }
	.plan-card .plan-title { font-weight: 600; font-size: 0.85em; opacity: 0.8; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.03em; }
	.plan-step { display: flex; align-items: flex-start; gap: 7px; padding: 2px 0; font-size: 0.92em; }
	.plan-step .pi { flex: 0 0 auto; width: 14px; text-align: center; }
	.plan-step.done .pt { opacity: 0.6; text-decoration: line-through; }
	.plan-step.in_progress { font-weight: 600; }
	.plan-step.in_progress .pi { color: var(--mg-accent); }
	.run-block { align-self: stretch; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--mg-accent); border-radius: 6px; }
	.run-block .run-head { font-weight: 600; padding: 7px 9px; }
	.run-block .run-body { padding: 0 9px 7px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; opacity: 0.9; max-height: 320px; overflow: auto; }
	.run-line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
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
	.speak-btn { display: inline-block; margin-top: 4px; background: transparent; border: none; color: var(--vscode-foreground); opacity: 0.45; cursor: pointer; font-size: 12px; padding: 0 2px; }
	.speak-btn:hover { opacity: 1; }
	.reason summary { cursor: pointer; opacity: 0.8; }
	.reason-body { margin-top: 4px; padding: 6px 8px; border-left: 2px solid var(--vscode-panel-border); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); opacity: 0.8; max-height: 240px; overflow: auto; }
	#changes { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; margin: 0 8px 6px; padding: 7px 10px; border: 1px solid var(--mg-accent); border-radius: 10px; background: color-mix(in srgb, var(--mg-accent) 12%, transparent); font-size: 12px; }
	#changes-label { font-weight: 600; }
	#changes button { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-input-border, #5a5a5a); border-radius: 6px; padding: 3px 9px; font-size: 11.5px; cursor: pointer; }
	#changes button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.18)); }
	#changes #changes-revert { border-color: var(--mg-accent); color: var(--mg-accent); }
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
	.iconbtn.rec { color: var(--vscode-errorForeground); opacity: 1; animation: mgpulse 1s infinite; }
	.iconbtn.stt-busy { opacity: 0.5; }
	.iconbtn.on { color: var(--mg-accent); opacity: 1; background: color-mix(in srgb, var(--mg-accent) 18%, transparent); }
	.iconbtn.speaking { animation: mgpulse 1.4s infinite; }
	@keyframes mgpulse { 50% { opacity: 0.4; } }
	#ctxpie { flex: 0 0 auto; display: flex; align-items: center; margin-left: 2px; }
	#ctxpie svg { display: block; }
	.spacer { flex: 1 1 auto; }
	#model-dd { position: relative; flex: 0 1 auto; min-width: 0; max-width: 52%; }
	#model-btn { display: flex; align-items: center; gap: 4px; width: 100%; min-width: 0; background: transparent; color: var(--vscode-foreground); border: none; border-radius: 7px; padding: 4px 6px; font-size: 12px; opacity: 0.85; cursor: pointer; }
	#model-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.18)); opacity: 1; }
	#model-cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	#model-btn .caret { flex: 0 0 auto; opacity: 0.7; font-size: 10px; }
	#model-menu { position: absolute; bottom: calc(100% + 4px); right: 0; left: auto; min-width: 160px; max-width: calc(100vw - 24px); width: max-content; max-height: 260px; overflow-y: auto; overflow-x: hidden; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.35); padding: 4px; display: none; z-index: 20; box-sizing: border-box; }
	#model-menu.open { display: block; }
	.model-item { padding: 6px 9px; border-radius: 6px; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.model-item:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.18)); }
	.model-item.sel { background: color-mix(in srgb, var(--mg-accent) 22%, transparent); }
	.model-item .tool-badge { margin-left: 6px; opacity: 0.9; font-size: 11px; }
	.menu-sep { height: 1px; margin: 4px 2px; background: var(--vscode-dropdown-border, var(--vscode-panel-border)); opacity: 0.6; }
	.menu-toggle { padding: 6px 9px; border-radius: 6px; font-size: 11px; cursor: pointer; opacity: 0.9; white-space: normal; }
	.menu-toggle:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.18)); }
	.menu-toggle.top { position: sticky; top: 0; z-index: 1; background: var(--vscode-dropdown-background); border: 1px solid color-mix(in srgb, var(--mg-accent) 30%, transparent); }
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
	<div id="changes" style="display:none">
		<span id="changes-label"></span>
		<span class="spacer"></span>
		<button id="changes-view" title="Apri le diff delle modifiche">Vedi tutto</button>
		<button id="changes-revert" title="Ripristina i file allo stato precedente">Ripristina</button>
	</div>
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
			<button class="iconbtn" id="mic" title="Detta a voce (STT)">🎤</button>
			<button class="iconbtn" id="convo" title="Conversazione vocale a mani libere (parla e ascolta la risposta)">🎧</button>
			<span id="ctxpie" title="Contesto utilizzato"></span>
			<span class="spacer"></span>
			<div id="model-dd">
				<button id="model-btn" title="Modello / provider"><span id="model-cur">…</span><span class="caret">▾</span></button>
				<div id="model-menu"></div>
			</div>
			<button class="toggle" id="auto" title="Autopilot: esegue senza conferme"><span class="knob"></span><span>Autopilot</span></button>
		</div>
	</div>
<script nonce="${nonce}">
	var vscode = acquireVsCodeApi();
	var log = document.getElementById('log');
	var input = document.getElementById('input');
	var sendBtn = document.getElementById('send');
	var modelBtn = document.getElementById('model-btn');
	var modelMenu = document.getElementById('model-menu');
	var modelCur = document.getElementById('model-cur');
	var stopBtn = document.getElementById('stop');
	var sessionSel = document.getElementById('session');
	var newBtn = document.getElementById('newbtn');
	var modeVibe = document.getElementById('mode-vibe');
	var modeSpec = document.getElementById('mode-spec');
	var hashBtn = document.getElementById('hash');
	var attachBtn = document.getElementById('attach');
	var micBtn = document.getElementById('mic');
	var convoBtn = document.getElementById('convo');
	var mgRecording = false, mgCtx = null, mgSrc = null, mgProc = null, mgStream = null, mgPcm = [], mgRate = 16000;
	var mgHandsFree = false, mgSpeaking = false;
	function encodeWav(chunks, sampleRate) {
		var len = 0; for (var i = 0; i < chunks.length; i++) { len += chunks[i].length; }
		var data = new Float32Array(len); var off = 0;
		for (var j = 0; j < chunks.length; j++) { data.set(chunks[j], off); off += chunks[j].length; }
		var buf = new ArrayBuffer(44 + data.length * 2); var view = new DataView(buf);
		function ws(o, s) { for (var k = 0; k < s.length; k++) { view.setUint8(o + k, s.charCodeAt(k)); } }
		ws(0, 'RIFF'); view.setUint32(4, 36 + data.length * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
		view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
		view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true); view.setUint16(34, 16, true); ws(36, 'data'); view.setUint32(40, data.length * 2, true);
		var p = 44; for (var n = 0; n < data.length; n++) { var v = Math.max(-1, Math.min(1, data[n])); view.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7fff, true); p += 2; }
		return new Blob([view], { type: 'audio/wav' });
	}
	function teardownAudio() {
		try { if (mgProc) { mgProc.onaudioprocess = null; mgProc.disconnect(); } if (mgSrc) { mgSrc.disconnect(); } } catch (e) {}
		try { if (mgStream) { mgStream.getTracks().forEach(function (t) { t.stop(); }); } } catch (e) {}
		try { if (mgCtx) { mgCtx.close(); } } catch (e) {}
		mgCtx = null; mgSrc = null; mgProc = null; mgStream = null;
	}
	// Ferma la registrazione e invia l'audio a trascrivere.
	function stopRec() {
		if (!mgRecording) { return; }
		teardownAudio();
		mgRecording = false; micBtn.classList.remove('rec');
		var pcm = mgPcm; mgPcm = [];
		if (!pcm.length) { if (mgHandsFree) { restartListen(); } return; }
		var blob = encodeWav(pcm, mgRate);
		var r = new FileReader();
		r.onloadend = function () { var b64 = String(r.result).split(',')[1] || ''; if (b64) { vscode.postMessage({ type: 'transcribe', text: b64, mime: 'audio/wav' }); } };
		r.readAsDataURL(blob);
	}
	// Annulla la registrazione senza inviare (es. nessun parlato rilevato).
	function cancelRec() {
		if (!mgRecording) { return; }
		teardownAudio();
		mgRecording = false; micBtn.classList.remove('rec'); mgPcm = [];
	}
	// In hands-free: dopo un giro a vuoto, torna in ascolto se non è in corso altro.
	function restartListen() {
		setTimeout(function () {
			if (mgHandsFree && !mgRecording && !mgSpeaking && !document.body.classList.contains('busy')) { startRecording(); }
		}, 250);
	}
	async function startRecording() {
		if (mgRecording) { return; }
		try {
			mgStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			mgCtx = new (window.AudioContext || window.webkitAudioContext)();
			mgRate = mgCtx.sampleRate; mgPcm = [];
			mgSrc = mgCtx.createMediaStreamSource(mgStream);
			mgProc = mgCtx.createScriptProcessor(4096, 1, 1);
			var analyser = mgCtx.createAnalyser(); analyser.fftSize = 512;
			mgSrc.connect(analyser);
			var win = new Float32Array(analyser.fftSize);
			var speechStarted = false, silenceStart = 0, startedAt = Date.now();
			mgProc.onaudioprocess = function (e) {
				mgPcm.push(new Float32Array(e.inputBuffer.getChannelData(0)));
				if (!mgHandsFree) { return; }
				// Rilevamento attività vocale (VAD): stop automatico dopo una pausa.
				analyser.getFloatTimeDomainData(win);
				var sum = 0; for (var i = 0; i < win.length; i++) { sum += win[i] * win[i]; }
				var rms = Math.sqrt(sum / win.length), now = Date.now();
				if (rms > 0.018) { speechStarted = true; silenceStart = 0; }
				else if (speechStarted) {
					if (!silenceStart) { silenceStart = now; }
					else if (now - silenceStart > 1300) { stopRec(); return; }
				}
				if (!speechStarted && now - startedAt > 9000) { cancelRec(); restartListen(); return; }
				if (now - startedAt > 30000) { stopRec(); return; }
			};
			mgSrc.connect(mgProc); mgProc.connect(mgCtx.destination);
			mgRecording = true; micBtn.classList.add('rec');
		} catch (e) {
			mgHandsFree = false; convoBtn.classList.remove('on');
			vscode.postMessage({ type: 'sttError', text: (e && e.message) ? e.message : String(e) });
		}
	}
	micBtn.addEventListener('click', function () {
		if (mgRecording) { stopRec(); } else { startRecording(); }
	});
	convoBtn.addEventListener('click', function () {
		mgHandsFree = !mgHandsFree;
		convoBtn.classList.toggle('on', mgHandsFree);
		if (mgHandsFree) { startRecording(); }
		else { try { if (window.speechSynthesis) { window.speechSynthesis.cancel(); } } catch (e) {} mgSpeaking = false; convoBtn.classList.remove('speaking'); cancelRec(); }
	});
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
	var runBlock = null;
	var currentMode = 'vibe';
	var BT = String.fromCharCode(96);
	var fenceRe = new RegExp(BT + BT + BT + '(\\\\w*)\\\\n?([\\\\s\\\\S]*?)' + BT + BT + BT, 'g');
	var inlineRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');

	// Ripulisce il markdown per una lettura vocale naturale.
	var symRe = new RegExp('[*_#>' + BT + ']', 'g');
	function ttsClean(t) {
		return String(t)
			.replace(fenceRe, ' . ')
			.replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1')
			.replace(inlineRe, '$1')
			.replace(symRe, '')
			.replace(/\\s+/g, ' ')
			.trim();
	}
	// Voci disponibili per la sintesi vocale (caricate in modo asincrono dal browser).
	var mgVoices = [];
	var mgVoiceLang = 'it-IT';
	var mgVoiceWarned = false;
	function loadVoices() { try { mgVoices = window.speechSynthesis.getVoices() || []; } catch (e) {} }
	try { loadVoices(); if (window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = loadVoices; } } catch (e) {}
	// Rileva in modo euristico se il testo è italiano o inglese, con forte preferenza
	// per l'italiano (i documenti spec contengono molte parole inglesi EARS come
	// "WHEN / THE SYSTEM SHALL / IF / THEN" che non devono far scattare l'inglese).
	function detectLang(t) {
		var s = ' ' + String(t).toLowerCase() + ' ';
		var it = (s.match(/[àèéìòù]| (il|lo|la|le|gli|di|che|con|per|non|una|uno|sono|questo|come|anche|perché|cosa|fare|puoi|ciao|grazie|qui|del|della|dei|nel|alla|voglio|così|utente|nuova) /g) || []).length;
		var en = (s.match(/ (and|are|you|for|with|have|will|your|here|please|thanks|file|code|the|this|that) /g) || []).length;
		return en > it * 1.6 ? 'en' : 'it';
	}
	// Sceglie la lingua secondo l'impostazione (auto/it-IT/en-US).
	function chosenLang(text) {
		if (mgVoiceLang === 'it-IT') { return 'it'; }
		if (mgVoiceLang === 'en-US') { return 'en'; }
		return detectLang(text);
	}
	// Sceglie una voce installata che corrisponda alla lingua rilevata.
	function pickVoice(lang) {
		if (!mgVoices.length) { loadVoices(); }
		for (var i = 0; i < mgVoices.length; i++) { if ((mgVoices[i].lang || '').toLowerCase().indexOf(lang) === 0) { return mgVoices[i]; } }
		return null;
	}
	function speak(text, onDone) {
		try {
			var s = window.speechSynthesis;
			var clean = ttsClean(text);
			if (!s || !clean) { if (onDone) { onDone(); } return; }
			s.cancel();
			var lang = chosenLang(clean);
			var v = pickVoice(lang);
			// Se manca una voce per la lingua richiesta, avvisa UNA volta (causa tipica del
			// "legge in inglese": nessuna voce italiana installata nel sistema).
			if (!v && lang === 'it' && !mgVoiceWarned) {
				mgVoiceWarned = true;
				addStatic('error', 'Nessuna voce italiana trovata nel sistema: la lettura userà la voce predefinita (inglese). Per leggere in italiano installa una voce IT da Impostazioni Windows → Ora e lingua → Voce → Aggiungi voci → Italiano (poi riavvia MGCoding).');
			}
			var u = new SpeechSynthesisUtterance(clean.slice(0, 4000));
			u.lang = v ? v.lang : (lang === 'en' ? 'en-US' : 'it-IT');
			if (v) { u.voice = v; }
			if (onDone) { u.onend = onDone; u.onerror = onDone; }
			s.speak(u);
		} catch (e) { if (onDone) { onDone(); } }
	}
	// Hands-free: legge la risposta e, al termine, torna in ascolto.
	function speakThenListen(text) {
		mgSpeaking = true; convoBtn.classList.add('speaking');
		speak(text, function () {
			mgSpeaking = false; convoBtn.classList.remove('speaking');
			if (mgHandsFree && !mgRecording && !document.body.classList.contains('busy')) { startRecording(); }
		});
	}
	function addSpeakBtn(msgEl, getText) {
		var b = document.createElement('button'); b.className = 'speak-btn'; b.title = 'Leggi ad alta voce'; b.textContent = '\\uD83D\\uDD0A';
		b.addEventListener('click', function () { speak(getText()); });
		msgEl.appendChild(b);
	}
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
		addSpeakBtn(el, function () { return ans.textContent; });
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
		if (cls === 'assistant') { var a = document.createElement('div'); a.className = 'answer'; a.innerHTML = mdToHtml(text); el.appendChild(a); attachCodeTools(a); addSpeakBtn(el, function () { return a.textContent; }); }
		else { el.textContent = text; }
		log.appendChild(el); log.scrollTop = log.scrollHeight;
		return el;
	}
	function mgAvatarSvg() {
		return '<svg viewBox="0 0 24 24">' +
			'<circle cx="12" cy="12" r="10" fill="none" stroke="var(--mg-accent)" stroke-width="2"/>' +
			'<circle cx="9" cy="11" r="1.5" fill="var(--mg-accent)"/>' +
			'<circle cx="15" cy="11" r="1.5" fill="var(--mg-accent)"/>' +
			'<path d="M8.5 14.5 Q12 17 15.5 14.5" fill="none" stroke="var(--mg-accent)" stroke-width="1.6" stroke-linecap="round"/>' +
			'</svg>';
	}
	// Intestazione di turno stile Kiro: avatar animato + nome + chip degli steering inclusi.
	function renderSteeringChips(names) {
		ensureCleared();
		var card = document.createElement('div'); card.className = 'steering-card';
		var head = document.createElement('div'); head.className = 'steering-head';
		var av = document.createElement('span'); av.className = 'mg-avatar'; av.innerHTML = mgAvatarSvg();
		var lbl = document.createElement('span'); lbl.className = 'steering-title';
		lbl.textContent = names && names.length ? 'MGCoding · includo gli Steering' : 'MGCoding';
		head.appendChild(av); head.appendChild(lbl); card.appendChild(head);
		if (names && names.length) {
			var chips = document.createElement('div'); chips.className = 'steering-chips';
			for (var i = 0; i < names.length; i++) {
				var c = document.createElement('span'); c.className = 'steering-chip'; c.textContent = '\\uD83D\\uDCC4 ' + names[i] + '.md';
				chips.appendChild(c);
			}
			card.appendChild(chips);
		}
		log.appendChild(card); log.scrollTop = log.scrollHeight;
	}
	var planCard = null;
	// Piano di lavoro a step (tool update_plan): card che si aggiorna sul posto.
	function renderPlan(steps) {
		ensureCleared();
		if (!planCard || !planCard.isConnected) {
			planCard = document.createElement('div'); planCard.className = 'plan-card';
			var t = document.createElement('div'); t.className = 'plan-title'; t.textContent = '\\uD83D\\uDCCB Piano';
			planCard.appendChild(t);
			var body = document.createElement('div'); body.className = 'plan-body'; planCard.appendChild(body);
			planCard._body = body;
			log.appendChild(planCard);
		}
		var body = planCard._body; body.innerHTML = '';
		for (var i = 0; i < (steps || []).length; i++) {
			var s = steps[i]; var st = s.status || 'pending';
			var row = document.createElement('div'); row.className = 'plan-step ' + st;
			var ic = document.createElement('span'); ic.className = 'pi';
			ic.textContent = st === 'done' ? '\\u2713' : st === 'in_progress' ? '\\u25D0' : '\\u25CB';
			var tx = document.createElement('span'); tx.className = 'pt'; tx.textContent = s.text;
			row.appendChild(ic); row.appendChild(tx); body.appendChild(row);
		}
		log.scrollTop = log.scrollHeight;
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
	modelBtn.addEventListener('click', function (e) { e.stopPropagation(); modelMenu.classList.toggle('open'); if (modelMenu.classList.contains('open')) { vscode.postMessage({ type: 'refreshState' }); } });
	document.addEventListener('click', function () { modelMenu.classList.remove('open'); });
	modelMenu.addEventListener('click', function (e) { e.stopPropagation(); });
	function renderModelMenu(options, current, nativeTools) {
		modelMenu.innerHTML = '';
		var hasOllama = false, curOpt = null;
		for (var k = 0; k < options.length; k++) {
			if (options[k].id.indexOf('ollama:') === 0) { hasOllama = true; }
			if (options[k].id === current) { curOpt = options[k]; }
		}
		// Toggle tool nativi Ollama IN CIMA (sticky), così è subito visibile.
		if (hasOllama) {
			var row = document.createElement('div'); row.className = 'menu-toggle top';
			var curIsOllama = curOpt && curOpt.id.indexOf('ollama:') === 0;
			var hint = curIsOllama ? (curOpt.tools ? ' \\u2014 il modello attuale li supporta \\uD83D\\uDD27' : ' \\u2014 non dichiarati da questo modello') : '';
			row.innerHTML = '\\uD83D\\uDD27 Tool nativi Ollama: <b>' + (nativeTools ? 'ON' : 'OFF') + '</b>' + hint;
			row.title = 'Usa il function-calling nativo di Ollama. Attivalo con i modelli che hanno il badge 🔧; con gli altri lascialo OFF (protocollo testuale, più affidabile).';
			row.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'toggleNativeTools' }); });
			modelMenu.appendChild(row);
			var sep = document.createElement('div'); sep.className = 'menu-sep'; modelMenu.appendChild(sep);
		}
		for (var i = 0; i < options.length; i++) {
			(function (o) {
				var it = document.createElement('div');
				it.className = 'model-item' + (o.id === current ? ' sel' : '');
				it.textContent = o.label;
				if (o.tools) {
					var badge = document.createElement('span');
					badge.className = 'tool-badge'; badge.textContent = '\\uD83D\\uDD27';
					badge.title = 'Questo modello supporta il tool-use nativo';
					it.appendChild(badge);
				}
				it.addEventListener('click', function () {
					modelMenu.classList.remove('open');
					vscode.postMessage({ type: 'setProvider', id: o.id });
				});
				modelMenu.appendChild(it);
				if (o.id === current) { modelCur.textContent = o.label; }
			})(options[i]);
		}
	}
	sessionSel.addEventListener('change', function () { vscode.postMessage({ type: 'switchSession', id: sessionSel.value }); });
	hashBtn.addEventListener('click', function () { vscode.postMessage({ type: 'pickContext' }); });
	attachBtn.addEventListener('click', function () { vscode.postMessage({ type: 'attachImage' }); });
	autoBtn.addEventListener('click', function () { vscode.postMessage({ type: 'toggleAutopilot' }); });
	var changesBar = document.getElementById('changes');
	var changesLabel = document.getElementById('changes-label');
	document.getElementById('changes-view').addEventListener('click', function () { vscode.postMessage({ type: 'viewChanges' }); });
	document.getElementById('changes-revert').addEventListener('click', function () { vscode.postMessage({ type: 'revertChanges' }); });
	function renderChanges(n) {
		if (n > 0) {
			changesLabel.textContent = '\\u2713 ' + n + (n === 1 ? ' file modificato' : ' file modificati');
			changesBar.style.display = 'flex';
		} else {
			changesBar.style.display = 'none';
		}
	}
	function specBtn(card, label, msg, primary) {
		var b = document.createElement('button'); b.textContent = label; if (primary) { b.className = 'primary'; }
		b.addEventListener('click', function () { vscode.postMessage({ type: msg }); card.remove(); });
		card.appendChild(b);
	}
	function renderSpecModeChoose() {
		ensureCleared();
		var card = document.createElement('div'); card.className = 'spec-actions';
		var lbl = document.createElement('span'); lbl.className = 'sa-label'; lbl.textContent = 'Come procedo con la spec?';
		card.appendChild(lbl);
		function mb(label, mode, primary) {
			var b = document.createElement('button'); b.textContent = label; if (primary) { b.className = 'primary'; }
			b.addEventListener('click', function () { vscode.postMessage({ type: 'specMode', specMode: mode }); card.remove(); });
			card.appendChild(b);
		}
		mb('🛠 Funzionalità (passo-passo)', 'step', true);
		mb('🐞 Bugfix', 'bugfix', false);
		mb('⚡ Quick Plan (veloce)', 'fast', false);
		mb('📄 Solo requirements', 'single:requirements', false);
		mb('📄 Solo design', 'single:design', false);
		mb('📄 Solo tasks', 'single:tasks', false);
		log.appendChild(card); log.scrollTop = log.scrollHeight;
	}
	function renderSpecOffer() {
		ensureCleared();
		var card = document.createElement('div'); card.className = 'spec-actions';
		var lbl = document.createElement('span'); lbl.className = 'sa-label'; lbl.textContent = 'Sembra un lavoro adatto a una Spec. Avviare una sessione Spec dedicata?';
		card.appendChild(lbl);
		function ob(label, choice, primary) {
			var b = document.createElement('button'); b.textContent = label; if (primary) { b.className = 'primary'; }
			b.addEventListener('click', function () { vscode.postMessage({ type: 'specOfferChoice', choice: choice }); card.remove(); });
			card.appendChild(b);
		}
		ob('Sì', 'yes', true); ob('No', 'no', false); ob('Annulla', 'cancel', false);
		log.appendChild(card); log.scrollTop = log.scrollHeight;
	}
	function renderSpecPrioritize(specs) {
		ensureCleared();
		var card = document.createElement('div'); card.className = 'spec-actions';
		var lbl = document.createElement('span'); lbl.className = 'sa-label'; lbl.style.width = '100%'; lbl.textContent = 'Quale spec creare per prima?';
		card.appendChild(lbl);
		(specs || []).forEach(function (s, i) {
			var b = document.createElement('button'); if (i === 0) { b.className = 'primary'; }
			b.textContent = (i === 0 ? '\\u2605 ' : '') + s.title + (i === 0 ? ' (consigliata)' : '');
			b.title = s.desc || '';
			b.addEventListener('click', function () { vscode.postMessage({ type: 'specPick', index: i }); card.remove(); });
			card.appendChild(b);
		});
		log.appendChild(card); log.scrollTop = log.scrollHeight;
	}
	function renderSpecActions(phase) {
		ensureCleared();
		var card = document.createElement('div'); card.className = 'spec-actions';
		var lbl = document.createElement('span'); lbl.className = 'sa-label';
		if (phase === 'done') {
			lbl.textContent = 'Spec pronta. Vuoi eseguire i task ora?';
			card.appendChild(lbl);
			specBtn(card, '\\u25B6 Esegui i task', 'specRunTasks', true);
		} else {
			lbl.textContent = phase === 'requirements' ? 'Approvi i requisiti?' : phase === 'design' ? 'Approvi il design?' : 'Approvi i task?';
			card.appendChild(lbl);
			specBtn(card, 'Approva e continua', 'specApprove', true);
			specBtn(card, 'Rigenera', 'specRegenerate', false);
		}
		log.appendChild(card); log.scrollTop = log.scrollHeight;
	}
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
			mgVoiceLang = m.state.voiceLang || 'it-IT';
			renderModelMenu(m.state.options, m.state.current, m.state.nativeTools);
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
		else if (m.type === 'streamEnd') { var _et = current ? current.raw : ''; current = null; if (mgHandsFree && _et) { speakThenListen(_et); } }
		else if (m.type === 'streamCancel') { if (current) { current.el.remove(); current = null; } }
		else if (m.type === 'assistant') { addStatic('assistant', m.text); if (mgHandsFree && m.text) { speakThenListen(m.text); } }
		else if (m.type === 'tool') { lastToolResult = addTool(m.name, m.args); }
		else if (m.type === 'toolResult') { if (lastToolResult) { lastToolResult.textContent = m.text; log.scrollTop = log.scrollHeight; } }
		else if (m.type === 'error') { addStatic('error', '⚠ ' + m.text); }
		else if (m.type === 'busy') { document.body.classList.toggle('busy', m.value); }
		else if (m.type === 'changes') { renderChanges(m.count || 0); }
		else if (m.type === 'sttResult') { if (m.text) { input.value = (input.value ? input.value + ' ' : '') + m.text; autoGrow(); input.focus(); if (m.autoSend || mgHandsFree) { send(); } } else if (mgHandsFree) { restartListen(); } }
		else if (m.type === 'sttBusy') { micBtn.classList.toggle('stt-busy', !!m.value); }
		else if (m.type === 'plan') { renderPlan(m.steps); }
		else if (m.type === 'steeringChips') { renderSteeringChips(m.names); planCard = null; }
		else if (m.type === 'specActions') { renderSpecActions(m.phase); }
		else if (m.type === 'specModeChoose') { renderSpecModeChoose(); }
		else if (m.type === 'specOffer') { renderSpecOffer(); }
		else if (m.type === 'specPrioritize') { renderSpecPrioritize(m.specs); }
		else if (m.type === 'run') {
			if (m.phase === 'start') {
				ensureCleared();
				runBlock = document.createElement('div'); runBlock.className = 'msg run-block';
				var rh = document.createElement('div'); rh.className = 'run-head'; rh.textContent = '\\u25B6 ' + m.text;
				var rb = document.createElement('div'); rb.className = 'run-body';
				runBlock.appendChild(rh); runBlock.appendChild(rb); runBlock._body = rb;
				log.appendChild(runBlock); log.scrollTop = log.scrollHeight;
			} else if (m.phase === 'append' && runBlock) {
				var rl = document.createElement('div'); rl.className = 'run-line'; rl.textContent = m.text;
				runBlock._body.appendChild(rl); log.scrollTop = log.scrollHeight;
			} else if (m.phase === 'end') {
				runBlock = null;
			}
		}
	});

	showWelcome();
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
