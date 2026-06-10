/*---------------------------------------------------------------------------------------------
 *  MGCoding - client MCP (Model Context Protocol): trasporto stdio (JSON-RPC line-delimited)
 *  e HTTP "streamable" (POST + SSE). Avvia i server definiti in .mg/mcp.json ed espone i loro
 *  tool all'agente, con env per server, timeout configurabile, riconnessione automatica,
 *  log degli stderr e supporto alle IMMAGINI nei risultati (es. screenshot da Unity).
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as vscode from 'vscode';
import { ToolSpec } from '../agent/tools';
import { AnthropicToolDef } from '../llm/types';
import { resolveFile } from '../util/paths';

const DEC = new TextDecoder();
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_RESULT_CHARS = 12000;
const MAX_RESTART_ATTEMPTS = 5;

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpImage {
	mediaType: string;
	data: string;
}

export interface McpToolResult {
	text: string;
	images: McpImage[];
}

/** Configurazione di un server in mcp.json (formato compatibile Kiro). */
interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** Trasporto HTTP "streamable": URL dell'endpoint MCP (alternativo a command). */
	url?: string;
	/** Timeout per chiamata in SECONDI (default 60). Unity con domain reload può servirne di più. */
	timeout?: number;
	disabled?: boolean;
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
}

/** Estrae testo e immagini dal risultato di tools/call. */
function toToolResult(res: any): McpToolResult {
	const content = (res?.content ?? []) as any[];
	const texts = content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text as string);
	const images: McpImage[] = content
		.filter(c => c?.type === 'image' && typeof c.data === 'string')
		.map(c => ({ mediaType: typeof c.mimeType === 'string' ? c.mimeType : 'image/png', data: c.data as string }));
	const text = texts.length ? texts.join('\n') : (images.length ? '(il tool ha restituito un\'immagine)' : JSON.stringify(res));
	return { text, images };
}

/** Superficie comune dei trasporti MCP (stdio e HTTP). */
interface McpServerConnection {
	readonly name: string;
	tools: McpToolDef[];
	resources: string[];
	prompts: string[];
	/** Notifica del manager quando la connessione cade (per la riconnessione automatica). */
	onDown?: () => void;
	start(): Promise<void>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
	dispose(): void;
}

/** Connessione a un server MCP via stdio. */
class McpStdioConnection implements McpServerConnection {
	private proc?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private buffer = '';
	private disposed = false;
	tools: McpToolDef[] = [];
	resources: string[] = [];
	prompts: string[] = [];
	onDown?: () => void;

	constructor(
		readonly name: string,
		private readonly command: string,
		private readonly args: string[],
		private readonly cwd: string,
		private readonly env: Record<string, string>,
		private readonly timeoutMs: number,
		private readonly log: (line: string) => void
	) { }

	async start(): Promise<void> {
		this.proc = spawn(this.command, this.args, {
			cwd: this.cwd,
			shell: process.platform === 'win32',
			env: { ...process.env, ...this.env }
		});
		this.proc.stdout.on('data', (chunk: Buffer) => this.onData(DEC.decode(chunk)));
		// Gli stderr dei server sono preziosi per capire perché non si connettono.
		this.proc.stderr.on('data', (chunk: Buffer) => {
			const text = DEC.decode(chunk).trim();
			if (text) {
				this.log(`[${this.name}:stderr] ${text.slice(0, 600)}`);
			}
		});
		this.proc.on('error', () => this.failAll('processo MCP non avviabile'));
		this.proc.on('exit', code => {
			this.failAll(`processo MCP terminato (codice ${code})`);
			if (!this.disposed) {
				this.onDown?.();
			}
		});

		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'MGCoding', version: '0.8.3' }
		});
		this.notify('notifications/initialized', {});
		const res = await this.request('tools/list', {});
		this.tools = (res?.tools ?? []) as McpToolDef[];
		try {
			const r = await this.request('resources/list', {});
			this.resources = ((r?.resources ?? []) as { name?: string; uri?: string }[]).map(x => x.name || x.uri || '').filter(Boolean);
		} catch {
			this.resources = [];
		}
		try {
			const p = await this.request('prompts/list', {});
			this.prompts = ((p?.prompts ?? []) as { name?: string }[]).map(x => x.name || '').filter(Boolean);
		} catch {
			this.prompts = [];
		}
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
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`timeout MCP su ${method} (${Math.round(this.timeoutMs / 1000)}s — alzalo con "timeout" in mcp.json)`));
				}
			}, this.timeoutMs);
			this.pending.set(id, {
				resolve: v => { clearTimeout(timer); resolve(v); },
				reject: e => { clearTimeout(timer); reject(e); }
			});
			try {
				this.proc?.stdin.write(payload);
			} catch (err) {
				this.pending.delete(id);
				clearTimeout(timer);
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

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		return toToolResult(await this.request('tools/call', { name, arguments: args }));
	}

	private failAll(reason: string): void {
		for (const [, p] of this.pending) {
			p.reject(new Error(reason));
		}
		this.pending.clear();
	}

	dispose(): void {
		this.disposed = true;
		this.proc?.kill();
	}
}

