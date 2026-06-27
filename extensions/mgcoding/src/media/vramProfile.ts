/*---------------------------------------------------------------------------------------------
 *  MGCoding - Profilo VRAM: selezione PURA dei parametri di generazione compatibili con un
 *  limite di VRAM, riduzione progressiva del consumo di memoria per livelli (`MemoryTier`) e
 *  preferenza per le varianti quantizzate GGUF a bassa VRAM.
 *  Logica PURA (nessuna dipendenza da vscode/fetch): l'applicazione concreta (esecuzione del
 *  workflow, download del modello) vive negli adapter / nell'Orchestratore.
 *  Vedi design "Data Models > Profilo VRAM" e Requirement 19.
 *  _Requirements: 18.4, 19.1, 19.2, 19.3_
 *--------------------------------------------------------------------------------------------*/

/** Profilo di memoria della GPU disponibile. */
export interface VramProfile {
	/** Limite di VRAM in gigabyte. */
	limitGB: number;
}

/**
 * Parametri di generazione che incidono sul consumo di memoria.
 * `frames` è presente solo per le generazioni video.
 */
export interface GenParams {
	steps: number;
	cfg: number;
	width: number;
	height: number;
	frames?: number;
}

/**
 * Livelli di riduzione progressiva applicati dal Recupero_Errori.
 * `0` = parametri predefiniti (nessuna riduzione), `3` = minimo consumo di memoria.
 */
export type MemoryTier = 0 | 1 | 2 | 3;

/**
 * Soglie compatibili (valori massimi consentiti) per un dato limite di VRAM.
 * I parametri predefiniti restano sempre entro queste soglie.
 */
export interface VramThresholds {
	maxSteps: number;
	maxWidth: number;
	maxHeight: number;
	maxFrames: number;
}

/** Limite (incluso) entro cui una GPU è considerata "a bassa VRAM" (Req. 19.1, 19.3). */
export const LOW_VRAM_GB = 8;

/**
 * Minimi assoluti consentiti per la riduzione di memoria: la riduzione non scende mai sotto
 * questi valori (Req. 18.4, 19.2). Larghezza e altezza minime sono multipli di 8 (vincolo dei
 * sampler ComfyUI).
 */
export const MIN_GEN_PARAMS: Readonly<{ steps: number; width: number; height: number; frames: number }> = {
	steps: 8,
	width: 256,
	height: 256,
	frames: 8,
};

/** Granularità (multipli) richiesta per larghezza/altezza dai sampler ComfyUI. */
const DIM_GRANULARITY = 8;

/**
 * Fattori di scala per livello di riduzione. Tutti `<= 1`, così da non aumentare mai i
 * parametri (Req. 18.4, 19.2). Il livello `0` è l'identità.
 */
const TIER_STEP_FACTOR: Readonly<Record<MemoryTier, number>> = { 0: 1, 1: 0.85, 2: 0.7, 3: 0.55 };
const TIER_DIM_FACTOR: Readonly<Record<MemoryTier, number>> = { 0: 1, 1: 0.85, 2: 0.75, 3: 0.5 };
const TIER_FRAME_FACTOR: Readonly<Record<MemoryTier, number>> = { 0: 1, 1: 0.75, 2: 0.5, 3: 0.5 };

/**
 * Restituisce le soglie compatibili (massimi consentiti) per il limite di VRAM indicato.
 * Più la VRAM è bassa, più strette sono le soglie. Espone i valori usati da `defaultParams`
 * così che i parametri predefiniti possano essere verificati rispetto alle soglie (Req. 19.1).
 */
export function vramThresholds(limitGB: number): VramThresholds {
	if (limitGB <= 4) {
		return { maxSteps: 20, maxWidth: 512, maxHeight: 512, maxFrames: 16 };
	}
	if (limitGB <= 6) {
		return { maxSteps: 24, maxWidth: 640, maxHeight: 640, maxFrames: 24 };
	}
	if (limitGB <= LOW_VRAM_GB) {
		return { maxSteps: 30, maxWidth: 768, maxHeight: 768, maxFrames: 32 };
	}
	return { maxSteps: 40, maxWidth: 1280, maxHeight: 1280, maxFrames: 81 };
}

