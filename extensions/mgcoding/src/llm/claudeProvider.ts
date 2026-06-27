/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider Claude (Anthropic Messages API, streaming SSE) via fetch
 *  Supporta sia lo streaming di solo testo sia il tool-use NATIVO (function calling).
 *--------------------------------------------------------------------------------------------*/

import { AgentStreamParams, AnthropicStreamEvent, ChatMessage, classifyHttpError, LLMError, LLMProvider, LLMRequest } from './types';

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
	/**
	 * Endpoint Messages API alternativo (es. endpoint Anthropic-compatibile di GLM).
	 * Se assente si usa l'endpoint ufficiale Anthropic. Mantiene la retrocompatibilità.
	 */
	baseUrl?: string;
}

export class ClaudeProvider implements LLMProvider {
	readonly id: string = 'claude';
	readonly label: string = 'Claude (Anthropic)';

	constructor(
		private readonly getApiKey: () => Promise<string | undefined>,
		private readonly getConfig: () => ClaudeConfig,
		/** Identità opzionale: consente a un provider contenitore (es. GLM) di attribuirsi gli errori. */
		identity?: { id?: string; label?: string }
	) {
		if (identity?.id) {
			this.id = identity.id;
		}
		if (identity?.label) {
			this.label = identity.label;
		}
	}

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
			// Chiave assente (Req. 9.2): la richiesta è interrotta dal throw; la chiave verrà richiesta a monte.
			throw new LLMError(`Chiave API mancante per ${this.label}. Imposta la chiave con "MGCoding: Configurazione guidata" e riprova.`, undefined, { kind: 'missing_key', providerId: this.id });
		}
		let res: Response;
		try {
			// Usa l'endpoint configurato (es. Anthropic-compat di GLM) o quello ufficiale Anthropic.
			res = await fetch(this.getConfig().baseUrl ?? ANTHROPIC_URL, {
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
			throw new LLMError(`Impossibile contattare ${this.label}.`, err, { kind: 'unreachable', providerId: this.id });
		}
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			// Chiave non valida (Req. 9.3) o rate limit (Req. 9.4): qui la chiave è presente.
			throw classifyHttpError({ status: res.status, bodyText: text, hasKey: true, providerId: this.id, providerLabel: this.label });
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
		const body: Record<string, unknown> = {
			model: cfg.model,
			max_tokens: req.maxTokens ?? cfg.maxTokens,
			system: cachedSystem(req.system),
			messages: req.messages
				.filter(m => m.role !== 'system')
				.map((m: ChatMessage) => ({ role: m.role, content: m.content }))
		};
		if (typeof req.temperature === 'number') {
			body.temperature = req.temperature;
		}
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
