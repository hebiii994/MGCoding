/*---------------------------------------------------------------------------------------------
 *  MGCoding - loop agentico (ReAct con protocollo tool JSON, compatibile Claude e Ollama)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../llm/registry';
import { AnthropicBlock, AnthropicMessage, ChatMessage, LLMProvider } from '../llm/types';
import { getMcpManager } from '../mcp/mcpClient';
import { buildSystemPrompt, complete, streamChat } from './agent';
import { anthropicBuiltinTools, executeTool, ToolCall, TOOL_SPECS } from './tools';

const MAX_ITERATIONS = 12;

function toolSystemPrompt(): string {
	const specs = [...TOOL_SPECS, ...(getMcpManager()?.toolSpecs() ?? [])];
	const list = specs.map(t => `- ${t.name}: ${t.description} args: ${t.args}`).join('\n');
	return `Puoi usare dei tool per agire sul progetto.
Quando vuoi usare un tool, rispondi ESCLUSIVAMENTE con un blocco di codice così (un solo tool per volta):
\`\`\`mg-tool
{"tool": "<nome>", "args": { ... }}
\`\`\`
Dopo che ti avrò fornito il risultato del tool, continua il ragionamento o usa un altro tool.
Quando hai completato il compito, rispondi normalmente in Markdown SENZA blocchi mg-tool.

Tool disponibili:
${list}

Usa percorsi relativi alla radice del workspace. Sii prudente con run_command.`;
}

const TOOL_RE = /```(?:mg-tool|json)?\s*([\s\S]*?)```/;

/** Estrae una tool-call accettando sia {tool,args} (mg-tool) sia {name,arguments} (stile function-call). */
function parseToolCall(text: string): ToolCall | undefined {
	let jsonStr: string | undefined;
	const m = TOOL_RE.exec(text);
	if (m) {
		jsonStr = m[1].trim();
	} else if (text.trim().startsWith('{') && text.trim().endsWith('}')) {
		jsonStr = text.trim();
	}
	if (!jsonStr) {
		return undefined;
	}
	try {
		const obj = JSON.parse(jsonStr);
		const name = obj.tool ?? obj.name;
		const args = obj.args ?? obj.arguments ?? {};
		if (typeof name === 'string') {
			return { tool: name, args };
		}
	} catch {
		// JSON malformato: trattato come risposta finale
	}
	return undefined;
}

export interface AgentCallbacks {
	/** Testo "statico" dell'assistente (ragionamento prima di un tool, o fallback non-streaming). */
	onAssistantText(text: string): void;
	onToolStart(call: ToolCall): void;
	onToolResult(result: string): void;
	/** Callback di streaming (opzionali): se onStreamDelta è presente, il loop usa lo streaming. */
	onStreamStart?(): void;
	onStreamDelta?(text: string): void;
	onStreamEnd?(): void;
	onStreamCancel?(): void;
}

/**
 * Esegue il loop agentico finché il modello smette di invocare tool o si raggiunge il limite.
 * `messages` include già il messaggio utente corrente.
 * Se vengono forniti i callback di streaming, i token sono emessi in tempo reale; il parsing
 * dei tool avviene comunque sul testo completo della risposta.
 */
export async function runAgent(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	cb: AgentCallbacks,
	signal?: AbortSignal
): Promise<void> {
	const provider = registry.current();
	// Percorso preferito: tool-use NATIVO se il provider lo supporta (Claude sempre; Ollama se abilitato).
	const ollamaNative = provider.id !== 'ollama'
		|| vscode.workspace.getConfiguration('mgcoding').get<boolean>('ollama.nativeTools', true);
	if (typeof provider.streamAgent === 'function' && ollamaNative) {
		return runNativeAgent(provider, messages, cb, signal);
	}
	return runJsonAgent(registry, messages, cb, signal);
}

/**
 * Loop agentico con protocollo tool testuale (mg-tool), usato dai modelli senza tool-use
 * nativo (es. Ollama).
 */
async function runJsonAgent(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	cb: AgentCallbacks,
	signal?: AbortSignal
): Promise<void> {
	const sys = toolSystemPrompt();
	const streaming = typeof cb.onStreamDelta === 'function';

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		if (signal?.aborted) {
			return;
		}

		let reply: string;
		if (streaming) {
			cb.onStreamStart?.();
			reply = await streamChat(registry, messages, d => cb.onStreamDelta!(d), signal, sys);
		} else {
			reply = await complete(registry, messages, sys, signal);
		}

		const call = parseToolCall(reply);

		if (!call) {
			if (streaming) {
				cb.onStreamEnd?.();
			} else {
				cb.onAssistantText(reply);
			}
			messages.push({ role: 'assistant', content: reply });
			return;
		}

		// È una tool-call: in streaming annulliamo la bolla mostrata (conteneva il JSON del tool)
		if (streaming) {
			cb.onStreamCancel?.();
		}
		// testo eventuale prima del blocco tool (ragionamento) mostrato come testo statico
		const before = reply.slice(0, TOOL_RE.exec(reply)?.index ?? 0).trim();
		if (before) {
			cb.onAssistantText(before);
		}
		messages.push({ role: 'assistant', content: reply });

		cb.onToolStart(call);
		const result = await executeTool(call);
		cb.onToolResult(result);
		messages.push({ role: 'user', content: `Risultato del tool ${call.tool}:\n${result}` });
	}

	cb.onAssistantText('_(raggiunto il limite massimo di passi dell\'agente)_');
}

