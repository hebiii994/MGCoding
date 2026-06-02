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
				this.post({ type: 'state', state: this.buildState() });
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
					this.post({ type: 'state', state: this.buildState() });
					break;
				case 'send':
					if (msg.text) {
						await this.handleSend(msg.text);
					}
					break;
				case 'setProvider':
					if (msg.id) {
						await vscode.workspace.getConfiguration('mgcoding')
							.update('provider', msg.id, vscode.ConfigurationTarget.Global);
						this.post({ type: 'state', state: this.buildState() });
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

	private buildState(): ChatState {
		const c = vscode.workspace.getConfiguration('mgcoding');
		const claudeModel = c.get<string>('claude.model', 'claude-opus-4-8');
		const ollamaModel = c.get<string>('ollama.model', 'qwen2.5-coder:14b');
		return {
			current: c.get<string>('provider', 'ollama'),
			options: [
				{ id: 'claude', label: `Claude (API) · ${claudeModel}` },
				{ id: 'ollama', label: `Ollama (locale) · ${ollamaModel}` }
			]
		};
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
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
	#log { flex: 1; overflow-y: auto; padding: 8px; }
	.msg { padding: 6px 8px; margin: 4px 0; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; }
	.user { background: var(--vscode-input-background); }
	.assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
	.tool { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-focusBorder); font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
	.tool .head { font-weight: 600; }
	.tool .result { opacity: 0.8; margin-top: 4px; max-height: 160px; overflow: auto; }
	.error { color: var(--vscode-errorForeground); }
	.empty { opacity: 0.6; padding: 12px 8px; }
	#bottom { border-top: 1px solid var(--vscode-panel-border); padding: 8px; }
	#input { width: 100%; box-sizing: border-box; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px; font-family: inherit; }
	#row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
	#model { flex: 1; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; }
	#spinner { display: none; opacity: 0.7; padding: 4px 8px; font-style: italic; }
	#spinner.on { display: block; }
</style>
</head>
<body>
	<div id="log"><div class="empty">Chiedi qualcosa o descrivi un task… L'agente può leggere/scrivere file ed eseguire comandi.</div></div>
	<div id="spinner">L'agente sta lavorando…</div>
	<div id="bottom">
		<textarea id="input" rows="3" placeholder="Scrivi un messaggio… (Invio per inviare, Shift+Invio per andare a capo)"></textarea>
		<div id="row">
			<select id="model" title="Modello / provider"></select>
			<button id="send">Invia</button>
		</div>
	</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const log = document.getElementById('log');
	const input = document.getElementById('input');
	const sendBtn = document.getElementById('send');
	const model = document.getElementById('model');
	const spinner = document.getElementById('spinner');
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
		else if (m.type === 'busy') { spinner.classList.toggle('on', m.value); }
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
