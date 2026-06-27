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
import * as os from 'os';
import * as zlib from 'zlib';
import { exec } from 'child_process';
import { promisify } from 'util';
import { queueAndCollect } from './imageGen';
import { ApiWorkflow, isApiFormat } from './workflowGraph';
import { convertUiToApi, isUiFormat, type ConversionResult, type ObjectInfo, type UiWorkflow } from './workflowConverter';
import { referencedModels as detectModelRefs, missingModels as computeMissingModels, type ModelRef } from './modelRefs';
import { usedClassTypes, missingNodes as computeMissingNodes } from './nodeRefs';

const execAsync = promisify(exec);

/** Vero se l'errore deriva dall'annullamento dell'utente (AbortController/CancellationToken). */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
}

/**
 * Cartella dove salvare/leggere le immagini generate. Priorità: cartella scelta dall'utente
 * (image.galleryFolder) → .mg/generated del workspace → fallback globale in home (così funziona
 * anche senza una cartella di lavoro aperta — prima in quel caso le immagini non si salvavano).
 */
export function generatedDirUri(): vscode.Uri {
	const custom = vscode.workspace.getConfiguration('mgcoding').get<string>('image.galleryFolder', '').trim();
	if (custom) {
		return vscode.Uri.file(custom);
	}
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (ws) {
		return vscode.Uri.joinPath(ws.uri, '.mg', 'generated');
	}
	return vscode.Uri.file(path.join(os.homedir(), '.mgcoding', 'generated'));
}

/** Sceglie una cartella per la galleria delle immagini (image.galleryFolder). */
export async function pickGalleryFolder(): Promise<void> {
	const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Cartella della galleria immagini', openLabel: 'Usa questa cartella' });
	if (!sel?.length) {
		return;
	}
	await vscode.workspace.getConfiguration('mgcoding').update('image.galleryFolder', sel[0].fsPath, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`Galleria: ${sel[0].fsPath}`);
}

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

/** L'endpoint ComfyUI configurato (normalizzato, senza slash finale). */
function configuredComfyEndpoint(): string {
	const ep = vscode.workspace.getConfiguration('mgcoding').get<string>('image.comfyEndpoint', 'http://127.0.0.1:8188');
	return (ep || 'http://127.0.0.1:8188').replace(/\/$/, '');
}

/**
 * Scarica da ComfyUI i metadati `/object_info` nel formato `ObjectInfo` usato dal
 * Convertitore_Workflow (l'ordine delle chiavi `input.required`/`optional` guida la
 * mappatura dei `widgets_values`). Lancia se ComfyUI non è raggiungibile o risponde male:
 * il chiamante distingue così "conversione locale fallita" da "fallback ComfyUI non
 * disponibile" (Req 15.3).
 */
export async function fetchObjectInfo(endpoint: string): Promise<ObjectInfo> {
	const res = await fetch(`${endpoint.replace(/\/$/, '')}/object_info`, { signal: AbortSignal.timeout(25000) });
	if (!res.ok) {
		throw new Error(`ComfyUI /object_info ha risposto ${res.status}`);
	}
	return await res.json() as ObjectInfo;
}

/**
 * Estrae le voci di un archivio ZIP (`.zip`) leggendone la **central directory** (robusto
 * anche con i data descriptor) e decomprimendo ogni entry: metodo 0 (stored) o 8 (deflate,
 * via `zlib.inflateRawSync`). Nessuna dipendenza esterna: usa solo lo `zlib` di Node, così
 * non incide sul bundling dell'estensione. Ignora le cartelle. Lancia su archivio non valido
 * o metodo di compressione non supportato.
 */
