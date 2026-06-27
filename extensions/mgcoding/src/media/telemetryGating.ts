/*---------------------------------------------------------------------------------------------
 *  MGCoding - Logica PURA per telemetria e gating delle funzioni.
 *  Nessuna dipendenza da `vscode`/`fetch`: questo modulo non invia telemetria né interroga
 *  ComfyUI, ma fornisce due funzioni deterministiche e testabili:
 *    1. `buildTelemetryEvent` costruisce un evento di telemetria che ESCLUDE il testo dei
 *       prompt da qualsiasi campo serializzato (Req. 21.3, Property 36).
 *    2. `enabledFeatures` calcola l'insieme delle funzioni abilitate: quando ComfyUI non è
 *       disponibile esclude esattamente le funzioni dipendenti da ComfyUI e mantiene le altre
 *       (Req. 23.1, Property 37).
 *  Vedi design "Error Handling/Degrado controllato" e Property 36 & 37.
 *  _Requirements: 21.3, 23.1_
 *--------------------------------------------------------------------------------------------*/

// ---------------------------------------------------------------------------------------------
// 1) Costruzione evento di telemetria (Req. 21.3, Property 36)
// ---------------------------------------------------------------------------------------------

/** Valore consentito nelle proprietà di telemetria (scalari/serializzabili). */
export type TelemetryValue = string | number | boolean | null | TelemetryValue[] | { [key: string]: TelemetryValue };

/**
 * Input per la costruzione di un evento di telemetria. Può contenere il testo dei prompt
 * (positivo/negativo) e proprietà arbitrarie: la funzione garantisce che il testo dei prompt
 * non finisca nell'evento risultante.
 */
export interface TelemetryInput {
	/** Nome dell'evento (identificatore controllato dal chiamante, non derivato dal prompt). */
	event: string;
	/** Testo del prompt positivo, da NON includere mai nella telemetria. */
	prompt?: string;
	/** Testo del prompt negativo, da NON includere mai nella telemetria. */
	negativePrompt?: string;
	/** Proprietà arbitrarie associate all'evento (verranno sanificate). */
	properties?: Record<string, TelemetryValue>;
	/** Misurazioni numeriche associate all'evento (non possono contenere testo di prompt). */
	measurements?: Record<string, number>;
}

/** Evento di telemetria sanificato, privo del testo dei prompt. */
export interface TelemetryEvent {
	event: string;
	properties: Record<string, TelemetryValue>;
	measurements: Record<string, number>;
}

/** Segnaposto usato al posto dei valori che conterrebbero il testo di un prompt. */
export const REDACTED = '[redacted]';

/**
 * Nomi di campo che notoriamente trasportano testo di prompt. Le proprietà con queste chiavi
 * (confronto senza distinzione di maiuscole/minuscole) vengono rimosse a prescindere dal valore.
 */
const PROMPT_BEARING_KEYS: ReadonlySet<string> = new Set([
	'prompt',
	'prompts',
	'positiveprompt',
	'negativeprompt',
	'positive_prompt',
	'negative_prompt',
	'prompttext',
	'prompt_text',
	'text',
	'query',
	'content',
	'message',
	'input',
	'inputtext',
	'input_text',
	'userprompt',
	'user_prompt',
]);

/** Vero se la chiave (normalizzata) è una chiave nota per il trasporto di prompt. */
function isPromptBearingKey(key: string): boolean {
	return PROMPT_BEARING_KEYS.has(key.toLowerCase());
}

/**
 * Restituisce i testi di prompt non vuoti da escludere. I prompt vuoti vengono ignorati:
 * non c'è nulla da redarre e la stringa vuota è sottostringa di qualsiasi testo.
 */
function promptSecrets(input: TelemetryInput): string[] {
	const out: string[] = [];
	if (typeof input.prompt === 'string' && input.prompt.length > 0) {
		out.push(input.prompt);
	}
	if (typeof input.negativePrompt === 'string' && input.negativePrompt.length > 0) {
		out.push(input.negativePrompt);
	}
	return out;
}

/** Vero se la stringa contiene uno qualsiasi dei testi di prompt da escludere. */
function containsSecret(value: string, secrets: string[]): boolean {
	return secrets.some(secret => value.includes(secret));
}

