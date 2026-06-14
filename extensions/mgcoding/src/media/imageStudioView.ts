/*---------------------------------------------------------------------------------------------
 *  MGCoding - Image Studio: pannello visuale (webview) per la generazione immagini.
 *  Stato ComfyUI, scelta backend/checkpoint/workflow con valori consigliati, azioni rapide
 *  (le stesse dei comandi MGCoding) e galleria delle immagini generate in .mg/generated/.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { listCheckpoints, listWorkflows } from './comfyHelper';

export class ImageStudioProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'mgcoding.imageStudio';
	private view?: vscode.WebviewView;

	constructor(private readonly extensionUri: vscode.Uri) {
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('mgcoding.image')) {
				void this.sendState();
			}
		});
	}

	/** Forza un refresh del pannello (chiamabile da fuori, es. dopo una generazione). */
	refresh(): void {
		void this.sendState();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const roots = [this.extensionUri, ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [])];
		view.webview.options = { enableScripts: true, localResourceRoots: roots };
		view.webview.html = this.html();
		view.onDidChangeVisibility(() => { if (view.visible) { void this.sendState(); } });
		view.webview.onDidReceiveMessage(async (msg: { type: string;[k: string]: unknown }) => {
			switch (msg.type) {
				case 'ready':
				case 'refresh':
					await this.sendState();
					break;
				case 'cmd':
					await vscode.commands.executeCommand(String(msg.command));
					setTimeout(() => void this.sendState(), 600);
					break;
				case 'setConfig':
					await vscode.workspace.getConfiguration('mgcoding').update(String(msg.key), msg.value, vscode.ConfigurationTarget.Global);
					break;
				case 'openImage':
					if (msg.path) {
						await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(String(msg.path)));
					}
					break;
			}
		});
		void this.sendState();
	}

	private async galleryUris(): Promise<{ src: string; path: string }[]> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder || !this.view) {
			return [];
		}
		const dir = vscode.Uri.joinPath(folder.uri, '.mg', 'generated');
		try {
			const entries = await vscode.workspace.fs.readDirectory(dir);
			const imgs = entries
				.filter(([n, t]) => t === vscode.FileType.File && /\.(png|jpe?g|webp)$/i.test(n))
				.map(([n]) => n)
				.sort()
				.reverse()
				.slice(0, 40);
			return imgs.map(n => {
				const uri = vscode.Uri.joinPath(dir, n);
				return { src: this.view!.webview.asWebviewUri(uri).toString(), path: uri.fsPath };
			});
		} catch {
			return [];
		}
	}

	private async sendState(): Promise<void> {
		if (!this.view) {
			return;
		}
		const cfg = vscode.workspace.getConfiguration('mgcoding');
		const endpoint = cfg.get<string>('image.comfyEndpoint', 'http://127.0.0.1:8188');
		const [checkpoints, workflows, gallery] = await Promise.all([listCheckpoints(endpoint), listWorkflows(), this.galleryUris()]);
		this.view.webview.postMessage({
			type: 'state',
			connected: checkpoints.length > 0,
			endpoint,
			backend: cfg.get<string>('image.backend', 'auto'),
			checkpoints,
			checkpoint: cfg.get<string>('image.checkpoint', ''),
			workflows,
			workflow: cfg.get<string>('image.workflow', ''),
			enhancePrompt: cfg.get<boolean>('image.enhancePrompt', true),
			enhanceModel: cfg.get<string>('image.enhanceModel', ''),
			aspect: cfg.get<string>('image.aspect', 'auto'),
			denoise: cfg.get<number>('image.denoise', 0.6),
			comfyRoot: cfg.get<string>('image.comfyRoot', ''),
			gallery
		});
	}

	private html(): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view?.webview.cspSource ?? ''} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px; }
	h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; opacity: .7; margin: 14px 0 6px; }
	.status { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; background: var(--vscode-editorWidget-background); }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
	.dot.on { background: #3fb950; } .dot.off { background: #d29922; }
	.row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
	.row label { flex: 0 0 90px; opacity: .85; }
	select, input[type=text] { flex: 1; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px 6px; }
	input[type=range] { flex: 1; }
	.hint { opacity: .6; font-size: 10.5px; margin: 2px 0 0 90px; }
	.actions { display: flex; flex-wrap: wrap; gap: 6px; }
	button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 6px; padding: 5px 9px; cursor: pointer; font-size: 11.5px; }
	button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 6px; }
	.gallery img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; cursor: zoom-in; border: 1px solid var(--vscode-panel-border); }
	.muted { opacity: .6; }
	.val { flex: 0 0 34px; text-align: right; font-variant-numeric: tabular-nums; }
