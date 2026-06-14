/*---------------------------------------------------------------------------------------------
 *  MGCoding - ComfyUI Helper: selezione cartella ComfyUI, download modelli da un catalogo
 *  curato (HuggingFace, URL diretti verificati) nelle cartelle giuste, esecuzione di workflow
 *  "porta il tuo" (formato API) con iniezione del prompt e controllo delle dipendenze mancanti.
 *  Ispirato ai tool della community (Workflow-Models-Downloader, Download-Helper), ma con
 *  catalogo curato invece del fuzzy-matching (piu affidabile) + incolla-URL per i casi fuori catalogo.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { queueAndCollect } from './imageGen';

const DEC = new TextDecoder();

/** Voce del catalogo modelli (URL HuggingFace diretti, senza login). */
export interface ModelCatalogEntry {
	label: string;
	file: string;
	/** Sottocartella di models/ dove va il file. */
	subfolder: 'checkpoints' | 'vae' | 'loras' | 'unet' | 'clip' | 'controlnet';
	url: string;
	sizeMB: number;
	note: string;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
	{ label: 'SDXL Base 1.0 (qualita, 8GB+ VRAM)', file: 'sd_xl_base_1.0.safetensors', subfolder: 'checkpoints', url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors', sizeMB: 6938, note: 'Modello generalista SDXL, ottimo punto di partenza.' },
	{ label: 'FLUX.1 schnell fp8 (moderno, veloce, 12GB)', file: 'flux1-schnell-fp8.safetensors', subfolder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors', sizeMB: 17246, note: 'FLUX schnell in un unico file fp8: qualita alta, pochi step. Ideale per la tua 4070 12GB.' },
	{ label: 'Stable Diffusion 1.5 (leggero, 4-6GB VRAM)', file: 'v1-5-pruned-emaonly-fp16.safetensors', subfolder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors', sizeMB: 2132, note: 'SD 1.5 classico: veloce e leggero, per GPU piccole.' },
	{ label: 'SDXL VAE fp16-fix (consigliato con SDXL)', file: 'sdxl_vae.safetensors', subfolder: 'vae', url: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors', sizeMB: 335, note: 'VAE che evita artefatti/colori slavati con SDXL in fp16.' }
];

/** Trova la cartella `models` data una cartella scelta (root portable o cartella ComfyUI). */
function resolveModelsDir(picked: string): string | undefined {
	const candidates = [
		path.join(picked, 'models'),
		path.join(picked, 'ComfyUI', 'models'),
		path.join(picked, 'ComfyUI_windows_portable', 'ComfyUI', 'models')
	];
	return candidates.find(c => { try { return fs.statSync(c).isDirectory(); } catch { return false; } });
}

/** La cartella ComfyUI configurata (radice che contiene `models`), o undefined. */
export function comfyModelsDir(): string | undefined {
	const root = vscode.workspace.getConfiguration('mgcoding').get<string>('image.comfyRoot', '');
	if (!root) {
		return undefined;
	}
	return resolveModelsDir(root) ?? (fs.existsSync(path.join(root, 'checkpoints')) ? root : undefined);
}

/** Apre un dialog per scegliere la cartella di ComfyUI e la salva in impostazioni. */
export async function pickComfyFolder(): Promise<boolean> {
	const sel = await vscode.window.showOpenDialog({
		canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		title: 'Seleziona la cartella di ComfyUI', openLabel: 'Usa questa cartella'
	});
	if (!sel?.length) {
		return false;
	}
	const picked = sel[0].fsPath;
	const models = resolveModelsDir(picked);
	if (!models) {
		const retry = await vscode.window.showWarningMessage(
			`In "${picked}" non ho trovato la cartella models/ di ComfyUI. Scegli la cartella che contiene "ComfyUI" (o direttamente quella con models/).`,
			'Riprova'
		);
		return retry === 'Riprova' ? pickComfyFolder() : false;
	}
	const root = path.dirname(models); // la cartella che contiene models/
	await vscode.workspace.getConfiguration('mgcoding').update('image.comfyRoot', root, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`Cartella ComfyUI impostata: ${root}`);
	return true;
}

/** Scarica un file in streaming con barra di avanzamento. Ritorna true se completato. */
async function downloadFile(url: string, dest: string, label: string, signal?: AbortSignal): Promise<boolean> {
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Scarico ${label}`, cancellable: true },
		async (progress, token) => {
			const ctrl = new AbortController();
			token.onCancellationRequested(() => ctrl.abort());
			signal?.addEventListener('abort', () => ctrl.abort());
			const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
			if (!res.ok || !res.body) {
				throw new Error(`HTTP ${res.status} da ${url}`);
			}
			const total = Number(res.headers.get('content-length')) || 0;
			const tmp = `${dest}.part`;
			const out = fs.createWriteStream(tmp);
			let received = 0;
			let lastPct = 0;
			const reader = (res.body as ReadableStream<Uint8Array>).getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					out.write(Buffer.from(value));
					received += value.length;
					if (total) {
						const pct = Math.floor((received / total) * 100);
						if (pct > lastPct) {
							progress.report({ increment: pct - lastPct, message: `${pct}% (${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)` });
							lastPct = pct;
						}
					} else {
						progress.report({ message: `${(received / 1e6).toFixed(0)} MB` });
					}
				}
			} finally {
				out.end();
			}
			await new Promise<void>((resolve, reject) => { out.on('finish', () => resolve()); out.on('error', reject); });
			await fs.promises.rename(tmp, dest);
			return true;
		}
	);
}

/** Scarica un modello del catalogo (o da URL incollato) nella cartella giusta di ComfyUI. */
export async function downloadImageModel(): Promise<void> {
	let modelsDir = comfyModelsDir();
	if (!modelsDir) {
		const pick = await vscode.window.showInformationMessage('Prima seleziona la cartella di ComfyUI.', 'Seleziona cartella');
		if (pick !== 'Seleziona cartella' || !(await pickComfyFolder())) {
			return;
		}
		modelsDir = comfyModelsDir();
		if (!modelsDir) {
			return;
		}
	}
	const items: (vscode.QuickPickItem & { entry?: ModelCatalogEntry; paste?: boolean })[] = [
		...MODEL_CATALOG.map(e => ({ label: e.label, description: `${(e.sizeMB / 1024).toFixed(1)} GB → models/${e.subfolder}`, detail: e.note, entry: e })),
		{ label: '$(link) Incolla un URL diretto…', description: 'Per modelli fuori catalogo (HuggingFace/Civitai)', paste: true }
	];
	const choice = await vscode.window.showQuickPick(items, { title: 'Scarica modello immagini (ComfyUI)', placeHolder: 'Scegli un modello da scaricare' });
	if (!choice) {
		return;
	}
	let entry: ModelCatalogEntry;
	if (choice.paste) {
		const url = (await vscode.window.showInputBox({ title: 'URL del modello', prompt: 'URL diretto al file .safetensors', placeHolder: 'https://...' }))?.trim();
		if (!url) {
			return;
		}
		const sub = await vscode.window.showQuickPick(['checkpoints', 'vae', 'loras', 'unet', 'clip', 'controlnet'], { title: 'In quale cartella di models/?' });
		if (!sub) {
			return;
		}
		entry = { label: path.basename(url), file: decodeURIComponent(url.split('/').pop()!.split('?')[0]), subfolder: sub as ModelCatalogEntry['subfolder'], url, sizeMB: 0, note: '' };
	} else {
		entry = choice.entry!;
	}
	const dest = path.join(modelsDir, entry.subfolder, entry.file);
	if (fs.existsSync(dest)) {
		const ow = await vscode.window.showWarningMessage(`"${entry.file}" esiste già. Riscaricarlo?`, 'Riscarica');
		if (ow !== 'Riscarica') {
			return;
		}
	}
	try {
		await downloadFile(entry.url, dest, entry.file);
		vscode.window.showInformationMessage(`Modello scaricato: ${entry.file} (in models/${entry.subfolder}). Ora puoi usarlo in ComfyUI / modalità Img.`);
	} catch (err) {
		vscode.window.showErrorMessage(`Download fallito: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---- Workflow "porta il tuo" (formato API) ----

/** Cartella .mg/workflows/ del workspace. */
function workflowsDir(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders?.[0];
	return f ? vscode.Uri.joinPath(f.uri, '.mg', 'workflows') : undefined;
}

/** Elenca i workflow disponibili (.json) in .mg/workflows/. */
export async function listWorkflows(): Promise<string[]> {
	const dir = workflowsDir();
	if (!dir) {
		return [];
	}
	try {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		return entries.filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json')).map(([n]) => n);
	} catch {
		return [];
	}
}

/** Carica il JSON di un workflow per nome file. */
export async function loadWorkflow(name: string): Promise<Record<string, { class_type: string; inputs: Record<string, unknown> }> | undefined> {
	const dir = workflowsDir();
	if (!dir) {
		return undefined;
	}
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
		return JSON.parse(DEC.decode(bytes));
	} catch {
		return undefined;
	}
}

/** I nomi di modello referenziati in un workflow (valori dei campi *_name stringa). */
export function referencedModels(workflow: Record<string, { inputs?: Record<string, unknown> }>): string[] {
	const names = new Set<string>();
	for (const node of Object.values(workflow)) {
		for (const [k, v] of Object.entries(node.inputs ?? {})) {
			if (typeof v === 'string' && /_name$/.test(k) && /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(v)) {
				names.add(v);
			}
		}
	}
	return [...names];
}

type WfNode = { class_type: string; inputs: Record<string, unknown> };
type Workflow = Record<string, WfNode>;

/**
 * Inietta il prompt utente nel workflow: trova il nodo di testo POSITIVO (quello collegato
 * all'input "positive" di un sampler) e ne sostituisce il testo; randomizza i seed.
 */
function injectPrompt(workflow: Workflow, prompt: string): Workflow {
	const wf: Workflow = JSON.parse(JSON.stringify(workflow));
	// 1) Individua il nodo positivo via collegamento del sampler.
	let positiveId: string | undefined;
	for (const node of Object.values(wf)) {
		if (/sampler/i.test(node.class_type) && Array.isArray(node.inputs.positive)) {
			positiveId = String((node.inputs.positive as unknown[])[0]);
			break;
		}
	}
	const textNodes = Object.entries(wf).filter(([, n]) => /CLIPTextEncode/i.test(n.class_type) && typeof n.inputs.text === 'string');
	if (positiveId && wf[positiveId] && typeof wf[positiveId].inputs.text === 'string') {
		wf[positiveId].inputs.text = prompt;
	} else if (textNodes.length) {
		// Fallback: il primo nodo di testo (o quello non-"negative").
		const pick = textNodes.find(([, n]) => !/negative|low quality|worst/i.test(String(n.inputs.text))) ?? textNodes[0];
		pick[1].inputs.text = prompt;
	}
	// 2) Randomizza i seed.
	for (const node of Object.values(wf)) {
		if ('seed' in node.inputs) {
			node.inputs.seed = Math.floor(Math.random() * 1e15);
		}
		if ('noise_seed' in node.inputs) {
			node.inputs.noise_seed = Math.floor(Math.random() * 1e15);
		}
	}
	return wf;
}

/** Esegue un workflow "porta il tuo" iniettando il prompt; ritorna immagini base64. */
export async function runWorkflow(endpoint: string, name: string, prompt: string, signal?: AbortSignal): Promise<string[]> {
	const wf = await loadWorkflow(name);
	if (!wf) {
		throw new Error(`Workflow "${name}" non trovato o non valido (serve il formato API JSON).`);
	}
	return queueAndCollect(endpoint, injectPrompt(wf as Workflow, prompt), signal);
}

/** Modelli del workflow NON disponibili in ComfyUI (confronto con /object_info). */
export async function missingModels(endpoint: string, workflow: Record<string, { inputs?: Record<string, unknown> }>): Promise<string[]> {
	const referenced = referencedModels(workflow);
	if (!referenced.length) {
		return [];
	}
	let available = new Set<string>();
	try {
		const res = await fetch(`${endpoint.replace(/\/$/, '')}/object_info`, { signal: AbortSignal.timeout(8000) });
		if (res.ok) {
			const info = await res.json() as Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>;
			for (const node of Object.values(info)) {
				for (const grp of [node.input?.required, node.input?.optional]) {
					for (const spec of Object.values(grp ?? {})) {
						if (Array.isArray(spec) && Array.isArray(spec[0])) {
							for (const opt of spec[0]) {
								if (typeof opt === 'string') {
									available.add(opt);
								}
							}
						}
					}
				}
			}
		}
	} catch {
		available = new Set();
	}
	return referenced.filter(r => !available.has(r));
}
