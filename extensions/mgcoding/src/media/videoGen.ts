/*---------------------------------------------------------------------------------------------
 *  MGCoding - Motore_Generazione (video): adapter di esecuzione dei workflow video su ComfyUI.
 *  A differenza di `imageGen.ts` (che raccoglie solo immagini), questo adapter estende il flusso
 *  di accodamento/raccolta per recuperare anche gli output VIDEO dalla `/history` di ComfyUI,
 *  classificandoli con la logica PURA di `outputClassifier.ts`.
 *
 *  Responsabilità (Pilastro B — Autonomia di generazione):
 *   - Esegue workflow T2V e I2V; per l'I2V instrada l'immagine iniziale al nodo di caricamento
 *     immagine riusando `buildMapping` + `applyParams` (Req 5.2).
 *   - Applica i parametri di durata (frames) e frequenza (fps) al workflow (Req 5.3).
 *   - Recupera i file video prodotti dai nodi di output video scaricandoli via `/view`
 *     (Req 5.4, 6.3, 6.4) e, quando un'esecuzione produce sia immagini sia video, li raccoglie
 *     entrambi (Req 6.4).
 *   - Se il workflow non espone alcun nodo di output video, segnala che il workflow non produce
 *     video usando `producesVideo` (Req 5.5).
 *
 *  Dipende da `vscode`/`fetch` solo per l'I/O (accodamento, upload immagine, download file); la
 *  classificazione e la mappatura restano nella logica pura riusata.
 *  Vedi design "Motore_Generazione (`media/videoGen.ts`, `imageGen.ts`)".
 *  _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.3, 6.4_
 *--------------------------------------------------------------------------------------------*/

import { ApiWorkflow, LogicalParams } from './workflowGraph';
import { buildMapping, applyParams } from './workflowMapping';
import { classifyOutput, extensionOf, producesVideo } from './outputClassifier';
import { MediaKind } from './genTypes';

/** Tipo di generazione video supportato dall'adapter. */
export type VideoKind = 't2v' | 'i2v';

/**
 * Un singolo file di media recuperato da un'esecuzione ComfyUI e scaricato in base64.
 * - `filename`/`subfolder`/`type`: coordinate di `/view` da cui il file è stato scaricato.
 * - `format`: estensione/formato del file (es. `mp4`, `webp`, `png`), preservato dall'origine.
 * - `kind`: classificazione `video`/`image` calcolata da `classifyOutput` (logica pura).
 * - `nodeClassType`: `class_type` del nodo che ha prodotto l'output, quando noto.
 * - `data`: contenuto del file in base64 (senza prefisso `data:`).
 */
export interface CollectedFile {
	filename: string;
	subfolder: string;
	type: string;
	format: string;
	kind: MediaKind;
	nodeClassType?: string;
	data: string;
}

/** Output di un'esecuzione partizionato in immagini e video, scaricati in base64. */
export interface CollectedMedia {
	images: CollectedFile[];
	videos: CollectedFile[];
}

/** Parametri logici della generazione video (indipendenti dal workflow concreto). */
export interface VideoGenOptions {
	/** Prompt positivo da iniettare nei nodi di testo positivi. */
	prompt: string;
	/** Prompt negativo opzionale. */
	negativePrompt?: string;
	/** Immagine iniziale in base64 (senza prefisso `data:`) per l'I2V. */
	initImage?: string;
	/** Durata del video in numero di fotogrammi (Req 5.3). */
	frames?: number;
	/** Frequenza fotogrammi (fps) (Req 5.3). */
	fps?: number;
	/** Seed: >=0 = fisso; assente/-1 = casuale. */
	seed?: number;
	width?: number;
	height?: number;
	steps?: number;
	cfg?: number;
}

/** Esito di una generazione video: file video e (eventuali) immagini prodotte. */
export interface VideoGenResult {
	/** File video recuperati dai nodi di output video. */
	videos: CollectedFile[];
	/** Eventuali immagini prodotte dalla stessa esecuzione (Req 6.4). */
	images: CollectedFile[];
	/** Tipo di generazione effettivamente eseguito (T2V/I2V). */
	kind: VideoKind;
	/** Etichetta descrittiva del backend per i messaggi all'utente. */
	backendLabel: string;
}

/** Opzioni di basso livello dell'esecuzione (con punti di iniezione per i test). */
export interface VideoExecOptions {
	/** Implementazione `fetch` da usare (default: `fetch` globale). */
	fetchImpl?: typeof fetch;
	/** Identificativo client usato nell'accodamento del job. */
	clientId?: string;
	/** Intervallo del polling della history in ms (default 1000). */
	pollIntervalMs?: number;
	/**
	 * Numero massimo di tentativi di polling prima del timeout. I video sono lunghi da
	 * generare, quindi il default è ampio (1800 ≈ 30 min con intervallo da 1s).
	 */
	maxPolls?: number;
	/** Segnale di annullamento. */
	signal?: AbortSignal;
}

/** Descrittore di un file restituito da ComfyUI negli output di `/history`. */
interface ComfyFileRef {
	filename: string;
	subfolder?: string;
	type?: string;
	/** Formato/mime opzionale fornito da alcuni nodi (es. VHS_VideoCombine). */
	format?: string;
}