</style></head><body>
	<div class="status"><span id="dot" class="dot"></span><span id="statusText">…</span></div>

	<h3>Backend & modello</h3>
	<div class="row"><label>Backend</label>
		<select id="backend">
			<option value="auto">Auto</option><option value="comfyui">ComfyUI</option>
			<option value="a1111">A1111/SD.Next</option><option value="gemini">Imagen (cloud)</option><option value="openai">OpenAI (cloud)</option>
		</select></div>
	<div class="row"><label>Checkpoint</label><select id="checkpoint"></select></div>
	<div class="hint" id="ckptHint">FLUX = ottimo su mani/anatomia. SDXL base = base, fine-tune (Juggernaut/RealVis) meglio.</div>
	<div class="row"><label>Workflow</label><select id="workflow"></select></div>

	<h3>Parametri</h3>
	<div class="row"><label>Aspetto</label>
		<select id="aspect">
			<option value="auto">Auto</option><option value="1:1">1:1 quadrato</option>
			<option value="2:3">2:3 verticale (full body)</option><option value="9:16">9:16 verticale alto</option>
			<option value="3:2">3:2 orizzontale</option><option value="16:9">16:9 panorama</option>
			<option value="3:4">3:4</option><option value="4:3">4:3</option>
		</select></div>
	<div class="hint">Per una persona a figura intera scegli 2:3 o 9:16 (verticale).</div>
	<div class="row"><label>Migliora prompt</label><input type="checkbox" id="enhance" /><span class="muted">amplifica e traduce</span></div>
	<div class="row"><label>Modello prompt</label><input type="text" id="enhanceModel" placeholder="(usa il modello di chat)" /></div>
	<div class="hint">Per i prompt puoi usare un modello creativo/uncensored separato.</div>
	<div class="row"><label>Forza img2img</label><input type="range" id="denoise" min="0" max="1" step="0.05" /><span class="val" id="denoiseVal"></span></div>
	<div class="hint">0.4 ritocco · 0.6 consigliato · 0.8 cambiamento forte (solo con immagine allegata).</div>

	<h3>Azioni rapide</h3>
	<div class="actions">
		<button data-cmd="mgcoding.pickComfyFolder">📁 Cartella ComfyUI</button>
		<button data-cmd="mgcoding.downloadImageModel" class="primary">⬇ Scarica modello</button>
		<button data-cmd="mgcoding.selectCheckpoint">🎯 Checkpoint</button>
		<button data-cmd="mgcoding.selectWorkflow">🎛 Workflow</button>
		<button data-cmd="mgcoding.importWorkflow">⬆ Importa workflow</button>
		<button data-cmd="mgcoding.installMissingNodes">🧩 Nodi mancanti</button>
		<button data-cmd="mgcoding.openChat">💬 Apri chat Img</button>
	</div>
	<div class="hint" id="rootHint"></div>

	<h3>Galleria <span class="muted" id="galCount"></span></h3>
	<div class="gallery" id="gallery"></div>
	<div class="muted" id="galEmpty" style="display:none">Nessuna immagine ancora. Genera dalla chat in modalità 🎨 Img.</div>

<script nonce="${nonce}">
	var vscode = acquireVsCodeApi();
	function $(id){ return document.getElementById(id); }
	function send(m){ vscode.postMessage(m); }
	$('backend').addEventListener('change', function(){ send({type:'setConfig', key:'image.backend', value:this.value}); });
	$('checkpoint').addEventListener('change', function(){ send({type:'setConfig', key:'image.checkpoint', value:this.value}); });
	$('workflow').addEventListener('change', function(){ send({type:'setConfig', key:'image.workflow', value:this.value}); });
	$('aspect').addEventListener('change', function(){ send({type:'setConfig', key:'image.aspect', value:this.value}); });
	$('enhance').addEventListener('change', function(){ send({type:'setConfig', key:'image.enhancePrompt', value:this.checked}); });
	$('enhanceModel').addEventListener('change', function(){ send({type:'setConfig', key:'image.enhanceModel', value:this.value}); });
	$('denoise').addEventListener('input', function(){ $('denoiseVal').textContent = (+this.value).toFixed(2); });
	$('denoise').addEventListener('change', function(){ send({type:'setConfig', key:'image.denoise', value:+this.value}); });
	var btns = document.querySelectorAll('button[data-cmd]');
	for (var i=0;i<btns.length;i++){ btns[i].addEventListener('click', function(){ send({type:'cmd', command:this.getAttribute('data-cmd')}); }); }
	function opt(v, label, sel){ var o=document.createElement('option'); o.value=v; o.textContent=label; if(v===sel)o.selected=true; return o; }
	window.addEventListener('message', function(e){
		var m = e.data; if (m.type!=='state') return;
		$('dot').className = 'dot ' + (m.connected ? 'on' : 'off');
		$('statusText').textContent = m.connected ? ('ComfyUI connesso · ' + m.checkpoints.length + ' checkpoint') : ('ComfyUI non rilevato su ' + m.endpoint);
		$('backend').value = m.backend;
		var cs = $('checkpoint'); cs.innerHTML=''; cs.appendChild(opt('', '(auto: primo disponibile)', m.checkpoint));
		for (var i=0;i<m.checkpoints.length;i++){ cs.appendChild(opt(m.checkpoints[i], m.checkpoints[i], m.checkpoint)); }
		var ws = $('workflow'); ws.innerHTML=''; ws.appendChild(opt('', '(predefinito txt2img)', m.workflow));
		for (var j=0;j<m.workflows.length;j++){ ws.appendChild(opt(m.workflows[j], m.workflows[j], m.workflow)); }
		$('aspect').value = m.aspect || 'auto';
		$('enhance').checked = !!m.enhancePrompt;
		$('enhanceModel').value = m.enhanceModel || '';
		$('denoise').value = m.denoise; $('denoiseVal').textContent = (+m.denoise).toFixed(2);
		$('rootHint').textContent = m.comfyRoot ? ('Cartella: ' + m.comfyRoot) : 'Cartella ComfyUI non impostata (usa 📁).';
		var g = $('gallery'); g.innerHTML='';
		for (var k=0;k<m.gallery.length;k++){ (function(it){ var im=document.createElement('img'); im.src=it.src; im.addEventListener('click', function(){ send({type:'openImage', path:it.path}); }); g.appendChild(im); })(m.gallery[k]); }
		$('galCount').textContent = m.gallery.length ? ('('+m.gallery.length+')') : '';
		$('galEmpty').style.display = m.gallery.length ? 'none' : 'block';
	});
	send({type:'ready'});
</script></body></html>`;
	}
}
