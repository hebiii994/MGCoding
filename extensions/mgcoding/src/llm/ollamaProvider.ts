/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider Ollama (LLM locale, API /api/chat, streaming NDJSON) via fetch
 *  Supporta sia lo streaming di solo testo sia il tool-use NATIVO (/api/chat con tools),
 *  tradotto da/verso il formato Anthropic per condividere lo stesso loop agentico.
 *--------------------------------------------------------------------------------------------*/

import { computeBudget } from './contextManager';
import { AgentStreamParams, AnthropicMessage, AnthropicStreamEvent, LLMError, LLMProvider, LLMRequest, parseDataUrl, ToolResultPart, toolResultText } from './types';

export interface OllamaConfig {
	endpoint: string;
	model: string;
	think?: boolean;
	/** Temperatura bassa per i task agentici (riduce JSON spazzatura/allucinazioni). */
	temperature?: number;
	/** Override esplicito mgcoding.ollama.numCtx (intero positivo) per la finestra di contesto. */
	numCtx?: number;
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

	/** Cache della finestra di contesto massima per modello (da /api/show: model_info.*context_length). */
	private readonly maxCtxCache = new Map<string, number>();

	/** Cache dell'esito della probe funzionale del tool-use per modello. */
	private readonly probeCache = new Map<string, boolean>();