// --- Percorso tool-use NATIVO (Claude) ---

interface AccBlock {
	type: 'text' | 'tool_use';
	text?: string;
	id?: string;
	name?: string;
	json?: string;
}

/**
 * Loop agentico con tool-use NATIVO (function calling Anthropic): più affidabile,
 * stile Kiro. I tool sono passati come schema; il modello risponde con blocchi tool_use
 * e noi rispondiamo con tool_result.
 */
async function runNativeAgent(
	provider: LLMProvider,
	history: ChatMessage[],
	cb: AgentCallbacks,
	signal?: AbortSignal
): Promise<void> {
	const system = await buildSystemPrompt();
	const tools = [...anthropicBuiltinTools(), ...(getMcpManager()?.anthropicTools() ?? [])];
	const streaming = typeof cb.onStreamDelta === 'function';

	// Costruisce i messaggi Anthropic dallo storico testuale.
	const messages: AnthropicMessage[] = history.map(m => ({
		role: m.role === 'assistant' ? 'assistant' : 'user',
		content: [{ type: 'text', text: m.content }]
	}));

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		if (signal?.aborted) {
			return;
		}

		if (streaming) {
			cb.onStreamStart?.();
		}

		const blocks = new Map<number, AccBlock>();
		let textAcc = '';
		let stopReason: string | undefined;

		for await (const evt of provider.streamAgent!({ system, messages, tools, signal })) {
			if (evt.type === 'content_block_start' && evt.content_block && evt.index !== undefined) {
				if (evt.content_block.type === 'tool_use') {
					blocks.set(evt.index, { type: 'tool_use', id: evt.content_block.id, name: evt.content_block.name, json: '' });
				} else if (evt.content_block.type === 'text') {
					blocks.set(evt.index, { type: 'text', text: '' });
				}
			} else if (evt.type === 'content_block_delta' && evt.delta && evt.index !== undefined) {
				const b = blocks.get(evt.index);
				if (evt.delta.type === 'text_delta' && evt.delta.text) {
					textAcc += evt.delta.text;
					if (streaming) {
						cb.onStreamDelta!(evt.delta.text);
					}
					if (b && b.type === 'text') {
						b.text = (b.text ?? '') + evt.delta.text;
					}
				} else if (evt.delta.type === 'input_json_delta' && evt.delta.partial_json && b && b.type === 'tool_use') {
					b.json = (b.json ?? '') + evt.delta.partial_json;
				}
			} else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
				stopReason = evt.delta.stop_reason;
			} else if (evt.type === 'error') {
				throw new Error('Errore nello stream Anthropic.');
			}
		}

		// Ricostruisce i blocchi della risposta in ordine di indice.
		const assistantContent: AnthropicBlock[] = [];
		for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
			if (b.type === 'text' && b.text) {
				assistantContent.push({ type: 'text', text: b.text });
			} else if (b.type === 'tool_use' && b.id && b.name) {
				let input: Record<string, unknown> = {};
				try {
					input = b.json ? JSON.parse(b.json) : {};
				} catch {
					input = {};
				}
				assistantContent.push({ type: 'tool_use', id: b.id, name: b.name, input });
			}
		}
		if (assistantContent.length === 0) {
			assistantContent.push({ type: 'text', text: textAcc });
		}
		messages.push({ role: 'assistant', content: assistantContent });

		const toolUses = assistantContent.filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b.type === 'tool_use');

		if (stopReason !== 'tool_use' || toolUses.length === 0) {
			// Risposta finale.
			if (streaming) {
				cb.onStreamEnd?.();
			} else {
				cb.onAssistantText(textAcc);
			}
			history.push({ role: 'assistant', content: textAcc });
			return;
		}

		// Chiude la bolla di testo (vuota -> annulla; con testo -> mantiene).
		if (streaming) {
			if (textAcc.trim()) {
				cb.onStreamEnd?.();
			} else {
				cb.onStreamCancel?.();
			}
		} else if (textAcc.trim()) {
			cb.onAssistantText(textAcc);
		}

		// Esegue i tool e prepara i tool_result.
		const resultBlocks: AnthropicBlock[] = [];
		for (const tu of toolUses) {
			cb.onToolStart({ tool: tu.name, args: tu.input });
			const result = await executeTool({ tool: tu.name, args: tu.input });
			cb.onToolResult(result);
			resultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
		}
		messages.push({ role: 'user', content: resultBlocks });
	}

	cb.onAssistantText('_(raggiunto il limite massimo di passi dell\'agente)_');
}
