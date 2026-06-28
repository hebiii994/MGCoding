/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider GLM (Zhipu/Z.ai)
 *  GLM espone sia un endpoint OpenAI-compatibile sia uno Anthropic-compatibile.
 *  Per non duplicare il parsing dello streaming, il provider riusa la logica esistente:
 *   - OpenAIProvider per il percorso OpenAI-compat (default, Req. 8.2);
 *   - ClaudeProvider per il percorso Anthropic-native con tool-use nativo (Req. 8.3).
 *--------------------------------------------------------------------------------------------*/

import { ClaudeProvider } from './claudeProvider';
import { OpenAIProvider } from './openaiProvider';
import { AgentStreamParams, AnthropicStreamEvent, LLMProvider, LLMRequest } from './types';

/** maxTokens di default per il percorso Anthropic-compat quando non configurato altrove. */
const DEFAULT_MAX_TOKENS = 8192;

export interface GLMConfig {
	/** Endpoint OpenAI-compatibile (default Z.ai). */
	openaiEndpoint: string;
	/** Endpoint Anthropic-compatibile (Messages API). */
	anthropicEndpoint: string;
	/** Modello GLM da usare (es. glm-4.6). */
	model: string;
	/** mgcoding.glm.useAnthropicEndpoint: se true usa il percorso Anthropic-native (Req. 8.3). */
	useAnthropicEndpoint: boolean;
	/** Tetto di token per la risposta sul percorso Anthropic-compat (opzionale). */
	maxTokens?: number;
}

/**
 * Provider GLM. Mantiene sempre disponibili entrambi i percorsi (OpenAI-compat e
 * Anthropic-compat) e instrada in base al flag `useAnthropicEndpoint`:
 *  - false (default): delega all'OpenAIProvider sull'endpoint OpenAI-compat (Req. 8.2);
 *  - true: usa il ClaudeProvider sull'endpoint Anthropic-compat per il tool-use nativo,
 *    senza disattivare la compatibilità OpenAI per i flussi che la richiedono (Req. 8.3).
 */
export class GLMProvider implements LLMProvider {
	readonly id = 'glm';
	readonly label = 'GLM (Zhipu/Z.ai)';

	/** Percorso OpenAI-compat: riusa interamente la logica di OpenAIProvider. */
	private readonly openaiPath: OpenAIProvider;
	/** Percorso Anthropic-compat: riusa interamente la logica di ClaudeProvider. */
	private readonly anthropicPath: ClaudeProvider;

	constructor(
		private readonly getApiKey: () => Promise<string | undefined>,
		private readonly getConfig: () => GLMConfig
	) {
		// Sotto-provider OpenAI-compat: condivide chiave e modello, puntato all'endpoint GLM.
		// L'identità è sovrascritta a 'glm' così gli errori (chiave/rate limit) sono attribuiti
		// al provider GLM e non al generico OpenAI-compatibile (Req. 9.2-9.4).
		this.openaiPath = new OpenAIProvider(
			this.getApiKey,
			() => {
				const cfg = this.getConfig();
				return { endpoint: cfg.openaiEndpoint, model: cfg.model };
			},
			{ id: this.id, label: this.label }
		);
		// Sotto-provider Anthropic-compat: stesso modello/chiave, endpoint Messages API GLM.
		this.anthropicPath = new ClaudeProvider(
			this.getApiKey,
			() => {
				const cfg = this.getConfig();
				return {
					model: cfg.model,
					maxTokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
					baseUrl: cfg.anthropicEndpoint
				};
			},
			{ id: this.id, label: this.label }
		);
	}

	/** Percorso attivo in base al flag di configurazione. */
	private active(): LLMProvider {
		return this.getConfig().useAnthropicEndpoint ? this.anthropicPath : this.openaiPath;
	}

	isConfigured(): Promise<boolean> {
		return this.active().isConfigured();
	}

	modelName(): string {
		return this.getConfig().model;
	}

	/**
	 * Elenca i modelli GLM esposti dall'endpoint OpenAI-compatibile (per popolare il menù
	 * modelli). Il percorso Anthropic-compat non ha un `/models` standard: in quel caso si
	 * ricade sul solo modello configurato. Best-effort: `[]` se non disponibile.
	 */
	async listModels(): Promise<string[]> {
		return this.openaiPath.listModels();
	}

	stream(req: LLMRequest): AsyncIterable<string> {
		return this.active().stream(req);
	}

	async *streamAgent(params: AgentStreamParams): AsyncIterable<AnthropicStreamEvent> {
		const provider = this.active();
		// Entrambi i sotto-provider implementano streamAgent (tool-use nativo / function calling).
		if (!provider.streamAgent) {
			throw new Error('Il percorso GLM attivo non supporta lo streaming agentico.');
		}
		yield* provider.streamAgent(params);
	}
}
