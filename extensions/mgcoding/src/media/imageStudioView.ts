/*---------------------------------------------------------------------------------------------
 *  MGCoding - Image Studio: pannello visuale (webview) per la generazione immagini.
 *  Stato ComfyUI, scelta backend/checkpoint/workflow/aspetto con valori consigliati, azioni
 *  rapide e galleria delle immagini generate (con anteprima, apertura ed eliminazione).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { listCheckpoints, listWorkflows, generatedDirUri } from './comfyHelper';

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

	refresh(): void {
		void this.sendState();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const roots = [this.extensionUri, generatedDirUri(), ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [])];
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
				case 'deleteImage':
					if (msg.path) {
						try {
							await vscode.workspace.fs.delete(vscode.Uri.file(String(msg.path)));
						} catch { /* già rimossa */ }
						await this.sendState();
					}
					break;
				case 'openFolder':
					await vscode.commands.executeCommand('revealFileInOS', generatedDirUri());
					break;
			}
		});
		void this.sendState();
	}

	private async galleryUris(): Promise<{ src: string; path: string }[]> {
		if (!this.view) {
			return [];
		}
		const dir = generatedDirUri();
		try {
			const entries = await vscode.workspace.fs.readDirectory(dir);
			const imgs = entries
				.filter(([n, t]) => t === vscode.FileType.File && /\.(png|jpe?g|webp)$/i.test(n))
				.map(([n]) => n)
				.sort()
				.reverse()
				.slice(0, 60);
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
			galleryFolder: generatedDirUri().fsPath,
			gallery
		});
	}

	private html(): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view?.webview.cspSource ?? ''} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	:root { --acc: var(--vscode-charts-green, #3fb950); --bd: var(--vscode-panel-border, #2a2a2a); --bg2: var(--vscode-editorWidget-background); }
	* { box-sizing: border-box; }
	body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 10px 10px 24px; }
	.card { background: var(--bg2); border: 1px solid var(--bd); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
	.status { display: flex; align-items: center; gap: 8px; font-weight: 600; }
	.dot { width: 9px; height: 9px; border-radius: 50%; background: #888; box-shadow: 0 0 0 3px color-mix(in srgb, #888 22%, transparent); }
	.dot.on { background: var(--acc); box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc) 22%, transparent); }
	.dot.off { background: #d29922; box-shadow: 0 0 0 3px color-mix(in srgb, #d29922 22%, transparent); }
	.sub { opacity: .65; font-weight: 400; font-size: 11px; margin-top: 3px; }
	h3 { font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; opacity: .6; margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
	h3 .ic { font-size: 13px; opacity: .9; }
	.row { display: flex; align-items: center; gap: 8px; margin: 7px 0; }
	.row label { flex: 0 0 86px; opacity: .85; }
	select, input[type=text] { flex: 1; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 6px; padding: 4px 7px; }
	select:focus, input:focus { outline: 1px solid var(--acc); }
	input[type=range] { flex: 1; accent-color: var(--acc); }
	.hint { opacity: .55; font-size: 10.5px; margin: 1px 0 2px 86px; line-height: 1.35; }
	.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
	button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 7px; padding: 7px 9px; cursor: pointer; font-size: 11.5px; text-align: left; transition: filter .12s; }
	button:hover { filter: brightness(1.15); }
	button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.gal-head { display: flex; align-items: center; justify-content: space-between; }
	.gal-tools { display: flex; gap: 6px; }
	.gal-tools button { padding: 3px 7px; font-size: 10.5px; }
	.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 7px; margin-top: 8px; }
	.thumb { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; border: 1px solid var(--bd); }
	.thumb img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
	.thumb .del { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; padding: 0; border-radius: 50%; background: rgba(0,0,0,.6); color: #fff; opacity: 0; text-align: center; line-height: 18px; font-size: 12px; }
	.thumb:hover .del { opacity: 1; }
	.muted { opacity: .55; }
	.val { flex: 0 0 36px; text-align: right; font-variant-numeric: tabular-nums; opacity: .85; }
	.path { font-size: 10px; opacity: .5; margin-top: 6px; word-break: break-all; }
</style></head><body>
	<div class="card">
		<div class="status"><span id="dot" class="dot"></span><span id="statusText">…</span></div>
		<div class="sub" id="statusSub"></div>
	</div>

	<div class="card">
		<h3><span class="ic">🧠</span> Backend & modello</h3>
		<div class="row"><label>Backend</label>
			<select id="backend">
				<option value="auto">Auto</option><option value="comfyui">ComfyUI</option>
				<option value="a1111">A1111/SD.Next</option><option value="gemini">Imagen (cloud)</option><option value="openai">OpenAI (cloud)</option>
			</select></div>
		<div class="row"><label>Checkpoint</label><select id="checkpoint"></select></div>
		<div class="hint">FLUX = ottimo su mani/anatomia. SDXL fine-tune (Juggernaut/RealVis) = miglior controllo coi negativi.</div>
		<div class="row"><label>Workflow</label><select id="workflow"></select></div>
	</div>

	<div class="card">
		<h3><span class="ic">🎚️</span> Parametri</h3>
		<div class="row"><label>Aspetto</label>
			<select id="aspect">
				<option value="auto">Auto</option><option value="1:1">1:1 quadrato</option>
				<option value="2:3">2:3 verticale (full body)</option><option value="9:16">9:16 verticale alto</option>
				<option value="3:2">3:2 orizzontale</option><option value="16:9">16:9 panorama</option>
				<option value="3:4">3:4</option><option value="4:3">4:3</option>
			</select></div>
		<div class="hint">Persona a figura intera → verticale (2:3 o 9:16); a 1:1 esce mezzo busto.</div>
		<div class="row"><label>Migliora prompt</label><input type="checkbox" id="enhance" /><span class="muted">amplifica e traduce</span></div>
		<div class="row"><label>Modello prompt</label><input type="text" id="enhanceModel" placeholder="(usa il modello di chat)" /></div>
		<div class="hint">Per i prompt puoi usare un modello creativo/uncensored separato.</div>
		<div class="row"><label>Forza img2img</label><input type="range" id="denoise" min="0" max="1" step="0.05" /><span class="val" id="denoiseVal"></span></div>
		<div class="hint">0.4 ritocco · 0.6 consigliato · 0.8 cambiamento forte (solo con immagine allegata).</div>
	</div>

	<div class="card">
		<h3><span class="ic">⚡</span> Azioni rapide</h3>
		<div class="actions">
			<button data-cmd="mgcoding.pickComfyFolder">📁 Cartella ComfyUI</button>
			<button data-cmd="mgcoding.downloadImageModel" class="primary">⬇ Scarica modello</button>
			<button data-cmd="mgcoding.selectCheckpoint">🎯 Checkpoint</button>
			<button data-cmd="mgcoding.selectWorkflow">🎛 Workflow</button>
			<button data-cmd="mgcoding.importWorkflow">⬆ Importa workflow</button>
			<button data-cmd="mgcoding.installMissingNodes">🧩 Nodi mancanti</button>
			<button data-cmd="mgcoding.openChat" class="primary">💬 Apri chat Img</button>
			<button data-cmd="mgcoding.recommendModel">💡 Consiglia modello</button>
		</div>
		<div class="path" id="rootHint"></div>
	</div>

	<div class="card">
		<div class="gal-head">
			<h3 style="margin:0"><span class="ic">🖼️</span> Galleria <span class="muted" id="galCount"></span></h3>
			<div class="gal-tools">
				<button id="browseGal" title="Scegli la cartella della galleria">📂 Sfoglia</button>
				<button id="openGal" title="Apri la cartella nel sistema">↗ Apri</button>
				<button id="refreshGal" title="Aggiorna">⟳</button>
			</div>
		</div>
		<div class="gallery" id="gallery"></div>
		<div class="muted" id="galEmpty" style="display:none; margin-top:8px">Nessuna immagine ancora. Genera dalla chat (modalità 🎨 Img o pulsante Genera immagine).</div>
		<div class="path" id="galPath"></div>
	</div>

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
	$('browseGal').addEventListener('click', function(){ send({type:'cmd', command:'mgcoding.pickGalleryFolder'}); });
	$('openGal').addEventListener('click', function(){ send({type:'openFolder'}); });
	$('refreshGal').addEventListener('click', function(){ send({type:'refresh'}); });
	var btns = document.querySelectorAll('button[data-cmd]');
	for (var i=0;i<btns.length;i++){ btns[i].addEventListener('click', function(){ send({type:'cmd', command:this.getAttribute('data-cmd')}); }); }
	function opt(v, label, sel){ var o=document.createElement('option'); o.value=v; o.textContent=label; if(v===sel)o.selected=true; return o; }
	window.addEventListener('message', function(e){
		var m = e.data; if (m.type!=='state') return;
		$('dot').className = 'dot ' + (m.connected ? 'on' : 'off');
		$('statusText').textContent = m.connected ? 'ComfyUI connesso' : 'ComfyUI non rilevato';
		$('statusSub').textContent = m.connected ? (m.checkpoints.length + ' checkpoint disponibili · ' + m.endpoint) : ('Avvialo, poi premi ⟳. Endpoint: ' + m.endpoint);
		$('backend').value = m.backend;
		var cs = $('checkpoint'); cs.innerHTML=''; cs.appendChild(opt('', '(auto: primo disponibile)', m.checkpoint));
		for (var i=0;i<m.checkpoints.length;i++){ cs.appendChild(opt(m.checkpoints[i], m.checkpoints[i], m.checkpoint)); }
		var ws = $('workflow'); ws.innerHTML=''; ws.appendChild(opt('', '(predefinito txt2img)', m.workflow));
		for (var j=0;j<m.workflows.length;j++){ ws.appendChild(opt(m.workflows[j], m.workflows[j], m.workflow)); }
		$('aspect').value = m.aspect || 'auto';
		$('enhance').checked = !!m.enhancePrompt;
		$('enhanceModel').value = m.enhanceModel || '';
		$('denoise').value = m.denoise; $('denoiseVal').textContent = (+m.denoise).toFixed(2);
		$('rootHint').textContent = m.comfyRoot ? ('ComfyUI: ' + m.comfyRoot) : 'Cartella ComfyUI non impostata (usa 📁).';
		$('galPath').textContent = 'Cartella galleria: ' + m.galleryFolder;
		var g = $('gallery'); g.innerHTML='';
		for (var k=0;k<m.gallery.length;k++){ (function(it){
			var d=document.createElement('div'); d.className='thumb';
			var im=document.createElement('img'); im.src=it.src; im.title='Apri'; im.addEventListener('click', function(){ send({type:'openImage', path:it.path}); });
			var del=document.createElement('button'); del.className='del'; del.textContent='\\u2715'; del.title='Elimina';
			del.addEventListener('click', function(ev){ ev.stopPropagation(); send({type:'deleteImage', path:it.path}); });
			d.appendChild(im); d.appendChild(del); g.appendChild(d);
		})(m.gallery[k]); }
		$('galCount').textContent = m.gallery.length ? ('('+m.gallery.length+')') : '';
		$('galEmpty').style.display = m.gallery.length ? 'none' : 'block';
	});
	send({type:'ready'});
</script></body></html>`;
	}
}