function readZipEntries(buf: Buffer): { name: string; data: Buffer }[] {
	const EOCD_SIG = 0x06054b50;
	const CDH_SIG = 0x02014b50;
	const LFH_SIG = 0x04034b50;
	// Cerca l'End Of Central Directory partendo dal fondo (il commento finale è ≤ 65535 byte).
	let eocd = -1;
	const minPos = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= minPos; i--) {
		if (i >= 0 && buf.readUInt32LE(i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) {
		throw new Error('Archivio ZIP non valido: record di fine central directory non trovato.');
	}
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const entries: { name: string; data: Buffer }[] = [];
	for (let n = 0; n < count && p + 46 <= buf.length; n++) {
		if (buf.readUInt32LE(p) !== CDH_SIG) {
			break;
		}
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		const isDir = name.endsWith('/');
		if (!isDir && buf.readUInt32LE(localOffset) === LFH_SIG) {
			// L'header locale dichiara la propria lunghezza nome/extra: serve per trovare i dati.
			const lNameLen = buf.readUInt16LE(localOffset + 26);
			const lExtraLen = buf.readUInt16LE(localOffset + 28);
			const dataStart = localOffset + 30 + lNameLen + lExtraLen;
			const comp = buf.subarray(dataStart, dataStart + compSize);
			let data: Buffer;
			if (method === 0) {
				data = Buffer.from(comp);
			} else if (method === 8) {
				data = zlib.inflateRawSync(comp);
			} else {
				throw new Error(`Metodo di compressione ZIP non supportato (${method}) per "${name}".`);
			}
			entries.push({ name, data });
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/**
 * Estrae il **primo workflow JSON** da un archivio ZIP (Req 15.5): preferisce la prima entry
 * con estensione `.json` (escludendo le cartelle di metadati `__MACOSX/`). Restituisce
 * `{ name, text }` con il testo del file, o `{ error }` se l'archivio non è valido o non
 * contiene alcun `.json`.
 */
export function extractWorkflowFromArchive(bytes: Uint8Array): { name: string; text: string } | { error: string } {
	let entries: { name: string; data: Buffer }[];
	try {
		entries = readZipEntries(Buffer.from(bytes));
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	const jsonEntries = entries.filter(e => /\.json$/i.test(e.name) && !e.name.startsWith('__MACOSX/'));
	if (!jsonEntries.length) {
		return { error: "l'archivio non contiene alcun file .json di workflow." };
	}
	const chosen = jsonEntries[0];
	return { name: path.basename(chosen.name), text: DEC.decode(chosen.data) };
}

/**
 * Converte un Workflow_UI in formato API tentando prima la conversione **locale** e, se non
 * basta, il **fallback ComfyUI** (Req 15.2/15.3). ComfyUI non espone un endpoint diretto
 * UI→API: il fallback consiste nello scaricare `/object_info` (possibile solo se ComfyUI è
 * raggiungibile) per dare al convertitore l'ordine dei `widgets_values` mancante.
 * - tenta `convertUiToApi(ui, {})`: copre i workflow senza widget posizionali da ordinare;
 * - se fallisce e ComfyUI è raggiungibile, riscarica `/object_info` e ritenta;
 * - altrimenti restituisce `{ ok: false, reason }` (Req 15.4), indicando il motivo.
 */
async function convertUiWithFallback(ui: UiWorkflow, endpoint: string): Promise<ConversionResult> {
	// 1) Tentativo locale senza interrogare ComfyUI.
	const local = convertUiToApi(ui, {});
	if (local.ok) {
		return local;
	}
	// 2) Conversione locale non possibile: usa ComfyUI come fallback se raggiungibile (Req 15.3).
	let objectInfo: ObjectInfo;
	try {
		objectInfo = await fetchObjectInfo(endpoint);
	} catch (err) {
		return {
			ok: false,
			reason: `${local.reason} Per completare la conversione serve ComfyUI in esecuzione su ${endpoint} (non raggiungibile: ${err instanceof Error ? err.message : String(err)}).`,
		};
	}
	return convertUiToApi(ui, objectInfo);
}

/** Vero se `t` è un id di subgraph ComfyUI (UUID): i subgraph non sono appiattiti localmente. */
function isSubgraphType(t: unknown): boolean {
	return typeof t === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
}

/**
 * Repository CANONICI dei pacchetti di nodi più diffusi: quando più repo (spesso fork)
 * rivendicano lo stesso `class_type` nella mappa di ComfyUI-Manager, si preferisce questo
 * elenco per evitare di clonare un fork sbagliato (es. un fork al posto di city96/ComfyUI-GGUF).
 */
const CANONICAL_NODE_REPOS: readonly string[] = [
	'https://github.com/city96/ComfyUI-GGUF',
	'https://github.com/rgthree/rgthree-comfy',
	'https://github.com/kijai/ComfyUI-KJNodes',
	'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
	'https://github.com/Fannovel16/ComfyUI-Frame-Interpolation',
	'https://github.com/yolain/ComfyUI-Easy-Use',
	'https://github.com/cubiq/ComfyUI_essentials',
	'https://github.com/ltdrdata/ComfyUI-Impact-Pack',
	'https://github.com/WASasquatch/was-node-suite-comfyui',
];

/**
 * Risolve il repository che fornisce una `class_type`:
 *  1) euristiche su suffissi distintivi dei pacchetti noti (robuste anche quando la mappa è
 *     ambigua o non indicizza il nodo): `… (rgthree)` → rgthree-comfy; `…GGUF` → city96/ComfyUI-GGUF;
 *  2) candidati dalla mappa di ComfyUI-Manager, preferendo un repo CANONICO se presente;
 *  3) in mancanza d'altro, il primo match della mappa.
 * Restituisce `undefined` se nessuna fonte risolve il nodo.
 */
function resolveRepoForClass(cls: string, nodeMap: Record<string, [string[], unknown]>): string | undefined {
	if (/\(rgthree\)\s*$/i.test(cls)) {
		return 'https://github.com/rgthree/rgthree-comfy';
	}
	if (/GGUF$/.test(cls)) {
		return 'https://github.com/city96/ComfyUI-GGUF';
	}
	const candidates: string[] = [];
	for (const [repo, val] of Object.entries(nodeMap)) {
		if (Array.isArray(val?.[0]) && val[0].includes(cls)) {
			candidates.push(repo);
		}
	}
	if (candidates.length === 0) {
		return undefined;
	}
	return candidates.find(c => CANONICAL_NODE_REPOS.includes(c)) ?? candidates[0];
}

/**
 * Riconosce un export "API" DEGRADATO: un oggetto (non array) i cui valori hanno `inputs`
 * oggetto ma a cui MANCA `class_type`. Succede quando ComfyUI esporta in formato API un
 * workflow i cui nodi custom NON sono installati: il frontend non conosce le definizioni,
 * omette `class_type` e nomina i widget `"UNKNOWN"`. Restituisce i titoli (`_meta.title`) dei
 * nodi privi di `class_type`, oppure `undefined` se non è un export API (degradato).
 */
function degradedApiNodeTitles(obj: unknown): string[] | undefined {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
		return undefined;
	}
	const values = Object.values(obj as Record<string, unknown>);
	if (values.length === 0) {
		return undefined;
	}
	const missing: string[] = [];
	for (const v of values) {
		if (!v || typeof v !== 'object' || Array.isArray(v)) {
			return undefined; // non è una mappa di nodi
		}
		const node = v as { class_type?: unknown; inputs?: unknown; _meta?: { title?: unknown } };
		const hasInputs = !!node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs);
		if (!hasInputs) {
			return undefined; // non sembra una mappa di nodi in formato API
		}
		if (typeof node.class_type !== 'string') {
			missing.push(typeof node._meta?.title === 'string' ? node._meta!.title as string : '(senza titolo)');
		}
	}
	return missing.length > 0 ? missing : undefined;
}

/**
 * Importa un workflow ComfyUI in `.mg/workflows/` e lo imposta come attivo.
 * Accetta sia file `.json` (formato API o UI) sia archivi `.zip` contenenti il workflow:
 * - **formato API** → salvato così com'è (Req 15.1);
 * - **formato UI** → convertito in API prima del salvataggio (Req 15.2), con fallback su
 *   ComfyUI quando la conversione locale non basta (Req 15.3);
 * - **non convertibile** → l'utente viene informato del motivo (Req 15.4);
 * - **archivio `.zip`** → il workflow viene estratto prima dell'import (Req 15.5).
 */
export async function importWorkflow(): Promise<void> {
	const dir = workflowsDir();
	if (!dir) {
		vscode.window.showWarningMessage('Apri una cartella di lavoro per importare un workflow.');
		return;
	}
	const sel = await vscode.window.showOpenDialog({
		canSelectMany: false, filters: { 'Workflow ComfyUI (JSON o ZIP)': ['json', 'zip'] },
		title: 'Importa un workflow ComfyUI (JSON formato API/UI o archivio ZIP)', openLabel: 'Importa'
	});
	if (!sel?.length) {
		return;
	}
	const bytes = await vscode.workspace.fs.readFile(sel[0]);
	const fileName = path.basename(sel[0].fsPath);

	// 1) Archivio compresso: estrai il workflow prima dell'import (Req 15.5).
	let jsonText: string;
	let sourceName = fileName;
	const isZip = /\.zip$/i.test(fileName) || (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b); // "PK"
	if (isZip) {
		const extracted = extractWorkflowFromArchive(bytes);
		if ('error' in extracted) {
			vscode.window.showErrorMessage(`Impossibile estrarre il workflow dall'archivio: ${extracted.error}`);
			return;
		}
		jsonText = extracted.text;
		sourceName = extracted.name;
	} else {
		jsonText = DEC.decode(bytes);
	}

	// 2) Parsing JSON.
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		vscode.window.showErrorMessage('File non valido: non è un JSON.');
		return;
	}

	// 3) Determina il formato e ottieni il workflow API da salvare.
	let api: ApiWorkflow;
	if (isApiFormat(parsed)) {
		// Formato API: salvato così com'è (Req 15.1).
		api = parsed;
	} else if (isUiFormat(parsed)) {
		// Formato UI: convertito in API (Req 15.2) con fallback ComfyUI (Req 15.3).
		const subgraphs = parsed.nodes.filter(n => isSubgraphType((n as { type?: unknown }).type)).length;
		const result = await convertUiWithFallback(parsed, configuredComfyEndpoint());
		if (!result.ok) {
			// Workflow non convertibile: spiega il motivo in modo ACTIONABLE (Req 15.4).
			let hint = ' Causa probabile: i nodi custom richiesti non sono installati in ComfyUI '
				+ '(quindi /object_info non ne espone i widget). Installali in ComfyUI (es. con ComfyUI-Manager), '
				+ 'poi in ComfyUI usa "Export (API)" e reimporta qui quel file.';
			if (subgraphs > 0) {
				hint = ` Il workflow contiene ${subgraphs} subgraph (gruppi annidati) che la conversione locale non sa appiattire. `
					+ 'Aprilo in ComfyUI con i nodi custom installati ed esporta con "Export (API)": quel file '
					+ '(formato API completo) è importabile direttamente qui.';
			}
			vscode.window.showWarningMessage(`Workflow non convertibile in formato API: ${result.reason}${hint}`);
			return;
		}
		api = result.api;
	} else {
		// Potrebbe essere un export API DEGRADATO: nodi senza `class_type` perché i relativi nodi
		// custom non erano installati in ComfyUI all'export. Diagnosi precisa invece del generico.
		const degraded = degradedApiNodeTitles(parsed);
		if (degraded) {
			const list = degraded.slice(0, 8).join(', ') + (degraded.length > 8 ? `, … (+${degraded.length - 8})` : '');
			vscode.window.showWarningMessage(
				`Export API incompleto: ${degraded.length} nodo/i senza "class_type". Accade quando ComfyUI esporta `
				+ 'in formato API un workflow i cui nodi custom NON sono installati. Installa i nodi custom in ComfyUI '
				+ `e ripeti "Export (API)". Nodi interessati: ${list}.`
			);
			return;
		}
		// Né API né UI: non importabile (Req 15.4).
		vscode.window.showErrorMessage('Il file non è un workflow ComfyUI valido (né formato API né formato UI).');
		return;
	}

	const baseName = sourceName.replace(/\.json$/i, '').replace(/[^a-z0-9_-]+/gi, '-') || 'workflow';
	await vscode.workspace.fs.createDirectory(dir);
	const dest = vscode.Uri.joinPath(dir, `${baseName}.json`);
	await vscode.workspace.fs.writeFile(dest, new TextEncoder().encode(JSON.stringify(api, null, 2)));
	await vscode.workspace.getConfiguration('mgcoding').update('image.workflow', `${baseName}.json`, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`Workflow importato e attivato: ${baseName}.json`);
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

/** Elenca i checkpoint installati in ComfyUI (da /object_info). */
export async function listCheckpoints(endpoint: string): Promise<string[]> {
	try {
		const res = await fetch(`${endpoint.replace(/\/$/, '')}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) {
			return [];
		}
		const info = await res.json() as Record<string, { input?: { required?: { ckpt_name?: unknown[][] } } }>;
		return (info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] as string[] | undefined) ?? [];
	} catch {
		return [];
	}
}

/** Elenca i LoRA installati in ComfyUI (da /object_info LoraLoader). */
export async function listLoras(endpoint: string): Promise<string[]> {
	try {
		const res = await fetch(`${endpoint.replace(/\/$/, '')}/object_info/LoraLoader`, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) {
			return [];
		}
		const info = await res.json() as Record<string, { input?: { required?: { lora_name?: unknown[][] } } }>;
		return (info?.LoraLoader?.input?.required?.lora_name?.[0] as string[] | undefined) ?? [];
	} catch {
		return [];
	}
}

/** Le class_type usate dal workflow che NON sono registrate in ComfyUI (nodi custom mancanti). */
export async function missingNodes(endpoint: string, workflow: Record<string, { class_type?: string }>): Promise<string[]> {
	// Rilevamento PURO tramite `nodeRefs` (Req 17.1): differenza tra le class_type usate dal
	// workflow e quelle registrate in ComfyUI (note da /object_info).
	const used = usedClassTypes(workflow as unknown as ApiWorkflow);
	if (!used.length) {
		return [];
	}
	// object_info può essere grande su ComfyUI con molti nodi: timeout generoso.
	const res = await fetch(`${endpoint.replace(/\/$/, '')}/object_info`, { signal: AbortSignal.timeout(25000) });
	if (!res.ok) {
		throw new Error(`ComfyUI /object_info ha risposto ${res.status}`);
	}
	const known = new Set(Object.keys(await res.json() as Record<string, unknown>));
	return computeMissingNodes(used, known);
}

/** Cartella custom_nodes e python embedded di ComfyUI (struttura portable o standard). */
function comfyPaths(): { customNodes?: string; python?: string } {
	const root = vscode.workspace.getConfiguration('mgcoding').get<string>('image.comfyRoot', '');
	if (!root) {
		return {};
	}
	const customNodes = path.join(root, 'custom_nodes');
	// portable: <root>/../python_embeded/python.exe ; altrimenti python di sistema.
	const embedded = path.join(path.dirname(root), 'python_embeded', 'python.exe');
	return { customNodes: fs.existsSync(customNodes) ? customNodes : undefined, python: fs.existsSync(embedded) ? embedded : undefined };
}

/**
 * Installa automaticamente i nodi custom mancanti per un workflow: risolve le class_type
 * mancanti nei repo via la mappa di ComfyUI-Manager, le clona in custom_nodes e installa i
 * requirements. RICHIEDE CONFERMA (clona codice di terzi). Serve git nel PATH.
 */
export async function installMissingNodesForWorkflow(endpoint: string, workflowName: string): Promise<void> {
	const wf = await loadWorkflow(workflowName);
	if (!wf) {
		vscode.window.showWarningMessage(`Workflow «${workflowName}» non trovato.`);
		return;
	}
	// Se il workflow non ha class_type, è in formato UI (non API): non analizzabile.
	const hasClassTypes = Object.values(wf).some(n => n && typeof (n as { class_type?: unknown }).class_type === 'string');
	if (!hasClassTypes) {
		vscode.window.showWarningMessage(`«${workflowName}» non è in formato API (manca class_type). In ComfyUI: Save → API Format, poi reimportalo. Per ora usa ComfyUI-Manager per i nodi mancanti.`);
		return;
	}
	let missing: string[];
	try {
		missing = await missingNodes(endpoint, wf);
	} catch (err) {
		vscode.window.showWarningMessage(`Non riesco a leggere i nodi da ComfyUI (${err instanceof Error ? err.message : String(err)}). È avviato su ${endpoint}? In alternativa usa ComfyUI-Manager (più completo).`);
		return;
	}
	if (!missing.length) {
		vscode.window.showInformationMessage('Per QUESTO workflow non risultano nodi mancanti. Nota: MGCoding controlla il workflow attivo in .mg/workflows, non quello aperto nella scheda di ComfyUI. Per workflow complessi usa ComfyUI-Manager (Install Missing Custom Nodes + Models).');
		return;
	}
	await installResolvedNodes(missing, `il workflow «${workflowName}»`);
}

/**
 * Cuore RIUSABILE dell'installazione nodi: risolve un insieme di `class_type` mancanti nei
 * repository tramite la mappa di ComfyUI-Manager (`extension-node-map.json`), chiede conferma
 * esplicita (clona codice di terzi) e installa clonando in `custom_nodes/` + `pip install` dei
 * requirements. NON richiede ComfyUI-Manager installato in ComfyUI: MGCoding fa git/pip da sé.
 * `contextLabel` descrive l'origine (es. "il workflow «x»" o "il file «y.json»").
 */
async function installResolvedNodes(missing: string[], contextLabel: string): Promise<void> {
	const { customNodes, python } = comfyPaths();
	if (!customNodes) {
		vscode.window.showWarningMessage('Imposta prima la cartella di ComfyUI ("MGCoding: Seleziona cartella ComfyUI"): non trovo custom_nodes/.');
		return;
	}
	// Mappa class_type -> repo via ComfyUI-Manager (extension-node-map.json).
	let nodeMap: Record<string, [string[], unknown]>;
	try {
		const res = await fetch('https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/extension-node-map.json', { signal: AbortSignal.timeout(15000) });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		nodeMap = await res.json() as Record<string, [string[], unknown]>;
	} catch (err) {
		vscode.window.showErrorMessage(`Impossibile scaricare l'elenco nodi di ComfyUI-Manager: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	const repos = new Map<string, string[]>(); // repoUrl -> class_types che fornisce
	const unresolved: string[] = [];
	for (const cls of missing) {
		const found = resolveRepoForClass(cls, nodeMap);
		if (found) {
			repos.set(found, [...(repos.get(found) ?? []), cls]);
		} else {
			unresolved.push(cls);
		}
	}
	if (!repos.size) {
		vscode.window.showWarningMessage(`Nodi mancanti non risolti automaticamente: ${unresolved.join(', ')}. Installali da ComfyUI-Manager.`);
		return;
	}
	const repoList = [...repos.keys()];
	const installedRepos: string[] = [];
	const failedRepos: string[] = [];
	const detail = repoList.map(r => `• ${r.replace(/^https?:\/\/github\.com\//, '')} (${repos.get(r)!.join(', ')})`).join('\n');
	const ok = await vscode.window.showWarningMessage(
		`Installo ${repoList.length} pacchetto/i di nodi custom per ${contextLabel}? Verranno clonati da GitHub in custom_nodes/ e ne verranno installate le dipendenze (codice di terzi).`,
		{ modal: true, detail: `${detail}${unresolved.length ? `\n\nNon risolti (manuali): ${unresolved.join(', ')}` : ''}` },
		'Installa'
	);
	if (ok !== 'Installa') {
		return;
	}
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installo nodi ComfyUI', cancellable: false }, async progress => {
		for (const repo of repoList) {
			const name = repo.split('/').pop()!.replace(/\.git$/, '');
			const dest = path.join(customNodes, name);
			progress.report({ message: name });
			try {
				if (fs.existsSync(dest)) {
					await execAsync(`git -C "${dest}" pull`, { timeout: 120000 });
				} else {
					await execAsync(`git clone --depth 1 "${repo}" "${dest}"`, { timeout: 180000 });
				}
				const reqs = path.join(dest, 'requirements.txt');
				if (fs.existsSync(reqs) && python) {
					await execAsync(`"${python}" -m pip install -r "${reqs}"`, { timeout: 300000 });
				}
				installedRepos.push(name);
			} catch (err) {
				failedRepos.push(`${name} (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
			}
		}
	});
	// Riepilogo finale chiaro: installati / falliti / non risolti (Req. 17.4, 17.5).
	if (installedRepos.length > 0) {
		vscode.window.showInformationMessage(
			`Installati ${installedRepos.length}/${repoList.length} pacchetti in custom_nodes/ (${installedRepos.join(', ')}). RIAVVIA ComfyUI per caricarli.`
		);
	}
	if (failedRepos.length > 0) {
		vscode.window.showWarningMessage(
			`Pacchetti NON installati: ${failedRepos.join(' | ')}. Verifica che "git" sia disponibile nel PATH e riprova.`
		);
	}
	if (unresolved.length > 0) {
		vscode.window.showWarningMessage(`Nodi non risolti automaticamente (installali a mano): ${unresolved.join(', ')}.`);
	}
}

/** Estrae da un workflow UI le `class_type` "installabili": i `node.type`, escludendo i nodi
 * solo-frontend (Note/Reroute/Primitive/Group e i nodi "virtuali" Set/Get di KJNodes, che sono
 * definiti in JavaScript e NON compaiono in /object_info) e i subgraph (UUID), che non sono
 * pacchetti Python installabili. */
function uiInstallableClassTypes(ui: UiWorkflow): string[] {
	const skip = new Set([
		'Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveString', 'Group',
		// Nodi virtuali frontend di ComfyUI-KJNodes (web/js/setgetnodes.js): non sono nodi Python
		// e non risultano da /object_info → vanno ignorati (li fornisce KJNodes lato UI).
		'SetNode', 'GetNode',
	]);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const n of ui.nodes) {
		const t = (n as { type?: unknown }).type;
		if (typeof t !== 'string' || t.length === 0 || skip.has(t) || isSubgraphType(t)) {
			continue;
		}
		if (!seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

/**
 * Installa i nodi custom richiesti da un FILE di workflow SCARICATO (UI o API, anche `.zip`),
 * SENZA doverlo prima importare/convertire e SENZA ComfyUI-Manager installato in ComfyUI.
 * Ricava le `class_type` dal file (UI: `node.type`; API: `class_type`), calcola quelle non
 * presenti in ComfyUI (se raggiungibile; altrimenti tenta tutte quelle risolvibili) e le
 * installa clonando i repo in `custom_nodes/`. È il "Risolvi nodi" che parte dal file UI.
 */
export async function installNodesFromFile(): Promise<void> {
	const sel = await vscode.window.showOpenDialog({
		canSelectMany: false, filters: { 'Workflow ComfyUI (JSON o ZIP)': ['json', 'zip'] },
		title: 'Installa nodi dal workflow scaricato (UI/API/ZIP)', openLabel: 'Analizza e installa'
	});
	if (!sel?.length) {
		return;
	}
	const bytes = await vscode.workspace.fs.readFile(sel[0]);
	const fileName = path.basename(sel[0].fsPath);

	// Estrai dall'archivio se ZIP.
	let jsonText: string;
	const isZip = /\.zip$/i.test(fileName) || (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b);
	if (isZip) {
		const ex = extractWorkflowFromArchive(bytes);
		if ('error' in ex) {
			vscode.window.showErrorMessage(`Impossibile estrarre il workflow dall'archivio: ${ex.error}`);
			return;
		}
		jsonText = ex.text;
	} else {
		jsonText = DEC.decode(bytes);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		vscode.window.showErrorMessage('File non valido: non è un JSON.');
		return;
	}

	// Ricava le class_type richieste dal file.
	let used: string[];
	if (isUiFormat(parsed)) {
		used = uiInstallableClassTypes(parsed);
	} else if (isApiFormat(parsed)) {
		used = usedClassTypes(parsed);
	} else {
		// Export API DEGRADATO: i class_type mancano proprio perché quei nodi non erano
		// installati → non sono deducibili in modo affidabile. Serve il file UI scaricato.
		vscode.window.showWarningMessage(
			'Da questo file non riesco a ricavare i nodi (è un export API senza class_type: '
			+ 'i nodi custom non erano installati all\'export). Usa il file di workflow UI '
			+ '(quello scaricato dal sito / "Save" da ComfyUI) per far rilevare e installare i nodi.'
		);
		return;
	}
	if (!used.length) {
		vscode.window.showInformationMessage('Nessun nodo custom rilevato nel workflow.');
		return;
	}

	// Calcola i mancanti rispetto a ComfyUI (se raggiungibile). Se ComfyUI non risponde,
	// prova comunque a installare quelli risolvibili dal node-map (i nodi core non ci sono).
	const endpoint = configuredComfyEndpoint();
	let missing = used;
	try {
		const res = await fetch(`${endpoint}/object_info`, { signal: AbortSignal.timeout(25000) });
		if (res.ok) {
			const known = new Set(Object.keys(await res.json() as Record<string, unknown>));
			missing = used.filter(c => !known.has(c));
		}
	} catch {
		// ComfyUI non raggiungibile: `missing` resta `used`; i core verranno ignorati perché
		// non presenti nella mappa dei nodi custom.
	}
	if (!missing.length) {
		vscode.window.showInformationMessage('Tutti i nodi del workflow risultano già installati in ComfyUI.');
		return;
	}
	await installResolvedNodes(missing, `il file «${fileName}»`);
}

/**
 * Cerca un'installazione COMPLETA di CPython della stessa minor version (es. 3.13) da cui
 * copiare le librerie di sviluppo (`libs/pythonXY.lib` e gli header `include/`) che mancano
 * nel Python EMBEDDED. Prova il py-launcher e i percorsi d'installazione tipici su Windows.
 */
async function findFullPython(tag: string): Promise<string | undefined> {
	const candidates: string[] = [];
	// py-launcher (es. "py -3.13"): la via più affidabile se Python è installato.
	try {
		const major = tag.slice(0, 1);
		const minor = tag.slice(1);
		const { stdout } = await execAsync(`py -${major}.${minor} -c "import sys,os;print(os.path.dirname(sys.executable))"`, { timeout: 15000 });
		const p = stdout.trim().split(/\r?\n/).pop()?.trim();
		if (p) {
			candidates.push(p);
		}
	} catch { /* py-launcher assente */ }
	const la = process.env.LOCALAPPDATA;
	if (la) {
		candidates.push(path.join(la, 'Programs', 'Python', `Python${tag}`));
	}
	const pf = process.env.ProgramFiles;
	if (pf) {
		candidates.push(path.join(pf, `Python${tag}`));
	}
	candidates.push(`C:\\Python${tag}`);
	// Preferisci una sorgente che abbia ENTRAMBI lib e header; altrimenti accetta gli header.
	for (const c of candidates) {
		if (c && fs.existsSync(path.join(c, 'libs', `python${tag}.lib`)) && fs.existsSync(path.join(c, 'include', 'Python.h'))) {
			return c;
		}
	}
	for (const c of candidates) {
		if (c && (fs.existsSync(path.join(c, 'libs', `python${tag}.lib`)) || fs.existsSync(path.join(c, 'include', 'Python.h')))) {
			return c;
		}
	}
	return undefined;
}

/**
 * Riparazione BEST-EFFORT per il fallimento di SageAttention/Triton (compilazione CUDA a
 * runtime con tcc che esce con errore perché il Python embedded NON ha le dev libs: il classico
 * "Failed to find Python libs"). Tenta di:
 *  1. aggiungere `libs/pythonXY.lib` + header `Include/` al python embedded copiandoli da una
 *     installazione COMPLETA di Python della stessa versione (se presente);
 *  2. (re)installare `triton-windows`.
 * NON garantisce il successo (l'alternativa sicura resta disabilitare Sage Attention nel
 * workflow). Operazioni solo additive sul python embedded: non elimina nulla.
 */
export async function repairComfyTriton(): Promise<void> {
	const { python } = comfyPaths();
	if (!python) {
		vscode.window.showWarningMessage('Python embedded di ComfyUI non trovato. Imposta la cartella di ComfyUI (distribuzione portable) con "MGCoding: Seleziona cartella ComfyUI" e riprova.');
		return;
	}
	const pyDir = path.dirname(python);
	// Versione del python embedded (es. "313").
	let tag = '313';
	try {
		const { stdout } = await execAsync(`"${python}" -c "import sys;print(f'{sys.version_info.major}{sys.version_info.minor}')"`, { timeout: 20000 });
		const m = stdout.trim().match(/\d{2,3}/);
		if (m) {
			tag = m[0];
		}
	} catch { /* usa il default */ }
	const libName = `python${tag}.lib`;
	const libsDir = path.join(pyDir, 'libs');
	const includeDir = path.join(pyDir, 'Include');
	const steps: string[] = [];

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Riparo Triton/SageAttention…', cancellable: false },
		async () => {
			const haveLib = fs.existsSync(path.join(libsDir, libName));
			const haveInc = fs.existsSync(path.join(includeDir, 'Python.h'));
			// (1) Dev libs mancanti → copia da una full Python della stessa versione.
			if (!haveLib || !haveInc) {
				const full = await findFullPython(tag);
				if (full) {
					try {
						const srcLib = path.join(full, 'libs', libName);
						if (!haveLib && fs.existsSync(srcLib)) {
							fs.mkdirSync(libsDir, { recursive: true });
							fs.copyFileSync(srcLib, path.join(libsDir, libName));
							steps.push(`Copiato ${libName} da ${full}.`);
						}
						const srcInc = path.join(full, 'include');
						if (!haveInc && fs.existsSync(path.join(srcInc, 'Python.h'))) {
							fs.cpSync(srcInc, includeDir, { recursive: true, force: false, errorOnExist: false });
							steps.push(`Copiati gli header Python da ${full}.`);
						}
					} catch (e) {
						steps.push(`Copia delle dev libs non riuscita: ${e instanceof Error ? e.message : String(e)}.`);
					}
				} else {
					steps.push(`Non ho trovato un'installazione completa di Python ${tag[0]}.${tag.slice(1)} da cui copiare ${libName}/header. Installa Python ${tag[0]}.${tag.slice(1)} (python.org, stessa versione) e riprova, oppure disabilita Sage Attention.`);
				}
			} else {
				steps.push('Le dev libs Python (lib + header) erano già presenti.');
			}
			// (2) (re)installa triton-windows.
			try {
				await execAsync(`"${python}" -m pip install -U triton-windows`, { timeout: 600000 });
				steps.push('triton-windows (re)installato.');
			} catch (e) {
				steps.push(`pip install triton-windows fallito: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}.`);
			}
		}
	);

	const fixedLibs = fs.existsSync(path.join(libsDir, libName)) && fs.existsSync(path.join(includeDir, 'Python.h'));
	if (fixedLibs) {
		await vscode.window.showInformationMessage(
			`Riparazione completata. ${steps.join(' ')} RIAVVIA ComfyUI e riprova il workflow.`,
			'OK'
		);
	} else {
		await vscode.window.showWarningMessage(
			`Riparazione PARZIALE: le dev libs Python (${libName} + header) servono a Triton ma non sono state aggiunte.\n\n${steps.join('\n')}`,
			{ modal: true, detail: 'Alternativa SICURA: nel tuo workflow ComfyUI disabilita "Sage Attention" — di solito è il nodo KJNodes "Patch Sage Attention KJ" (impostalo su "disabled") oppure metti in bypass/mute il nodo (Ctrl+B / Ctrl+M). Il workflow girerà con l\'attention di PyTorch: un po\' più lento ma funziona subito, senza Triton.' },
			'OK'
		);
	}
}

/**
 * Scansiona `models/` di ComfyUI e restituisce i file di modello SOSPETTI perché troppo piccoli
 * (probabile download corrotto/incompleto: pagina HTML o puntatore Git LFS al posto del binario).
 * Esclude `embeddings/` (legittimamente piccoli). Ordina dal più piccolo; lista limitata.
 */
export async function findSuspiciousModelFiles(maxKB = 1024): Promise<{ rel: string; kb: number }[]> {
	const root = vscode.workspace.getConfiguration('mgcoding').get<string>('image.comfyRoot', '');
	if (!root) {
		return [];
	}
	const modelsRoot = path.join(root, 'models');
	if (!fs.existsSync(modelsRoot)) {
		return [];
	}
	const exts = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.gguf', '.bin', '.onnx', '.sft']);
	const out: { rel: string; kb: number }[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name.toLowerCase() === 'embeddings') {
					continue; // gli embedding sono legittimamente piccoli
				}
				walk(full, depth + 1);
			} else if (exts.has(path.extname(e.name).toLowerCase())) {
				try {
					const kb = Math.round(fs.statSync(full).size / 1024);
					if (kb < maxKB) {
						out.push({ rel: path.relative(modelsRoot, full), kb });
					}
				} catch { /* file sparito/illeggibile */ }
			}
		}
	};
	walk(modelsRoot, 0);
	return out.sort((a, b) => a.kb - b.kb).slice(0, 20);
}

/**
 * Apre nel file manager di sistema la cartella `models/` di ComfyUI (o la radice di ComfyUI se
 * `models/` non esiste). Utile quando un modello è corrotto/incompleto e va eliminato/riscaricato.
 */
export async function openComfyModelsFolder(): Promise<void> {
	const root = vscode.workspace.getConfiguration('mgcoding').get<string>('image.comfyRoot', '');
	if (!root) {
		vscode.window.showWarningMessage('Cartella di ComfyUI non impostata. Usa "MGCoding: Seleziona cartella ComfyUI" e riprova.');
		return;
	}
	const models = path.join(root, 'models');
	const target = fs.existsSync(models) ? models : root;
	await vscode.env.openExternal(vscode.Uri.file(target));
}

/** Mappa nomi di modulo Python ai pacchetti pip (alcuni differiscono dal nome importato). */
function pipPackageForModule(moduleName: string): string {
	const m = moduleName.trim().toLowerCase();
	if (m === 'triton') {
		return process.platform === 'win32' ? 'triton-windows' : 'triton';
	}
	return moduleName.trim();
}

/**
 * Installa un modulo Python MANCANTE nel python embedded di ComfyUI (es. `sageattention`,
 * `triton`), con conferma e progresso. Risolve i `ModuleNotFoundError` dei nodi che richiedono
	 * dipendenze opzionali. NON garantisce il successo: alcuni pacchetti (es. `sageattention`)
	 * richiedono build/CUDA/triton e possono fallire; in tal caso l'alternativa è disabilitare la
	 * funzione opzionale (Sage Attention) nel workflow.
	 */
export async function installComfyPythonModule(moduleName: string): Promise<void> {
	if (!moduleName || !moduleName.trim()) {
		return;
	}
	const { python } = comfyPaths();
	if (!python) {
		vscode.window.showWarningMessage('Python embedded di ComfyUI non trovato. Imposta la cartella di ComfyUI (distribuzione portable) e riprova.');
		return;
	}
	const pkg = pipPackageForModule(moduleName);
	const ok = await vscode.window.showWarningMessage(
		`Installo la dipendenza Python "${pkg}" nel python embedded di ComfyUI?`,
		{
			modal: true,
			detail: `Serve al nodo che richiede il modulo "${moduleName}". Nota: alcuni pacchetti (es. sageattention) richiedono build/CUDA/triton e potrebbero non installarsi; in tal caso disabilita "Sage Attention" nel workflow.`
		},
		'Installa'
	);
	if (ok !== 'Installa') {
		return;
	}
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Installo ${pkg} (pip)…`, cancellable: false },
		async () => {
			try {
				await execAsync(`"${python}" -m pip install -U ${pkg}`, { timeout: 600000 });
				vscode.window.showInformationMessage(`"${pkg}" installato nel python embedded. RIAVVIA ComfyUI per applicare.`);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Installazione di "${pkg}" fallita: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}. `
					+ 'Se è sageattention serve di solito triton-windows + un wheel compatibile con la tua versione di Python/torch, '
					+ 'oppure disabilita "Sage Attention" nel workflow per eseguirlo con l\'attention standard di PyTorch.'
				);
			}
		}
	);
}

