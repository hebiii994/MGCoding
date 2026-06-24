/*---------------------------------------------------------------------------------------------
 *  MGCoding - Canvas ComfyUI al centro: apre l'editor a nodi di ComfyUI (già in esecuzione)
 *  dentro un pannello editor di MGCoding via iframe. Riusa il frontend open-source di ComfyUI
 *  invece di reimplementare un editor a nodi.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | undefined;

/** Apre (o rivela) il canvas ComfyUI in un pannello editor centrale. */
export function openComfyCanvas(): void {
	const endpoint = vscode.workspace.getConfiguration('mgcoding').get<string>('image.comfyEndpoint', 'http://127.0.0.1:8188').replace(/\/$/, '');
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
		return;
	}
	panel = vscode.window.createWebviewPanel('mgcoding.comfyCanvas', 'ComfyUI', vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true
	});
	const nonce = String(Date.now());
	panel.webview.html = `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${endpoint} http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	html, body { height: 100%; margin: 0; padding: 0; }
	#bar { height: 30px; display: flex; align-items: center; gap: 10px; padding: 0 10px; font: 12px var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); }
	#bar .sp { flex: 1; opacity: .7; }
	#bar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 5px; padding: 3px 9px; cursor: pointer; font-size: 11.5px; }
	iframe { width: 100%; height: calc(100% - 31px); border: 0; background: #1e1e1e; }
	#err { display: none; padding: 16px; font: 13px var(--vscode-font-family); color: var(--vscode-foreground); }
</style></head>
<body>
	<div id="bar"><span>🧩 ComfyUI</span><span class="sp">${endpoint}</span><button id="reload">⟳ Ricarica</button><button id="ext">↗ Apri nel browser</button></div>
	<iframe id="f" src="${endpoint}"></iframe>
	<div id="err">Se il canvas non compare, assicurati che ComfyUI sia avviato su <b>${endpoint}</b>, poi premi ⟳ Ricarica. In alternativa "↗ Apri nel browser".</div>
	<script nonce="${nonce}">
		var v = acquireVsCodeApi();
		var f = document.getElementById('f');
		document.getElementById('reload').addEventListener('click', function () { f.src = f.src; });
		document.getElementById('ext').addEventListener('click', function () { v.postMessage({ type: 'ext' }); });
		// Se l'iframe non carica entro qualche secondo, mostra il suggerimento.
		setTimeout(function () { try { if (!f.contentWindow || !f.contentWindow.length) { document.getElementById('err').style.display = 'block'; } } catch (e) { document.getElementById('err').style.display = 'block'; } }, 4000);
	</script>
</body></html>`;
	panel.webview.onDidReceiveMessage(m => {
		if (m?.type === 'ext') {
			void vscode.env.openExternal(vscode.Uri.parse(endpoint));
		}
	});
	panel.onDidDispose(() => { panel = undefined; });
}
