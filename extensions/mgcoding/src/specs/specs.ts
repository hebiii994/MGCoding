/*---------------------------------------------------------------------------------------------
 *  MGCoding - Specs: sviluppo spec-driven (requirements -> design -> tasks)
 *  Cartella: <workspace>/.mg/specs/<feature>/{requirements,design,tasks}.md
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { complete } from '../agent/agent';
import { runAgent } from '../agent/agentLoop';
import { ProviderRegistry } from '../llm/registry';
import { RunReporter } from '../run/runView';
import { resolveFeatureDirs } from '../util/paths';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export function slugify(name: string): string {
	return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature';
}

export function specsRoot(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? vscode.Uri.joinPath(f[0].uri, '.mg', 'specs') : undefined;
}

/** System prompt per ciascuna fase del workflow spec-driven. */
export const SPEC_SYS = {
	requirements: `Genera un documento requirements.md spec-driven. Struttura:
# Requisiti: <nome>
## Introduzione (2-3 righe)
## Requisiti
Per ogni requisito numerato:
### Requisito N: <titolo>
**User story:** Come <ruolo>, voglio <obiettivo>, così che <beneficio>.
**Criteri di accettazione** in notazione EARS:
1. WHEN <evento> THE SYSTEM SHALL <comportamento>
2. IF <condizione> THEN THE SYSTEM SHALL <comportamento>
3. WHILE <stato> THE SYSTEM SHALL <comportamento>
Copri casi felici, errori e casi limite. Solo Markdown, nessun preambolo.`,
	design: `Genera un documento design.md (architettura tecnica) coerente con i requisiti dati. Sezioni:
# Design: <nome>
## Panoramica
## Architettura (componenti e responsabilità; usa un diagramma mermaid se utile)
## Componenti e interfacce (firme/API principali)
## Modello dati (tipi/strutture)
## Gestione degli errori
## Strategia di test
Mappa esplicitamente le scelte ai requisiti. Solo Markdown.`,
	tasks: `Genera un documento tasks.md: piano di implementazione come checklist Markdown ("- [ ] ...").
Regole:
- Ogni task è piccolo, concreto e verificabile (idealmente una singola unità di lavoro).
- Ordina i task per dipendenza (prima le fondamenta).
- Ogni task cita i requisiti che soddisfa, es: "(Req 1.2, 3.1)".
- Includi task di test dove sensato.
- Marca i task OPZIONALI (non essenziali per un MVP, es. CI/CD, documentazione extra) aggiungendo " (opzionale)" alla fine della riga del task.
- Solo passi implementabili nel codice (niente deploy/manuali). Solo Markdown.`
};

export async function writeAndOpen(uri: vscode.Uri, content: string): Promise<void> {
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
		SPEC_SYS.requirements,
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
		SPEC_SYS.design,
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
		SPEC_SYS.tasks,
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
	optional: boolean;
}

const TASK_RE = /^(\s*[-*]\s*\[)( |x|X)(\]\s*)(.+)$/;
const OPTIONAL_RE = /\((opzionale|optional)\)/i;

