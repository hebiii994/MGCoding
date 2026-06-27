/*---------------------------------------------------------------------------------------------
 *  MGCoding - Recupero_Errori: classificazione PURA degli errori di esecuzione ComfyUI e
 *  pianificazione dell'azione correttiva con budget di tentativi.
 *  Logica PURA (nessuna dipendenza da vscode/fetch): l'esecuzione concreta delle azioni
 *  (installazione nodi, download modelli, riduzione memoria, riavvio) vive negli adapter.
 *  Vedi design "Components and Interfaces > Recupero_Errori".
 *  _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_
 *--------------------------------------------------------------------------------------------*/

/** Causa classificata di un errore di esecuzione ComfyUI. */
export type ErrorCause = 'missing-node' | 'missing-model' | 'oom-vram' | 'unknown';

/**
 * Errore classificato.
 * - `cause`: categoria della causa.
 * - `detail`: messaggio originale (utile per riportarlo in linguaggio naturale).
 * - `subject`: nome del nodo/modello coinvolto, se estraibile dal messaggio.
 */
export interface ClassifiedError {
	cause: ErrorCause;
	detail: string;
	subject?: string;
}

/**
 * Azione correttiva pianificata.
 * - `kind`: tipo di azione da intraprendere.
 * - `requiresConfirmation`: vero quando l'azione richiede una conferma esplicita dell'utente
 *   (clonazione codice di terzi per i nodi, download di modelli).
 */
export interface RecoveryAction {
	kind: 'install-node' | 'download-model' | 'reduce-memory' | 'give-up';
	requiresConfirmation: boolean;
}

/** Numero massimo di tentativi di ritentativo consentiti (Req. 18.6). */
export const MAX_RETRIES = 3;

/**
 * Marcatori caratteristici della memoria VRAM insufficiente.
 * Coprono i messaggi tipici di PyTorch/CUDA e le formulazioni generiche di OOM.
 */
const OOM_MARKERS: readonly RegExp[] = [
	/out of memory/i,
	/\boom\b/i,
	/cuda error: out of memory/i,
	/insufficient (?:vram|memory)/i,
	/not enough (?:vram|memory)/i,
	/failed to allocate/i,
	/cannot allocate memory/i,
	/\ballocation (?:on device )?failed/i,
	/\bvram\b/i,
];

/**
 * Marcatori caratteristici di un nodo custom mancante.
 * Coprono i messaggi di ComfyUI quando una `class_type` non è registrata.
 */
const MISSING_NODE_MARKERS: readonly RegExp[] = [
	/node type[s]? (?:were |was )?not found/i,
	/node type[s]? .*not in list/i,
	/cannot execute because (?:a )?node/i,
	/does not exist.*(?:node|class[_ ]?type)/i,
	/(?:unknown|unrecognized|missing) node(?: type)?/i,
	/class[_ ]?type .*not found/i,
];

/**
 * Marcatori caratteristici di un file di modello mancante.
 * Coprono i messaggi di file non trovato e i riferimenti a checkpoint/LoRA/VAE assenti.
 */
const MISSING_MODEL_MARKERS: readonly RegExp[] = [
	/model .*not found/i,
	/(?:checkpoint|lora|vae|unet|clip|controlnet) .*not found/i,
	/no such file or directory/i,
	/value not in list/i,
	/file .*not found/i,
	/could not find .*(?:model|checkpoint|\.safetensors|\.ckpt|\.gguf|\.pt|\.pth|\.bin)/i,
	/\berrno 2\b/i,
];

/** Tenta di estrarre tra virgolette (apici singoli/doppi) il soggetto coinvolto. */
function extractQuoted(message: string): string | undefined {
	const match = message.match(/['"`]([^'"`]+)['"`]/);
	return match ? match[1] : undefined;
}

/** Vero se almeno un marcatore corrisponde al messaggio. */
function matchesAny(message: string, markers: readonly RegExp[]): boolean {
	return markers.some(re => re.test(message));
}

/**
 * Classifica un messaggio di errore di esecuzione ComfyUI in una delle cause note.
 * Restituisce sempre una causa tra `missing-node`, `missing-model`, `oom-vram`, `unknown`.
 * La VRAM insufficiente ha priorità (è la causa più specifica e operativamente distinta),
 * seguita dal nodo mancante e dal modello mancante; in assenza di marcatori la causa è
 * `unknown`.
 * _Requirements: 18.1_
 */
export function classifyError(message: string): ClassifiedError {
	const detail = typeof message === 'string' ? message : String(message ?? '');

	if (matchesAny(detail, OOM_MARKERS)) {
		return { cause: 'oom-vram', detail };
	}
	if (matchesAny(detail, MISSING_NODE_MARKERS)) {
		const subject = extractQuoted(detail);
		return subject ? { cause: 'missing-node', detail, subject } : { cause: 'missing-node', detail };
	}
	if (matchesAny(detail, MISSING_MODEL_MARKERS)) {
		const subject = extractQuoted(detail);
		return subject ? { cause: 'missing-model', detail, subject } : { cause: 'missing-model', detail };
	}
	return { cause: 'unknown', detail };
}

/**
 * Pianifica l'azione correttiva data la causa classificata e il numero di tentativi già usati.
 * - Causa `unknown` oppure tentativi >= `MAX_RETRIES` ⇒ `give-up` (Req. 18.5, 18.6).
 * - `missing-node` ⇒ `install-node` con conferma richiesta (Req. 18.2).
 * - `missing-model` ⇒ `download-model` con conferma richiesta (Req. 18.3).
 * - `oom-vram` ⇒ `reduce-memory` senza conferma (riduzione automatica entro i limiti, Req. 18.4).
 * Garantisce che il numero di ritentativi non superi mai `MAX_RETRIES`.
 * _Requirements: 18.2, 18.3, 18.4, 18.5, 18.6_
 */
export function planRecovery(err: ClassifiedError, attempt: number): RecoveryAction {
	if (err.cause === 'unknown' || attempt >= MAX_RETRIES) {
		return { kind: 'give-up', requiresConfirmation: false };
	}
	switch (err.cause) {
		case 'missing-node':
			return { kind: 'install-node', requiresConfirmation: true };
		case 'missing-model':
			return { kind: 'download-model', requiresConfirmation: true };
		case 'oom-vram':
			return { kind: 'reduce-memory', requiresConfirmation: false };
		default:
			return { kind: 'give-up', requiresConfirmation: false };
	}
}
