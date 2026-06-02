/*---------------------------------------------------------------------------------------------
 *  MGCoding - MCP Servers: lettura/visualizzazione configurazione MCP
 *  File: <workspace>/.mg/mcp.json  =>  { "mcpServers": { "<name>": { command, args, disabled? } } }
 *  Nota: per ora è solo visualizzazione/configurazione; il client MCP verrà collegato in seguito.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveFile } from '../util/paths';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

interface McpServer {
	name: string;
	command?: string;
	args?: string[];
	disabled?: boolean;
}

function mcpConfigUri(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? vscode.Uri.joinPath(f[0].uri, '.mg', 'mcp.json') : undefined;
}

async function readServers(): Promise<McpServer[]> {
	const uri = await resolveFile('.mg/mcp.json', '.kiro/settings/mcp.json');
	if (!uri) {
		return [];
	}
	try {
		const raw = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(uri)));
		const servers = raw?.mcpServers ?? {};
		return Object.entries(servers).map(([name, cfg]: [string, any]) => ({
			name,
			command: cfg?.command,
			args: cfg?.args,
			disabled: cfg?.disabled === true
		}));
	} catch {
		return [];
	}
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

interface McpNode {
	server: McpServer;
}

export class McpTreeProvider implements vscode.TreeDataProvider<McpNode> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	getTreeItem(node: McpNode): vscode.TreeItem {
		const s = node.server;
		const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
		item.description = s.disabled ? 'disabilitato' : (s.command ?? '');
		item.iconPath = new vscode.ThemeIcon(s.disabled ? 'circle-slash' : 'server-environment');
		item.tooltip = `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim();
		return item;
	}

	async getChildren(): Promise<McpNode[]> {
		return (await readServers()).map(server => ({ server }));
	}
}
