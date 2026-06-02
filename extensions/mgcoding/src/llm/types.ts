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
}

export class LLMError extends Error {
	constructor(message: string, override readonly cause?: unknown) {
		super(message);
		this.name = 'LLMError';
	}
}
