/*---------------------------------------------------------------------------------------------
 *  MGCoding - provider Ollama (LLM locale, API /api/chat, streaming NDJSON) via fetch
 *--------------------------------------------------------------------------------------------*/

import { LLMError, LLMProvider, LLMRequest } from './types';

export interface OllamaConfig {
	endpoint: string;
	model: string;
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

	async *stream(req: LLMRequest): AsyncIterable<string> {
		const cfg = this.getConfig();
		const endpoint = cfg.endpoint.replace(/\/$/, '');

		const messages = [
			...(req.system ? [{ role: 'system', content: req.system }] : []),
			...req.messages.map(m => ({ role: m.role, content: m.content }))
		];

		let res: Response;
		try {
			res = await fetch(`${endpoint}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: cfg.model, messages, stream: true }),
				signal: req.signal
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
				let evt: any;
				try {
					evt = JSON.parse(line);
				} catch {
					continue;
				}
				if (evt.message?.content) {
					yield evt.message.content as string;
				}
				if (evt.error) {
					throw new LLMError(`Ollama error: ${evt.error}`);
				}
			}
		}
	}
}
