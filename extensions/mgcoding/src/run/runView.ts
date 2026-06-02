/*---------------------------------------------------------------------------------------------
 *  MGCoding - vista "Esecuzione": stato dei task in tempo reale + toggle Autopilot
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

/** Interfaccia usata da chi esegue task (specs, agent) per riportare lo stato. */
export interface RunReporter {
	start(title: string, steps: string[]): void;
	setStatus(index: number, status: StepStatus): void;
	log(line: string): void;
	finish(message?: string): void;
}

interface Step {
	text: string;
	status: StepStatus;
}

export class RunViewProvider implements vscode.WebviewViewProvider, RunReporter, vscode.Disposable {
	static readonly viewType = 'mgcoding.run';

	private view?: vscode.WebviewView;
	private title = '';
	private steps: Step[] = [];
	private logs: string[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('mgcoding.autoApprove')) {
				this.render();
			}
		}));
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage(async (msg: { type: string }) => {
			if (msg.type === 'ready') {
				this.render();
			} else if (msg.type === 'toggleAutopilot') {
				const cfg = vscode.workspace.getConfiguration('mgcoding');
				await cfg.update('autoApprove', !cfg.get<boolean>('autoApprove', false), vscode.ConfigurationTarget.Global);
			}
		});
	}

	private autopilot(): boolean {
		return vscode.workspace.getConfiguration('mgcoding').get<boolean>('autoApprove', false);
	}

	private render(): void {
		this.view?.webview.postMessage({
			type: 'render',
			title: this.title,
			steps: this.steps,
			logs: this.logs.slice(-60),
			autopilot: this.autopilot()
		});
	}

	private reveal(): void {
		void vscode.commands.executeCommand('mgcoding.run.focus');
	}

	// --- RunReporter ---
	start(title: string, steps: string[]): void {
		this.title = title;
		this.steps = steps.map(text => ({ text, status: 'pending' as StepStatus }));
		this.logs = [];
		this.reveal();
		this.render();
	}

	setStatus(index: number, status: StepStatus): void {
		if (this.steps[index]) {
			this.steps[index].status = status;
			this.render();
		}
	}

	log(line: string): void {
		this.logs.push(line);
		this.render();
	}

	finish(message?: string): void {
		if (message) {
			this.logs.push(message);
		}
		this.render();
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
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 8px; font-size: 13px; }
	#head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
	#title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	#auto { flex: 0 0 auto; border: none; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
	.auto-on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.auto-off { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	ul { list-style: none; margin: 0; padding: 0; }
	li { padding: 4px 2px; display: flex; gap: 8px; align-items: flex-start; }
	.badge { flex: 0 0 auto; width: 16px; text-align: center; }
	.running { color: var(--vscode-charts-yellow, #d7ba7d); }
	.done { color: var(--vscode-charts-green, #2ea043); }
	.error { color: var(--vscode-errorForeground); }
	.pending { opacity: 0.6; }
	.txt { white-space: pre-wrap; word-break: break-word; }
	.done .txt { text-decoration: line-through; opacity: 0.8; }
	#empty { opacity: 0.6; padding: 12px 2px; }
	#log { margin-top: 10px; border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.85; max-height: 220px; overflow: auto; white-space: pre-wrap; }
</style>
</head>
<body>
	<div id="head">
		<span id="title">Esecuzione</span>
		<button id="auto" class="auto-off">Autopilot: OFF</button>
	</div>
	<div id="empty">Nessuna esecuzione in corso. Avvia "Esegui tutti i task" da una Spec o un task dell'agente.</div>
	<ul id="steps"></ul>
	<div id="log"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const auto = document.getElementById('auto');
	const titleEl = document.getElementById('title');
	const stepsEl = document.getElementById('steps');
	const emptyEl = document.getElementById('empty');
	const logEl = document.getElementById('log');
	const ICON = { pending: '○', running: '◐', done: '✓', error: '✗' };

	auto.addEventListener('click', () => vscode.postMessage({ type: 'toggleAutopilot' }));

	window.addEventListener('message', e => {
		const m = e.data;
		if (m.type !== 'render') { return; }
		auto.textContent = 'Autopilot: ' + (m.autopilot ? 'ON' : 'OFF');
		auto.className = m.autopilot ? 'auto-on' : 'auto-off';
		titleEl.textContent = m.title || 'Esecuzione';
		emptyEl.style.display = (m.steps && m.steps.length) ? 'none' : 'block';
		stepsEl.innerHTML = '';
		(m.steps || []).forEach(s => {
			const li = document.createElement('li');
			li.className = s.status;
			const b = document.createElement('span');
			b.className = 'badge ' + s.status;
			b.textContent = ICON[s.status] || '○';
			const t = document.createElement('span');
			t.className = 'txt';
			t.textContent = s.text;
			li.appendChild(b); li.appendChild(t);
			stepsEl.appendChild(li);
		});
		logEl.textContent = (m.logs || []).join('\\n');
		logEl.scrollTop = logEl.scrollHeight;
	});
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
