/*---------------------------------------------------------------------------------------------
 *  MGCoding - tool dell'agente (filesystem + comandi shell)
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { getMcpManager } from '../mcp/mcpClient';
import { AnthropicToolDef } from '../llm/types';
import { confirmWrite } from '../edit/diffApproval';

const execAsync = promisify(exec);
const ENC = new TextEncoder();
const DEC = new TextDecoder();

export interface ToolCall {
	tool: string;
	args: Record<string, unknown>;
}

export interface ToolSpec {
	name: string;
	description: string;
	/** Esempio di args per il prompt testuale (Ollama). */
	args: string;
	/** JSON Schema dei parametri (tool-use nativo Claude). */
	inputSchema: object;
}

export const TOOL_SPECS: ToolSpec[] = [
	{
		name: 'read_file',
		description: 'Legge il contenuto di un file (percorso relativo alla radice del workspace).',
		args: '{"path": "percorso/relativo"}',
		inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Percorso relativo del file' } }, required: ['path'] }
	},
	{
		name: 'write_file',
		description: 'Crea o sovrascrive un file con il contenuto dato.',
		args: '{"path": "percorso/relativo", "content": "..."}',
		inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
	},
	{
		name: 'list_dir',
		description: 'Elenca file e cartelle in una directory.',
		args: '{"path": "percorso/relativo"}',
		inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Percorso relativo (default: radice)' } } }
	},
	{
		name: 'run_command',
		description: 'Esegue un comando shell nella radice del workspace (può richiedere conferma).',
		args: '{"command": "..."}',
		inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
	},
	{
		name: 'find_files',
		description: 'Trova file per pattern glob, opzionalmente sotto una cartella "path". Ritorna i percorsi relativi.',
		args: '{"pattern": "**/*.ts", "path": "src", "maxResults": 50}',
		inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Cartella base relativa entro cui cercare' }, maxResults: { type: 'number' } }, required: ['pattern'] }
	},
	{
		name: 'search_text',
		description: 'Cerca testo o regex nei file, opzionalmente sotto una cartella "path". Ritorna righe "file:linea: testo".',
		args: '{"query": "pattern", "glob": "**/*.ts", "path": "src"}',
		inputSchema: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' }, path: { type: 'string', description: 'Cartella base relativa' } }, required: ['query'] }
	}
];

const EXCLUDE = '**/{node_modules,.git,out,out-build,out-vscode,.build,dist,.vscode-test,Library,Temp,Logs,obj,bin}/**';

/** Combina una cartella base opzionale con un glob. */
function scopedGlob(pattern: string, base?: unknown): string {
	const b = base ? String(base).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '') : '';
	if (!b) {
		return pattern;
	}
	return pattern.startsWith('**') ? `${b}/${pattern}` : `${b}/**/${pattern}`;
}

/** Tool built-in in formato Anthropic (tool-use nativo). */
export function anthropicBuiltinTools(): AnthropicToolDef[] {
	return TOOL_SPECS.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

function workspaceRoot(): vscode.Uri {
	const f = vscode.workspace.workspaceFolders;
	if (!f || f.length === 0) {
		throw new Error('Nessun workspace aperto.');
	}
	return f[0].uri;
}

function resolve(p: string): vscode.Uri {
	return vscode.Uri.joinPath(workspaceRoot(), p);
}

export async function executeTool(call: ToolCall): Promise<string> {
	try {
		switch (call.tool) {
			case 'read_file': {
				const uri = resolve(String(call.args.path));
				const bytes = await vscode.workspace.fs.readFile(uri);
				return DEC.decode(bytes);
			}
			case 'write_file': {
				const rel = String(call.args.path);
				const uri = resolve(rel);
				const newContent = String(call.args.content ?? '');
				let oldContent = '';
				try {
					oldContent = DEC.decode(await vscode.workspace.fs.readFile(uri));
				} catch {
					// file nuovo
				}
				const cfg = vscode.workspace.getConfiguration('mgcoding');
				const needApproval = cfg.get<boolean>('diffApproval', true) && !cfg.get<boolean>('autoApprove', false);
				if (needApproval) {
					const ok = await confirmWrite(rel, oldContent, newContent);
					if (!ok) {
						return `Modifica a ${rel} scartata dall'utente.`;
					}
				}
				await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
				await vscode.workspace.fs.writeFile(uri, ENC.encode(newContent));
				return `OK: scritto ${rel}`;
			}
			case 'list_dir': {
				const uri = resolve(String(call.args.path ?? '.'));
				const entries = await vscode.workspace.fs.readDirectory(uri);
				return entries.map(([n, t]) => (t === vscode.FileType.Directory ? `${n}/` : n)).join('\n') || '(vuota)';
			}
			case 'run_command': {
				const command = String(call.args.command ?? '');
				if (!command) {
					return 'Errore: comando vuoto.';
				}
				const auto = vscode.workspace.getConfiguration('mgcoding').get<boolean>('autoApprove', false);
				if (!auto) {
					const ok = await vscode.window.showWarningMessage(
						`L'agente vuole eseguire:\n\n${command}`,
						{ modal: true }, 'Esegui'
					);
					if (ok !== 'Esegui') {
						return 'Comando annullato dall\'utente.';
					}
				}
				try {
					const { stdout, stderr } = await execAsync(command, {
						cwd: workspaceRoot().fsPath,
						timeout: 120000,
						maxBuffer: 1024 * 1024
					});
					return `[stdout]\n${stdout}\n${stderr ? `[stderr]\n${stderr}` : ''}`.trim();
				} catch (err: any) {
					return `[errore comando] ${err?.message ?? String(err)}\n${err?.stdout ?? ''}\n${err?.stderr ?? ''}`.trim();
				}
			}
			case 'find_files': {
				const pattern = String(call.args.pattern ?? '**/*');
				const max = Math.min(Number(call.args.maxResults ?? 100), 300);
				const uris = await vscode.workspace.findFiles(scopedGlob(pattern, call.args.path), EXCLUDE, max);
				return uris.map(u => vscode.workspace.asRelativePath(u, false)).join('\n') || '(nessun file trovato)';
			}
			case 'search_text': {
				const query = String(call.args.query ?? '');
				if (!query) {
					return 'Errore: query vuota.';
				}
				const glob = scopedGlob(String(call.args.glob ?? '**/*'), call.args.path);
				let re: RegExp | undefined;
				try {
					re = new RegExp(query, 'i');
				} catch {
					re = undefined;
				}
				const uris = await vscode.workspace.findFiles(glob, EXCLUDE, 500);
				const out: string[] = [];
				for (const u of uris) {
					if (out.length >= 60) {
						break;
					}
					let text: string;
					try {
						const bytes = await vscode.workspace.fs.readFile(u);
						if (bytes.length > 512 * 1024) {
							continue;
						}
						text = DEC.decode(bytes);
					} catch {
						continue;
					}
					const lines = text.split('\n');
					for (let i = 0; i < lines.length && out.length < 60; i++) {
						const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(query.toLowerCase());
						if (hit) {
							out.push(`${vscode.workspace.asRelativePath(u, false)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
						}
					}
				}
				return out.join('\n') || '(nessuna corrispondenza)';
			}
			default: {
				const mcp = getMcpManager();
				if (mcp?.hasTool(call.tool)) {
					return await mcp.callTool(call.tool, call.args);
				}
				return `Errore: tool sconosciuto "${call.tool}".`;
			}
		}
	} catch (err) {
		return `Errore tool ${call.tool}: ${err instanceof Error ? err.message : String(err)}`;
	}
}
