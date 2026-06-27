/*---------------------------------------------------------------------------------------------
 *  MGCoding - Gestore_Modelli: rilevamento PURO dei riferimenti a modelli di un workflow API.
 *  Nessuna dipendenza da vscode/fetch: estrae i modelli referenziati (inclusi i pesi GGUF),
 *  deduce la cartella di destinazione dal tipo di campo e calcola i modelli mancanti come
 *  differenza insiemistica rispetto a quelli disponibili.
 *  Vedi design "Components and Interfaces > Gestore_Modelli e Gestore_Nodi".
 *  _Requirements: 9.1, 16.1, 16.2, 19.3_
 *--------------------------------------------------------------------------------------------*/

import { ApiWorkflow } from './workflowGraph';

/**
 * Riferimento a un modello richiesto da un workflow.
 * - `filename`: nome del file del modello (es. `wan2.2.gguf`, `sd_xl_base.safetensors`).
 * - `dir`: sottocartella di modelli ComfyUI attesa per quel tipo di campo (es. `checkpoints`).
 * - `viaGguf`: vero se il riferimento è un peso quantizzato GGUF (estensione `.gguf`).
 */
export interface ModelRef {
	filename: string;
	dir: string;
	viaGguf: boolean;
}

/**
 * Mappa nome-campo → sottocartella di modelli ComfyUI. Copre i campi nome-modello più comuni,
 * inclusi i campi usati dai nodi GGUF (`unet_name`, `gguf_name`, `clip_name`).
 */
const MODEL_DIR_BY_FIELD: Readonly<Record<string, string>> = {
	ckpt_name: 'checkpoints',
	checkpoint_name: 'checkpoints',
	vae_name: 'vae',
	lora_name: 'loras',
	lora_name_1: 'loras',
	lora_name_2: 'loras',
	lora_01: 'loras',
	lora_02: 'loras',
	unet_name: 'unet',
	gguf_name: 'unet',
	clip_name: 'clip',
	clip_name1: 'clip',
	clip_name2: 'clip',
	clip_name_1: 'clip',
	clip_name_2: 'clip',
	control_net_name: 'controlnet',
	controlnet_name: 'controlnet',
	style_model_name: 'style_models',
	upscale_model_name: 'upscale_models',
};

/** Cartella di fallback quando il tipo di campo non è riconosciuto. */
const DEFAULT_MODEL_DIR = 'checkpoints';

/**
 * Deduce la sottocartella di modelli ComfyUI per un nome di campo modello.
 * Per i campi noti (es. `ckpt_name`, `vae_name`, `lora_name`, `unet_name`, `clip_name`,
 * `control_net_name`, campi GGUF) restituisce la cartella attesa; altrimenti la cartella
 * predefinita `checkpoints`.
 * _Requirements: 16.2_
 */
export function keyToModelDir(field: string): string {
	return MODEL_DIR_BY_FIELD[field] ?? DEFAULT_MODEL_DIR;
}

/** Vero se il valore stringa è un file di pesi GGUF. */
function isGgufFile(value: string): boolean {
	return value.toLowerCase().endsWith('.gguf');
}

/**
 * Vero se il campo è un campo nome-modello da cui estrarre un riferimento.
 * Considera modello sia i campi noti (mappati a una cartella) sia qualunque campo il cui
 * valore sia un file `.gguf` (i nodi GGUF usano nomi di campo eterogenei).
 */
function isModelField(field: string, value: string): boolean {
	return field in MODEL_DIR_BY_FIELD || isGgufFile(value);
}

/**
 * Estrae i riferimenti a modelli da un workflow in formato API.
 * Considera solo i valori letterali stringa dei campi nome-modello (i link `[nodeId, slot]`
 * non sono nomi di file). I file `.gguf` sono inclusi con `viaGguf: true` (Req. 9.1, 19.3).
 * I riferimenti duplicati (stesso `filename` + `dir`) sono uniti una sola volta.
 * _Requirements: 9.1, 16.1, 19.3_
 */
export function referencedModels(wf: ApiWorkflow): ModelRef[] {
	const seen = new Set<string>();
	const refs: ModelRef[] = [];
	for (const node of Object.values(wf)) {
		if (!node || !node.inputs) {
			continue;
		}
		for (const [field, value] of Object.entries(node.inputs)) {
			if (typeof value !== 'string' || value.length === 0) {
				continue;
			}
			if (!isModelField(field, value)) {
				continue;
			}
			const ref: ModelRef = {
				filename: value,
				dir: keyToModelDir(field),
				viaGguf: isGgufFile(value),
			};
			const key = `${ref.dir}/${ref.filename}`;
			if (!seen.has(key)) {
				seen.add(key);
				refs.push(ref);
			}
		}
	}
	return refs;
}

/**
 * Calcola i modelli mancanti come differenza insiemistica: i riferimenti il cui `filename`
 * non è presente tra quelli disponibili. Preserva l'ordine e l'unicità dell'input.
 * _Requirements: 16.1_
 */
export function missingModels(refs: ModelRef[], available: Set<string>): ModelRef[] {
	return refs.filter(ref => !available.has(ref.filename));
}
