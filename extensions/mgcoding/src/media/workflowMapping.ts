/*---------------------------------------------------------------------------------------------
 *  MGCoding - Motore_Workflow: mappatura PURA dei parametri logici sui nodi/campi del grafo
 *  e persistenza (serialize/deserialize) della mappatura risolta per il riuso.
 *  Nessuna dipendenza da vscode/fetch: costruisce la `ParamMapping` percorrendo il grafo
 *  (sampler -> nodo di testo, campi seed/steps/cfg/dimensioni, nodo immagine, campi video),
 *  calcola i parametri non mappabili come differenza insiemistica e serializza/deserializza
 *  una `SavedWorkflowMapping` (hash della struttura del grafo + mappatura + timestamp).
 *
 *  `applyParams` è la trasformazione PURA e IMMUTABILE che inietta i parametri logici nei
 *  nodi/campi indicati dalla mappatura: prompt nel solo nodo di testo risolto via link del
 *  sampler, seed (fisso/casuale) coerente su tutti i campi seed, immagine iniziale, frames/fps,
 *  preservando i link (LoRA inclusi). Clona l'input e non lo muta.
 *
 *  Vedi design "Components and Interfaces > Motore_Workflow" e "Data Models > Mappatura risolta".
 *  _Requirements: 3.1, 3.3, 3.4, 5.2, 5.3, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5_
 *--------------------------------------------------------------------------------------------*/

import {
	ApiWorkflow,
	LogicalParams,
	ParamMapping,
	WorkflowValue,
	findSamplers,
	isLink,
	resolveConditioningTextNode,
} from './workflowGraph';

/** Una singola destinazione concreta di un parametro logico: `(nodeId, field)`. */
type Destination = { nodeId: string; field: string };

/**
 * Campi che, se presenti tra gli `inputs` di un nodo, espongono un valore di **seed**
 * (un seed o un rumore-seed di campionamento, in modo coerente tra gli stadi multipli).
 */
const SEED_FIELDS: readonly string[] = ['seed', 'noise_seed'];

/** Campi che espongono il numero di **fotogrammi** (durata) nei nodi video. */
const FRAME_FIELDS: readonly string[] = ['frames', 'num_frames', 'length', 'video_frames'];

/** Campi che espongono la **frequenza fotogrammi** (fps) nei nodi video. */
const FPS_FIELDS: readonly string[] = ['fps', 'frame_rate'];

/** Campo di testo standard di un nodo di codifica conditioning (`CLIPTextEncode`). */
const TEXT_FIELD = 'text';

/** Campo del riferimento immagine di un nodo di caricamento immagine (`LoadImage`). */
const IMAGE_FIELD = 'image';

/**
 * Raccoglie le destinazioni `(nodeId, field)` per cui uno dei `fields` indicati è presente
 * tra gli `inputs` del nodo. Ogni voce prodotta referenzia quindi un campo esistente
 * (garanzia per la Property 7). I nodi sono visitati in ordine deterministico.
 */
function fieldDestinations(wf: ApiWorkflow, fields: readonly string[]): Destination[] {
	const result: Destination[] = [];
	for (const [nodeId, node] of Object.entries(wf)) {
		if (!node || !node.inputs) {
			continue;
		}
		for (const field of fields) {
			if (field in node.inputs) {
				result.push({ nodeId, field });
			}
		}
	}
	return result;
}

/**
 * Risale dai sampler ai nodi di testo del conditioning per lo slot indicato
 * (`positive`/`negative`) e raccoglie le destinazioni `(nodeId, 'text')`, deduplicando i
 * nodi raggiunti da più sampler. Include solo i nodi che espongono effettivamente il campo
 * `text` tra gli `inputs`, così ogni voce referenzia un campo esistente (Property 7).
 */
function promptDestinations(wf: ApiWorkflow, samplerIds: string[], slot: 'positive' | 'negative'): Destination[] {
	const seen = new Set<string>();
	const result: Destination[] = [];
	for (const samplerId of samplerIds) {
		const textNodeId = resolveConditioningTextNode(wf, samplerId, slot);
		if (textNodeId === undefined || seen.has(textNodeId)) {
			continue;
		}
		const node = wf[textNodeId];
		if (node && node.inputs && TEXT_FIELD in node.inputs) {
			seen.add(textNodeId);
			result.push({ nodeId: textNodeId, field: TEXT_FIELD });
		}
	}
	return result;
}

