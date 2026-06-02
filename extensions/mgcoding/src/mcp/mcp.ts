/*---------------------------------------------------------------------------------------------
 *  MGCoding - MCP Servers: vista con stato di connessione live e tool per server
 *  Config: <workspace>/.mg/mcp.json (o .kiro/settings/mcp.json)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { McpServerStatus } from './mcpClient';

const ENC = new TextEncoder();

function mcpConfigUri(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? vscode.Uri.joinPath(f[0].uri, '.mg', 'mcp.json') : undefined;
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

type McpNode = { kind: 'server'; status: McpServerStatus } | { kind: 'tool'; name: string };

export class McpTreeProvider implements vscode.TreeDataProvider<McpNode> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	constructor(private readonly getStatuses: () => McpServerStatus[]) { }

	refresh(): void {
		this._onDidChange.fire();
	}

	getTreeItem(node: McpNode): vscode.TreeItem {
		if (node.kind === 'tool') {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('tools');
			return item;
		}
		const s = node.status;
		const item = new vscode.TreeItem(
			s.name,
			s.connected && s.tools.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
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
			return node.status.tools.map(name => ({ kind: 'tool' as const, name }));
		}
		return [];
	}
}
