/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider Ollama (LLM locale, API /api/chat, streaming NDJSON) via fetch
 *  Supporta sia lo streaming di solo testo sia il tool-use NATIVO (/api/chat con tools),
 *  tradotto da/verso il formato Anthropic per condividere lo stesso loop agentico.
 *--------------------------------------------------------------------------------------------*/

import { AgentStreamParams, AnthropicMessage, AnthropicStreamEvent, LLMError, LLMProvider, LLMRequest } from './types';

export interface OllamaConfig {
	endpoint: string;
	model: string;
}

interface OllamaMessage {
	role: string;
	content: string;
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
		const messages = [
			...(req.system ? [{ role: 'system', content: req.system }] : []),
			...req.messages.map(m => ({ role: m.role, content: m.content }))
		];
		for await (const evt of this.postNdjson({ model: cfg.model, messages }, req.signal)) {
			if (evt.message?.content) {
				yield evt.message.content as string;
			}
			if (evt.error) {
				throw new LLMError(`Ollama error: ${evt.error}`);
			}
		}
	}

	/** Converte i messaggi in formato Anthropic nel formato /api/chat di Ollama. */
	private toOllamaMessages(system: string | undefined, messages: AnthropicMessage[]): OllamaMessage[] {
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
				const toolResults = m.content.filter(b => b.type === 'tool_result') as { content: string }[];
				if (toolResults.length) {
					for (const tr of toolResults) {
						out.push({ role: 'tool', content: tr.content });
					}
				} else {
					const text = m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
					out.push({ role: 'user', content: text });
				}
			}
		}
		return out;
	}

	/** Streaming agentico con tool-use NATIVO di Ollama, emesso nel formato eventi Anthropic. */
	async *streamAgent(params: AgentStreamParams): AsyncIterable<AnthropicStreamEvent> {
		const cfg = this.getConfig();
		const messages = this.toOllamaMessages(params.system, params.messages);
		const tools = params.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

		let textStarted = false;
		let toolIndex = 0;
		let sawTool = false;

		for await (const evt of this.postNdjson({ model: cfg.model, messages, tools }, params.signal)) {
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
