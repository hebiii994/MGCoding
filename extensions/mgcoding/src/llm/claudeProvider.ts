/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider Claude (Anthropic Messages API, streaming SSE) via fetch
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage, LLMError, LLMProvider, LLMRequest } from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeConfig {
	model: string;
	maxTokens: number;
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

	async *stream(req: LLMRequest): AsyncIterable<string> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new LLMError('API key Claude non impostata. Usa "MGCoding: Imposta API key Claude".');
		}
		const cfg = this.getConfig();
		const body = {
			model: cfg.model,
			max_tokens: req.maxTokens ?? cfg.maxTokens,
			stream: true,
			system: req.system,
			messages: req.messages
				.filter(m => m.role !== 'system')
				.map((m: ChatMessage) => ({ role: m.role, content: m.content }))
		};

		let res: Response;
		try {
			res = await fetch(ANTHROPIC_URL, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': ANTHROPIC_VERSION
				},
				body: JSON.stringify(body),
				signal: req.signal
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
				let evt: any;
				try {
					evt = JSON.parse(data);
				} catch {
					continue;
				}
				if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
					yield evt.delta.text as string;
				} else if (evt.type === 'error') {
					throw new LLMError(`Anthropic stream error: ${evt.error?.message ?? 'unknown'}`);
				}
			}
		}
	}
}
