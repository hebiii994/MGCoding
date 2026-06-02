/*---------------------------------------------------------------------------------------------
 *  MGCoding - tool dell'agente (filesystem + comandi shell)
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { getMcpManager } from '../mcp/mcpClient';
import { AnthropicToolDef } from '../llm/types';

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
	}
];

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
				const uri = resolve(String(call.args.path));
				const dir = vscode.Uri.joinPath(uri, '..');
				await vscode.workspace.fs.createDirectory(dir);
				await vscode.workspace.fs.writeFile(uri, ENC.encode(String(call.args.content ?? '')));
				return `OK: scritto ${call.args.path}`;
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
