/*---------------------------------------------------------------------------------------------
 *  MGCoding - tipi comuni del livello LLM
 *--------------------------------------------------------------------------------------------*/

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

export class LLMError extends Error {
	constructor(message: string, override readonly cause?: unknown) {
		super(message);
		this.name = 'LLMError';
	}
}