/**
 * Nomi di modello disponibili in ComfyUI: tutte le opzioni stringa esposte da `/object_info`
 * (i campi a tendina dei loader elencano i file effettivamente installati). Lancia se ComfyUI
 * non è raggiungibile, così il chiamante può distinguere "nessun modello disponibile" da
 * "impossibile interrogare ComfyUI".
 */
async function availableModelNames(endpoint: string): Promise<Set<string>> {
	const available = new Set<string>();
	const res = await fetch(`${endpoint.replace(/\/$/, '')}/object_info`, { signal: AbortSignal.timeout(8000) });
	if (!res.ok) {
		throw new Error(`ComfyUI /object_info ha risposto ${res.status}`);
	}
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
	return available;
}

/**
 * Scarica automaticamente i MODELLI mancanti di un workflow (come i tool della community):
 * risolve i nomi file tramite la lista curata di ComfyUI-Manager (model-list.json) e li scarica
 * nelle cartelle giuste. Per i non risolti offre l'incolla-URL. RICHIEDE CONFERMA.
 */
export async function installMissingModelsForWorkflow(endpoint: string, workflowName: string): Promise<void> {
	const wf = await loadWorkflow(workflowName);
	if (!wf) {
		vscode.window.showWarningMessage(`Workflow «${workflowName}» non trovato.`);
		return;
	}
	// Rilevamento PURO dei modelli referenziati e mancanti tramite il modulo `modelRefs`
	// (Req 16.1): differenza tra i modelli del workflow e quelli installati in ComfyUI.
	const refs = detectModelRefs(wf as unknown as ApiWorkflow);
	if (!refs.length) {
		vscode.window.showInformationMessage('Questo workflow non referenzia modelli da scaricare.');
		return;
	}
	let available: Set<string>;
	try {
		available = await availableModelNames(endpoint);
	} catch (err) {
		vscode.window.showWarningMessage(`Non riesco a leggere i modelli da ComfyUI (${err instanceof Error ? err.message : String(err)}). È avviato su ${endpoint}?`);
		return;
	}
	const missing: ModelRef[] = computeMissingModels(refs, available);
	if (!missing.length) {
		vscode.window.showInformationMessage('Nessun modello mancante per questo workflow.');
		return;
	}
	const modelsDir = comfyModelsDir();
	if (!modelsDir) {
		vscode.window.showWarningMessage('Imposta prima la cartella di ComfyUI ("MGCoding: Seleziona cartella ComfyUI").');
		return;
	}
	// Cartella di destinazione dedotta dal tipo di campo (Req 16.2) per ogni file mancante.
	const refDirs = new Map(missing.map(r => [r.filename, r.dir]));
	// Lista curata di modelli di ComfyUI-Manager: filename -> {url, dir}.
	const catalog = new Map<string, { url: string; dir: string }>();
	try {
		const res = await fetch('https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json', { signal: AbortSignal.timeout(20000) });
		if (res.ok) {
			const data = await res.json() as { models?: { filename?: string; url?: string; type?: string; save_path?: string }[] };
			for (const m of data.models ?? []) {
				if (m.filename && m.url) {
					const dir = (m.save_path && m.save_path !== 'default') ? m.save_path : (m.type || '');
					catalog.set(m.filename, { url: m.url, dir });
				}
			}
		}
	} catch {
		// proseguo con catalog vuoto: tutti finiranno tra i "non risolti"
	}
	const resolved: { filename: string; url: string; dir: string }[] = [];
	const unresolved: ModelRef[] = [];
	for (const ref of missing) {
		const hit = catalog.get(ref.filename);
		if (hit) {
			// La cartella dedotta dal campo (Req 16.2) ha priorità; in mancanza, quella del catalogo.
			resolved.push({ filename: ref.filename, url: hit.url, dir: ref.dir || hit.dir || 'checkpoints' });
		} else {
			unresolved.push(ref);
		}
	}
	let cancelled = false;
	if (resolved.length) {
		// Conferma esplicita prima di scaricare (Req 16.2, 22.2).
		const ok = await vscode.window.showWarningMessage(
			`Scarico ${resolved.length} modello/i mancante/i del workflow «${workflowName}»?`,
			{ modal: true, detail: resolved.map(r => `• ${r.filename} → models/${r.dir}`).join('\n') + (unresolved.length ? `\n\nNon trovati nel catalogo (incolla URL a parte): ${unresolved.map(r => r.filename).join(', ')}` : '') },
			'Scarica'
		);
		if (ok === 'Scarica') {
			for (const r of resolved) {
				try {
					// `downloadFile` mostra avanzamento e consente l'annullamento (Req 16.4).
					await downloadFile(r.url, path.join(modelsDir, r.dir, r.filename), r.filename);
				} catch (err) {
					if (isAbortError(err)) {
						cancelled = true;
						break;
					}
					// Riporta il modello non scaricato e la causa (Req 16.5).
					vscode.window.showWarningMessage(`Download di ${r.filename} fallito: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}
	// Per i non risolti: chiedi un URL di download manuale (Req 16.3), uno per uno.
	if (!cancelled) {
		for (const ref of unresolved) {
			const url = (await vscode.window.showInputBox({ title: `Modello non trovato: ${ref.filename}`, prompt: `Incolla l'URL di download per "${ref.filename}" (vuoto = salta)`, placeHolder: 'https://...' }))?.trim();
			if (url) {
				try {
					await downloadFile(url, path.join(modelsDir, refDirs.get(ref.filename) ?? 'checkpoints', ref.filename), ref.filename);
				} catch (err) {
					if (isAbortError(err)) {
						cancelled = true;
						break;
					}
					vscode.window.showWarningMessage(`Download di ${ref.filename} fallito: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}
	if (cancelled) {
		vscode.window.showInformationMessage('Download modelli annullato.');
		return;
	}
	vscode.window.showInformationMessage('Download modelli completato. Se hai installato anche dei nodi, riavvia ComfyUI.');
}

/** Risolve un workflow: installa nodi mancanti E scarica i modelli mancanti. */
export async function fixWorkflow(endpoint: string, workflowName: string): Promise<void> {
	await installMissingNodesForWorkflow(endpoint, workflowName);
	await installMissingModelsForWorkflow(endpoint, workflowName);
}

/** Modelli del workflow NON disponibili in ComfyUI (confronto con /object_info). */
export async function missingModels(endpoint: string, workflow: Record<string, { inputs?: Record<string, unknown> }>): Promise<string[]> {
	// Rilevamento PURO tramite `modelRefs` (Req 16.1): differenza tra referenziati e disponibili.
	const refs = detectModelRefs(workflow as unknown as ApiWorkflow);
	if (!refs.length) {
		return [];
	}
	let available: Set<string>;
	try {
		available = await availableModelNames(endpoint);
	} catch {
		// ComfyUI non interrogabile: nessuna disponibilità nota.
		available = new Set<string>();
	}
	return computeMissingModels(refs, available).map(r => r.filename);
}
