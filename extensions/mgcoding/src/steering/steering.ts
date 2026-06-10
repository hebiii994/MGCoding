/*---------------------------------------------------------------------------------------------
 *  MGCoding - Steering: regole persistenti iniettate nel system prompt
 *  Cartella: <workspace>/.mg/steering/*.md  (+ globale: ~/.mg/steering)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveFeatureDirs } from '../util/paths';

type Inclusion = 'always' | 'fileMatch' | 'manual' | 'auto';

interface SteeringFile {
	name: string;
	inclusion: Inclusion;
	fileMatchPattern: string[];
	/** Per inclusion "auto": descrizione confrontata con la richiesta dell'utente. */
	description: string;
	body: string;
}

const DECODER = new TextDecoder();

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
	if (!raw.startsWith('---')) {
		return { meta: {}, body: raw };
	}
	const end = raw.indexOf('\n---', 3);
	if (end < 0) {
		return { meta: {}, body: raw };
	}
	const header = raw.slice(3, end).trim();
	const body = raw.slice(end + 4).replace(/^\s*\n/, '');
	const meta: Record<string, string> = {};
	for (const line of header.split('\n')) {
		const idx = line.indexOf(':');
		if (idx > 0) {
			meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}
	return { meta, body };
}

async function readSteeringDir(dir: vscode.Uri): Promise<SteeringFile[]> {
	const result: SteeringFile[] = [];
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return result;
	}
	for (const [fileName, type] of entries) {
		if (type !== vscode.FileType.File || !fileName.endsWith('.md')) {
			continue;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, fileName));
			const { meta, body } = parseFrontMatter(DECODER.decode(bytes));
			const inclusion = (meta.inclusion as Inclusion) || 'always';
			const patternRaw = meta.fileMatchPattern || '';
			const fileMatchPattern = patternRaw
				.replace(/[[\]"']/g, '')
				.split(',')
				.map(s => s.trim())
				.filter(Boolean);
			result.push({ name: fileName.replace(/\.md$/, ''), inclusion, fileMatchPattern, description: meta.description ?? '', body });
		} catch {
			// ignora file illeggibili
		}
	}
	return result;
}

function globToRegExp(glob: string): RegExp {
	const re = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '§§')
		.replace(/\*/g, '[^/]*')
		.replace(/§§/g, '.*');
	return new RegExp(`${re}$`);
}

/**
 * Elenca i nomi dei documenti di steering attivi (per mostrarli in chat, stile Kiro).
 */
export async function listSteeringNames(): Promise<string[]> {
	const dirs = await resolveFeatureDirs('steering');
	const seen = new Set<string>();
	for (const dir of dirs) {
		for (const f of await readSteeringDir(dir)) {
			seen.add(f.name);
		}
	}
	return [...seen];
}

/** True se la descrizione di uno steering "auto" combacia con la richiesta dell'utente. */
function matchesRequest(description: string, request: string): boolean {
	if (!description || !request) {
		return false;
	}
	const req = request.toLowerCase();
	const words = description.toLowerCase().split(/[^a-zàèéìíòóùú0-9]+/).filter(w => w.length > 3);
	if (!words.length) {
		return false;
	}
	const hits = words.filter(w => req.includes(w)).length;
	return hits >= Math.min(2, words.length);
}

/**
 * Costruisce la sezione "steering" del system prompt in base alla modalità di inclusione,
 * al file attivo e (per inclusion "auto") alla richiesta corrente dell'utente.
 */
export async function buildSteeringContext(requestHint?: string): Promise<string> {
	const dirs = await resolveFeatureDirs('steering');
	if (dirs.length === 0) {
		return '';
	}
	const seen = new Set<string>();
	const files: SteeringFile[] = [];
	for (const dir of dirs) {
		for (const f of await readSteeringDir(dir)) {
			if (!seen.has(f.name)) {
				seen.add(f.name);
				files.push(f);
			}
		}
	}
	if (files.length === 0) {
		return '';
	}

	const activePath = vscode.window.activeTextEditor?.document.uri.fsPath.replace(/\\/g, '/');

	const included = files.filter(f => {
		if (f.inclusion === 'always') {
			return true;
		}
		if (f.inclusion === 'fileMatch' && activePath) {
			return f.fileMatchPattern.some(p => globToRegExp(p).test(activePath));
		}
		if (f.inclusion === 'auto') {
			return matchesRequest(f.description, requestHint ?? '');
		}
		return false; // manual: incluso solo su richiesta esplicita
	});

	if (included.length === 0) {
		return '';
	}

	const sections = included.map(f => `## Steering: ${f.name}\n${f.body.trim()}`);
	return `Le seguenti regole di progetto (steering) sono SEMPRE valide e prioritarie:\n\n${sections.join('\n\n')}`;
}

const DEFAULT_STEERING: Record<string, string> = {
	'product.md': `---\ninclusion: always\n---\n\n# Prodotto\n\nDescrivi qui lo scopo del prodotto, gli utenti target e le funzionalità chiave.\n`,
	'tech.md': `---\ninclusion: always\n---\n\n# Stack tecnico\n\nElenca linguaggi, framework, librerie e vincoli tecnici del progetto.\n`,
	'structure.md': `---\ninclusion: always\n---\n\n# Struttura del progetto\n\nDescrivi l'organizzazione delle cartelle, le convenzioni di naming e i pattern architetturali.\n`
};

export async function initSteering(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showWarningMessage('Apri una cartella per inizializzare lo steering.');
		return;
	}
	const dir = vscode.Uri.joinPath(folders[0].uri, '.mg', 'steering');
	await vscode.workspace.fs.createDirectory(dir);
	const enc = new TextEncoder();
	for (const [name, content] of Object.entries(DEFAULT_STEERING)) {
		const uri = vscode.Uri.joinPath(dir, name);
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			await vscode.workspace.fs.writeFile(uri, enc.encode(content));
		}
	}
	vscode.window.showInformationMessage('Steering inizializzato in .mg/steering/');
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(dir, 'product.md'));
	await vscode.window.showTextDocument(doc);
}

// ---- Tree view ----

interface SteeringNode {
	uri: vscode.Uri;
	label: string;
	inclusion: Inclusion;
}

export class SteeringTreeProvider implements vscode.TreeDataProvider<SteeringNode> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	getTreeItem(node: SteeringNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.description = node.inclusion;
		item.iconPath = new vscode.ThemeIcon('compass');
		item.resourceUri = node.uri;
		item.contextValue = 'mgcoding.steering';
		item.command = { command: 'vscode.open', title: 'Apri', arguments: [node.uri] };
		return item;
	}

	async getChildren(): Promise<SteeringNode[]> {
		const dirs = await resolveFeatureDirs('steering');
		const seen = new Set<string>();
		const nodes: SteeringNode[] = [];
		for (const dir of dirs) {
			for (const f of await readSteeringDir(dir)) {
				if (seen.has(f.name)) {
					continue;
				}
				seen.add(f.name);
				nodes.push({ uri: vscode.Uri.joinPath(dir, `${f.name}.md`), label: f.name, inclusion: f.inclusion });
			}
		}
		return nodes;
	}
}
