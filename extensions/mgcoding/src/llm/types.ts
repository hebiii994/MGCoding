/*---------------------------------------------------------------------------------------------
 *  MGCoding - tipi comuni del livello LLM
 *--------------------------------------------------------------------------------------------*/

import type { ProviderDescriptor } from './registry';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
	role: ChatRole;
	content: string;
	/** Immagini allegate (data URL: data:image/...;base64,...). */
	images?: string[];
}

export interface LLMRequest {
	/** System prompt (steering + istruzioni). */
	system?: string;
	/** Storico conversazione (senza system). */
	messages: ChatMessage[];
	maxTokens?: number;
	/** Temperatura override (es. alta per la chat creativa "Libera"); se assente usa il default. */
	temperature?: number;
	signal?: AbortSignal;
}

// --- Tool-use nativo (stile Anthropic) ---

export interface AnthropicToolDef {
	name: string;
	description: string;
	input_schema: object;
}

export type AnthropicBlock =
	| { type: 'text'; text: string }
	| { type: 'thinking'; thinking: string; signature?: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string | ToolResultPart[] };

/** Parte di un tool_result composito (testo + immagini, es. screenshot da tool MCP). */
export type ToolResultPart =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Estrae il solo testo dal content di un tool_result (stringa o array di parti). */
export function toolResultText(content: string | ToolResultPart[]): string {
	if (typeof content === 'string') {
		return content;
	}
	return content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n');
}

/** Spezza un data URL (data:image/png;base64,XXXX) in media_type e dati base64. */
export function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | undefined {
	const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
	return m ? { mediaType: m[1], data: m[2] } : undefined;
}

export interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: AnthropicBlock[];
}

export interface AgentStreamParams {
	system?: string;
	messages: AnthropicMessage[];
	tools: AnthropicToolDef[];
	maxTokens?: number;
	signal?: AbortSignal;
}

/** Evento SSE (parsato) dello streaming Anthropic, forma minima usata dal loop. */
export interface AnthropicStreamEvent {
	type: string;
	index?: number;
	content_block?: { type: string; id?: string; name?: string };
	delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string };
}

/**
 * Un provider LLM produce testo in streaming.
 * Implementazioni: Claude (Anthropic), Ollama (locale).
 */
export interface LLMProvider {
	readonly id: string;
	readonly label: string;
	/** Vero se il provider è pronto all'uso (es. API key impostata). */
	isConfigured(): Promise<boolean>;
	/** Nome del modello attualmente selezionato (per la UI). */
	modelName(): string;
	/** Streaming dei delta di testo della risposta. */
	stream(req: LLMRequest): AsyncIterable<string>;
	/** Opzionale: streaming agentico con tool-use NATIVO (solo Claude). */
	streamAgent?(params: AgentStreamParams): AsyncIterable<AnthropicStreamEvent>;
}

/**
 * Categoria di errore di un provider LLM (Req. 9), utile per una gestione uniforme a monte
 * (richiesta della chiave, proposta di ripiego, messaggio di assenza provider):
 *  - `unreachable`: il server del provider non è raggiungibile (rete/endpoint) (Req. 9.1);
 *  - `missing_key`: manca la chiave API di un provider cloud (Req. 9.2);
 *  - `invalid_key`: la chiave API è presente ma rifiutata (401/403) (Req. 9.3);
 *  - `rate_limit`: il provider ha imposto un limite di rate (429) (Req. 9.4);
 *  - `no_provider`: nessun provider configurato/raggiungibile (Req. 9.5);
 *  - `unknown`: errore non classificato.
 */
export type LLMErrorKind = 'unreachable' | 'missing_key' | 'invalid_key' | 'rate_limit' | 'no_provider' | 'unknown';

/** Informazioni di classificazione opzionali per un {@link LLMError}. */
export interface LLMErrorInfo {
	/** Categoria dell'errore (default `unknown`). */
	kind?: LLMErrorKind;
	/** Id del provider che ha generato l'errore (es. 'ollama', 'claude', 'openai', 'glm'). */
	providerId?: string;
}

export class LLMError extends Error {
	/** Categoria dell'errore per la gestione uniforme (Req. 9). */
	readonly kind: LLMErrorKind;
	/** Id del provider che ha generato l'errore, se noto. */
	readonly providerId?: string;

	/**
	 * Il terzo parametro `info` è opzionale e retrocompatibile: i chiamanti esistenti che
	 * passano solo `(message, cause)` ottengono `kind = 'unknown'` senza modifiche.
	 */
	constructor(message: string, override readonly cause?: unknown, info?: LLMErrorInfo) {
		super(message);
		this.name = 'LLMError';
		this.kind = info?.kind ?? 'unknown';
		this.providerId = info?.providerId;
	}
}

/**
 * Estrae un dettaglio LEGGIBILE e azionabile dalla causa di un'eccezione di rete (tipicamente
 * un `fetch` che lancia prima di ricevere risposta). Node/undici annida la causa reale in
 * `err.cause` con un `code` (es. `ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
 * `CERT_HAS_EXPIRED`, `SELF_SIGNED_CERT_IN_CHAIN`). Restituisce stringa vuota se non c'è nulla
 * di utile. Serve a non mascherare la causa vera dietro un generico "irraggiungibile" (Req. 9.1).
 */