function parseTasks(md: string): ParsedTask[] {
	const lines = md.split('\n');
	const tasks: ParsedTask[] = [];
	lines.forEach((line, lineIdx) => {
		const m = TASK_RE.exec(line);
		if (m) {
			const text = m[4].trim();
			tasks.push({ lineIdx, text, done: m[2].toLowerCase() === 'x', optional: OPTIONAL_RE.test(text) });
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
export async function runSpecTasks(registry: ProviderRegistry, specDir: vscode.Uri, refresh: () => void, reporter: RunReporter, includeOptional = true, signal?: AbortSignal): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	let tasksMd = await readIfExists(tasksUri);
	if (!tasksMd) {
		vscode.window.showWarningMessage('Nessun tasks.md in questa spec. Genera prima la spec.');
		return;
	}
	const requirements = await readIfExists(vscode.Uri.joinPath(specDir, 'requirements.md'));
	const design = await readIfExists(vscode.Uri.joinPath(specDir, 'design.md'));
	const specName = specDir.path.split('/').pop() ?? 'spec';

	const pending = parseTasks(tasksMd).filter(t => !t.done && (includeOptional || !t.optional));
	if (pending.length === 0) {
		vscode.window.showInformationMessage(`Nessun task da eseguire per "${specName}"${includeOptional ? '' : ' (esclusi gli opzionali)'}.`);
		return;
	}

	reporter.start(`Spec: ${specName}`, pending.map(t => t.text));

	for (let i = 0; i < pending.length; i++) {
		if (signal?.aborted) {
			reporter.log('⏹ Esecuzione interrotta.');
			break;
		}
		const task = pending[i];
		reporter.setStatus(i, 'running');
		reporter.log(`▶ Task ${i + 1}/${pending.length}: ${task.text}`);

		const prompt = `Stai implementando la funzionalità "${specName}" in modo spec-driven. Implementa SOLO il task indicato, usando i tool per leggere e scrivere i file necessari nel workspace.

# Requisiti
${requirements || '(non disponibili)'}

# Design
${design || '(non disponibile)'}

# Task da implementare ora
${task.text}

NON modificare i file della spec (requirements.md, design.md, tasks.md): allo stato dei task (spunte) ci pensa MGCoding.
Quando hai finito di implementare questo task, fornisci un breve riepilogo di cosa hai fatto.`;

		const messages = [{ role: 'user' as const, content: prompt }];
		try {
			await runAgent(registry, messages, {
				onAssistantText: t => reporter.log(`🤖 ${t.slice(0, 300)}`),
				onToolStart: c => reporter.log(`🔧 ${c.tool} ${JSON.stringify(c.args).slice(0, 160)}`),
				onToolResult: r => reporter.log(`↳ ${r.slice(0, 200)}`)
			}, signal);
			reporter.setStatus(i, 'done');
		} catch (err) {
			reporter.setStatus(i, 'error');
			reporter.log(`[errore] ${String(err)}`);
		}

		// Spunta il task sulla NOSTRA copia autorevole (così non si perdono i task
		// già completati anche se l'agente avesse modificato il file).
		tasksMd = markTaskDone(tasksMd, task.lineIdx);
		await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
		refresh();
	}

	reporter.finish('=== Esecuzione task terminata ===');
}

/**
 * Esegue i task in PARALLELO con più subagent (pool di worker a concorrenza limitata).
 * Ogni task è un'esecuzione agentica indipendente. La marcatura su tasks.md è
 * serializzata per non perdere aggiornamenti. ATTENZIONE: subagent che modificano
 * gli stessi file possono confliggere — adatto a task su file distinti.
 */
export async function runSpecTasksParallel(
	registry: ProviderRegistry,
	specDir: vscode.Uri,
	refresh: () => void,
	reporter: RunReporter,
	includeOptional = true,
	signal?: AbortSignal,
	concurrency = 2
): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	let tasksMd = await readIfExists(tasksUri);
	if (!tasksMd) {
		vscode.window.showWarningMessage('Nessun tasks.md in questa spec. Genera prima la spec.');
		return;
	}
	const requirements = await readIfExists(vscode.Uri.joinPath(specDir, 'requirements.md'));
	const design = await readIfExists(vscode.Uri.joinPath(specDir, 'design.md'));
	const specName = specDir.path.split('/').pop() ?? 'spec';

	const pending = parseTasks(tasksMd).filter(t => !t.done && (includeOptional || !t.optional));
	if (pending.length === 0) {
		vscode.window.showInformationMessage(`Nessun task da eseguire per "${specName}".`);
		return;
	}

	const n = Math.max(1, Math.min(concurrency, pending.length));
	reporter.start(`Spec (paralleli ×${n}): ${specName}`, pending.map(t => t.text));

	// Lock per serializzare le scritture su tasks.md (evita aggiornamenti persi).
	let writeLock: Promise<void> = Promise.resolve();
	const markDone = (lineIdx: number): Promise<void> => {
		writeLock = writeLock.then(async () => {
			tasksMd = markTaskDone(tasksMd, lineIdx);
			await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
			refresh();
		});
		return writeLock;
	};

	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (signal?.aborted) {
				return;
			}
			const i = next++;
			if (i >= pending.length) {
				return;
			}
			const task = pending[i];
			const tag = `[${i + 1}/${pending.length}]`;
			reporter.log(`▶ ${tag} ${task.text}`);
			const prompt = `Stai implementando la funzionalità "${specName}" in modo spec-driven, come uno di più subagent in parallelo. Implementa SOLO questo task usando i tool. Tocca solo i file necessari a QUESTO task per non confliggere con gli altri subagent.

# Requisiti
${requirements || '(non disponibili)'}

# Design
${design || '(non disponibile)'}

# Task da implementare ora
${task.text}

NON modificare i file della spec (requirements/design/tasks.md). Al termine un breve riepilogo.`;
			try {
				await runAgent(registry, [{ role: 'user', content: prompt }], {
					onAssistantText: t => reporter.log(`🤖 ${tag} ${t.slice(0, 200)}`),
					onToolStart: c => reporter.log(`🔧 ${tag} ${c.tool} ${JSON.stringify(c.args).slice(0, 120)}`),
					onToolResult: r => reporter.log(`↳ ${tag} ${r.slice(0, 160)}`)
				}, signal);
				reporter.log(`✓ ${tag} completato`);
			} catch (err) {
				reporter.log(`✗ ${tag} ${String(err)}`);
			}
			await markDone(task.lineIdx);
		}
	};

	await Promise.all(Array.from({ length: n }, () => worker()));
	await writeLock;
	reporter.finish(`=== Esecuzione parallela terminata (${specName}) ===`);
}

