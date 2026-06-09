/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider Claude (Anthropic Messages API, streaming SSE) via fetch
 *  Supporta sia lo streaming di solo testo sia il tool-use NATIVO (function calling).
 *--------------------------------------------------------------------------------------------*/

import { AgentStreamParams, AnthropicStreamEvent, ChatMessage, LLMError, LLMProvider, LLMRequest } from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const EPHEMERAL = { type: 'ephemeral' as const };

/** System prompt come blocco cache-abile (prompt caching). Vuoto → non inviare nulla di cache. */
function cachedSystem(system?: string): unknown {
	if (!system || !system.trim()) {
		return system;
	}
	return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
}

/** Marca l'ultimo tool con cache_control così l'intero blocco tools viene messo in cache. */
function cachedTools(tools?: unknown[]): unknown[] | undefined {
	if (!tools || !tools.length) {
		return tools;
	}
	const out = tools.map(t => ({ ...(t as object) }));
	out[out.length - 1] = { ...(out[out.length - 1] as object), cache_control: EPHEMERAL };
	return out;
}

export interface ClaudeConfig {
	model: string;
	maxTokens: number;
	thinking?: boolean;
	/** Attiva l'extended thinking nel percorso agentico (tool-use) anche se "thinking" è off. */
	thinkingAuto?: boolean;
	thinkingBudget?: number;
	/** Livello di "effort" per i modelli con adaptive thinking (low|medium|high|xhigh|max). */
	effort?: string;
}

export class ClaudeProvider implements LLMProvider {
	readonly id = 'claude';
	readonly label = 'Claude (Anthropic)';

	constructor(
		private readonly getApiKey: () => Promise<string | undefined>,
		private readonly getConfig: () => ClaudeConfig
	) { }

	async isConfigured(): Promise<boolean> {
		return !!(await this.getApiKey());
	}

	modelName(): string {
		return this.getConfig().model;
	}

	/** POST con streaming SSE; restituisce gli eventi JSON già parsati. */
	private async *postStream(body: object, signal?: AbortSignal): AsyncIterable<AnthropicStreamEvent> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new LLMError('API key Claude non impostata. Usa "MGCoding: Imposta API key Claude".');
		}
		let res: Response;
		try {
			res = await fetch(ANTHROPIC_URL, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': ANTHROPIC_VERSION
				},
				body: JSON.stringify({ ...body, stream: true }),
				signal
			});
		} catch (err) {
			throw new LLMError('Errore di rete verso Anthropic.', err);
		}
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			throw new LLMError(`Anthropic ha risposto ${res.status}: ${text}`);
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line.startsWith('data:')) {
					continue;
				}
				const data = line.slice('data:'.length).trim();
				if (!data || data === '[DONE]') {
					continue;
				}
				try {
					yield JSON.parse(data) as AnthropicStreamEvent;
				} catch {
					// frammento non-JSON: ignora
				}
			}
		}
	}

	/** Streaming di solo testo (chat semplice / fallback). */
	async *stream(req: LLMRequest): AsyncIterable<string> {
		const cfg = this.getConfig();
		const body = {
			model: cfg.model,
			max_tokens: req.maxTokens ?? cfg.maxTokens,
			system: cachedSystem(req.system),
			messages: req.messages
				.filter(m => m.role !== 'system')
				.map((m: ChatMessage) => ({ role: m.role, content: m.content }))
		};
		for await (const evt of this.postStream(body, req.signal)) {
			if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
				yield evt.delta.text;
			} else if (evt.type === 'error') {
				throw new LLMError('Errore nello stream Anthropic.');
			}
		}
	}

	/** Streaming agentico con tool-use NATIVO: emette gli eventi SSE grezzi. */
	async *streamAgent(params: AgentStreamParams): AsyncIterable<AnthropicStreamEvent> {
		const cfg = this.getConfig();
		const maxTokens = params.maxTokens ?? cfg.maxTokens;
		const body: Record<string, unknown> = {
			model: cfg.model,
			max_tokens: maxTokens,
			system: cachedSystem(params.system),
			messages: params.messages,
			tools: cachedTools(params.tools as unknown[])
		};
		// Extended thinking nel percorso agentico: attivo se richiesto esplicitamente
		// o in automatico (thinkingAuto), perché ragionare aiuta molto nei task con tool.
		if (cfg.thinking || cfg.thinkingAuto) {
			// I modelli recenti (Opus 4.6+/Sonnet 4.6, e OBBLIGATORIO su Opus 4.7/4.8) usano
			// l'adaptive thinking + output_config.effort; il vecchio {type:'enabled',budget_tokens}
			// dà 400 su Opus 4.7/4.8. I modelli più vecchi usano ancora enabled+budget.
			if (/opus-4-(?:[6-9])|opus-4-1\d|sonnet-4-(?:[6-9])/.test(cfg.model)) {
				body.thinking = { type: 'adaptive' };
				body.output_config = { effort: cfg.effort ?? 'high' };
			} else {
				const budget = Math.min(cfg.thinkingBudget ?? 2048, Math.max(1024, maxTokens - 1024));
				body.thinking = { type: 'enabled', budget_tokens: budget };
			}
		}
		yield* this.postStream(body, params.signal);
	}
}