/** Errore sollevato quando il workflow non espone alcun nodo di output video (Req 5.5). */
export class NoVideoOutputError extends Error {
	constructor(message = 'Il workflow selezionato non produce video: non espone alcun nodo di output video (es. VHS_VideoCombine, SaveVideo, SaveAnimatedWEBP). Scegli o importa un workflow video.') {
		super(message);
		this.name = 'NoVideoOutputError';
	}
}

/** Rimuove la barra finale da un endpoint. */
function normalizeEndpoint(endpoint: string): string {
	return endpoint.replace(/\/$/, '');
}

/**
 * Carica un'immagine iniziale (base64) su ComfyUI tramite `POST /upload/image` e restituisce
 * il riferimento (`subfolder/name` o `name`) da collegare al nodo di caricamento immagine.
 * _Requirements: 5.2, 10.3_
 */
export async function uploadInitImage(
	endpoint: string,
	imageBase64: string,
	filename = 'mgcoding-i2v-init.png',
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<string> {
	const ep = normalizeEndpoint(endpoint);
	const fd = new FormData();
	fd.append('image', new Blob([Buffer.from(imageBase64, 'base64')], { type: 'image/png' }), filename);
	fd.append('overwrite', 'true');
	const res = await fetchImpl(`${ep}/upload/image`, { method: 'POST', body: fd, signal });
	if (!res.ok) {
		throw new Error(`ComfyUI: upload dell'immagine iniziale fallito (${res.status}).`);
	}
	const uploaded = await res.json() as { name: string; subfolder?: string };
	return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

/**
 * Estrae i riferimenti ai file dagli output di un nodo. ComfyUI espone gli output prodotti in
 * array per chiave (`images`, `gifs`, `videos`, ...): qualunque elemento con un campo
 * `filename` stringa è considerato un file di media. Questo è robusto rispetto ai nodi video
 * custom che usano chiavi diverse da `images`.
 */
function fileRefsFromOutput(out: Record<string, unknown>): ComfyFileRef[] {
	const refs: ComfyFileRef[] = [];
	for (const value of Object.values(out)) {
		if (!Array.isArray(value)) {
			continue;
		}
		for (const item of value) {
			if (item && typeof item === 'object' && typeof (item as { filename?: unknown }).filename === 'string') {
				const f = item as { filename: string; subfolder?: unknown; type?: unknown; format?: unknown };
				refs.push({
					filename: f.filename,
					subfolder: typeof f.subfolder === 'string' ? f.subfolder : '',
					type: typeof f.type === 'string' ? f.type : 'output',
					format: typeof f.format === 'string' ? f.format : undefined,
				});
			}
		}
	}
	return refs;
}

/** Vero se il formato/mime fornito da ComfyUI indica un contenuto animato (video). */
function isAnimatedFormat(format: string | undefined): boolean {
	return typeof format === 'string' && /video|gif|webm|mp4/i.test(format);
}

/**
 * Accoda un workflow ComfyUI, attende il completamento e raccoglie **sia le immagini sia i
 * video** prodotti, scaricandoli via `/view` e classificandoli con `classifyOutput` (logica
 * pura). A differenza di `queueAndCollect` (solo immagini), questa funzione partiziona ogni
 * file di output in `images`/`videos` usando la `class_type` del nodo produttore e
 * l'estensione/formato del file.
 *
 * La classificazione di ciascun output è quella di `classifyOutput`: copertura totale senza
 * perdite né duplicazioni (Property 17). Preserva il formato originale di ogni file (Req 6.3).
 * _Requirements: 5.4, 6.3, 6.4_
 */
export async function queueAndCollectMedia(
	endpoint: string,
	workflow: ApiWorkflow,
	options: VideoExecOptions = {}
): Promise<CollectedMedia> {
	const ep = normalizeEndpoint(endpoint);
	const fetchImpl = options.fetchImpl ?? fetch;
	const signal = options.signal;
	const pollIntervalMs = options.pollIntervalMs ?? 1000;
	const maxPolls = options.maxPolls ?? 1800;
	const clientId = options.clientId ?? `mgcoding-${Date.now()}`;

	const queue = await fetchImpl(`${ep}/prompt`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prompt: workflow, client_id: clientId }),
		signal
	});
	if (!queue.ok) {
		const t = await queue.text().catch(() => '');
		throw new Error(`ComfyUI ha rifiutato il job (${queue.status}): ${t.slice(0, 200)}`);
	}
	const { prompt_id } = await queue.json() as { prompt_id: string };

	for (let i = 0; i < maxPolls; i++) {
		if (signal?.aborted) {
			throw new Error('Annullato.');
		}
		await new Promise(r => setTimeout(r, pollIntervalMs));
		const h = await fetchImpl(`${ep}/history/${encodeURIComponent(prompt_id)}`, { signal }).catch(() => undefined);
		if (!h?.ok) {
			continue;
		}
		const hist = await h.json() as Record<string, { outputs?: Record<string, Record<string, unknown>> }>;
		const entry = hist[prompt_id];
		if (!entry?.outputs || Object.keys(entry.outputs).length === 0) {
			continue;
		}

		const result: CollectedMedia = { images: [], videos: [] };
		for (const [nodeId, out] of Object.entries(entry.outputs)) {
			const nodeClassType = workflow[nodeId]?.class_type;
			for (const ref of fileRefsFromOutput(out)) {
				const url = `${ep}/view?filename=${encodeURIComponent(ref.filename)}`
					+ `&subfolder=${encodeURIComponent(ref.subfolder ?? '')}`
					+ `&type=${encodeURIComponent(ref.type ?? 'output')}`;
				const v = await fetchImpl(url, { signal });
				if (!v.ok) {
					continue;
				}
				const data = Buffer.from(await v.arrayBuffer()).toString('base64');
				const kind = classifyOutput({
					filename: ref.filename,
					nodeClassType,
					animated: isAnimatedFormat(ref.format),
				});
				const file: CollectedFile = {
					filename: ref.filename,
					subfolder: ref.subfolder ?? '',
					type: ref.type ?? 'output',
					format: extensionOf(ref.filename),
					kind,
					nodeClassType,
					data,
				};
				if (kind === 'video') {
					result.videos.push(file);
				} else {
					result.images.push(file);
				}
			}
		}
		if (result.images.length > 0 || result.videos.length > 0) {
			return result;
		}
	}
	throw new Error('ComfyUI: timeout in attesa del risultato del video.');
}

