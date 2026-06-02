/*---------------------------------------------------------------------------------------------
 *  MGCoding - tipi comuni del livello LLM
 *--------------------------------------------------------------------------------------------*/

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface LLMRequest {
	/** System prompt (steering + istruzioni). */
	system?: string;
	/** Storico conversazione (senza system). */
	messages: ChatMessage[];
	maxTokens?: number;
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
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string };

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
	delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
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

export class LLMError extends Error {
	constructor(message: string, override readonly cause?: unknown) {
		super(message);
		this.name = 'LLMError';
	}
}
