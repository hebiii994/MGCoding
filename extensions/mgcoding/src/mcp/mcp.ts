/*---------------------------------------------------------------------------------------------
 *  MGCoding - MCP Servers: vista con stato di connessione live e tool per server
 *  Config: <workspace>/.mg/mcp.json (o .kiro/settings/mcp.json)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { McpServerStatus } from './mcpClient';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

interface McpServerConfig {
	command?: string;
	args?: string[];
	disabled?: boolean;
}

interface McpJson {
	mcpServers?: Record<string, McpServerConfig>;
}

function mcpConfigUri(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? vscode.Uri.joinPath(f[0].uri, '.mg', 'mcp.json') : undefined;
}

/** File mcp.json esistente da modificare (.mg preferito, poi .kiro), o undefined se nessuno. */
async function existingConfigUri(): Promise<vscode.Uri | undefined> {
	const f = vscode.workspace.workspaceFolders;
	if (!f?.length) {
		return undefined;
	}
	const candidates = [
		vscode.Uri.joinPath(f[0].uri, '.mg', 'mcp.json'),
		vscode.Uri.joinPath(f[0].uri, '.kiro', 'settings', 'mcp.json')
	];
	for (const c of candidates) {
		try {
			await vscode.workspace.fs.stat(c);
			return c;
		} catch {
			// prova il prossimo
		}
	}
	return undefined;
}

async function readConfig(uri: vscode.Uri): Promise<McpJson> {
	try {
		return JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(uri))) as McpJson;
	} catch {
		return {};
	}
}

async function writeConfig(uri: vscode.Uri, cfg: McpJson): Promise<void> {
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, ENC.encode(JSON.stringify(cfg, null, 2)));
}

/** Aggiunge un server MCP in modo guidato (nome, comando, argomenti). */
export async function addMcpServer(): Promise<boolean> {
	const target = mcpConfigUri();
	if (!target) {
		vscode.window.showWarningMessage('Apri una cartella per configurare MCP.');
		return false;
	}
	const name = (await vscode.window.showInputBox({
		title: 'Nuovo server MCP (1/3)',
		prompt: 'Nome del server',
		placeHolder: 'es. filesystem',
		validateInput: v => v.trim() ? undefined : 'Inserisci un nome'
	}))?.trim();
	if (!name) {
		return false;
	}
	const command = (await vscode.window.showInputBox({
		title: 'Nuovo server MCP (2/3)',
		prompt: 'Comando da eseguire',
		placeHolder: 'es. npx',
		validateInput: v => v.trim() ? undefined : 'Inserisci un comando'
	}))?.trim();
	if (!command) {
		return false;
	}
	const argsRaw = await vscode.window.showInputBox({
		title: 'Nuovo server MCP (3/3)',
		prompt: 'Argomenti separati da spazio (opzionale)',
		placeHolder: '-y @modelcontextprotocol/server-filesystem .'
	});
	if (argsRaw === undefined) {
		return false;
	}
	const args = argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [];

	const uri = (await existingConfigUri()) ?? target;
	const cfg = await readConfig(uri);
	cfg.mcpServers = cfg.mcpServers ?? {};
	if (cfg.mcpServers[name]) {
		const ow = await vscode.window.showWarningMessage(`Esiste già un server "${name}". Sovrascriverlo?`, { modal: true }, 'Sovrascrivi');
		if (ow !== 'Sovrascrivi') {
			return false;
		}
	}
	cfg.mcpServers[name] = { command, args, disabled: false };
	await writeConfig(uri, cfg);
	vscode.window.showInformationMessage(`Server MCP "${name}" aggiunto.`);
	return true;
}

/** Rimuove un server MCP per nome (con conferma). */
export async function removeMcpServer(name?: string): Promise<boolean> {
	if (!name) {
		return false;
	}
	const uri = await existingConfigUri();
	if (!uri) {
		return false;
	}
	const cfg = await readConfig(uri);
	if (!cfg.mcpServers?.[name]) {
		return false;
	}
	const ok = await vscode.window.showWarningMessage(`Rimuovere il server MCP "${name}"?`, { modal: true }, 'Rimuovi');
	if (ok !== 'Rimuovi') {
		return false;
	}
	delete cfg.mcpServers[name];
	await writeConfig(uri, cfg);
	return true;
}

/** Abilita o disabilita un server MCP per nome. */
export async function toggleMcpServer(name?: string): Promise<boolean> {
	if (!name) {
		return false;
	}
	const uri = await existingConfigUri();
	if (!uri) {
		return false;
	}
	const cfg = await readConfig(uri);
	const s = cfg.mcpServers?.[name];
	if (!s) {
		return false;
	}
	s.disabled = !s.disabled;
	await writeConfig(uri, cfg);
	return true;
}

export async function openMcpConfig(): Promise<void> {
	const uri = mcpConfigUri();
	if (!uri) {
		vscode.window.showWarningMessage('Apri una cartella per configurare MCP.');
		return;
	}
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		const sample = {
			mcpServers: {
				'example': {
					command: 'npx',
					args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
					disabled: true
				}
			}
		};
		await vscode.workspace.fs.writeFile(uri, ENC.encode(JSON.stringify(sample, null, 2)));
	}
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc);
}

type McpNode =
	| { kind: 'server'; status: McpServerStatus }
	| { kind: 'tool'; name: string }
	| { kind: 'resource'; name: string }
	| { kind: 'prompt'; name: string };

export class McpTreeProvider implements vscode.TreeDataProvider<McpNode> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	constructor(private readonly getStatuses: () => McpServerStatus[]) { }

	refresh(): void {
		this._onDidChange.fire();
	}

	getTreeItem(node: McpNode): vscode.TreeItem {
		if (node.kind === 'tool' || node.kind === 'resource' || node.kind === 'prompt') {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon(node.kind === 'tool' ? 'tools' : node.kind === 'resource' ? 'file-symlink-file' : 'comment-discussion');
			item.description = node.kind;
			return item;
		}
		const s = node.status;
		const childCount = s.tools.length + s.resources.length + s.prompts.length;
		const item = new vscode.TreeItem(
			s.name,
			s.connected && childCount ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
		);
		item.description = s.connected ? `● ${s.tools.length} tool` : (s.error ?? 'non connesso');
		item.iconPath = new vscode.ThemeIcon(
			s.connected ? 'server-environment' : (s.error === 'disabilitato' ? 'circle-slash' : 'error')
		);
		item.tooltip = s.connected ? `${s.command} — connesso (${s.tools.length} tool)` : `${s.command} — ${s.error ?? 'non connesso'}`;
		item.contextValue = 'mgcoding.mcpServer';
		return item;
	}

	getChildren(node?: McpNode): McpNode[] {
		if (!node) {
			return this.getStatuses().map(status => ({ kind: 'server' as const, status }));
		}
		if (node.kind === 'server') {
			return [
				...node.status.tools.map(name => ({ kind: 'tool' as const, name })),
				...node.status.resources.map(name => ({ kind: 'resource' as const, name })),
				...node.status.prompts.map(name => ({ kind: 'prompt' as const, name }))
			];
		}
		return [];
	}
}