/** Esegue un singolo task (per lineIdx) di una spec con l'agente. */
export async function runSpecTask(registry: ProviderRegistry, specDir: vscode.Uri, lineIdx: number, refresh: () => void, reporter: RunReporter, signal?: AbortSignal): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	let tasksMd = await readIfExists(tasksUri);
	const task = parseTasks(tasksMd).find(t => t.lineIdx === lineIdx);
	if (!task) {
		vscode.window.showWarningMessage('Task non trovato.');
		return;
	}
	if (task.done) {
		vscode.window.showInformationMessage('Task già completato.');
		return;
	}
	const requirements = await readIfExists(vscode.Uri.joinPath(specDir, 'requirements.md'));
	const design = await readIfExists(vscode.Uri.joinPath(specDir, 'design.md'));
	const specName = specDir.path.split('/').pop() ?? 'spec';

	reporter.start(`Task · ${specName}`, [task.text]);
	reporter.setStatus(0, 'running');
	const prompt = `Stai implementando la funzionalità "${specName}" in modo spec-driven. Implementa SOLO questo task usando i tool.

# Requisiti
${requirements || '(non disponibili)'}

# Design
${design || '(non disponibile)'}

# Task
${task.text}

NON modificare i file della spec (requirements.md, design.md, tasks.md): allo stato dei task ci pensa MGCoding.
Al termine fornisci un breve riepilogo.`;
	try {
		await runAgent(registry, [{ role: 'user', content: prompt }], {
			onAssistantText: t => reporter.log(`🤖 ${t.slice(0, 300)}`),
			onToolStart: c => reporter.log(`🔧 ${c.tool} ${JSON.stringify(c.args).slice(0, 160)}`),
			onToolResult: r => reporter.log(`↳ ${r.slice(0, 200)}`)
		}, signal);
		reporter.setStatus(0, 'done');
	} catch (err) {
		reporter.setStatus(0, 'error');
		reporter.log(`[errore] ${String(err)}`);
	}
	tasksMd = markTaskDone(await readIfExists(tasksUri) || tasksMd, lineIdx);
	await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
	refresh();
	reporter.finish('=== Task terminato ===');
}

// ---- CodeLens su tasks.md: "Start task" per riga + Run all in cima (stile Kiro) ----

/** Inverte lo stato (fatto/da fare) di un task nel tasks.md. */
export async function toggleSpecTask(specDir: vscode.Uri, lineIdx: number): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	const md = await readIfExists(tasksUri);
	if (!md) {
		return;
	}
	const lines = md.split('\n');
	const line = lines[lineIdx] ?? '';
	if (/\[ \]/.test(line)) {
		lines[lineIdx] = line.replace('[ ]', '[x]');
	} else if (/\[[xX]\]/.test(line)) {
		lines[lineIdx] = line.replace(/\[[xX]\]/, '[ ]');
	} else {
		return;
	}
	await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(lines.join('\n')));
}

