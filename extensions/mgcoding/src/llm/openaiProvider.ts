/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider OpenAI-compatibile (LM Studio, OpenRouter, llama.cpp, ecc.)
 *  Endpoint /chat/completions con streaming SSE e tool-use nativo (function calling).
 *--------------------------------------------------------------------------------------------*/

import { AgentStreamParams, AnthropicMessage, AnthropicStreamEvent, LLMError, LLMProvider, LLMRequest, ToolResultPart, toolResultText } from './types';

export interface OpenAIConfig {
	endpoint: string;
	model: string;
	/** Modalità Azure OpenAI: usa header 'api-key' e query ?api-version=. */
	azure?: boolean;
	/** api-version per Azure OpenAI (es. 2024-08-01-preview). */
	apiVersion?: string;
}

type OpenAIPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** Dati extra Gemini su un tool_call: la firma di ragionamento da ri-allegare in cronologia. */
type GoogleExtra = { google: { thought_signature: string } };

interface OpenAIMessage {
	role: string;
	content: string | null | OpenAIPart[];
	tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: GoogleExtra }[];
	tool_call_id?: string;
}

/** Estrae la thought_signature di Gemini da un oggetto (tool_call o delta), se presente. */
function thoughtSignature(obj: unknown): string | undefined {
	const sig = (obj as { extra_content?: { google?: { thought_signature?: unknown } } })?.extra_content?.google?.thought_signature;
	return typeof sig === 'string' && sig ? sig : undefined;
}

export class OpenAIProvider implements LLMProvider {
	readonly id = 'openai';
	readonly label = 'OpenAI-compatibile';

	/**
	 * Firme di ragionamento (thought_signature) di Gemini, indicizzate per id del tool_call.
	 * Gemini le richiede su OGNI functionCall rispedito in cronologia, altrimenti risponde 400.
	 */
	private readonly toolSignatures = new Map<string, string>();

	constructor(
		private readonly getApiKey: () => Promise<string | undefined>,
		private readonly getConfig: () => OpenAIConfig
	) { }

	private base(): string {
		return this.getConfig().endpoint.replace(/\/$/, '');
	}

	/** URL di /chat/completions, con query api-version in modalità Azure. */
	private chatUrl(): string {
		const cfg = this.getConfig();
		const url = `${this.base()}/chat/completions`;
		return cfg.azure && cfg.apiVersion ? `${url}?api-version=${encodeURIComponent(cfg.apiVersion)}` : url;
	}

	private modelsUrl(): string {
		const cfg = this.getConfig();
		const url = `${this.base()}/models`;
		return cfg.azure && cfg.apiVersion ? `${url}?api-version=${encodeURIComponent(cfg.apiVersion)}` : url;
	}

	private async headers(): Promise<Record<string, string>> {
		const h: Record<string, string> = { 'content-type': 'application/json' };
		const key = await this.getApiKey();
		if (key) {
			// Azure OpenAI usa l'header 'api-key'; gli altri usano il Bearer token.
			if (this.getConfig().azure) {
				h['api-key'] = key;
			} else {
				h['authorization'] = `Bearer ${key}`;
			}
		}
		return h;
	}

	async isConfigured(): Promise<boolean> {
		try {
			const res = await fetch(this.modelsUrl(), { headers: await this.headers() });
			return res.ok;
		} catch {
			return false;
		}
	}

	modelName(): string {
		return this.getConfig().model;
	}

	async listModels(): Promise<string[]> {
		try {
			const res = await fetch(this.modelsUrl(), { headers: await this.headers() });
			if (!res.ok) {
				return [];
			}
			const data = await res.json() as { data?: { id?: string }[] };
			return (data.data ?? []).map(m => m.id).filter((x): x is string => !!x);
		} catch {
			return [];
		}
	}

