/*---------------------------------------------------------------------------------------------
 *  MGCoding - agente: assembla il contesto (steering) e dialoga col provider attivo
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../llm/registry';
import { ChatMessage, LLMProvider } from '../llm/types';
import { buildSteeringContext } from '../steering/steering';

const BASE_SYSTEM = `Sei MGCoding, un assistente di sviluppo agentico integrato nell'IDE, in stile spec-driven (come Kiro).

Principi operativi:
- Esplora prima di agire: usa find_files, search_text e read_file per capire il codice esistente; non assumere percorsi o API.
- Se l'utente si riferisce a "questo file", "questa spec" o un nome (es. una cartella in specs), usa il file aperto e i suoi fratelli (requirements.md/design.md/tasks.md) e LEGGILI con read_file. NON dichiarare che un file o una spec "non esiste" senza prima averlo cercato con find_files/read_file.
- Fai modifiche minime e mirate, coerenti con i pattern, lo stile e le convenzioni del progetto.
- Rispetta SEMPRE le regole di steering del progetto: hanno la priorità su tutto.
- Per funzionalità non banali ragiona in fasi: requisiti → design → task → implementazione.
- Verifica il tuo lavoro: dopo una modifica, rileggi o controlla il risultato quando ha senso.
- Con run_command spiega prima cosa fai e preferisci comandi non distruttivi.
- Sii conciso e tecnico. Usa Markdown. Mostra solo le porzioni di codice rilevanti, non interi file.`;

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

/** Contesto del file attualmente aperto (+ file fratelli), così l'agente "vede" cosa stai guardando. */
async function buildActiveContext(): Promise<string> {
	const ed = vscode.window.activeTextEditor;
	if (!ed || ed.document.uri.scheme !== 'file') {
		return '';
	}
	const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
	const text = ed.document.getText();
	const parts = [`File attualmente aperto nell'editor: ${rel}\n\`\`\`\n${text.slice(0, 6000)}${text.length > 6000 ? '\n…(troncato)' : ''}\n\`\`\``];

	// Se il file fa parte di una spec (.../specs/<nome>/...), elenca i file fratelli.
	try {
		const dir = vscode.Uri.joinPath(ed.document.uri, '..');
		const entries = await vscode.workspace.fs.readDirectory(dir);
		const siblings = entries.filter(([, t]) => t === vscode.FileType.File).map(([n]) => n);
		if (siblings.length > 1) {
			const dirRel = vscode.workspace.asRelativePath(dir, false);
			parts.push(`Altri file nella stessa cartella (${dirRel}): ${siblings.join(', ')} — leggili con read_file se servono.`);
		}
	} catch {
		// ignora
	}
	return parts.join('\n\n');
}

export async function buildSystemPrompt(extra?: string): Promise<string> {
	const [project, steering, active] = await Promise.all([buildProjectContext(), buildSteeringContext(), buildActiveContext()]);
	return [BASE_SYSTEM, project, steering, active, extra].filter(Boolean).join('\n\n');
}

/** Streaming: invoca onDelta per ogni frammento di testo. */
export async function streamChat(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	onDelta: (text: string) => void,
	signal?: AbortSignal,
	systemExtra?: string,
	providerOverride?: LLMProvider
): Promise<string> {
	const provider = providerOverride ?? registry.current();
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
	signal?: AbortSignal,
	providerOverride?: LLMProvider
): Promise<string> {
	const provider = providerOverride ?? registry.current();
	const system = await buildSystemPrompt(systemExtra);
	let full = '';
	for await (const delta of provider.stream({ system, messages, signal })) {
		full += delta;
	}
	return full;
}
