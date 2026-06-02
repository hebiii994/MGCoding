/*---------------------------------------------------------------------------------------------
 *  MGCoding - Agent Hooks: automazioni scatenate da eventi dell'IDE + tree view
 *  Cartella: <workspace>/.mg/hooks/*.json
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { complete } from '../agent/agent';
import { ProviderRegistry } from '../llm/registry';
import { resolveFeatureDirs } from '../util/paths';
import { kiroHookToInternal } from '../util/parsing';

type HookEvent = 'onSave' | 'onCreate' | 'onDelete' | 'manual';
type HookAction = 'ask' | 'command';

export interface Hook {
	name: string;
	description?: string;
	event: HookEvent;
	filePattern?: string;
	action: HookAction;
	prompt?: string;
	command?: string;
	enabled?: boolean;
	/** uri del file json sorgente (runtime) */
	uri?: vscode.Uri;
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function hooksDir(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? vscode.Uri.joinPath(f[0].uri, '.mg', 'hooks') : undefined;
}

function globToRegExp(glob: string): RegExp {
	const re = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '§§')
		.replace(/\*/g, '[^/]*')
		.replace(/§§/g, '.*');
	return new RegExp(`${re}$`);
}

/** Converte un hook in formato Kiro (.kiro.hook: when/then) nel nostro Hook. */
function fromKiroHook(raw: any, uri: vscode.Uri): Hook | undefined {
	const internal = kiroHookToInternal(raw);
	return internal ? { ...internal, uri } : undefined;
}

export async function loadHooks(): Promise<Hook[]> {
	const dirs = await resolveFeatureDirs('hooks');
	const hooks: Hook[] = [];
	const seenNames = new Set<string>();
	for (const dir of dirs) {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			continue;
		}
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.File) {
				continue;
			}
			const isKiro = name.endsWith('.kiro.hook');
			if (!name.endsWith('.json') && !isKiro) {
				continue;
			}
			const uri = vscode.Uri.joinPath(dir, name);
			try {
			const raw = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(uri)));
			// Formato Kiro (when/then) oppure nostro (event/action)
			const hook = (isKiro || raw?.when || raw?.then) ? fromKiroHook(raw, uri) : (() => {
				if (raw?.name && raw?.event && raw?.action) {
					raw.uri = uri;
					raw.enabled = raw.enabled !== false;
					return raw as Hook;
				}
				return undefined;
			})();
			if (hook && !seenNames.has(hook.name)) {
				seenNames.add(hook.name);
				hooks.push(hook);
			}
		} catch {
			// ignora file non validi
		}
		}
	}
	return hooks;
}

export async function toggleHook(hook: Hook): Promise<void> {
	if (!hook.uri) {
		return;
	}
	// Riscrive solo il flag "enabled" preservando il formato originale (nostro o Kiro).
	try {
		const raw = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(hook.uri)));
		raw.enabled = !(raw.enabled !== false);
		await vscode.workspace.fs.writeFile(hook.uri, ENC.encode(JSON.stringify(raw, null, 2)));
	} catch {
		// ignora
	}
}

