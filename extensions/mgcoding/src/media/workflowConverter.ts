/*---------------------------------------------------------------------------------------------
 *  MGCoding - Convertitore_Workflow: conversione PURA e deterministica di un workflow
 *  ComfyUI dal formato UI (litegraph: `nodes[]` + `links[]`) al formato API
 *  (`nodeId -> { class_type, inputs }`).
 *  Logica PURA (nessuna dipendenza da vscode/fetch): l'import del workflow, il fallback
 *  all'endpoint ComfyUI e l'estrazione da archivio restano in un adapter dedicato.
 *  Vedi design "Components and Interfaces > Convertitore_Workflow" e Req. 15.2.
 *--------------------------------------------------------------------------------------------*/

import { ApiNode, ApiWorkflow, WorkflowValue, isApiFormat } from './workflowGraph';

/**
 * Workflow in **formato UI** (litegraph), così come esportato dall'editor di ComfyUI.
 * - `nodes`: elenco dei nodi del grafo; ogni nodo ha un `id`, un `type` (la `class_type`),
 *   gli eventuali `widgets_values` (valori dei widget **in ordine**), e gli slot `inputs`/
 *   `outputs` (connessioni del grafo).
 * - `links`: elenco dei collegamenti; ogni link è la tupla
 *   `[linkId, originNodeId, originSlot, targetNodeId, targetSlot, type]`.
 */
export interface UiWorkflow {
	nodes: { id: number | string; type: string; widgets_values?: unknown[]; inputs?: unknown[]; outputs?: unknown[] }[];
	links: [number, number, number, number, number, string][];
}

/**
 * Specifica di un singolo input come riportato da `/object_info`: una tupla in cui il
 * **primo elemento** descrive il tipo. Il tipo è una stringa (es. `"INT"`, `"STRING"`,
 * `"MODEL"`, `"LATENT"`) oppure un array di opzioni (combo/menu a tendina).
 */
export type ObjectInfoInputSpec = [unknown, ...unknown[]];

/**
 * Metadati per-classe esposti da `/object_info`: per ogni `class_type`, l'ordinamento
 * degli input `required` (e `optional`). L'ordine delle chiavi è significativo e viene
 * usato per associare i `widgets_values` (privi di nome) al nome di input corretto.
 */
export type ObjectInfo = Record<string, {
	input?: {
		required?: Record<string, ObjectInfoInputSpec>;
		optional?: Record<string, ObjectInfoInputSpec>;
	};
}>;

/** Esito della conversione: il workflow API, oppure un fallimento con il motivo. */
export type ConversionResult =
	| { ok: true; api: ApiWorkflow }
	| { ok: false; reason: string };

/**
 * Tipi di input che in ComfyUI sono renderizzati come **widget** (valore inline) e quindi
 * compaiono in `widgets_values`, anziché come slot di connessione. Un input il cui tipo è
 * un array di opzioni (combo) è anch'esso un widget.
 */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'BOOL', 'NUMBER']);

/**
 * Vero se la specifica di input di `/object_info` descrive un **widget** (valore inline):
 * tipo combo (array di opzioni) oppure tipo primitivo. In caso contrario è uno slot di
 * connessione, alimentato da un link.
 */
function isWidgetInput(spec: ObjectInfoInputSpec | undefined): boolean {
	if (!spec || spec.length === 0) {
		return false;
	}
	const type = spec[0];
	if (Array.isArray(type)) {
		return true; // combo/menu a tendina
	}
	return typeof type === 'string' && WIDGET_TYPES.has(type.toUpperCase());
}

/**
 * Nomi degli input di una `class_type` nell'**ordine dichiarato** in `/object_info`
 * (`required` seguiti da `optional`). L'ordine è ciò che permette di associare i
 * `widgets_values` (posizionali) ai rispettivi nomi.
 */
function orderedInputNames(objectInfo: ObjectInfo, classType: string): { name: string; widget: boolean }[] | undefined {
	const entry = objectInfo[classType];
	if (!entry || !entry.input) {
		return undefined;
	}
	const result: { name: string; widget: boolean }[] = [];
	for (const group of [entry.input.required, entry.input.optional]) {
		if (!group) {
			continue;
		}
		for (const [name, spec] of Object.entries(group)) {
			result.push({ name, widget: isWidgetInput(spec) });
		}
	}
	return result;
}

