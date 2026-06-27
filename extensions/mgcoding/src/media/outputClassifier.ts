/*---------------------------------------------------------------------------------------------
 *  MGCoding - Riconoscitore output: classificazione PURA degli output di generazione.
 *  Nessuna dipendenza da vscode/fetch. Distingue gli output in `video`/`image`, rileva se un
 *  workflow "produce video" (presenza di nodi di output video) e preserva il formato originale
 *  nel percorso di destinazione della Galleria. Partiziona elenchi di output/file in immagini
 *  e video senza perdite né duplicazioni.
 *  Vedi design "Motore_Generazione / Riconoscitore output" e Property 14, 15, 16, 17.
 *  _Requirements: 5.5, 6.1, 6.2, 6.3, 6.4, 7.1_
 *--------------------------------------------------------------------------------------------*/

import { ApiWorkflow } from './workflowGraph';
import { MediaKind } from './genTypes';

/**
 * Descrittore di un singolo output prodotto da un'esecuzione ComfyUI.
 * - `filename`: nome del file prodotto (es. `WAN_00001.mp4`, `ComfyUI_00001_.png`).
 * - `nodeClassType`: `class_type` del nodo che ha prodotto l'output, se noto (per riconoscere
 *   i nodi di combinazione video anche quando l'estensione non è di per sé un formato video).
 * - `animated`: vero se l'output è marcato esplicitamente come animato (es. WEBP/GIF animato).
 */
export interface OutputDescriptor {
	filename: string;
	nodeClassType?: string;
	animated?: boolean;
}

/**
 * Estensioni che sono **di per sé** formati video (a prescindere dal nodo che le produce).
 */
const PURE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
	'mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'flv', 'gifv',
]);

/**
 * Estensioni che, nel contesto della generazione, rappresentano sempre un'animazione (video).
 * Un GIF prodotto da un workflow di generazione è un'animazione.
 */
const ANIMATION_EXTENSIONS: ReadonlySet<string> = new Set([
	'gif',
]);

/**
 * Estensioni di **immagine** statica. `webp` è qui perché può essere sia statico sia animato:
 * a livello di solo nome file è trattato come immagine, mentre come `OutputDescriptor` diventa
 * video se marcato `animated`.
 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff',
]);

/**
 * Estensioni che possono essere animate (quindi video) solo se l'output è marcato `animated`.
 */
const ANIMATABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	'webp', 'png',
]);

/**
 * Pattern di `class_type` dei nodi che producono **output video** (combinazione video o
 * salvataggio di animazioni). Confrontati senza distinzione di maiuscole/minuscole.
 */
const VIDEO_OUTPUT_NODE_PATTERNS: RegExp[] = [
	/videocombine/i,        // VHS_VideoCombine, VideoCombine
	/video.*combine/i,
	/combine.*video/i,
	/savevideo/i,           // SaveVideo
	/createvideo/i,         // CreateVideo
	/saveanimated/i,        // SaveAnimatedWEBP, SaveAnimatedPNG
	/savewebm/i,            // SaveWEBM
	/savegif/i,
];

/**
 * Restituisce l'estensione (in minuscolo, senza punto) di un nome file o percorso.
 * Gestisce sia i separatori `/` sia `\`. Stringa vuota se non c'è estensione.
 */
export function extensionOf(filenameOrPath: string): string {
	const base = baseName(filenameOrPath);
	const dot = base.lastIndexOf('.');
	if (dot <= 0 || dot === base.length - 1) {
		// Nessun punto, oppure punto iniziale (dotfile), oppure punto finale: nessuna estensione.
		return '';
	}
	return base.slice(dot + 1).toLowerCase();
}

