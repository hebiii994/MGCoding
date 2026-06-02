/*---------------------------------------------------------------------------------------------
 *  MGCoding - agente: assembla il contesto (steering) e dialoga col provider attivo
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../llm/registry';
import { ChatMessage } from '../llm/types';
import { buildSteeringContext } from '../steering/steering';

const BASE_SYSTEM = `Sei MGCoding, un assistente di sviluppo agentico integrato nell'IDE.
Lavori in modo spec-driven: aiuti a definire requisiti, progettare e implementare funzionalità.
Prima di modificare, esplora il progetto con i tool find_files, search_text e read_file invece di assumere.
Rispondi in modo conciso e tecnico. Usa Markdown. Scrivi codice idiomatico e coerente col progetto.`;

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'out-build', 'out-vscode', '.build', 'dist', '.vscode-test']);

/** Mappa compatta del progetto (2 livelli, limitata) per orientare l'agente. */
async function buildProjectContext(): Promise<string> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return '';
	}
	const root = folders[0].uri;
	let top: [string, vscode.FileType][];
	try {
		top = await vscode.workspace.fs.readDirectory(root);
	} catch {
		return '';
	}
	top.sort((a, b) => a[0].localeCompare(b[0]));
	const lines: string[] = [];
	for (const [name, type] of top) {
		if (lines.length > 70) {
			break;
		}
		if (type === vscode.FileType.Directory) {
			if (SKIP_DIRS.has(name)) {
				lines.push(`${name}/ (…)`);
				continue;
			}
			lines.push(`${name}/`);
			try {
				const sub = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, name));
				sub.slice(0, 12).forEach(([n, t]) => lines.push(`  ${n}${t === vscode.FileType.Directory ? '/' : ''}`));
				if (sub.length > 12) {
					lines.push(`  … (+${sub.length - 12})`);
				}
			} catch {
				// ignora
			}
		} else {
			lines.push(name);
		}
	}
	return `Struttura del progetto (workspace: ${folders[0].name}):\n${lines.join('\n')}`;
}

export async function buildSystemPrompt(extra?: string): Promise<string> {
	const [project, steering] = await Promise.all([buildProjectContext(), buildSteeringContext()]);
	return [BASE_SYSTEM, project, steering, extra].filter(Boolean).join('\n\n');
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
