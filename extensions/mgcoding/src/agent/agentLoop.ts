/*---------------------------------------------------------------------------------------------
 *  MGCoding - loop agentico (ReAct con protocollo tool JSON, compatibile Claude e Ollama)
 *--------------------------------------------------------------------------------------------*/

import { ProviderRegistry } from '../llm/registry';
import { ChatMessage } from '../llm/types';
import { getMcpManager } from '../mcp/mcpClient';
import { complete, streamChat } from './agent';
import { executeTool, ToolCall, TOOL_SPECS } from './tools';

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

const TOOL_RE = /```mg-tool\s*([\s\S]*?)```/;

function parseToolCall(text: string): ToolCall | undefined {
	const m = TOOL_RE.exec(text);
	if (!m) {
		return undefined;
	}
	try {
		const obj = JSON.parse(m[1].trim());
		if (obj && typeof obj.tool === 'string') {
			return { tool: obj.tool, args: obj.args ?? {} };
		}
	} catch {
		// JSON malformato: ignora, verrà trattato come risposta finale
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
