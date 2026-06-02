/*---------------------------------------------------------------------------------------------
 *  MGCoding - Specs: sviluppo spec-driven (requirements -> design -> tasks)
 *  Cartella: <workspace>/.mg/specs/<feature>/{requirements,design,tasks}.md
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { complete } from '../agent/agent';
import { runAgent } from '../agent/agentLoop';
import { ProviderRegistry } from '../llm/registry';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function slugify(name: string): string {
	return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature';
}

function specsRoot(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? vscode.Uri.joinPath(f[0].uri, '.mg', 'specs') : undefined;
}

async function writeAndOpen(uri: vscode.Uri, content: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, ENC.encode(content));
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, { preview: false });
}

async function readIfExists(uri: vscode.Uri): Promise<string> {
	try {
		return DEC.decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return '';
	}
}

async function generatePhase(
	registry: ProviderRegistry,
	title: string,
	systemExtra: string,
	userPrompt: string
): Promise<string> {
	return await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `MGCoding: genero ${title}...`, cancellable: false },
		async () => complete(registry, [{ role: 'user', content: userPrompt }], systemExtra)
	);
}

export async function createSpec(registry: ProviderRegistry, refresh: () => void): Promise<void> {
	const root = specsRoot();
	if (!root) {
		vscode.window.showWarningMessage('Apri una cartella per creare una Spec.');
		return;
	}
	const name = await vscode.window.showInputBox({ prompt: 'Nome della funzionalità', placeHolder: 'es. Autenticazione utenti' });
	if (!name) {
		return;
	}
	const desc = await vscode.window.showInputBox({ prompt: 'Descrivi cosa deve fare', ignoreFocusOut: true });
	if (desc === undefined) {
		return;
	}

	const dir = vscode.Uri.joinPath(root, slugify(name));
	await vscode.workspace.fs.createDirectory(dir);

	// Fase 1: requirements (EARS)
	const requirements = await generatePhase(
		registry,
		'requirements',
		`Genera un documento requirements.md per una funzionalità. Usa user stories e criteri di accettazione in notazione EARS (es. "WHEN <condizione> THE SYSTEM SHALL <comportamento>", "IF <condizione> THEN THE SYSTEM SHALL ..."). Solo Markdown, nessun preambolo.`,
		`Funzionalità: ${name}\nDescrizione: ${desc}`
	);
	await writeAndOpen(vscode.Uri.joinPath(dir, 'requirements.md'), requirements);
	refresh();

	const okReq = await vscode.window.showInformationMessage(
		`Requirements per "${name}" generati. Procedo col design?`,
		{ modal: true }, 'Approva e continua'
	);
	if (okReq !== 'Approva e continua') {
		return;
	}

	// Fase 2: design
	const design = await generatePhase(
		registry,
		'design',
		`Genera un documento design.md (architettura tecnica). Includi: panoramica, componenti, modello dati, interfacce/API, e dove utile diagrammi mermaid. Solo Markdown.`,
		`Funzionalità: ${name}\nRequisiti:\n${requirements}`
	);
	await writeAndOpen(vscode.Uri.joinPath(dir, 'design.md'), design);

	const okDes = await vscode.window.showInformationMessage(
		`Design per "${name}" generato. Procedo coi task?`,
		{ modal: true }, 'Approva e continua'
	);
	if (okDes !== 'Approva e continua') {
		return;
	}

	// Fase 3: tasks
	const tasks = await generatePhase(
		registry,
		'tasks',
		`Genera un documento tasks.md: elenco di task di implementazione discreti e tracciabili come checklist Markdown ("- [ ] ..."). Ogni task deve essere piccolo e verificabile, in ordine di dipendenza. Solo Markdown.`,
		`Funzionalità: ${name}\nDesign:\n${design}`
	);
	await writeAndOpen(vscode.Uri.joinPath(dir, 'tasks.md'), tasks);
	refresh();

	vscode.window.showInformationMessage(`Spec "${name}" completata in .mg/specs/${slugify(name)}/`);
}

// ---- Esecuzione dei task ----

interface ParsedTask {
	lineIdx: number;
	text: string;
	done: boolean;
}

const TASK_RE = /^(\s*[-*]\s*\[)( |x|X)(\]\s*)(.+)$/;

function parseTasks(md: string): ParsedTask[] {
	const lines = md.split('\n');
	const tasks: ParsedTask[] = [];
	lines.forEach((line, lineIdx) => {
		const m = TASK_RE.exec(line);
		if (m) {
			tasks.push({ lineIdx, text: m[4].trim(), done: m[2].toLowerCase() === 'x' });
		}
	});
	return tasks;
}

function markTaskDone(md: string, lineIdx: number): string {
	const lines = md.split('\n');
	lines[lineIdx] = lines[lineIdx].replace(/\[ \]/, '[x]');
	return lines.join('\n');
}

/**
 * Esegue (o riprende) tutti i task non completati di una spec, uno alla volta,
 * usando l'agente con il contesto di requirements e design. Spunta i task completati.
 */
