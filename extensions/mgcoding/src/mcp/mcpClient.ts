/*---------------------------------------------------------------------------------------------
 *  MGCoding - client MCP (Model Context Protocol) su trasporto stdio (JSON-RPC line-delimited)
 *  Avvia i server definiti in .mg/mcp.json ed espone i loro tool all'agente.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as vscode from 'vscode';
import { ToolSpec } from '../agent/tools';

const DEC = new TextDecoder();

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
}

/** Una connessione a un singolo server MCP via stdio. */
class McpConnection {
	private proc?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private buffer = '';
	tools: McpToolDef[] = [];

	constructor(readonly name: string, private readonly command: string, private readonly args: string[], private readonly cwd: string) { }

	async start(): Promise<void> {
		this.proc = spawn(this.command, this.args, { cwd: this.cwd, shell: process.platform === 'win32' });
		this.proc.stdout.on('data', (chunk: Buffer) => this.onData(DEC.decode(chunk)));
		this.proc.stderr.on('data', () => { /* log dei server ignorato */ });
		this.proc.on('error', () => this.failAll('processo MCP non avviabile'));
		this.proc.on('exit', () => this.failAll('processo MCP terminato'));

		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'MGCoding', version: '0.0.1' }
		});
		this.notify('notifications/initialized', {});
		const res = await this.request('tools/list', {});
		this.tools = (res?.tools ?? []) as McpToolDef[];
	}

	private onData(text: string): void {
		this.buffer += text;
		let nl: number;
		while ((nl = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) {
				continue;
			}
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) {
					p.reject(new Error(msg.error?.message ?? 'errore MCP'));
				} else {
					p.resolve(msg.result);
				}
			}
		}
	}

	private request(method: string, params: unknown): Promise<any> {
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
		return new Promise<any>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`timeout MCP su ${method}`));
				}
			}, 30000);
			const wrapped: PendingRequest = {
				resolve: v => { clearTimeout(timer); resolve(v); },
				reject: e => { clearTimeout(timer); reject(e); }
			};
			this.pending.set(id, wrapped);
			try {
				this.proc?.stdin.write(payload);
			} catch (err) {
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private notify(method: string, params: unknown): void {
		try {
			this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
		} catch {
			// ignora
		}
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		const res = await this.request('tools/call', { name, arguments: args });
		const content = res?.content ?? [];
		const texts = (content as any[]).filter(c => c?.type === 'text').map(c => c.text);
		return texts.length ? texts.join('\n') : JSON.stringify(res);
	}

	private failAll(reason: string): void {
		for (const [, p] of this.pending) {
			p.reject(new Error(reason));
		}
		this.pending.clear();
	}

	dispose(): void {
		this.proc?.kill();
	}
}

/** Gestisce tutte le connessioni MCP e instrada le chiamate ai tool. */
export class McpManager implements vscode.Disposable {
	private connections: McpConnection[] = [];
	/** prefixedToolName -> { connection, originalName } */
	private readonly toolMap = new Map<string, { conn: McpConnection; original: string }>();
	private readonly log = vscode.window.createOutputChannel('MGCoding MCP');

	async start(): Promise<void> {
		this.dispose();
		this.toolMap.clear();
		this.connections = [];

		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			this.log.appendLine('Nessun workspace: MCP non avviato.');
			return;
		}
		const uri = vscode.Uri.joinPath(folders[0].uri, '.mg', 'mcp.json');
		let config: any;
		try {
			config = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(uri)));
		} catch {
			this.log.appendLine('Nessun .mg/mcp.json valido.');
			return;
		}
		const servers = config?.mcpServers ?? {};
		const cwd = folders[0].uri.fsPath;

		for (const [serverName, cfg] of Object.entries<any>(servers)) {
			if (cfg?.disabled === true || !cfg?.command) {
				continue;
			}
			const conn = new McpConnection(serverName, cfg.command, cfg.args ?? [], cwd);
			this.log.appendLine(`Avvio server MCP "${serverName}": ${cfg.command} ${(cfg.args ?? []).join(' ')}`);
			try {
				await conn.start();
				this.connections.push(conn);
				for (const tool of conn.tools) {
					this.toolMap.set(`${serverName}__${tool.name}`, { conn, original: tool.name });
				}
				this.log.appendLine(`  -> connesso, ${conn.tools.length} tool: ${conn.tools.map(t => t.name).join(', ')}`);
			} catch (err) {
				this.log.appendLine(`  -> ERRORE: ${err instanceof Error ? err.message : String(err)}`);
				conn.dispose();
			}
		}
		this.log.appendLine(`MCP pronto: ${this.toolMap.size} tool totali.`);
	}

	/** Specifiche dei tool MCP da esporre all'agente. */
	toolSpecs(): ToolSpec[] {
		const specs: ToolSpec[] = [];
		for (const conn of this.connections) {
			for (const tool of conn.tools) {
				specs.push({
					name: `${conn.name}__${tool.name}`,
					description: `[MCP:${conn.name}] ${tool.description ?? ''}`.trim(),
					args: tool.inputSchema ? JSON.stringify(tool.inputSchema).slice(0, 300) : '{}'
				});
			}
		}
		return specs;
	}

	hasTool(name: string): boolean {
		return this.toolMap.has(name);
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		const entry = this.toolMap.get(name);
		if (!entry) {
			return `Errore: tool MCP "${name}" non trovato.`;
		}
		try {
			return await entry.conn.callTool(entry.original, args);
		} catch (err) {
			return `Errore tool MCP ${name}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	dispose(): void {
		this.connections.forEach(c => c.dispose());
		this.connections = [];
	}

	disposeLog(): void {
		this.log.dispose();
	}
}

// singleton condiviso (per l'integrazione nei tool dell'agente)
let instance: McpManager | undefined;
export function setMcpManager(m: McpManager | undefined): void {
	instance = m;
}
export function getMcpManager(): McpManager | undefined {
	return instance;
}