/**
 * Seleziona parametri di generazione predefiniti compatibili con il limite di VRAM indicato.
 * Per limiti pari o inferiori a 8 GB i parametri restano entro le soglie compatibili definite
 * da `vramThresholds` per quel limite (Req. 19.1).
 * _Requirements: 19.1_
 */
export function defaultParams(limitGB: number): GenParams {
	if (limitGB <= 4) {
		return { steps: 18, cfg: 7, width: 512, height: 512 };
	}
	if (limitGB <= 6) {
		return { steps: 22, cfg: 7, width: 640, height: 640 };
	}
	if (limitGB <= LOW_VRAM_GB) {
		return { steps: 26, cfg: 7, width: 768, height: 768 };
	}
	return { steps: 30, cfg: 7, width: 1024, height: 1024 };
}

/**
 * Riduce un conteggio (passi/frame) col fattore del livello, senza scendere sotto il minimo e
 * senza mai aumentarlo rispetto al valore corrente.
 */
function reduceCount(value: number, factor: number, min: number): number {
	const scaled = Math.floor(value * factor);
	const clamped = Math.max(min, scaled);
	return Math.min(value, clamped);
}

/**
 * Riduce una dimensione (larghezza/altezza) col fattore del livello, arrotondando al multiplo
 * di 8 inferiore, senza scendere sotto il minimo e senza mai aumentarla.
 */
function reduceDimension(value: number, factor: number, min: number): number {
	const scaled = Math.floor((value * factor) / DIM_GRANULARITY) * DIM_GRANULARITY;
	const clamped = Math.max(min, scaled);
	return Math.min(value, clamped);
}

/**
 * Applica la riduzione progressiva di memoria corrispondente a un `MemoryTier`.
 * Garantisce che `steps`, `width`, `height` (e `frames`, se presente) non siano mai maggiori
 * dei valori correnti e mai inferiori ai minimi consentiti (`MIN_GEN_PARAMS`). Il livello `0`
 * lascia invariati i parametri (per input già conformi ai minimi). `cfg` non è ridotto perché
 * non incide sul consumo di memoria. La funzione è immutabile: non muta l'input.
 * _Requirements: 18.4, 19.2_
 */
export function reduceForTier(params: GenParams, tier: MemoryTier): GenParams {
	const reduced: GenParams = {
		steps: reduceCount(params.steps, TIER_STEP_FACTOR[tier], MIN_GEN_PARAMS.steps),
		cfg: params.cfg,
		width: reduceDimension(params.width, TIER_DIM_FACTOR[tier], MIN_GEN_PARAMS.width),
		height: reduceDimension(params.height, TIER_DIM_FACTOR[tier], MIN_GEN_PARAMS.height),
	};
	if (params.frames !== undefined) {
		reduced.frames = reduceCount(params.frames, TIER_FRAME_FACTOR[tier], MIN_GEN_PARAMS.frames);
	}
	return reduced;
}

/** Variante di un modello richiesto, con l'indicazione se è un peso quantizzato GGUF. */
export interface ModelVariant {
	/** Nome del file della variante (es. `wan2.2-Q4_K_M.gguf`, `wan2.2.safetensors`). */
	filename: string;
	/** Vero se la variante è un peso quantizzato GGUF. */
	gguf: boolean;
}

/**
 * Seleziona la variante di modello preferita per un profilo VRAM.
 * A bassa VRAM (`limitGB <= LOW_VRAM_GB`), se è disponibile una variante quantizzata GGUF la
 * preferisce per ridurre il consumo di memoria (Req. 19.3); altrimenti restituisce la prima
 * variante disponibile. Restituisce `undefined` se non ci sono varianti.
 * _Requirements: 19.3_
 */
export function preferVariant(variants: ModelVariant[], profile: VramProfile): ModelVariant | undefined {
	if (variants.length === 0) {
		return undefined;
	}
	if (profile.limitGB <= LOW_VRAM_GB) {
		const gguf = variants.find(v => v.gguf);
		if (gguf) {
			return gguf;
		}
	}
	return variants[0];
}