/**
 * Raccoglie le destinazioni del riferimento immagine iniziale: i nodi di caricamento
 * immagine (`class_type` ~ `LoadImage`) che espongono il campo `image`.
 */
function imageDestinations(wf: ApiWorkflow): Destination[] {
	const result: Destination[] = [];
	for (const [nodeId, node] of Object.entries(wf)) {
		if (!node || !node.inputs) {
			continue;
		}
		if (typeof node.class_type === 'string' && /loadimage/i.test(node.class_type) && IMAGE_FIELD in node.inputs) {
			result.push({ nodeId, field: IMAGE_FIELD });
		}
	}
	return result;
}

/**
 * Costruisce la mappatura risolta tra i parametri logici e i nodi/campi concreti del
 * workflow, percorrendo il grafo:
 * - `positivePrompt`/`negativePrompt`: nodo di testo risolto via link `positive`/`negative` dei sampler;
 * - `seed`: tutti i nodi con un campo `seed`/`noise_seed`;
 * - `steps`/`cfg`/`width`/`height`: tutti i nodi che espongono il campo omonimo;
 * - `initImageRef`: i nodi di caricamento immagine;
 * - `frames`/`fps`: i campi corrispondenti dei nodi video.
 *
 * Ogni voce prodotta punta a una coppia `(nodeId, field)` esistente nel workflow
 * (i campi vengono inclusi solo se presenti tra gli `inputs`), garantendo la Property 7.
 * Una chiave è presente nella mappatura solo se esiste almeno una destinazione.
 * _Requirements: 3.1_
 */
export function buildMapping(wf: ApiWorkflow): ParamMapping {
	const mapping: ParamMapping = {};
	const samplers = findSamplers(wf);

	const positive = promptDestinations(wf, samplers, 'positive');
	if (positive.length > 0) {
		mapping.positivePrompt = positive;
	}
	const negative = promptDestinations(wf, samplers, 'negative');
	if (negative.length > 0) {
		mapping.negativePrompt = negative;
	}

	const seed = fieldDestinations(wf, SEED_FIELDS);
	if (seed.length > 0) {
		mapping.seed = seed;
	}
	const steps = fieldDestinations(wf, ['steps']);
	if (steps.length > 0) {
		mapping.steps = steps;
	}
	const cfg = fieldDestinations(wf, ['cfg']);
	if (cfg.length > 0) {
		mapping.cfg = cfg;
	}
	const width = fieldDestinations(wf, ['width']);
	if (width.length > 0) {
		mapping.width = width;
	}
	const height = fieldDestinations(wf, ['height']);
	if (height.length > 0) {
		mapping.height = height;
	}

	const initImage = imageDestinations(wf);
	if (initImage.length > 0) {
		mapping.initImageRef = initImage;
	}

	const frames = fieldDestinations(wf, FRAME_FIELDS);
	if (frames.length > 0) {
		mapping.frames = frames;
	}
	const fps = fieldDestinations(wf, FPS_FIELDS);
	if (fps.length > 0) {
		mapping.fps = fps;
	}

	return mapping;
}

/* -------------------------------------------------------------------------------------------
 * applyParams — iniezione PURA e IMMUTABILE dei parametri logici sul grafo.
 * _Requirements: 5.2, 5.3, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5_
 * ----------------------------------------------------------------------------------------- */

/** Limite superiore (incluso) del seed casuale: intero a 32 bit non negativo (`2^32 - 1`). */
const MAX_SEED = 0xffffffff;

/**
 * Produce un seed casuale: un intero non negativo nell'intervallo `[0, MAX_SEED]`.
 * Non dipende da `vscode`/`fetch`; il valore è usato in modo coerente su tutti i campi seed.
 */
function randomSeed(): number {
	return Math.floor(Math.random() * (MAX_SEED + 1));
}

/**
 * Clona in profondità un workflow API preservando le tuple-link `[nodeId, slot]` (che restano
 * array) e gli `_meta`. Il clone è indipendente dall'originale: nessuna struttura è condivisa,
 * così `applyParams` non muta mai il workflow in ingresso.
 */
function cloneWorkflow(wf: ApiWorkflow): ApiWorkflow {
	return JSON.parse(JSON.stringify(wf)) as ApiWorkflow;
}

