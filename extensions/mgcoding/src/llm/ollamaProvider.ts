/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider Ollama (LLM locale, API /api/chat, streaming NDJSON) via fetch
 *  Supporta sia lo streaming di solo testo sia il tool-use NATIVO (/api/chat con tools),
 *  tradotto da/verso il formato Anthropic per condividere lo stesso loop agentico.
 *--------------------------------------------------------------------------------------------*/

import { AgentStreamParams, AnthropicMessage, AnthropicStreamEvent, LLMError, LLMProvider, LLMRequest, parseDataUrl, ToolResultPart, toolResultText } from './types';

export interface OllamaConfig {
	endpoint: string;
	model: string;
	think?: boolean;
	/** Temperatura bassa per i task agentici (riduce JSON spazzatura/allucinazioni). */
	temperature?: number;
}

interface OllamaMessage {
	role: string;
	content: string;
	images?: string[];
	tool_calls?: { function: { name: string; arguments: unknown } }[];
}

export class OllamaProvider implements LLMProvider {
	readonly id = 'ollama';
	readonly label = 'Ollama (locale)';

	constructor(private readonly getConfig: () => OllamaConfig) { }

	async isConfigured(): Promise<boolean> {
		const { endpoint } = this.getConfig();
		try {
			const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { method: 'GET' });
			return res.ok;
		} catch {
			return false;
		}
	}

	modelName(): string {
		return this.getConfig().model;
	}

	/** Elenca i modelli installati nel server Ollama (da /api/tags). */
	async listModels(): Promise<string[]> {
		const endpoint = this.getConfig().endpoint.replace(/\/$/, '');
		try {
			const res = await fetch(`${endpoint}/api/tags`, { method: 'GET' });
			if (!res.ok) {
				return [];
			}
			const data = await res.json() as { models?: { name?: string }[] };
			return (data.models ?? []).map(m => m.name).filter((n): n is string => !!n);
		} catch {
			return [];
		}
	}

	/** Cache delle capability per modello (per non interrogare /api/show ogni volta). */
	private readonly toolCapCache = new Map<string, boolean>();

	/**
	 * Chiamata NON-stream con output VINCOLATO a uno JSON schema (grammar di llama.cpp via
	 * Ollama format): il risultato è garantito conforme allo schema. Ritorna il testo (JSON).
	 */
	async chatStructured(system: string | undefined, messages: { role: string; content: string }[], schema: object, signal?: AbortSignal): Promise<string> {
		const cfg = this.getConfig();
		const endpoint = cfg.endpoint.replace(/\/$/, '');
		const msgs = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
		const res = await fetch(`${endpoint}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: cfg.model, messages: msgs, format: schema, options: { temperature: cfg.temperature ?? 0.2 }, stream: false }),
			signal
		});
		if (!res.ok) {
			throw new LLMError(`Ollama ha risposto ${res.status}`);
		}
		const data = await res.json() as { message?: { content?: string } };
		return data.message?.content ?? '';
	}

	/** True se il modello dichiara di supportare il tool-use nativo (da /api/show). */
	async supportsTools(model: string): Promise<boolean> {
		const cached = this.toolCapCache.get(model);
		if (cached !== undefined) {
			return cached;
		}
		const endpoint = this.getConfig().endpoint.replace(/\/$/, '');
		try {
			const res = await fetch(`${endpoint}/api/show`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// "model" (Ollama recenti) e "name" (versioni precedenti) per compatibilità.
				body: JSON.stringify({ model, name: model })
			});
			if (!res.ok) {
				return false;
			}
			const data = await res.json() as { capabilities?: string[] };
			const ok = Array.isArray(data.capabilities) && data.capabilities.includes('tools');
			this.toolCapCache.set(model, ok);
			return ok;
		} catch {
			return false;
		}
	}

	/** Cache delle capability vision per modello. */
	private readonly visionCapCache = new Map<string, boolean>();

	/** True se il modello dichiara di supportare input multimodali (immagini), da /api/show. */
	async supportsVision(model: string): Promise<boolean> {
		const cached = this.visionCapCache.get(model);
		if (cached !== undefined) {
			return cached;
		}
		const endpoint = this.getConfig().endpoint.replace(/\/$/, '');
		try {
			const res = await fetch(`${endpoint}/api/show`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model, name: model })
			});
			if (!res.ok) {
				return false;
			}
			const data = await res.json() as { capabilities?: string[] };
			const ok = Array.isArray(data.capabilities) && data.capabilities.includes('vision');
			this.visionCapCache.set(model, ok);
			return ok;
		} catch {
			return false;
		}
	}

	/** POST /api/chat con streaming NDJSON; restituisce gli oggetti JSON già parsati. */
	private async *postNdjson(body: object, signal?: AbortSignal): AsyncIterable<any> {
		const endpoint = this.getConfig().endpoint.replace(/\/$/, '');
		let res: Response;
		try {
			res = await fetch(`${endpoint}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...body, stream: true }),
				signal
			});
		} catch (err) {
			throw new LLMError(`Impossibile contattare Ollama su ${endpoint}. È in esecuzione?`, err);
		}
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			throw new LLMError(`Ollama ha risposto ${res.status}: ${text}`);
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
				if (!line) {
					continue;
				}
				try {
					yield JSON.parse(line);
				} catch {
					// riga non-JSON: ignora
				}
			}
		}
	}

	async *stream(req: LLMRequest): AsyncIterable<string> {
		const cfg = this.getConfig();
		// Invia immagini solo se il modello supporta la vision, altrimenti Ollama risponde 400.
		const allowImages = await this.supportsVision(cfg.model);
		const messages = [
			...(req.system ? [{ role: 'system', content: req.system }] : []),
			...req.messages.map(m => {
				const msg: { role: string; content: string; images?: string[] } = { role: m.role, content: m.content };
				if (allowImages && m.images?.length) {
					msg.images = m.images.map(d => parseDataUrl(d)?.data).filter((x): x is string => !!x);
				}
				return msg;
			})
		];
		let thinkOpen = false;
		for await (const evt of this.postNdjson({ model: cfg.model, messages, options: { temperature: cfg.temperature ?? 0.2 }, ...(cfg.think ? { think: true } : {}) }, req.signal)) {
			if (evt.error) {
				throw new LLMError(`Ollama error: ${evt.error}`);
			}
			const thinking: string | undefined = evt.message?.thinking;
			if (thinking) {
				if (!thinkOpen) {
					yield '<think>';
					thinkOpen = true;
				}
				yield thinking;
			}
			const content: string | undefined = evt.message?.content;
			if (content) {
				if (thinkOpen) {
					yield '</think>';
					thinkOpen = false;
				}
				yield content;
			}
		}
		if (thinkOpen) {
			yield '</think>';
		}
	}

	/** Converte i messaggi in formato Anthropic nel formato /api/chat di Ollama. */
	private toOllamaMessages(system: string | undefined, messages: AnthropicMessage[], allowImages = true): OllamaMessage[] {
		const out: OllamaMessage[] = [];
		if (system) {
			out.push({ role: 'system', content: system });
		}
		for (const m of messages) {
			if (m.role === 'assistant') {
				const text = m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
				const toolUses = m.content.filter(b => b.type === 'tool_use') as { name: string; input: Record<string, unknown> }[];
				const msg: OllamaMessage = { role: 'assistant', content: text };
				if (toolUses.length) {
					msg.tool_calls = toolUses.map(tu => ({ function: { name: tu.name, arguments: tu.input } }));
				}
				out.push(msg);
			} else {
				const toolResults = m.content.filter(b => b.type === 'tool_result') as { content: string | ToolResultPart[] }[];
				if (toolResults.length) {
					for (const tr of toolResults) {
						out.push({ role: 'tool', content: toolResultText(tr.content) });
					}
				} else {
					const text = m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
					// Immagini (vision): Ollama vuole i base64 grezzi nel campo "images".
					const images = m.content
						.filter(b => b.type === 'image')
						.map(b => (b as { source?: { data?: string } }).source?.data)
						.filter((x): x is string => !!x);
					const msg: OllamaMessage = { role: 'user', content: text };
					if (allowImages && images.length) {
						msg.images = images;
					}
					out.push(msg);
				}
			}
		}
		return out;
	}

	/** Streaming agentico con tool-use NATIVO di Ollama, emesso nel formato eventi Anthropic. */
	async *streamAgent(params: AgentStreamParams): AsyncIterable<AnthropicStreamEvent> {
		const cfg = this.getConfig();
		const allowImages = await this.supportsVision(cfg.model);
		const messages = this.toOllamaMessages(params.system, params.messages, allowImages);
		const tools = params.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

		let textStarted = false;
		let toolIndex = 0;
		let sawTool = false;

		for await (const evt of this.postNdjson({ model: cfg.model, messages, tools, options: { temperature: cfg.temperature ?? 0.2 } }, params.signal)) {
			if (evt.error) {
				throw new LLMError(`Ollama error: ${evt.error}`);
			}
			const content: string | undefined = evt.message?.content;
			if (content) {
				if (!textStarted) {
					yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
					textStarted = true;
				}
				yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } };
			}
			const toolCalls: { function: { name: string; arguments: unknown } }[] | undefined = evt.message?.tool_calls;
			if (toolCalls?.length) {
				for (const tc of toolCalls) {
					const idx = ++toolIndex;
					const argsStr = typeof tc.function.arguments === 'string'
						? tc.function.arguments
						: JSON.stringify(tc.function.arguments ?? {});
					yield { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: `call_${idx}`, name: tc.function.name } };
					yield { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: argsStr } };
					sawTool = true;
				}
			}
			if (evt.done) {
				yield { type: 'message_delta', delta: { stop_reason: sawTool ? 'tool_use' : 'end_turn' } };
			}
		}
	}
}
