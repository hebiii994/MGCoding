/*---------------------------------------------------------------------------------------------
 *  MGCoding - agente: assembla il contesto (steering) e dialoga col provider attivo
 *--------------------------------------------------------------------------------------------*/

import { ProviderRegistry } from '../llm/registry';
import { ChatMessage } from '../llm/types';
import { buildSteeringContext } from '../steering/steering';

const BASE_SYSTEM = `Sei MGCoding, un assistente di sviluppo agentico integrato nell'IDE.
Lavori in modo spec-driven: aiuti a definire requisiti, progettare e implementare funzionalità.
Rispondi in modo conciso e tecnico. Usa Markdown. Scrivi codice idiomatico e coerente col progetto.`;

export async function buildSystemPrompt(extra?: string): Promise<string> {
	const steering = await buildSteeringContext();
	return [BASE_SYSTEM, steering, extra].filter(Boolean).join('\n\n');
}

/** Streaming: invoca onDelta per ogni frammento di testo. */
export async function streamChat(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	onDelta: (text: string) => void,
	signal?: AbortSignal,
	systemExtra?: string
): Promise<string> {
	const provider = registry.current();
	const system = await buildSystemPrompt(systemExtra);
	let full = '';
	for await (const delta of provider.stream({ system, messages, signal })) {
		full += delta;
		onDelta(delta);
	}
	return full;
}

/** Completamento non-streaming: ritorna l'intera risposta. */
export async function complete(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	systemExtra?: string,
	signal?: AbortSignal
): Promise<string> {
	const provider = registry.current();
	const system = await buildSystemPrompt(systemExtra);
	let full = '';
	for await (const delta of provider.stream({ system, messages, signal })) {
		full += delta;
	}
	return full;
}