export async function runSpecTasks(registry: ProviderRegistry, specDir: vscode.Uri, refresh: () => void): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	let tasksMd = await readIfExists(tasksUri);
	if (!tasksMd) {
		vscode.window.showWarningMessage('Nessun tasks.md in questa spec. Genera prima la spec.');
		return;
	}
	const requirements = await readIfExists(vscode.Uri.joinPath(specDir, 'requirements.md'));
	const design = await readIfExists(vscode.Uri.joinPath(specDir, 'design.md'));
	const specName = specDir.path.split('/').pop() ?? 'spec';

	const out = vscode.window.createOutputChannel('MGCoding Agent');
	out.show(true);

	const pending = parseTasks(tasksMd).filter(t => !t.done);
	if (pending.length === 0) {
		vscode.window.showInformationMessage(`Tutti i task di "${specName}" sono già completati.`);
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `MGCoding: eseguo i task di ${specName}`, cancellable: true },
		async (progress, token) => {
			const ac = new AbortController();
			token.onCancellationRequested(() => ac.abort());
			for (let i = 0; i < pending.length; i++) {
				if (token.isCancellationRequested) {
					break;
				}
				const task = pending[i];
				progress.report({ message: `(${i + 1}/${pending.length}) ${task.text.slice(0, 60)}`, increment: 100 / pending.length });
				out.appendLine(`\n\n========== TASK ${i + 1}/${pending.length}: ${task.text} ==========`);

				const prompt = `Stai implementando la funzionalità "${specName}" in modo spec-driven. Implementa SOLO il task indicato, usando i tool per leggere e scrivere i file necessari nel workspace.

# Requisiti
${requirements || '(non disponibili)'}

# Design
${design || '(non disponibile)'}

# Task da implementare ora
${task.text}

Quando hai finito di implementare questo task, fornisci un breve riepilogo di cosa hai fatto.`;

				const messages = [{ role: 'user' as const, content: prompt }];
				try {
					await runAgent(registry, messages, {
						onAssistantText: t => out.appendLine(`\n🤖 ${t}`),
						onToolStart: c => out.appendLine(`\n🔧 ${c.tool} ${JSON.stringify(c.args).slice(0, 200)}`),
						onToolResult: r => out.appendLine(`↳ ${r.slice(0, 400)}`)
					}, ac.signal);
				} catch (err) {
					out.appendLine(`[errore] ${String(err)}`);
				}

				// spunta il task (rileggo per sicurezza e applico per indice)
				tasksMd = markTaskDone(await readIfExists(tasksUri) || tasksMd, task.lineIdx);
				await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
				refresh();
			}
		}
	);

	out.appendLine('\n=== Esecuzione task terminata ===');
	vscode.window.showInformationMessage(`MGCoding: esecuzione task di "${specName}" terminata.`);
}

// ---- Tree view ----

type SpecNode = { kind: 'spec'; uri: vscode.Uri; label: string } | { kind: 'file'; uri: vscode.Uri; label: string };

export class SpecsTreeProvider implements vscode.TreeDataProvider<SpecNode> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	getTreeItem(node: SpecNode): vscode.TreeItem {
		if (node.kind === 'spec') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('checklist');
			item.contextValue = 'mgcoding.spec';
			return item;
		}
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('file');
		item.command = { command: 'vscode.open', title: 'Apri', arguments: [node.uri] };
		return item;
	}

	async getChildren(node?: SpecNode): Promise<SpecNode[]> {
		const root = specsRoot();
		if (!root) {
			return [];
		}
		if (!node) {
			let entries: [string, vscode.FileType][];
			try {
				entries = await vscode.workspace.fs.readDirectory(root);
			} catch {
				return [];
			}
			return entries
				.filter(([, t]) => t === vscode.FileType.Directory)
				.map(([dirName]) => ({ kind: 'spec', uri: vscode.Uri.joinPath(root, dirName), label: dirName }));
		}
		if (node.kind === 'spec') {
			const out: SpecNode[] = [];
			for (const fname of ['requirements.md', 'design.md', 'tasks.md']) {
				const uri = vscode.Uri.joinPath(node.uri, fname);
				if (await readIfExists(uri)) {
					out.push({ kind: 'file', uri, label: fname });
				}
			}
			return out;
		}
		return [];
	}
}
