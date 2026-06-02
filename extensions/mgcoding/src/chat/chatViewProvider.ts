/*---------------------------------------------------------------------------------------------
 *  MGCoding - vista chat (webview): agente con tool + selettore provider/modello
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
		private readonly registry: ProviderRegistry
	) {
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
			}
		});
	}

	private async buildState(): Promise<ChatState> {
		const c = vscode.workspace.getConfiguration('mgcoding');
		const claudeModel = c.get<string>('claude.model', 'claude-opus-4-8');
		const ollamaModel = c.get<string>('ollama.model', 'qwen2.5-coder:14b');
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

		return {
			current: provider === 'claude' ? 'claude' : `ollama:${ollamaModel}`,
			options
		};
	}

	private async sendState(): Promise<void> {
		this.post({ type: 'state', state: await this.buildState() });
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	private async handleSend(text: string): Promise<void> {
		this.history.push({ role: 'user', content: text });
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
	.msg { padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; max-width: 100%; box-sizing: border-box; }
	.user { background: var(--vscode-input-background); align-self: flex-end; max-width: 92%; }
	.assistant { background: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 100%; }
	.tool { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-focusBorder); font-family: var(--vscode-editor-font-family); font-size: 0.85em; align-self: stretch; }
	.tool .head { font-weight: 600; margin-bottom: 2px; }
	.tool .result { opacity: 0.85; max-height: 180px; overflow: auto; }
	.error { color: var(--vscode-errorForeground); }
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
			<button id="stop" title="Interrompi">⊘ Stop</button>
			<button id="send">Invia</button>
		</div>
	</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const log = document.getElementById('log');
	const input = document.getElementById('input');
	const sendBtn = document.getElementById('send');
	const model = document.getElementById('model');
	const stopBtn = document.getElementById('stop');
	let emptied = false;
	let current = null;

	function clearEmpty() { if (!emptied) { log.innerHTML = ''; emptied = true; } }
	function add(cls, text) {
		clearEmpty();
		const el = document.createElement('div');
		el.className = 'msg ' + cls;
		el.textContent = text;
		log.appendChild(el);
		log.scrollTop = log.scrollHeight;
		return el;
	}
	function addTool(name, args) {
		clearEmpty();
		const el = document.createElement('div');
		el.className = 'msg tool';
		const head = document.createElement('div');
		head.className = 'head';
		head.textContent = '🔧 ' + name + ' ' + (args && args.length < 120 ? args : '');
		el.appendChild(head);
		const res = document.createElement('div');
		res.className = 'result';
		el.appendChild(res);
		log.appendChild(el);
		log.scrollTop = log.scrollHeight;
		return res;
	}
	let lastToolResult = null;

	function send() {
		const text = input.value.trim();
		if (!text) { return; }
		add('user', text);
		input.value = '';
		vscode.postMessage({ type: 'send', text });
	}
	sendBtn.addEventListener('click', send);
	stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
	input.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
	});
	model.addEventListener('change', () => vscode.postMessage({ type: 'setProvider', id: model.value }));

	window.addEventListener('message', event => {
		const m = event.data;
		if (m.type === 'state') {
			model.innerHTML = '';
			for (const o of m.state.options) {
				const opt = document.createElement('option');
				opt.value = o.id; opt.textContent = o.label;
				if (o.id === m.state.current) { opt.selected = true; }
				model.appendChild(opt);
			}
		}
		else if (m.type === 'streamStart') { current = add('assistant', ''); }
		else if (m.type === 'streamDelta') { if (current) { current.textContent += m.text; log.scrollTop = log.scrollHeight; } }
		else if (m.type === 'streamEnd') { current = null; }
		else if (m.type === 'streamCancel') { if (current) { current.remove(); current = null; } }
		else if (m.type === 'assistant') { add('assistant', m.text); }
		else if (m.type === 'tool') { lastToolResult = addTool(m.name, m.args); }
		else if (m.type === 'toolResult') { if (lastToolResult) { lastToolResult.textContent = m.text; log.scrollTop = log.scrollHeight; } }
		else if (m.type === 'error') { add('error', '⚠ ' + m.text); }
		else if (m.type === 'busy') { document.body.classList.toggle('busy', m.value); }
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