/** Mostra azioni eseguibili direttamente nel tasks.md di una spec. */
export class SpecTasksCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const p = document.uri.path;
		if (!/tasks\.md$/i.test(p) || !/specs/i.test(p)) {
			return [];
		}
		const specDir = vscode.Uri.joinPath(document.uri, '..');
		const top = new vscode.Range(0, 0, 0, 0);
		const lenses: vscode.CodeLens[] = [
			new vscode.CodeLens(top, { title: '$(run-all) Run all tasks', command: 'mgcoding.runSpecTasksHere', arguments: [document.uri] }),
			new vscode.CodeLens(top, { title: '$(rocket) Run parallel (subagent)', command: 'mgcoding.runSpecTasksParallel', arguments: [document.uri] }),
			new vscode.CodeLens(top, { title: '$(play-circle) Run all + optional', command: 'mgcoding.runSpecTasksHereOptional', arguments: [document.uri] }),
			new vscode.CodeLens(top, { title: '$(sync) Sync', command: 'mgcoding.specSync', arguments: [document.uri] })
		];
		for (const t of parseTasks(document.getText())) {
			const range = new vscode.Range(t.lineIdx, 0, t.lineIdx, 0);
			if (!t.done) {
				const title = t.optional ? '$(play) Start task (opzionale)' : '$(play) Start task';
				lenses.push(new vscode.CodeLens(range, { title, command: 'mgcoding.runSpecTask', arguments: [{ specDir, lineIdx: t.lineIdx }] }));
			}
			lenses.push(new vscode.CodeLens(range, {
				title: t.done ? '$(check) Fatto (segna da fare)' : '$(circle-large-outline) Segna fatto',
				command: 'mgcoding.toggleSpecTask',
				arguments: [{ specDir, lineIdx: t.lineIdx }]
			}));
		}
		return lenses;
	}
}

// ---- Tree view ----

type SpecNode =
	| { kind: 'spec'; uri: vscode.Uri; label: string }
	| { kind: 'file'; uri: vscode.Uri; label: string }
	| { kind: 'task'; specDir: vscode.Uri; lineIdx: number; label: string; done: boolean };

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
		if (node.kind === 'task') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon(node.done ? 'pass-filled' : 'circle-large-outline');
			item.contextValue = 'mgcoding.task';
			item.tooltip = node.done ? 'Completato' : 'Da fare — esegui con ▶';
			return item;
		}
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('file');
		item.command = { command: 'vscode.open', title: 'Apri', arguments: [node.uri] };
		return item;
	}

	async getChildren(node?: SpecNode): Promise<SpecNode[]> {
		if (!node) {
			const roots = await resolveFeatureDirs('specs');
			const seen = new Set<string>();
			const out: SpecNode[] = [];
			for (const root of roots) {
				let entries: [string, vscode.FileType][];
				try {
					entries = await vscode.workspace.fs.readDirectory(root);
				} catch {
					continue;
				}
				for (const [dirName, t] of entries) {
					if (t === vscode.FileType.Directory && !seen.has(dirName)) {
						seen.add(dirName);
						out.push({ kind: 'spec', uri: vscode.Uri.joinPath(root, dirName), label: dirName });
					}
				}
			}
			return out;
		}
		if (node.kind === 'spec') {
			const out: SpecNode[] = [];
			for (const fname of ['requirements.md', 'design.md', 'tasks.md']) {
				const uri = vscode.Uri.joinPath(node.uri, fname);
				if (await readIfExists(uri)) {
					out.push({ kind: 'file', uri, label: fname });
				}
			}
			const tasksMd = await readIfExists(vscode.Uri.joinPath(node.uri, 'tasks.md'));
			for (const t of parseTasks(tasksMd)) {
				out.push({ kind: 'task', specDir: node.uri, lineIdx: t.lineIdx, label: t.text, done: t.done });
			}
			return out;
		}
		return [];
	}
}