export function networkErrorDetail(err: unknown): string {
	const seen = new Set<unknown>();
	let cur: unknown = err;
	// Scende lungo la catena di `cause` cercando un `code` o un messaggio significativo.
	while (cur && typeof cur === 'object' && !seen.has(cur)) {
		seen.add(cur);
		const code = (cur as { code?: unknown }).code;
		if (typeof code === 'string' && code) {
			return code;
		}
		const next = (cur as { cause?: unknown }).cause;
		if (next && next !== cur) {
			cur = next;
			continue;
		}
		const msg = (cur as { message?: unknown }).message;
		return typeof msg === 'string' ? msg : '';
	}
	return '';
}

/**
 * Classifica la risposta HTTP fallita di un provider cloud in un {@link LLMError} tipizzato
 * (Req. 9.2, 9.3, 9.4). Distingue la chiave mancante da quella non valida in base alla
 * presenza effettiva di una chiave:
 *  - 401/403 (o 400 con indizi di autorizzazione) senza chiave → `missing_key`;
 *  - 401/403 (o 400 con indizi di autorizzazione) con chiave presente → `invalid_key`;
 *  - 429 → `rate_limit`;
 *  - altri status → `unknown` con il dettaglio del corpo.
 */
export function classifyHttpError(opts: {
	status: number;
	bodyText: string;
	hasKey: boolean;
	providerId: string;
	providerLabel: string;
}): LLMError {
	const { status, bodyText, hasKey, providerId, providerLabel } = opts;
	const authHint = status === 401 || status === 403
		|| (status === 400 && /authorization|api[ _-]?key|unauthenticated|unauthorized|invalid.*key/i.test(bodyText));
	if (authHint) {
		if (!hasKey) {
			return new LLMError(
				`Chiave API mancante per ${providerLabel}. Imposta la chiave con "MGCoding: Configurazione guidata" e riprova.`,
				undefined,
				{ kind: 'missing_key', providerId }
			);
		}
		return new LLMError(
			`Chiave API non valida per ${providerLabel} (HTTP ${status}). Verifica e reimposta la chiave con "MGCoding: Configurazione guidata".`,
			undefined,
			{ kind: 'invalid_key', providerId }
		);
	}
	if (status === 429) {
		return new LLMError(
			`${providerLabel} ha raggiunto il limite di rate (HTTP 429).`,
			undefined,
			{ kind: 'rate_limit', providerId }
		);
	}
	return new LLMError(`${providerLabel} ha risposto ${status}: ${bodyText}`, undefined, { providerId });
}

// --- Tipi di dominio condivisi (local-model-kiro-parity) ---

/**
 * Classe di capacità di tool-use di un modello (Req. 3):
 *  - `native`: tool-use nativo affidabile (verificato da probe funzionale);
 *  - `structured`: richiede output vincolato a uno schema (grammar/JSON);
 *  - `textual`: richiede il protocollo testuale `mg-tool` con scaffolding.
 */
export type CapabilityTier = 'native' | 'structured' | 'textual';

/** Modalità di autonomia dell'agente (Req. 5). */
export type AutonomyMode = 'autopilot' | 'supervised';

/** Uno dei sei pattern EARS riconosciuti nei criteri di accettazione (Req. 6.1). */
export type EarsPattern =
	| 'ubiquitous'  // THE SYSTEM SHALL ...
	| 'event'       // WHEN ... THE SYSTEM SHALL ...
	| 'state'       // WHILE ... THE SYSTEM SHALL ...
	| 'optional'    // WHERE ... THE SYSTEM SHALL ...
	| 'unwanted'    // IF ... THEN THE SYSTEM SHALL ...
	| 'complex';    // combinazioni (WHEN/WHILE + IF/THEN)

/** Fase dello workflow Spec (Req. 6). */
export type SpecPhase = 'requirements' | 'design' | 'tasks';

/** Budget di token calcolato per una richiesta (Req. 1, 4). */
export interface ContextBudget {
	/** num_ctx effettivo da inviare a Ollama (intero positivo). */
	numCtx: number;
	/** Spazio disponibile per la cronologia = numCtx - system - tools - reserve. */
	historyBudget: number;
}

/** Esito della decisione di gating di un'azione dell'agente (Req. 5). */
export interface ActionDecision {
	/** True se serve l'approvazione esplicita dell'utente. */
	requiresApproval: boolean;
	/** True se va creato un checkpoint reversibile prima di agire. */
	needsCheckpoint: boolean;
	/** Motivazione della decisione (per logging/UI). */
	reason: string;
}

/** Voce della Coverage_Map: mappatura di un criterio EARS ai task (Req. 6.2). */
export interface CoverageEntry {
	/** Identificatore del criterio nel formato "Req N.M". */
	criterion: string;
	/** Indici (riga) dei task che citano il criterio. */
	taskLines: number[];
	/** True se almeno un task copre il criterio. */
	covered: boolean;
}

/** Risultato della selezione del provider (Req. 8, 9.5, 10). */
export interface RouteResult {
	/** Provider scelto; assente se nessun provider è disponibile (Req. 9.5). */
	provider?: ProviderDescriptor;
	/** Motivo del ripiego al cloud a pagamento (Req. 10.3) o dell'assenza di provider (Req. 9.5). */
	fallbackReason?: string;
	/** True se è stato scelto un locale insufficiente per assenza di cloud (Req. 8.7). */
	degradedLocal?: boolean;
}