/** Connessione a un server MCP via HTTP "streamable" (POST JSON-RPC, risposta JSON o SSE). */
class McpHttpConnection implements McpServerConnection {
	private nextId = 1;
	private sessionId?: string;
	tools: McpToolDef[] = [];
	resources: string[] = [];
	prompts: string[] = [];
	onDown?: () => void;

	constructor(
		readonly name: string,
		private readonly url: string,
		private readonly timeoutMs: number
	) { }

	async start(): Promise<void> {
		const init = await this.post('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'MGCoding', version: '0.8.3' }
		}, true);
		void init;
		await this.post('notifications/initialized', {}, false, true);
		const res = await this.post('tools/list', {});
		this.tools = (res?.tools ?? []) as McpToolDef[];
		try {
			const r = await this.post('resources/list', {});
			this.resources = ((r?.resources ?? []) as { name?: string; uri?: string }[]).map(x => x.name || x.uri || '').filter(Boolean);
		} catch {
			this.resources = [];
		}
		try {
			const p = await this.post('prompts/list', {});
			this.prompts = ((p?.prompts ?? []) as { name?: string }[]).map(x => x.name || '').filter(Boolean);
		} catch {
			this.prompts = [];
		}
	}

	/** POST JSON-RPC; gestisce risposta application/json o text/event-stream. */
	private async post(method: string, params: unknown, captureSession = false, isNotification = false): Promise<any> {
		const id = isNotification ? undefined : this.nextId++;
		const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
		if (id !== undefined) {
			body.id = id;
		}
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
		try {
			const res = await fetch(this.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'accept': 'application/json, text/event-stream',
					...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
				},
				body: JSON.stringify(body),
				signal: ctrl.signal
			});
			if (captureSession) {
				const sid = res.headers.get('mcp-session-id');
				if (sid) {
					this.sessionId = sid;
				}
			}
			if (isNotification) {
				return undefined;
			}
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} da ${this.url}`);
			}
			const ctype = res.headers.get('content-type') ?? '';
			if (ctype.includes('text/event-stream')) {
				// SSE: cerca l'evento con la risposta al nostro id.
				const text = await res.text();
				for (const line of text.split('\n')) {
					if (!line.startsWith('data:')) {
						continue;
					}
					try {
						const msg = JSON.parse(line.slice(5).trim());
						if (msg.id === id) {
							if (msg.error) {
								throw new Error(msg.error?.message ?? 'errore MCP');
							}
							return msg.result;
						}
					} catch (err) {
						if (err instanceof Error && err.message !== 'Unexpected end of JSON input') {
							throw err;
						}
					}
				}
				throw new Error(`nessuna risposta SSE per ${method}`);
			}
			const msg = await res.json() as any;
			if (msg.error) {
				throw new Error(msg.error?.message ?? 'errore MCP');
			}
			return msg.result;
		} finally {
			clearTimeout(timer);
		}
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		return toToolResult(await this.post('tools/call', { name, arguments: args }));
	}

	dispose(): void {
		// Best effort: chiude la sessione lato server.
		if (this.sessionId) {
			void fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId } }).catch(() => undefined);
		}
	}
}

export interface McpServerStatus {
	name: string;
	command: string;
	connected: boolean;
	error?: string;
	tools: string[];
	resources: string[];
	prompts: string[];
}

/** Gestisce tutte le connessioni MCP e instrada le chiamate ai tool. */
export class McpManager implements vscode.Disposable {
	private connections: McpServerConnection[] = [];
	/** prefixedToolName -> { connection, originalName } */
	private readonly toolMap = new Map<string, { conn: McpServerConnection; original: string }>();
	private statuses: McpServerStatus[] = [];
	private readonly log = vscode.window.createOutputChannel('MGCoding MCP');
	private readonly configs = new Map<string, McpServerConfig>();
	private readonly restartAttempts = new Map<string, number>();
	private cwd = '';
	private disposed = false;
	/** Immagini dell'ultima chiamata tool (da allegare al contesto del modello). */
	private lastImages: McpImage[] = [];

	getStatuses(): McpServerStatus[] {
		return this.statuses;
	}

	/** Ritira (e azzera) le immagini restituite dall'ultima chiamata a un tool MCP. */
	takeLastImages(): McpImage[] {
		const imgs = this.lastImages;
		this.lastImages = [];
		return imgs;
	}

	private createConnection(serverName: string, cfg: McpServerConfig): McpServerConnection {
		const timeoutMs = (typeof cfg.timeout === 'number' && cfg.timeout > 0 ? cfg.timeout : DEFAULT_TIMEOUT_MS / 1000) * 1000;
		if (cfg.url) {
			return new McpHttpConnection(serverName, cfg.url, timeoutMs);
		}
		const conn = new McpStdioConnection(
			serverName, cfg.command!, cfg.args ?? [], this.cwd,
			cfg.env ?? {}, timeoutMs, line => this.log.appendLine(line)
		);
		conn.onDown = () => this.scheduleRestart(serverName);
		return conn;
	}

	private registerConnection(serverName: string, cfg: McpServerConfig, conn: McpServerConnection): void {
		this.connections.push(conn);
		for (const tool of conn.tools) {
			this.toolMap.set(`${serverName}__${tool.name}`, { conn, original: tool.name });
		}
		const names = conn.tools.map(t => t.name);
		const status: McpServerStatus = { name: serverName, command: cfg.url ?? cfg.command ?? '', connected: true, tools: names, resources: conn.resources, prompts: conn.prompts };
		const idx = this.statuses.findIndex(s => s.name === serverName);
		if (idx >= 0) {
			this.statuses[idx] = status;
		} else {
			this.statuses.push(status);
		}
	}

	private unregisterConnection(serverName: string): void {
		const old = this.connections.find(c => c.name === serverName);
		old?.dispose();
		this.connections = this.connections.filter(c => c.name !== serverName);
		for (const key of [...this.toolMap.keys()]) {
			if (key.startsWith(`${serverName}__`)) {
				this.toolMap.delete(key);
			}
		}
	}

	/** Riconnessione automatica con backoff quando un server cade (es. riavvio di Unity). */
	private scheduleRestart(serverName: string): void {
		if (this.disposed) {
			return;
		}
		const n = (this.restartAttempts.get(serverName) ?? 0) + 1;
		if (n > MAX_RESTART_ATTEMPTS) {
			this.log.appendLine(`MCP "${serverName}": caduto e troppi tentativi falliti — riconnessione sospesa (riavviala dal pannello MCP).`);
			return;
		}
		this.restartAttempts.set(serverName, n);
		const delay = Math.min(30000, 1500 * 2 ** n);
		this.log.appendLine(`MCP "${serverName}" disconnesso: riconnessione tra ${Math.round(delay / 1000)}s (tentativo ${n}/${MAX_RESTART_ATTEMPTS})…`);
		const idx = this.statuses.findIndex(s => s.name === serverName);
		if (idx >= 0) {
			this.statuses[idx] = { ...this.statuses[idx], connected: false, error: 'disconnesso, riconnessione…', tools: [] };
		}
		setTimeout(() => void this.restartServer(serverName), delay);
	}

	private async restartServer(serverName: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		const cfg = this.configs.get(serverName);
		if (!cfg) {
			return;
		}
		this.unregisterConnection(serverName);
		try {
			const conn = this.createConnection(serverName, cfg);
			await conn.start();
			this.registerConnection(serverName, cfg, conn);
			this.restartAttempts.delete(serverName);
			this.log.appendLine(`MCP "${serverName}" riconnesso (${conn.tools.length} tool).`);
		} catch (err) {
			this.log.appendLine(`MCP "${serverName}": riconnessione fallita (${err instanceof Error ? err.message : String(err)}).`);
			this.scheduleRestart(serverName);
		}
	}

	async start(): Promise<void> {
		this.stopConnections();
		this.disposed = false;
		this.toolMap.clear();
		this.connections = [];
		this.statuses = [];
		this.configs.clear();
		this.restartAttempts.clear();

		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			this.log.appendLine('Nessun workspace: MCP non avviato.');
			return;
		}
		this.cwd = folders[0].uri.fsPath;
		const uri = await resolveFile('.mg/mcp.json', '.kiro/settings/mcp.json');
		if (!uri) {
			this.log.appendLine('Nessun mcp.json (.mg/mcp.json o .kiro/settings/mcp.json).');
			return;
		}
		let config: any;
		try {
			config = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(uri)));
		} catch {
			this.log.appendLine(`mcp.json non valido: ${uri.fsPath}`);
			return;
		}
		const servers = config?.mcpServers ?? {};

		for (const [serverName, cfg] of Object.entries<McpServerConfig>(servers)) {
			if (!cfg?.command && !cfg?.url) {
				continue;
			}
			if (cfg?.disabled === true) {
				this.statuses.push({ name: serverName, command: cfg.url ?? cfg.command ?? '', connected: false, error: 'disabilitato', tools: [], resources: [], prompts: [] });
				continue;
			}
			this.configs.set(serverName, cfg);
			const conn = this.createConnection(serverName, cfg);
			this.log.appendLine(`Avvio server MCP "${serverName}": ${cfg.url ?? `${cfg.command} ${(cfg.args ?? []).join(' ')}`}`);
			try {
				await conn.start();
				this.registerConnection(serverName, cfg, conn);
				this.log.appendLine(`  -> connesso, ${conn.tools.length} tool: ${conn.tools.map(t => t.name).join(', ')}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.statuses.push({ name: serverName, command: cfg.url ?? cfg.command ?? '', connected: false, error: msg, tools: [], resources: [], prompts: [] });
				this.log.appendLine(`  -> ERRORE: ${msg}`);
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
					args: tool.inputSchema ? JSON.stringify(tool.inputSchema).slice(0, 300) : '{}',
					inputSchema: (tool.inputSchema && typeof tool.inputSchema === 'object') ? tool.inputSchema as object : { type: 'object', properties: {} }
				});
			}
		}
		return specs;
	}

	/** Tool MCP in formato Anthropic (tool-use nativo). */
	anthropicTools(): AnthropicToolDef[] {
		const tools: AnthropicToolDef[] = [];
		for (const conn of this.connections) {
			for (const tool of conn.tools) {
				const schema = (tool.inputSchema && typeof tool.inputSchema === 'object')
					? tool.inputSchema as object
					: { type: 'object', properties: {} };
				tools.push({
					name: `${conn.name}__${tool.name}`,
					description: `[MCP:${conn.name}] ${tool.description ?? ''}`.trim(),
					input_schema: schema
				});
			}
		}
		return tools;
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
			const rich = await entry.conn.callTool(entry.original, args);
			this.lastImages = rich.images.slice(0, 3);
			let text = rich.text;
			if (text.length > MAX_RESULT_CHARS) {
				text = `${text.slice(0, MAX_RESULT_CHARS)}\n… [risultato MCP troncato: ${text.length} caratteri totali]`;
			}
			if (rich.images.length) {
				text += `\n[${rich.images.length} immagine/i del tool allegate al contesto]`;
			}
			return text;
		} catch (err) {
			return `Errore tool MCP ${name}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	private stopConnections(): void {
		this.connections.forEach(c => c.dispose());
		this.connections = [];
	}

	dispose(): void {
		this.disposed = true;
		this.stopConnections();
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