/** Ultimo segmento di un percorso, gestendo entrambi i separatori `/` e `\`. */
function baseName(filenameOrPath: string): string {
	const normalized = filenameOrPath.replace(/\\/g, '/');
	const idx = normalized.lastIndexOf('/');
	return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/**
 * Vero se la `class_type` indicata è un nodo di **output video** (combinazione video o
 * salvataggio di animazioni).
 * _Requirements: 5.5, 6.1_
 */
export function isVideoOutputNode(classType: string | undefined): boolean {
	if (typeof classType !== 'string' || classType.length === 0) {
		return false;
	}
	return VIDEO_OUTPUT_NODE_PATTERNS.some(re => re.test(classType));
}

/**
 * Vero se il workflow **produce video**: contiene almeno un nodo di output video.
 * Falso altrimenti. (Bicondizionale richiesto dalla Property 14.)
 * _Requirements: 5.5_
 */
export function producesVideo(wf: ApiWorkflow): boolean {
	for (const node of Object.values(wf)) {
		if (node && isVideoOutputNode(node.class_type)) {
			return true;
		}
	}
	return false;
}

/**
 * Classifica un **descrittore di output** di esecuzione in `video`/`image`.
 * È video se e solo se proviene da un nodo di combinazione/output video, oppure è un formato
 * di per sé video (mp4, webm, ...), oppure è un'animazione (gif), oppure è un'estensione
 * animabile (webp/png) marcata `animated`. Altrimenti è classificato come immagine.
 * _Requirements: 6.1, 6.2_
 */
export function classifyOutput(desc: OutputDescriptor): MediaKind {
	if (isVideoOutputNode(desc.nodeClassType)) {
		return 'video';
	}
	const ext = extensionOf(desc.filename);
	if (PURE_VIDEO_EXTENSIONS.has(ext) || ANIMATION_EXTENSIONS.has(ext)) {
		return 'video';
	}
	if (desc.animated === true && ANIMATABLE_IMAGE_EXTENSIONS.has(ext)) {
		return 'video';
	}
	return 'image';
}

/**
 * Classifica un file in base alla sola **estensione**. Restituisce `video`/`image` per le
 * estensioni di media note, `undefined` per le estensioni non multimediali (es. `.txt`).
 * A livello di solo nome file, `webp` è trattato come immagine e `gif` come video (animazione).
 * _Requirements: 6.4, 7.1_
 */
export function classifyFile(filename: string): MediaKind | undefined {
	const ext = extensionOf(filename);
	if (PURE_VIDEO_EXTENSIONS.has(ext) || ANIMATION_EXTENSIONS.has(ext)) {
		return 'video';
	}
	if (IMAGE_EXTENSIONS.has(ext)) {
		return 'image';
	}
	return undefined;
}

/** Risultato di un partizionamento in immagini e video. */
export interface MediaPartition<T> {
	images: T[];
	videos: T[];
}

/**
 * Partiziona un elenco di **descrittori di output** in immagini e video. Ogni descrittore è
 * assegnato a esattamente una categoria (`classifyOutput`): copertura totale senza perdite né
 * duplicazioni. Preserva l'ordine relativo all'interno di ciascuna categoria.
 * _Requirements: 6.4, 7.1_
 */
export function partitionOutputs(outputs: readonly OutputDescriptor[]): MediaPartition<OutputDescriptor> {
	const images: OutputDescriptor[] = [];
	const videos: OutputDescriptor[] = [];
	for (const out of outputs) {
		if (classifyOutput(out) === 'video') {
			videos.push(out);
		} else {
			images.push(out);
		}
	}
	return { images, videos };
}

/**
 * Partiziona un elenco di **nomi file** (es. contenuto di una cartella di output) in immagini
 * e video in base all'estensione. I file con estensione non multimediale sono esclusi da
 * entrambe le categorie. Ogni file di media noto compare in esattamente una categoria, senza
 * perdite né duplicazioni. Preserva l'ordine relativo.
 * _Requirements: 6.4, 7.1_
 */
export function partitionFiles(files: readonly string[]): MediaPartition<string> {
	const images: string[] = [];
	const videos: string[] = [];
	for (const file of files) {
		const kind = classifyFile(file);
		if (kind === 'video') {
			videos.push(file);
		} else if (kind === 'image') {
			images.push(file);
		}
		// estensione non multimediale: ignorata (nessuna perdita di media noti).
	}
	return { images, videos };
}

/**
 * Costruisce il percorso di destinazione nella Galleria **preservando il formato/estensione**
 * del file di origine. Se `newBaseName` è fornito (senza estensione), gli applica l'estensione
 * originale; altrimenti riusa il nome file di origine. Usa il separatore `/`.
 * _Requirements: 6.3_
 */
export function destinationPath(sourceFilename: string, destDir: string, newBaseName?: string): string {
	const ext = extensionOf(sourceFilename);
	const dir = destDir.replace(/[\\/]+$/, '');
	let name: string;
	if (newBaseName !== undefined && newBaseName.length > 0) {
		name = ext ? `${newBaseName}.${ext}` : newBaseName;
	} else {
		name = baseName(sourceFilename);
	}
	return dir.length > 0 ? `${dir}/${name}` : name;
}