/** Vero se `v` è un oggetto non-null e non-array. */
function isObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Vero se `obj` è un workflow in **formato UI** (`nodes[]` + `links[]`) e **non** in
 * formato API. Richiede un array `nodes` (i cui elementi espongono `id` e `type` stringa)
 * e un array `links`.
 */
export function isUiFormat(obj: unknown): obj is UiWorkflow {
	if (!isObject(obj)) {
		return false;
	}
	if (isApiFormat(obj)) {
		return false;
	}
	const { nodes, links } = obj as { nodes?: unknown; links?: unknown };
	if (!Array.isArray(nodes) || !Array.isArray(links)) {
		return false;
	}
	return nodes.every(n => {
		if (!isObject(n)) {
			return false;
		}
		const node = n as { id?: unknown; type?: unknown };
		return (typeof node.id === 'string' || typeof node.id === 'number')
			&& typeof node.type === 'string';
	});
}

/**
 * Indice `linkId -> [originNodeId, originSlot]` costruito dalla tabella `links` del formato
 * UI. Gli id dei nodi sono normalizzati a stringa per coerenza col formato API.
 */
function buildLinkIndex(links: UiWorkflow['links']): Map<number, [string, number]> {
	const index = new Map<number, [string, number]>();
	for (const link of links) {
		if (!Array.isArray(link) || link.length < 5) {
			continue;
		}
		const [linkId, originNodeId, originSlot] = link;
		if (typeof linkId === 'number' && originNodeId !== undefined && typeof originSlot === 'number') {
			index.set(linkId, [String(originNodeId), originSlot]);
		}
	}
	return index;
}

/**
 * Conversione **locale, pura e deterministica** da formato UI a formato API (Req. 15.2).
 *
 * Per ogni nodo UI produce un nodo API con la stessa `class_type` (`node.type`) e ne
 * ricostruisce gli `inputs` da due fonti:
 *  - **slot di connessione**: gli `inputs` del nodo che hanno un `link` valido diventano
 *    riferimenti `[originNodeId, originSlot]` risolti tramite la tabella `links` (topologia);
 *  - **widget**: i `widgets_values` (posizionali) sono associati ai nomi di input di tipo
 *    widget nell'ordine dichiarato in `objectInfo`, saltando quelli già forniti via link.
 *
 * Restituisce `{ ok: false, reason }` se mancano i metadati `objectInfo` necessari per
 * ordinare i `widgets_values` di un nodo. La funzione non muta gli input.
 */
export function convertUiToApi(ui: UiWorkflow, objectInfo: ObjectInfo): ConversionResult {
	if (!ui || !Array.isArray(ui.nodes)) {
		return { ok: false, reason: 'Workflow UI non valido: campo "nodes" mancante o non valido.' };
	}
	const linkIndex = buildLinkIndex(Array.isArray(ui.links) ? ui.links : []);
	const api: ApiWorkflow = {};

	for (const node of ui.nodes) {
		const classType = node.type;
		const nodeId = String(node.id);
		const inputs: Record<string, WorkflowValue> = {};

		// 1) Slot di connessione: ricostruisce la topologia dai link in ingresso.
		const connectedNames = new Set<string>();
		const uiInputs = Array.isArray(node.inputs) ? node.inputs : [];
		for (const raw of uiInputs) {
			if (!isObject(raw)) {
				continue;
			}
			const name = raw['name'];
			const link = raw['link'];
			if (typeof name !== 'string') {
				continue;
			}
			if (typeof link === 'number') {
				const source = linkIndex.get(link);
				if (source) {
					inputs[name] = [source[0], source[1]];
					connectedNames.add(name);
				}
			}
		}

		// 2) Widget: associa i widgets_values posizionali ai nomi di input via objectInfo.
		const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
		if (widgetValues.length > 0) {
			const ordered = orderedInputNames(objectInfo, classType);
			if (!ordered) {
				return {
					ok: false,
					reason: `Conversione non possibile: metadati /object_info mancanti per la classe "${classType}" (necessari per ordinare i valori dei widget).`,
				};
			}
			const widgetNames = ordered
				.filter(i => i.widget && !connectedNames.has(i.name))
				.map(i => i.name);
			const count = Math.min(widgetNames.length, widgetValues.length);
			for (let i = 0; i < count; i++) {
				inputs[widgetNames[i]] = widgetValues[i] as WorkflowValue;
			}
		}

		const apiNode: ApiNode = { class_type: classType, inputs };
		api[nodeId] = apiNode;
	}

	return { ok: true, api };
}