/**
 * Sanifica ricorsivamente un valore di proprietà:
 *  - rimuove le chiavi note per il trasporto di prompt;
 *  - sostituisce con `REDACTED` ogni stringa che contiene il testo di un prompt.
 */
function sanitizeValue(value: TelemetryValue, secrets: string[]): TelemetryValue {
	if (typeof value === 'string') {
		return containsSecret(value, secrets) ? REDACTED : value;
	}
	if (Array.isArray(value)) {
		return value.map(v => sanitizeValue(v, secrets));
	}
	if (value !== null && typeof value === 'object') {
		const out: { [key: string]: TelemetryValue } = {};
		for (const [k, v] of Object.entries(value)) {
			if (isPromptBearingKey(k)) {
				continue;
			}
			out[k] = sanitizeValue(v, secrets);
		}
		return out;
	}
	// number | boolean | null: non possono contenere testo.
	return value;
}

/**
 * Costruisce un evento di telemetria sanificato a partire dall'input.
 *
 * Garanzie (Req. 21.3 / Property 36):
 *  - il testo dei prompt (`prompt`, `negativePrompt`) non viene mai copiato nell'evento;
 *  - le proprietà con chiavi note per il trasporto di prompt vengono rimosse;
 *  - qualunque valore stringa (anche annidato) che contenga il testo di un prompt viene redatto;
 *  - di conseguenza la serializzazione dell'evento non contiene il testo dei prompt.
 *
 * Il nome dell'evento e le misurazioni numeriche sono preservati così come forniti.
 */
export function buildTelemetryEvent(input: TelemetryInput): TelemetryEvent {
	const secrets = promptSecrets(input);
	const sanitizedProps = sanitizeValue(input.properties ?? {}, secrets) as Record<string, TelemetryValue>;

	const measurements: Record<string, number> = {};
	for (const [k, v] of Object.entries(input.measurements ?? {})) {
		if (typeof v === 'number' && Number.isFinite(v)) {
			measurements[k] = v;
		}
	}

	return {
		event: input.event,
		properties: sanitizedProps,
		measurements,
	};
}

// ---------------------------------------------------------------------------------------------
// 2) Gating delle funzioni / degrado controllato (Req. 23.1, Property 37)
// ---------------------------------------------------------------------------------------------

/**
 * Descrittore di una funzione di MGCoding. `dependsOnComfy` indica se la funzione richiede
 * un'istanza di ComfyUI raggiungibile per essere utilizzabile.
 */
export interface FeatureDescriptor {
	/** Identificatore stabile della funzione. */
	id: string;
	/** Descrizione leggibile (opzionale), utile per i messaggi all'utente (Req. 23.3). */
	label?: string;
	/** Vero se la funzione dipende da ComfyUI. */
	dependsOnComfy: boolean;
}

/**
 * Calcola l'insieme delle funzioni abilitate data la disponibilità di ComfyUI.
 *
 * Regole (Req. 23.1 / Property 37):
 *  - se ComfyUI è disponibile, tutte le funzioni sono abilitate;
 *  - se ComfyUI NON è disponibile, sono abilitate esattamente le funzioni che NON dipendono
 *    da ComfyUI; quelle dipendenti vengono escluse.
 *
 * L'ordine di `features` è preservato. La funzione è pura e non muta l'input.
 */
export function enabledFeatures(features: readonly FeatureDescriptor[], comfyAvailable: boolean): FeatureDescriptor[] {
	return features.filter(f => comfyAvailable || !f.dependsOnComfy);
}

/**
 * Funzioni disabilitate a causa dell'indisponibilità di ComfyUI: il complemento di
 * `enabledFeatures`. Quando ComfyUI è disponibile l'insieme è vuoto. Utile per indicare
 * all'utente quali funzioni non sono disponibili (Req. 23.1).
 */
export function disabledFeatures(features: readonly FeatureDescriptor[], comfyAvailable: boolean): FeatureDescriptor[] {
	return features.filter(f => !comfyAvailable && f.dependsOnComfy);
}

/** Vero se la singola funzione è abilitata data la disponibilità di ComfyUI. */
export function isFeatureEnabled(feature: FeatureDescriptor, comfyAvailable: boolean): boolean {
	return comfyAvailable || !feature.dependsOnComfy;
}