	private async *postStream(body: object, signal?: AbortSignal): AsyncIterable<any> {
		let res: Response;
		try {
			res = await fetch(this.chatUrl(), {
				method: 'POST',
				headers: await this.headers(),
				body: JSON.stringify({ ...body, stream: true }),
				signal
			});
		} catch (err) {
			throw new LLMError(`Impossibile contattare l'endpoint OpenAI-compatibile (${this.base()}).`, err);
		}
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			if (res.status === 401 || res.status === 403 || (res.status === 400 && /authorization|api key|api_key|unauthenticated/i.test(text))) {
				throw new LLMError('Chiave API mancante o non valida per questo servizio. Reimpostala con "MGCoding: Configurazione guidata" (scegli il servizio e incolla la chiave).');
			}
			throw new LLMError(`Endpoint ha risposto ${res.status}: ${text}`);
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
					yield JSON.parse(data);
				} catch {
					// frammento non-JSON
				}
			}
		}
	}

	async *stream(req: LLMRequest): AsyncIterable<string> {
		const cfg = this.getConfig();
		const messages = [
			...(req.system ? [{ role: 'system', content: req.system }] : []),
			...req.messages.map(m => ({ role: m.role, content: m.content }))
		];
		const body: Record<string, unknown> = { model: cfg.model, messages };
		if (typeof req.temperature === 'number') {
			body.temperature = req.temperature;
			body.frequency_penalty = 0.4; // riduce le ripetizioni nella chat creativa
		}
		for await (const evt of this.postStream(body, req.signal)) {
			const delta = evt.choices?.[0]?.delta?.content;
			if (delta) {
				yield delta as string;
			}
		}
	}

	private toOpenAIMessages(system: string | undefined, messages: AnthropicMessage[]): OpenAIMessage[] {
		const out: OpenAIMessage[] = [];
		if (system) {
			out.push({ role: 'system', content: system });
		}
		for (const m of messages) {
			if (m.role === 'assistant') {
				const text = m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
				const toolUses = m.content.filter(b => b.type === 'tool_use') as { id: string; name: string; input: Record<string, unknown> }[];
				out.push({
					role: 'assistant',
					content: text || null,
					...(toolUses.length ? {
						tool_calls: toolUses.map(tu => {
							const sig = this.toolSignatures.get(tu.id);
							return {
								id: tu.id,
								type: 'function' as const,
								function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
								// Gemini esige la firma su ogni functionCall rispedito (altrimenti 400).
								...(sig ? { extra_content: { google: { thought_signature: sig } } } : {})
							};
						})
					} : {})
				});
			} else {
				const toolResults = m.content.filter(b => b.type === 'tool_result') as { tool_use_id: string; content: string | ToolResultPart[] }[];
				if (toolResults.length) {
					for (const tr of toolResults) {
						out.push({ role: 'tool', content: toolResultText(tr.content), tool_call_id: tr.tool_use_id });
					}
				} else {
					const text = m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
					const images = m.content.filter(b => b.type === 'image') as { source: { media_type: string; data: string } }[];
					if (images.length) {
						const parts: OpenAIPart[] = [{ type: 'text', text }];
						for (const im of images) {
							parts.push({ type: 'image_url', image_url: { url: `data:${im.source.media_type};base64,${im.source.data}` } });
						}
						out.push({ role: 'user', content: parts });
					} else {
						out.push({ role: 'user', content: text });
					}
				}
			}
		}
		return out;
	}

	async *streamAgent(params: AgentStreamParams): AsyncIterable<AnthropicStreamEvent> {
		const cfg = this.getConfig();
		const messages = this.toOpenAIMessages(params.system, params.messages);
		const tools = params.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

		let textStarted = false;
		let sawTool = false;
		// indice openai tool_call -> indice "anthropic" (>=1) e se è stato aperto
		const opened = new Map<number, number>();
		// indice openai tool_call -> id assegnato al blocco (per indicizzare la firma)
		const openedId = new Map<number, string>();
		let nextIdx = 1;

		for await (const evt of this.postStream({ model: cfg.model, messages, tools }, params.signal)) {
			const choice = evt.choices?.[0];
			const delta = choice?.delta;
			if (!delta) {
				continue;
			}
			if (delta.content) {
				if (!textStarted) {
					yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
					textStarted = true;
				}
				yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } };
			}
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const oi = tc.index ?? 0;
					let aidx = opened.get(oi);
					if (aidx === undefined) {
						aidx = nextIdx++;
						opened.set(oi, aidx);
						const newId: string = tc.id || `call_${aidx}`;
						openedId.set(oi, newId);
						yield { type: 'content_block_start', index: aidx, content_block: { type: 'tool_use', id: newId, name: tc.function?.name || 'tool' } };
						sawTool = true;
					}
					const id = openedId.get(oi);
					// Gemini: memorizza la thought_signature per ri-allegarla nei turni successivi.
					const sig = thoughtSignature(tc) ?? thoughtSignature(delta);
					if (sig && id) {
						this.toolSignatures.set(id, sig);
					}
					if (tc.function?.arguments) {
						yield { type: 'content_block_delta', index: aidx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } };
					}
				}
			}
			if (choice?.finish_reason) {
				yield { type: 'message_delta', delta: { stop_reason: sawTool ? 'tool_use' : 'end_turn' } };
			}
		}
	}
}
