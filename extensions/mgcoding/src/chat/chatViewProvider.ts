/*---------------------------------------------------------------------------------------------
 *  MGCoding - vista chat (webview): agente con tool, Markdown, reasoning, selettore modello
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgent } from '../agent/agentLoop';
import { ProviderRegistry } from '../llm/registry';
import { ChatMessage } from '../llm/types';

interface ProviderOption {
	id: string;
	label: string;
}

interface ChatState {
	current: string;
	options: ProviderOption[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'mgcoding.chat';

	private view?: vscode.WebviewView;
	private history: ChatMessage[] = [];
	private abort?: AbortController;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly registry: ProviderRegistry,
		private readonly memento: vscode.Memento
	) {
		this.history = this.memento.get<ChatMessage[]>('mgcoding.chatHistory', []);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('mgcoding')) {
				void this.sendState();
			}
		}));
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = this.getHtml();

		webviewView.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; id?: string }) => {
			switch (msg.type) {
				case 'ready':
					await this.sendState();
					if (this.history.length) {
						this.post({ type: 'restore', messages: this.history });
					}
					break;
				case 'newChat':
					this.history = [];
					await this.memento.update('mgcoding.chatHistory', []);
					this.post({ type: 'cleared' });
					break;
				case 'send':
					if (msg.text) {
						await this.handleSend(msg.text);
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
						await this.sendState();
					}
					break;
				case 'stop':
					this.abort?.abort();
					break;
				case 'clear':
					this.history = [];
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

	private async buildState(): Promise<ChatState> {
		const c = vscode.workspace.getConfiguration('mgcoding');
		const claudeModel = c.get<string>('claude.model', 'claude-opus-4-8');
		const ollamaModel = c.get<string>('ollama.model', 'qwen2.5-coder:14b');
		const provider = c.get<string>('provider', 'ollama');

		const openaiModel = c.get<string>('openai.model', 'local-model');

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

		const current = provider === 'claude' ? 'claude'
			: provider === 'openai' ? `openai:${openaiModel}`
				: `ollama:${ollamaModel}`;
		return { current, options };
	}

	private async sendState(): Promise<void> {
		this.post({ type: 'state', state: await this.buildState() });
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	/** Risolve i riferimenti @percorso allegando il contenuto dei file citati. */
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

	private async handleSend(text: string): Promise<void> {
		this.history.push({ role: 'user', content: await this.augmentWithMentions(text) });
		this.post({ type: 'busy', value: true });
		this.abort = new AbortController();
		try {
			await runAgent(this.registry, this.history, {
				onStreamStart: () => this.post({ type: 'streamStart' }),
				onStreamDelta: t => this.post({ type: 'streamDelta', text: t }),
				onStreamEnd: () => this.post({ type: 'streamEnd' }),
				onStreamCancel: () => this.post({ type: 'streamCancel' }),
				onAssistantText: t => this.post({ type: 'assistant', text: t }),
				onToolStart: call => this.post({ type: 'tool', name: call.tool, args: JSON.stringify(call.args) }),
				onToolResult: r => this.post({ type: 'toolResult', text: r })
			}, this.abort.signal);
		} catch (err) {
			this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
		} finally {
			this.abort = undefined;
			this.post({ type: 'busy', value: false });
			await this.memento.update('mgcoding.chatHistory', this.history.slice(-100));
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	private getHtml(): string {
		const nonce = String(Math.random()).slice(2);
		const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
	html, body { height: 100%; }
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; }
	#log { flex: 1 1 auto; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
	.empty { margin: auto; text-align: center; opacity: 0.6; line-height: 1.7; padding: 16px; }
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
	#composer { flex: 0 0 auto; border-top: 1px solid var(--vscode-panel-border); padding: 8px; display: flex; flex-direction: column; gap: 6px; background: var(--vscode-sideBar-background); }
	#input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 40px; max-height: 200px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 8px; font-family: inherit; font-size: 13px; }
	#input:focus { outline: none; border-color: var(--vscode-focusBorder); }
	#row { display: flex; align-items: center; gap: 6px; }
	#model { flex: 1 1 auto; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 6px; padding: 4px 6px; font-size: 12px; }
	button { flex: 0 0 auto; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	#stop { display: none; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 6px 10px; }
	body.busy #stop { display: inline-block; }
	body.busy #send { opacity: 0.5; }
</style>
</head>
<body>
	<div id="log"><div class="empty">💬 Chiedi qualcosa o descrivi un task.<br/>L'agente può leggere e scrivere file ed eseguire comandi.</div></div>
	<div id="composer">
		<textarea id="input" rows="2" placeholder="Scrivi un messaggio…  (Invio = invia · Shift+Invio = a capo)"></textarea>
		<div id="row">
			<select id="model" title="Modello / provider"></select>
			<button id="newchat" title="Nuova conversazione">＋</button>
			<button id="stop" title="Interrompi">⊘ Stop</button>
			<button id="send">Invia</button>
		</div>
	</div>
<script nonce="${nonce}">
	var vscode = acquireVsCodeApi();
	var log = document.getElementById('log');
	var input = document.getElementById('input');
	var sendBtn = document.getElementById('send');
	var model = document.getElementById('model');
	var stopBtn = document.getElementById('stop');
	var newchatBtn = document.getElementById('newchat');
	var emptied = false;
	var current = null;        // bolla assistant in streaming
	var lastToolResult = null;
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
				var tools = document.createElement('div');
				tools.className = 'code-tools';
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

	function clearEmpty() { if (!emptied) { log.innerHTML = ''; emptied = true; } }

	function makeAssistant() {
		clearEmpty();
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
		if (parts.think) {
			obj.reason.style.display = 'block';
			obj.rbody.textContent = parts.think;
			obj.reason.open = parts.thinking;
		} else {
			obj.reason.style.display = 'none';
		}
		obj.ans.innerHTML = mdToHtml(parts.answer);
		attachCodeTools(obj.ans);
		log.scrollTop = log.scrollHeight;
	}

	function addStatic(cls, text) {
		clearEmpty();
		var el = document.createElement('div'); el.className = 'msg ' + cls;
		if (cls === 'assistant') { var a = document.createElement('div'); a.className = 'answer'; a.innerHTML = mdToHtml(text); el.appendChild(a); attachCodeTools(a); }
		else { el.textContent = text; }
		log.appendChild(el); log.scrollTop = log.scrollHeight;
		return el;
	}

	function addTool(name, args) {
		clearEmpty();
		var el = document.createElement('div'); el.className = 'msg tool';
		var head = document.createElement('div'); head.className = 'head';
		head.textContent = '🔧 ' + name + ' ' + (args && args.length < 120 ? args : '');
		el.appendChild(head);
		var res = document.createElement('div'); res.className = 'result';
		el.appendChild(res);
		log.appendChild(el); log.scrollTop = log.scrollHeight;
		return res;
	}

	function send() {
		var text = input.value.trim();
		if (!text) { return; }
		addStatic('user', text);
		input.value = '';
		vscode.postMessage({ type: 'send', text: text });
	}
	sendBtn.addEventListener('click', send);
	stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'stop' }); });
	newchatBtn.addEventListener('click', function () { vscode.postMessage({ type: 'newChat' }); });
	input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
	model.addEventListener('change', function () { vscode.postMessage({ type: 'setProvider', id: model.value }); });

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
		else if (m.type === 'restore') {
			for (var k = 0; k < m.messages.length; k++) {
				var msg = m.messages[k];
				addStatic(msg.role === 'assistant' ? 'assistant' : 'user', msg.content);
			}
		}
		else if (m.type === 'cleared') {
			log.innerHTML = '<div class="empty">💬 Nuova conversazione. Chiedi qualcosa o descrivi un task.</div>';
			emptied = false;
		}
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
