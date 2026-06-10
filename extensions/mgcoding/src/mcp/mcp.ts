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
	env?: Record<string, string>;
	url?: string;
	/** Timeout per chiamata tool in secondi (default 60). */
	timeout?: number;
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

/** Aggiunge un server MCP in modo guidato (stdio o HTTP, con env e timeout opzionali). */
export async function addMcpServer(): Promise<boolean> {
	const target = mcpConfigUri();
	if (!target) {
		vscode.window.showWarningMessage('Apri una cartella per configurare MCP.');
		return false;
	}
	const name = (await vscode.window.showInputBox({
		title: 'Nuovo server MCP (1/4)',
		prompt: 'Nome del server',
		placeHolder: 'es. unity, filesystem',
		validateInput: v => v.trim() ? undefined : 'Inserisci un nome'
	}))?.trim();
	if (!name) {
		return false;
	}
	const transport = await vscode.window.showQuickPick(
		[
			{ label: 'Comando (stdio)', description: 'Avvia un processo locale (npx, node, python…)', value: 'stdio' as const },
			{ label: 'URL (HTTP)', description: 'Si collega a un server MCP già in esecuzione via HTTP', value: 'http' as const }
		],
		{ title: 'Nuovo server MCP (2/4)', placeHolder: 'Come si raggiunge il server?' }
	);
	if (!transport) {
		return false;
	}

	let entry: McpServerConfig;
	if (transport.value === 'http') {
		const url = (await vscode.window.showInputBox({
			title: 'Nuovo server MCP (3/4)',
			prompt: 'URL dell\'endpoint MCP',
			placeHolder: 'es. http://localhost:3000/mcp',
			validateInput: v => /^https?:\/\//.test(v.trim()) ? undefined : 'Inserisci una URL http(s)'
		}))?.trim();
		if (!url) {
			return false;
		}
		entry = { url, disabled: false };
	} else {
		const command = (await vscode.window.showInputBox({
			title: 'Nuovo server MCP (3/4)',
			prompt: 'Comando da eseguire',
			placeHolder: 'es. npx',
			validateInput: v => v.trim() ? undefined : 'Inserisci un comando'
		}))?.trim();
		if (!command) {
			return false;
		}
		const argsRaw = await vscode.window.showInputBox({
			title: 'Nuovo server MCP (3/4)',
			prompt: 'Argomenti separati da spazio (opzionale)',
			placeHolder: '-y @modelcontextprotocol/server-filesystem .'
		});
		if (argsRaw === undefined) {
			return false;
		}
		const envRaw = await vscode.window.showInputBox({
			title: 'Nuovo server MCP (4/4)',
			prompt: 'Variabili d\'ambiente CHIAVE=valore separate da spazio (opzionale)',
			placeHolder: 'es. UNITY_PORT=8090 API_KEY=xxx'
		});
		if (envRaw === undefined) {
			return false;
		}
		const env: Record<string, string> = {};
		for (const pair of (envRaw ?? '').trim().split(/\s+/).filter(Boolean)) {
			const eq = pair.indexOf('=');
			if (eq > 0) {
				env[pair.slice(0, eq)] = pair.slice(eq + 1);
			}
		}
		entry = {
			command,
			args: argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [],
			...(Object.keys(env).length ? { env } : {}),
			disabled: false
		};
	}
	// Timeout opzionale (operazioni lente: es. domain reload di Unity).
	const timeoutRaw = await vscode.window.showInputBox({
		title: 'Timeout per chiamata (opzionale)',
		prompt: 'Secondi di attesa massima per ogni chiamata tool (vuoto = 60)',
		placeHolder: 'es. 180 per Unity'
	});
	if (timeoutRaw === undefined) {
		return false;
	}
	const timeout = Number(timeoutRaw.trim());
	if (timeoutRaw.trim() && Number.isFinite(timeout) && timeout > 0) {
		entry.timeout = timeout;
	}

	const uri = (await existingConfigUri()) ?? target;
	const cfg = await readConfig(uri);
	cfg.mcpServers = cfg.mcpServers ?? {};
	if (cfg.mcpServers[name]) {
		const ow = await vscode.window.showWarningMessage(`Esiste già un server "${name}". Sovrascriverlo?`, { modal: true }, 'Sovrascrivi');
		if (ow !== 'Sovrascrivi') {
			return false;
		}
	}
	cfg.mcpServers[name] = entry;
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
