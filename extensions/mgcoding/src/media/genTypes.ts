/*---------------------------------------------------------------------------------------------
 *  MGCoding - Tipi condivisi della generazione autonoma (Orchestratore + Motore_Generazione).
 *  Modulo PURO riusabile: definisce richiesta, classificazione, piano, esito e gli elementi
 *  della Galleria. Vedi design "Components and Interfaces > Orchestratore" e "Data Models".
 *--------------------------------------------------------------------------------------------*/

/** Tipo di contenuto da generare: immagine, text-to-video, image-to-video. */
export type GenKind = 'image' | 't2v' | 'i2v';

/** Richiesta di generazione in linguaggio naturale + parametri opzionali. */
export interface GenRequest {
	prompt: string;
	/** Immagine iniziale in base64 (senza prefisso `data:`), se presente. */
	initImage?: string;
	/** Tipo forzato dall'utente; se assente lo classifica l'Orchestratore. */
	forcedKind?: GenKind;
	/** >=0 = seed fisso; assente/-1 = casuale. */
	seed?: number;
	/** Durata video (numero di fotogrammi). */
	frames?: number;
	fps?: number;
	aspect?: string;
}

/** Un passo del piano di esecuzione prodotto dall'Orchestratore. */
export interface PlanStepGen {
	kind: 'select-workflow' | 'check-deps' | 'set-inputs' | 'execute' | 'report';
	description: string;
}

/** Tipo di media prodotto/elencato nella Galleria. */
export type MediaKind = 'image' | 'video';

/** Un elemento generato e salvato nella Galleria (immagine o video). */
export interface GeneratedItem {
	uri: string;
	kind: MediaKind;
	/** Estensione/formato del file: png, webp, mp4, gif... */
	format: string;
	/** Timestamp ISO di creazione. */
	createdAt: string;
	sourcePrompt?: string;
}

/** Esito di un'esecuzione del piano di generazione. */
export interface GenOutcome {
	status: 'success' | 'failed' | 'cancelled' | 'needs-confirmation';
	media: GeneratedItem[];
	stepsExecuted: PlanStepGen[];
	failedStep?: PlanStepGen;
	/** Causa in linguaggio naturale, valorizzata in caso di fallimento. */
	cause?: string;
}
