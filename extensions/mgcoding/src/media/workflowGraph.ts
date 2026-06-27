/*---------------------------------------------------------------------------------------------
 *  MGCoding - Motore_Workflow: modello del grafo di un workflow ComfyUI in formato API.
 *  Logica PURA (nessuna dipendenza da vscode/fetch): tipi base del grafo e guardie di tipo,
 *  base per la mappatura robusta degli input (link vs valore letterale).
 *  Vedi design "Components and Interfaces > Motore_Workflow" e "Data Models".
 *--------------------------------------------------------------------------------------------*/

/**
 * Un input di un nodo è un valore scalare (testo, seed, nome file), `null`, oppure un
 * **link** `[nodeId, slotIndex]` che referenzia l'output di un altro nodo. Gli array annidati
 * coprono gli input compositi usati da alcuni nodi.
 */
export type WorkflowValue = string | number | boolean | null | [string, number] | WorkflowValue[];

/** Nodo di un workflow in formato API (dizionario `class_type` + `inputs`). */
export interface ApiNode {
	class_type: string;
	inputs: Record<string, WorkflowValue>;
	_meta?: { title?: string };
}

/** Un workflow API è un dizionario `nodeId -> nodo`. */
export type ApiWorkflow = Record<string, ApiNode>;

/** Parametri logici indipendenti dal workflow concreto (mappati sui nodi via `ParamMapping`). */
export interface LogicalParams {
	positivePrompt?: string;
	negativePrompt?: string;
	/** Assente => seed casuale. */
	seed?: number;
	steps?: number;
	cfg?: number;
	width?: number;
	height?: number;
	/** Nome del file immagine caricato su ComfyUI (ingresso I2V). */
	initImageRef?: string;
	frames?: number;
	fps?: number;
}

/** Mappatura risolta: parametro logico → elenco di destinazioni `(nodeId, field)`. */
export type ParamMapping = Partial<Record<keyof LogicalParams, { nodeId: string; field: string }[]>>;

/**
 * Vero se `v` è un **link** `[nodeId, slotIndex]`: una tupla con primo elemento stringa
 * (id del nodo sorgente) e secondo elemento numero (indice di slot di output).
 */
export function isLink(v: WorkflowValue): v is [string, number] {
	return Array.isArray(v)
		&& v.length === 2
		&& typeof v[0] === 'string'
		&& typeof v[1] === 'number';
}

/**
 * Vero se `obj` è un workflow in **formato API**: un oggetto (non array) i cui valori sono
 * nodi con `class_type` stringa e `inputs` oggetto. Un oggetto vuoto non è considerato un
 * workflow API valido.
 */
export function isApiFormat(obj: unknown): obj is ApiWorkflow {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
		return false;
	}
	const values = Object.values(obj as Record<string, unknown>);
	if (values.length === 0) {
		return false;
	}
	return values.every(n => {
		if (!n || typeof n !== 'object' || Array.isArray(n)) {
			return false;
		}
		const node = n as { class_type?: unknown; inputs?: unknown };
		return typeof node.class_type === 'string'
			&& !!node.inputs
			&& typeof node.inputs === 'object'
			&& !Array.isArray(node.inputs);
	});
}

/**
 * Segue il **link** dell'input `field` del nodo `nodeId` fino al nodo sorgente e ne
 * restituisce l'id. Restituisce `undefined` se il nodo o il campo non esistono, oppure
 * se il valore del campo è un valore letterale (non un link).
 */
export function resolveSource(wf: ApiWorkflow, nodeId: string, field: string): string | undefined {
	const node = wf[nodeId];
	if (!node || !node.inputs || !(field in node.inputs)) {
		return undefined;
	}
	const value = node.inputs[field];
	if (isLink(value)) {
		const [sourceId] = value;
		// Il nodo sorgente deve esistere nel workflow per essere una risoluzione valida.
		return sourceId in wf ? sourceId : undefined;
	}
	return undefined;
}

/**
 * Trova i nodi **sampler** del workflow, ossia quelli il cui `class_type` contiene
 * "Sampler" (es. `KSampler`, `KSamplerAdvanced`, `SamplerCustom`, `KSamplerSelect`).
 * Restituisce gli id dei nodi corrispondenti.
 */
export function findSamplers(wf: ApiWorkflow): string[] {
	const result: string[] = [];
	for (const [nodeId, node] of Object.entries(wf)) {
		if (node && typeof node.class_type === 'string' && /sampler/i.test(node.class_type)) {
			result.push(nodeId);
		}
	}
	return result;
}

/**
 * Vero se il nodo è un nodo di **codifica testo** del conditioning: `class_type` che
 * contiene `CLIPTextEncode` (es. `CLIPTextEncode`, `CLIPTextEncodeSDXL`) oppure, in modo
 * più permissivo, un nodo che espone un input `text` di tipo stringa.
 */
function isTextEncodeNode(node: ApiNode | undefined): boolean {
	if (!node || typeof node.class_type !== 'string') {
		return false;
	}
	if (/cliptextencode/i.test(node.class_type)) {
		return true;
	}
	return typeof node.inputs?.text === 'string';
}

/**
 * Risale dall'input `positive`/`negative` di un sampler fino al nodo di testo
 * (`CLIPTextEncode`) che alimenta quel conditioning, attraversando eventuali nodi
 * intermedi (combinazioni di conditioning, ControlNet, ecc.). Restituisce l'id del nodo
 * di testo, oppure `undefined` se non raggiungibile.
 */
export function resolveConditioningTextNode(wf: ApiWorkflow, samplerId: string, slot: 'positive' | 'negative'): string | undefined {
	const start = resolveSource(wf, samplerId, slot);
	if (start === undefined) {
		return undefined;
	}
	// Visita in ampiezza risalendo i link di input, fermandosi al primo nodo di testo.
	const visited = new Set<string>();
	const queue: string[] = [start];
	while (queue.length > 0) {
		const currentId = queue.shift()!;
		if (visited.has(currentId)) {
			continue;
		}
		visited.add(currentId);
		const node = wf[currentId];
		if (!node) {
			continue;
		}
		if (isTextEncodeNode(node)) {
			return currentId;
		}
		// Accoda tutti i nodi sorgente raggiunti dai link di input di questo nodo.
		for (const value of Object.values(node.inputs ?? {})) {
			if (isLink(value)) {
				const [sourceId] = value;
				if (sourceId in wf && !visited.has(sourceId)) {
					queue.push(sourceId);
				}
			}
		}
	}
	return undefined;
}