	/**
	 * Ricava e mette in cache la finestra di contesto massima del modello da /api/show
	 * (campo `model_info.*context_length`). Restituisce undefined se non determinabile.
	 */
	private async getModelMaxCtx(model: string): Promise<number | undefined> {
		const cached = this.maxCtxCache.get(model);
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
				return undefined;
			}
			const data = await res.json() as { model_info?: Record<string, unknown> };
			const info = data.model_info ?? {};
			// La chiave varia per architettura (es. "qwen2.context_length", "llama.context_length"):
			// si individua quella che termina con "context_length".
			for (const [key, value] of Object.entries(info)) {
				if (/context_length$/i.test(key) && typeof value === 'number' && Number.isInteger(value) && value > 0) {
					this.maxCtxCache.set(model, value);
					return value;
				}
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Deriva il num_ctx effettivo da inviare in `options.num_ctx` (Req. 1.1, 1.2, 1.3, 1.4):
	 * riusa la precedenza pura del Context_Manager — config (intero positivo) > finestra max
	 * del modello (da /api/show) > DEFAULT_NUM_CTX. Qui la riserva risposta è ininfluente
	 * (serve solo il valore di num_ctx), quindi si passa responseReserve a 0.
	 */
	private async resolveNumCtx(model: string): Promise<number> {
		const configNumCtx = this.getConfig().numCtx;
		const modelMaxCtx = await this.getModelMaxCtx(model);
		return computeBudget({ configNumCtx, modelMaxCtx, systemTokens: 0, toolTokens: 0, responseReserve: 0 }).numCtx;
	}

	/**
	 * num_ctx effettivo per il modello indicato (default: modello attivo). Espone al guscio
	 * dell'Agent_Loop la stessa risoluzione usata internamente (config > finestra max > default),
	 * così il budgeting della cronologia resta coerente con il valore davvero inviato a Ollama
	 * (Req. 1.5).
	 */
	async effectiveNumCtx(model?: string): Promise<number> {
		return this.resolveNumCtx(model ?? this.getConfig().model);
	}

	/**
	 * Probe funzionale del tool-use nativo (Req. 3.2): invia una mini-richiesta con un tool
	 * banale (`echo`) e verifica che il modello emetta una tool-call nativa valida e parsabile.
	 * Solo il superamento giustifica la promozione del modello al tier `native`; un fallimento,
	 * anche con `tools` dichiarato da /api/show, lo limita a `structured`. Esito in cache di sessione.
	 */
	async probeToolUse(model: string): Promise<boolean> {
		const cached = this.probeCache.get(model);
		if (cached !== undefined) {
			return cached;
		}
		const endpoint = this.getConfig().endpoint.replace(/\/$/, '');
		// Tool banale con schema noto: il modello deve invocarlo restituendo un argomento.
		const probeTool = {
			type: 'function',
			function: {
				name: 'echo',
				description: 'Restituisce il testo ricevuto.',
				parameters: {
					type: 'object',
					properties: { text: { type: 'string', description: 'Il testo da restituire.' } },
					required: ['text']
				}
			}
		};
		const messages = [
			{ role: 'user', content: 'Chiama lo strumento "echo" con il parametro text impostato a "ping". Usa una tool call nativa.' }
		];
		try {
			const numCtx = await this.resolveNumCtx(model);
			const res = await fetch(`${endpoint}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model, messages, tools: [probeTool], options: { temperature: 0, num_ctx: numCtx }, stream: false })
			});
			if (!res.ok) {
				this.probeCache.set(model, false);
				return false;
			}
			const data = await res.json() as { message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] } };
			const ok = this.isValidProbeToolCall(data.message?.tool_calls);
			this.probeCache.set(model, ok);
			return ok;
		} catch {
			this.probeCache.set(model, false);
			return false;
		}
	}

	/** Vero se almeno una tool-call ha un nome valido e argomenti parsabili in oggetto. */
	private isValidProbeToolCall(toolCalls: { function?: { name?: string; arguments?: unknown } }[] | undefined): boolean {
		if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
			return false;
		}
		for (const tc of toolCalls) {
			const name = tc.function?.name;
			if (typeof name !== 'string' || name.length === 0) {
				continue;
			}
			const args = tc.function?.arguments;
			// Gli argomenti possono arrivare come oggetto o come stringa JSON: entrambi vanno parsati.
			if (args && typeof args === 'object') {
				return true;
			}
			if (typeof args === 'string') {
				try {
					const parsed = JSON.parse(args);
					if (parsed && typeof parsed === 'object') {
						return true;
					}
				} catch {
					// argomenti non parsabili: questa tool-call non è valida
				}
			}
		}
		return false;
	}

	/**
	 * Chiamata NON-stream con output VINCOLATO a uno JSON schema (grammar di llama.cpp via
	 * Ollama format): il risultato è garantito conforme allo schema. Ritorna il testo (JSON).
	 */
	async chatStructured(system: string | undefined, messages: { role: string; content: string }[], schema: object, signal?: AbortSignal): Promise<string> {
		const cfg = this.getConfig();
		const endpoint = cfg.endpoint.replace(/\/$/, '');
		const msgs = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
		const numCtx = await this.resolveNumCtx(cfg.model);
		let res: Response;
		try {
			res = await fetch(`${endpoint}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: cfg.model, messages: msgs, format: schema, options: { temperature: cfg.temperature ?? 0.2, num_ctx: numCtx }, stream: false }),
				signal
			});
		} catch (err) {
			// Server locale irraggiungibile sul percorso strutturato (Req. 9.1): cita l'endpoint.
			throw new LLMError(`Impossibile contattare Ollama su ${endpoint}. È in esecuzione?`, err, { kind: 'unreachable', providerId: this.id });
		}
		if (!res.ok) {
			throw new LLMError(`Ollama ha risposto ${res.status}`, undefined, { providerId: this.id });
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
			throw new LLMError(`Impossibile contattare Ollama su ${endpoint}. È in esecuzione?`, err, { kind: 'unreachable', providerId: this.id });
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
		// Temperatura: override della richiesta (es. chat "Libera" creativa) o default di config.
		// In modalità creativa (temp alta) aggiungo repeat_penalty per evitare il "pappagallo".
		const temp = req.temperature ?? cfg.temperature ?? 0.2;
		const options: Record<string, number> = { temperature: temp };
		if (temp >= 0.5) {
			options.repeat_penalty = 1.3;
			options.top_p = 0.9;
		}
		// Imposta esplicitamente la finestra di contesto (Req. 1.1, 1.3): config > modello > default.
		options.num_ctx = await this.resolveNumCtx(cfg.model);
		let thinkOpen = false;
		for await (const evt of this.postNdjson({ model: cfg.model, messages, options, ...(cfg.think ? { think: true } : {}) }, req.signal)) {
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
		const numCtx = await this.resolveNumCtx(cfg.model);

		let textStarted = false;
		let toolIndex = 0;
		let sawTool = false;

		for await (const evt of this.postNdjson({ model: cfg.model, messages, tools, options: { temperature: cfg.temperature ?? 0.2, num_ctx: numCtx } }, params.signal)) {
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