/**
 * Applica i parametri logici al workflow in modo **immutabile**: clona l'input, scrive i
 * valori nelle destinazioni `(nodeId, field)` risolte dalla `mapping` e restituisce il clone.
 * Il workflow originale non viene mai modificato.
 *
 * Regole di iniezione:
 * - **Prompt** positivo/negativo: scritti solo nei nodi di testo risolti via link del sampler
 *   (le destinazioni `positivePrompt`/`negativePrompt` della mappatura), lasciando invariati
 *   gli altri nodi di testo (Req. 9.4, 10.1, 10.2).
 * - **Seed**: fisso quando `params.seed >= 0`, altrimenti casuale (`[0, MAX_SEED]`); lo stesso
 *   valore è scritto su **tutti** i campi seed (`seed`/`noise_seed`) per coerenza tra gli stadi
 *   multipli (Req. 9.2, 10.4, 10.5). Il seed viene sempre impostato anche senza un valore fisso.
 * - **Immagine iniziale**: instradata al campo immagine dei nodi di caricamento (Req. 5.2, 10.3).
 * - **frames/fps**: applicati ai campi di durata/frequenza dei nodi video (Req. 5.3).
 * - **steps/cfg/width/height**: applicati alle destinazioni mappate.
 *
 * Un input che è un **link** (`[nodeId, slot]`) non viene mai sovrascritto, così i collegamenti
 * dei LoRA — e ogni altro input collegato — restano identici (Req. 9.3).
 */
export function applyParams(wf: ApiWorkflow, params: LogicalParams, mapping: ParamMapping): ApiWorkflow {
	const result = cloneWorkflow(wf);

	/** Scrive `value` nella destinazione, saltando i campi assenti e gli input collegati (link). */
	const setDestination = (dest: { nodeId: string; field: string }, value: WorkflowValue): void => {
		const node = result[dest.nodeId];
		if (!node || !node.inputs || !(dest.field in node.inputs)) {
			return;
		}
		// Mai sovrascrivere un input che è un link: preserva i collegamenti (LoRA inclusi).
		if (isLink(node.inputs[dest.field])) {
			return;
		}
		node.inputs[dest.field] = value;
	};

	/** Applica `value` a tutte le destinazioni mappate per il parametro `key`. */
	const applyToAll = (key: keyof LogicalParams, value: WorkflowValue): void => {
		const destinations = mapping[key];
		if (!destinations) {
			return;
		}
		for (const dest of destinations) {
			setDestination(dest, value);
		}
	};

	if (params.positivePrompt !== undefined) {
		applyToAll('positivePrompt', params.positivePrompt);
	}
	if (params.negativePrompt !== undefined) {
		applyToAll('negativePrompt', params.negativePrompt);
	}

	// Seed: fisso se >=0, altrimenti casuale; stesso valore coerente su tutti i campi seed.
	const seedValue = params.seed !== undefined && params.seed >= 0
		? Math.floor(params.seed)
		: randomSeed();
	applyToAll('seed', seedValue);

	if (params.steps !== undefined) {
		applyToAll('steps', params.steps);
	}
	if (params.cfg !== undefined) {
		applyToAll('cfg', params.cfg);
	}
	if (params.width !== undefined) {
		applyToAll('width', params.width);
	}
	if (params.height !== undefined) {
		applyToAll('height', params.height);
	}
	if (params.initImageRef !== undefined) {
		applyToAll('initImageRef', params.initImageRef);
	}
	if (params.frames !== undefined) {
		applyToAll('frames', params.frames);
	}
	if (params.fps !== undefined) {
		applyToAll('fps', params.fps);
	}

	return result;
}

/**
 * Restituisce esattamente i parametri logici **richiesti** che non compaiono come chiavi
 * (con destinazione valorizzata) nella mappatura: la differenza insiemistica `required \ keys(mapping)`.
 * L'ordine del primo riscontro nell'input è preservato e i duplicati sono rimossi, così il
 * risultato è esattamente l'insieme dei parametri non mappabili (né più né meno).
 * _Requirements: 3.4_
 */
export function unmappedParams(required: (keyof LogicalParams)[], mapping: ParamMapping): (keyof LogicalParams)[] {
	const seen = new Set<keyof LogicalParams>();
	const result: (keyof LogicalParams)[] = [];
	for (const param of required) {
		if (seen.has(param)) {
			continue;
		}
		seen.add(param);
		if (mapping[param] === undefined) {
			result.push(param);
		}
	}
	return result;
}