/**
 * Costruisce i parametri logici da iniettare nel workflow a partire dalle opzioni di
 * generazione video. Include `frames`/`fps` (Req 5.3) e, per l'I2V, il riferimento
 * all'immagine iniziale già caricata su ComfyUI (Req 5.2).
 */
function buildVideoParams(opts: VideoGenOptions, initImageRef: string | undefined): LogicalParams {
	const params: LogicalParams = { positivePrompt: opts.prompt };
	if (opts.negativePrompt !== undefined) {
		params.negativePrompt = opts.negativePrompt;
	}
	if (opts.seed !== undefined) {
		params.seed = opts.seed;
	}
	if (opts.steps !== undefined) {
		params.steps = opts.steps;
	}
	if (opts.cfg !== undefined) {
		params.cfg = opts.cfg;
	}
	if (opts.width !== undefined) {
		params.width = opts.width;
	}
	if (opts.height !== undefined) {
		params.height = opts.height;
	}
	if (opts.frames !== undefined) {
		params.frames = opts.frames;
	}
	if (opts.fps !== undefined) {
		params.fps = opts.fps;
	}
	if (initImageRef !== undefined) {
		params.initImageRef = initImageRef;
	}
	return params;
}

/**
 * Esegue un workflow video su ComfyUI (T2V o I2V) e recupera i file prodotti.
 *
 * Passi:
 *  1. Verifica che il workflow esponga almeno un nodo di output video; in caso contrario
 *     solleva `NoVideoOutputError` per segnalare che il workflow non produce video (Req 5.5).
 *  2. Per l'I2V (immagine iniziale presente) carica l'immagine su ComfyUI e ne ottiene il
 *     riferimento, che `applyParams` instrada al nodo di caricamento immagine (Req 5.2).
 *  3. Costruisce la mappatura dei parametri (`buildMapping`) e inietta prompt, seed, durata
 *     (frames), fps e immagine iniziale con `applyParams` (immutabile) (Req 5.3, 9.x).
 *  4. Accoda il workflow risolto e raccoglie immagini e video (`queueAndCollectMedia`)
 *     (Req 5.1, 5.4, 6.3, 6.4).
 *
 * _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.3, 6.4_
 */
export async function generateVideo(
	endpoint: string,
	workflow: ApiWorkflow,
	opts: VideoGenOptions,
	options: VideoExecOptions = {}
): Promise<VideoGenResult> {
	// (1) Req 5.5: senza un nodo di output video il workflow non può produrre video.
	if (!producesVideo(workflow)) {
		throw new NoVideoOutputError();
	}

	const ep = normalizeEndpoint(endpoint);
	const fetchImpl = options.fetchImpl ?? fetch;
	const kind: VideoKind = opts.initImage ? 'i2v' : 't2v';

	// (2) I2V: carica l'immagine iniziale e ottieni il riferimento per il nodo LoadImage.
	let initImageRef: string | undefined;
	if (opts.initImage) {
		initImageRef = await uploadInitImage(ep, opts.initImage, 'mgcoding-i2v-init.png', fetchImpl, options.signal);
	}

	// (3) Mappatura + iniezione immutabile dei parametri (prompt, seed, frames/fps, immagine).
	const mapping = buildMapping(workflow);
	const params = buildVideoParams(opts, initImageRef);
	const resolved = applyParams(workflow, params, mapping);

	// (4) Esecuzione e raccolta di immagini + video.
	const media = await queueAndCollectMedia(ep, resolved, options);

	return {
		videos: media.videos,
		images: media.images,
		kind,
		backendLabel: `ComfyUI · ${kind.toUpperCase()}`,
	};
}
