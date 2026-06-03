/*---------------------------------------------------------------------------------------------
 *  MGCoding - autocomplete inline (ghost text) via Ollama FIM (/api/generate con suffix)
 *  Disattivato di default; usa un modello locale veloce dedicato.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

function cfg() {
	return vscode.workspace.getConfiguration('mgcoding');
}

async function fim(prefix: string, suffix: string, signal: AbortSignal): Promise<string> {
	const c = cfg();
	const endpoint = c.get<string>('ollama.endpoint', 'http://localhost:11434').replace(/\/$/, '');
	const model = c.get<string>('autocomplete.model', 'qwen2.5-coder:7b');
	try {
		const res = await fetch(`${endpoint}/api/generate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model,
				prompt: prefix,
				suffix,
				stream: false,
				options: { num_predict: 128, temperature: 0.2, stop: ['\n\n'] }
			}),
			signal
		});
		if (!res.ok) {
			return '';
		}
		const data = await res.json() as { response?: string };
		return data.response ?? '';
	} catch {
		return '';
	}
}

function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise(resolve => {
		const t = setTimeout(() => resolve(true), ms);
		token.onCancellationRequested(() => { clearTimeout(t); resolve(false); });
	});
}

class MgInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		if (!cfg().get<boolean>('autocomplete.enabled', false)) {
			return undefined;
		}
		// Debounce: attende un attimo; se l'utente continua a digitare, viene annullato.
		if (!(await delay(250, token)) || token.isCancellationRequested) {
			return undefined;
		}

		const full = document.getText();
		const offset = document.offsetAt(position);
		const prefix = full.slice(Math.max(0, offset - 4000), offset);
		const suffix = full.slice(offset, offset + 1000);
		if (!prefix.trim()) {
			return undefined;
		}

		const ac = new AbortController();
		token.onCancellationRequested(() => ac.abort());
		const completion = await fim(prefix, suffix, ac.signal);
		if (!completion || token.isCancellationRequested) {
			return undefined;
		}
		return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
	}
}

export function registerAutocomplete(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new MgInlineCompletionProvider())
	);
}