/* -------------------------------------------------------------------------------------------
 * Persistenza della mappatura risolta (riuso su esecuzioni successive).
 * Serialize/deserialize sono funzioni PURE (string <-> object); la scrittura su file è una
 * preoccupazione separata e sottile gestita altrove (adapter di I/O).
 * _Requirements: 3.3_
 * ----------------------------------------------------------------------------------------- */

/** Mappatura risolta persistita per un workflow, per riusarla nelle esecuzioni successive. */
export interface SavedWorkflowMapping {
	/** Hash della **struttura** del grafo (class_type + topologia dei link), non dei valori. */
	workflowHash: string;
	mapping: ParamMapping;
	/** Timestamp ISO di risoluzione della mappatura. */
	resolvedAt: string;
}

/**
 * Rappresentazione canonica e deterministica della **struttura** di un workflow:
 * nodi in ordine di id, ciascuno con `class_type` e, per ogni input (in ordine di nome),
 * la destinazione del link `field=>srcId:slot` oppure il marcatore `field=L` per i valori
 * letterali. Cattura tipi di nodo e topologia dei collegamenti ignorando i valori concreti.
 */
function canonicalStructure(wf: ApiWorkflow): string {
	const nodeIds = Object.keys(wf).sort();
	const parts: string[] = [];
	for (const nodeId of nodeIds) {
		const node = wf[nodeId];
		const classType = node && typeof node.class_type === 'string' ? node.class_type : '';
		const inputs = node && node.inputs ? node.inputs : {};
		const inputParts = Object.keys(inputs).sort().map(field => {
			const value = inputs[field];
			return isLink(value) ? `${field}=>${value[0]}:${value[1]}` : `${field}=L`;
		});
		parts.push(`${nodeId}|${classType}|${inputParts.join(',')}`);
	}
	return parts.join(';');
}

/**
 * Calcola un hash deterministico della struttura del grafo tramite FNV-1a (32 bit) sulla
 * rappresentazione canonica. Workflow con identica struttura producono lo stesso hash;
 * differenze di tipo nodo o topologia producono hash diversi. Funzione pura.
 */
export function computeWorkflowHash(wf: ApiWorkflow): string {
	const input = canonicalStructure(wf);
	let hash = 0x811c9dc5; // offset basis FNV-1a 32 bit
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// moltiplicazione per il prime FNV (16777619) in aritmetica a 32 bit non segnata
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Costruisce una `SavedWorkflowMapping` dato un workflow, la mappatura risolta e l'istante
 * di risoluzione. L'hash è derivato dalla struttura del grafo. Funzione pura.
 */
export function createSavedMapping(wf: ApiWorkflow, mapping: ParamMapping, resolvedAt: string): SavedWorkflowMapping {
	return {
		workflowHash: computeWorkflowHash(wf),
		mapping,
		resolvedAt,
	};
}

/**
 * Serializza una `SavedWorkflowMapping` in stringa JSON. Funzione pura: insieme a
 * `deserializeMapping` garantisce il round-trip (Property 8).
 * _Requirements: 3.3_
 */
export function serializeMapping(saved: SavedWorkflowMapping): string {
	return JSON.stringify(saved);
}

/**
 * Deserializza una `SavedWorkflowMapping` da stringa JSON. Funzione pura inversa di
 * `serializeMapping`; lancia se il JSON non è valido o non rappresenta una mappatura salvata.
 * _Requirements: 3.3_
 */
export function deserializeMapping(json: string): SavedWorkflowMapping {
	const parsed = JSON.parse(json) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('SavedWorkflowMapping non valida: atteso un oggetto JSON.');
	}
	const obj = parsed as Partial<SavedWorkflowMapping>;
	if (typeof obj.workflowHash !== 'string' || typeof obj.resolvedAt !== 'string'
		|| !obj.mapping || typeof obj.mapping !== 'object' || Array.isArray(obj.mapping)) {
		throw new Error('SavedWorkflowMapping non valida: campi mancanti o di tipo errato.');
	}
	return {
		workflowHash: obj.workflowHash,
		mapping: obj.mapping as ParamMapping,
		resolvedAt: obj.resolvedAt,
	};
}

/**
 * Percorso relativo del file di mappatura persistita per un workflow di nome `name`:
 * `.mg/workflows/.mappings/{name}.json`. Restituisce un percorso con separatori POSIX
 * (la scrittura effettiva è gestita da un adapter di I/O che lo risolve rispetto al workspace).
 * Funzione pura.
 * _Requirements: 3.3_
 */
export function mappingFilePath(name: string): string {
	return `.mg/workflows/.mappings/${name}.json`;
}