export async function createSampleHook(): Promise<void> {
	const dir = hooksDir();
	if (!dir) {
		vscode.window.showWarningMessage('Apri una cartella per creare un hook.');
		return;
	}
	const name = await vscode.window.showInputBox({ prompt: 'Nome del hook', ignoreFocusOut: true });
	if (!name) {
		return;
	}
	const description = await vscode.window.showInputBox({ prompt: 'Descrizione (opzionale)', ignoreFocusOut: true }) ?? '';
	const eventPick = await vscode.window.showQuickPick(
		[
			{ label: 'Al salvataggio file', value: 'onSave' as HookEvent },
			{ label: 'Alla creazione file', value: 'onCreate' as HookEvent },
			{ label: 'All\'eliminazione file', value: 'onDelete' as HookEvent },
			{ label: 'Manuale (bottone ▶)', value: 'manual' as HookEvent }
		],
		{ placeHolder: 'Quando si attiva?' }
	);
	if (!eventPick) {
		return;
	}
	const filePattern = await vscode.window.showInputBox({ prompt: 'Pattern file (glob), vuoto = tutti', value: '**/*.ts', ignoreFocusOut: true });
	const actionPick = await vscode.window.showQuickPick(
		[
			{ label: 'Chiedi all\'agente (prompt)', value: 'ask' as HookAction },
			{ label: 'Esegui comando shell', value: 'command' as HookAction }
		],
		{ placeHolder: 'Cosa fa?' }
	);
	if (!actionPick) {
		return;
	}
	let prompt: string | undefined;
	let command: string | undefined;
	if (actionPick.value === 'ask') {
		prompt = await vscode.window.showInputBox({ prompt: 'Prompt per l\'agente', ignoreFocusOut: true }) ?? '';
	} else {
		command = await vscode.window.showInputBox({ prompt: 'Comando shell (${file} = file coinvolto)', ignoreFocusOut: true }) ?? '';
	}

	await vscode.workspace.fs.createDirectory(dir);
	const hook: Hook = {
		name,
		description,
		event: eventPick.value,
		...(filePattern ? { filePattern } : {}),
		action: actionPick.value,
		...(prompt ? { prompt } : {}),
		...(command ? { command } : {}),
		enabled: true
	};
	const file = vscode.Uri.joinPath(dir, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'hook'}.json`);
	await vscode.workspace.fs.writeFile(file, ENC.encode(JSON.stringify(hook, null, 2)));
	const doc = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(doc);
}

export class HookManager implements vscode.Disposable {
	private hooks: Hook[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output: vscode.OutputChannel;

	constructor(private readonly registry: ProviderRegistry, private readonly onChanged: () => void) {
		this.output = vscode.window.createOutputChannel('MGCoding Hooks');
		this.disposables.push(this.output);

		this.disposables.push(vscode.workspace.onDidSaveTextDocument(doc => this.fire('onSave', doc.uri)));
		this.disposables.push(vscode.workspace.onDidCreateFiles(e => e.files.forEach(u => this.fire('onCreate', u))));
		this.disposables.push(vscode.workspace.onDidDeleteFiles(e => e.files.forEach(u => this.fire('onDelete', u))));

		const watcher = vscode.workspace.createFileSystemWatcher('**/{.mg/hooks/*.json,.kiro/hooks/*}');
		const reload = () => { void this.reload(); this.onChanged(); };
		watcher.onDidChange(reload);
		watcher.onDidCreate(reload);
		watcher.onDidDelete(reload);
		this.disposables.push(watcher);

		void this.reload();
	}

	async reload(): Promise<void> {
		this.hooks = await loadHooks();
	}

	private matches(hook: Hook, uri: vscode.Uri): boolean {
		if (!hook.filePattern) {
			return true;
		}
		const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		return globToRegExp(hook.filePattern).test(rel);
	}

	private async fire(event: HookEvent, uri: vscode.Uri): Promise<void> {
		for (const hook of this.hooks) {
			if (hook.enabled !== false && hook.event === event && this.matches(hook, uri)) {
				await this.execute(hook, uri);
			}
		}
	}

	async runManual(hook: Hook): Promise<void> {
		const uri = vscode.window.activeTextEditor?.document.uri
			?? vscode.workspace.workspaceFolders?.[0].uri;
		if (uri) {
			await this.execute(hook, uri);
		}
	}

	private async execute(hook: Hook, uri: vscode.Uri): Promise<void> {
		const rel = vscode.workspace.asRelativePath(uri, false);
		this.output.appendLine(`\n▶ Hook "${hook.name}" (${hook.event}) su ${rel}`);
		this.output.show(true);

		if (hook.action === 'command' && hook.command) {
			const term = vscode.window.createTerminal({ name: `MGCoding: ${hook.name}` });
			term.show(true);
			term.sendText(hook.command.replace(/\$\{file\}/g, uri.fsPath));
			return;
		}

		if (hook.action === 'ask' && hook.prompt) {
			let fileContent = '';
			try {
				fileContent = DEC.decode(await vscode.workspace.fs.readFile(uri));
			} catch {
				// es. file cancellato o cartella
			}
			const userPrompt = `${hook.prompt}\n\nFile: ${rel}\n\n\`\`\`\n${fileContent}\n\`\`\``;
			try {
				const reply = await complete(this.registry, [{ role: 'user', content: userPrompt }]);
				this.output.appendLine(reply);
			} catch (err) {
				this.output.appendLine(`[errore] ${String(err)}`);
			}
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

// ---- Tree view ----

interface HookNode {
	hook: Hook;
}

export class HooksTreeProvider implements vscode.TreeDataProvider<HookNode> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	getTreeItem(node: HookNode): vscode.TreeItem {
		const h = node.hook;
		const enabled = h.enabled !== false;
		const item = new vscode.TreeItem(h.name, vscode.TreeItemCollapsibleState.None);
		item.description = enabled ? h.event : `${h.event} · disabilitato`;
		item.tooltip = h.description ?? '';
		item.iconPath = new vscode.ThemeIcon(enabled ? 'zap' : 'circle-slash');
		item.contextValue = 'mgcoding.hook';
		if (h.uri) {
			item.command = { command: 'vscode.open', title: 'Apri', arguments: [h.uri] };
		}
		return item;
	}

	async getChildren(): Promise<HookNode[]> {
		return (await loadHooks()).map(hook => ({ hook }));
	}
}
