/*---------------------------------------------------------------------------------------------
 *  MGCoding - tool dell'agente (filesystem + comandi shell)
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { getMcpManager } from '../mcp/mcpClient';
import { codeIndex } from '../index/codeIndex';
import { AnthropicToolDef } from '../llm/types';
import { confirmWrite } from '../edit/diffApproval';
import { recordOriginal } from '../edit/checkpoint';
import { scopedGlob } from '../util/parsing';

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
		description: 'Legge un file (percorso relativo alla radice). Restituisce ogni riga con il numero ("N\\tcontenuto"): i numeri servono solo a orientarti e NON fanno parte del file — rimuovili prima di usare il testo in apply_patch. Per file grandi usa offset/limit.',
		args: '{"path": "percorso/relativo", "offset": 0, "limit": 400}',
		inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Percorso relativo del file' }, offset: { type: 'number', description: 'Riga di partenza (0-based)' }, limit: { type: 'number', description: 'Numero massimo di righe da leggere' } }, required: ['path'] }
	},
	{
		name: 'write_file',
		description: 'Crea un nuovo file o ne sovrascrive UNO ESISTENTE per intero. Per modifiche mirate a un file esistente preferisci apply_patch (più sicuro). Crea automaticamente le cartelle mancanti.',
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
		name: 'create_directory',
		description: 'Crea una cartella (e le cartelle intermedie). Usa QUESTO invece di "mkdir" da shell, che ha sintassi diversa tra i sistemi.',
		args: '{"path": "src/components"}',
		inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Percorso relativo della cartella da creare' } }, required: ['path'] }
	},
	{
		name: 'run_command',
		description: 'Esegue un comando shell nella radice del workspace (può richiedere conferma). I comandi che non terminano (dev server, watch: es. "npm run dev") vengono avviati nel TERMINALE INTEGRATO e considerati avviati subito — non attenderne l\'output. Per forzare il terminale su un comando, passa "background": true.',
		args: '{"command": "npm run dev", "background": true}',
		inputSchema: { type: 'object', properties: { command: { type: 'string' }, background: { type: 'boolean', description: 'true = avvia nel terminale integrato senza attendere (per processi che restano attivi)' } }, required: ['command'] }
	},
	{
		name: 'apply_patch',
		description: 'Modifica mirata di un file: sostituisce old_string (che deve esistere ed essere univoco) con new_string. Preferiscilo a write_file per file grandi.',
		args: '{"path": "src/x.ts", "old_string": "...", "new_string": "..."}',
		inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] }
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
	},
	{
		name: 'update_plan',
		description: 'Crea o aggiorna un PIANO di lavoro a step, mostrato all\'utente in chat. Usalo all\'inizio di un task non banale per elencare i passi, e richiamalo per aggiornare lo stato man mano che procedi. Stati ammessi: "pending", "in_progress", "done". Tieni un solo step "in_progress" alla volta.',
		args: '{"steps":[{"text":"Esplorare il codice","status":"done"},{"text":"Implementare X","status":"in_progress"},{"text":"Test","status":"pending"}]}',
		inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text'] } } }, required: ['steps'] }
	},
	{
		name: 'get_diagnostics',
		description: 'Errori e warning correnti dai language server (TypeScript, ESLint, ecc.), per un file o per tutto il workspace. Usalo per "correggi gli errori" e SEMPRE per verificare dopo aver modificato del codice.',
		args: '{"path": "src/x.ts"}  // path opzionale: vuoto = intero workspace',
		inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File relativo da controllare; vuoto = intero workspace' } } }
	},
	{
		name: 'ask_user',
		description: 'Fai una DOMANDA all\'utente mostrando opzioni cliccabili e ATTENDI la risposta. Usalo quando una scelta è ambigua e cambierebbe ciò che fai (es. linguaggio/framework, nome, approccio, file da toccare). Preferiscilo alle assunzioni silenziose. Fornisci 2-4 opzioni chiare e mutuamente esclusive; l\'utente può comunque scrivere una risposta libera.',
		args: '{"question":"Quale framework UI preferisci?","options":["React","Vue","Svelte"],"multiSelect":false}',
		inputSchema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: '2-4 opzioni' }, multiSelect: { type: 'boolean', description: 'true se si possono scegliere più opzioni' } }, required: ['question', 'options'] }
	},
	{
		name: 'search_code',
		description: 'Ricerca SEMANTICA nel workspace (codice E documenti md/pdf/docx/pptx/xlsx): trova i frammenti più pertinenti a una descrizione in linguaggio naturale (non solo per parola esatta come search_text). USALO PER PRIMO per localizzare dove sta una funzionalità/logica/informazione prima di leggere o modificare. Richiede l\'indice (creato in automatico al primo uso).',
		args: '{"query":"dove viene gestito il login utente","k":6}',
		inputSchema: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number', description: 'Numero di risultati (default 6)' } }, required: ['query'] }
	},
	{
		name: 'delegate',
		description: 'Affida un SOTTOCOMPITO ben definito e indipendente a un subagent focalizzato, che lo porta a termine con i propri tool e ti restituisce un report. Usalo quando orchestri un task complesso: scomponilo (anche con update_plan) e delega i pezzi indipendenti. Dai istruzioni complete e autosufficienti nel campo task (più eventuale context), perché il subagent non vede questa conversazione.',
		args: '{"task":"Implementa la validazione del form in src/forms/login.ts secondo questi requisiti…","context":"vincoli/decisioni rilevanti"}',
		inputSchema: { type: 'object', properties: { task: { type: 'string' }, context: { type: 'string', description: 'Contesto/vincoli utili al subagent' } }, required: ['task'] }
	},
	{
		name: 'remember',
		description: 'Salva una preferenza PERSONALE e TRASVERSALE sull\'utente nel suo profilo (es. "preferisce TypeScript", "si chiama Marco", "vuole risposte concise", "usa Windows"). Vale per QUALSIASI progetto. NON usarlo per dettagli del progetto/workspace corrente: niente nomi di progetto/repo, niente descrizioni di cosa sta costruendo ora, niente file/funzioni/feature specifiche (quelli NON sono preferenze e non vanno ricordati tra progetti).',
		args: '{"fact":"Preferisce TypeScript e risposte concise"}',
		inputSchema: { type: 'object', properties: { fact: { type: 'string', description: 'La preferenza/fatto da ricordare, conciso' } }, required: ['fact'] }
	}
];

const EXCLUDE = '**/{node_modules,.git,out,out-build,out-vscode,.build,dist,.vscode-test,Library,Temp,Logs,obj,bin}/**';

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

/** Durante l'esecuzione dei task, blocca le scritture dell'agente sui file della spec. */
let blockSpecWrites = false;
export function setSpecWriteGuard(on: boolean): void {
	blockSpecWrites = on;
}
const SPEC_FILE_GUARD = /(^|\/)(\.mg|\.kiro)\/specs\/[^/]+\/(requirements|design|tasks)\.md$/i;
function isProtectedSpecFile(rel: string): boolean {
	return blockSpecWrites && SPEC_FILE_GUARD.test(rel.replace(/\\/g, '/'));
}

/** Modalità remota (Telegram): non ci sono dialog di conferma sul PC. */
let remoteMode = false;
let remoteAutoApprove = false;
export function setRemoteMode(on: boolean, autoApprove: boolean): void {
	remoteMode = on;
	remoteAutoApprove = autoApprove;
}

/**
 * Diagnostiche di tipo ERRORE per i file relativi indicati (per la verifica automatica).
 * Ritorna '' se non ci sono errori. Esclude i warning per non innescare loop di correzione.
 */
export async function errorsForPaths(relPaths: string[]): Promise<string> {
	const lines: string[] = [];
	for (const rel of relPaths) {
		const uri = resolve(rel);
		for (const d of vscode.languages.getDiagnostics(uri)) {
			if (d.severity === vscode.DiagnosticSeverity.Error) {
				lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message.split('\n')[0]}${d.source ? ` [${d.source}]` : ''}`);
			}
		}
	}
	return lines.slice(0, 80).join('\n');
}

/** Comandi che NON terminano (dev server, watcher): vanno nel terminale integrato. */
const LONG_RUNNING_RE = /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b|\bvite\b|\bnext\s+(dev|start)\b|\bnodemon\b|--watch\b|\bwatch\b|http-server\b|http\.server\b|\bserve\b|\buvicorn\b|\bflask\s+run\b|\bng\s+serve\b|\brails\s+server\b|bootRun/i;

/** Terminale integrato riutilizzabile per i comandi long-running avviati dall'agente. */
let mgTerminal: vscode.Terminal | undefined;
function getMgTerminal(): vscode.Terminal {
	if (!mgTerminal || !vscode.window.terminals.includes(mgTerminal)) {
		mgTerminal = vscode.window.createTerminal({ name: 'MGCoding', cwd: workspaceRoot().fsPath });
	}
	return mgTerminal;
}

export async function executeTool(call: ToolCall): Promise<string> {
	try {
		switch (call.tool) {
			case 'read_file': {
				const uri = resolve(String(call.args.path));
				const bytes = await vscode.workspace.fs.readFile(uri);
				const lines = DEC.decode(bytes).split('\n');
				const offset = Math.max(0, Math.floor(Number(call.args.offset ?? 0)) || 0);
				const limit = call.args.limit !== undefined ? Math.max(1, Math.floor(Number(call.args.limit))) : undefined;
				const end = limit !== undefined ? Math.min(lines.length, offset + limit) : lines.length;
				const MAX_CHARS = 100000;
				let body = lines.slice(offset, end).map((l, i) => `${offset + i + 1}\t${l}`).join('\n');
				let note = '';
				if (body.length > MAX_CHARS) {
					body = body.slice(0, MAX_CHARS);
					note = '\n… [output troncato: usa offset/limit per leggere il resto]';
				} else if (end < lines.length) {
					note = `\n… [altre ${lines.length - end} righe; continua con offset=${end}]`;
				}
				return (body + note) || '(file vuoto)';
			}
			case 'write_file': {
				const rel = String(call.args.path);
				if (isProtectedSpecFile(rel)) {
					return `Bloccato: i file della spec (requirements/design/tasks.md) non si modificano durante l'esecuzione — ci pensa MGCoding. Implementa il codice negli altri file del workspace.`;
				}
				const uri = resolve(rel);
				const newContent = String(call.args.content ?? '');
				let oldContent = '';
				try {
					oldContent = DEC.decode(await vscode.workspace.fs.readFile(uri));
				} catch {
					// file nuovo
				}
				if (remoteMode && !remoteAutoApprove) {
					return `Modifica a ${rel} NON applicata: da remoto serve la conferma. Attiva "mgcoding.telegram.autoApprove" per consentire le modifiche a distanza.`;
				}
				const cfg = vscode.workspace.getConfiguration('mgcoding');
				const needApproval = !remoteMode && cfg.get<boolean>('diffApproval', true) && !cfg.get<boolean>('autoApprove', false);
				if (needApproval) {
					const ok = await confirmWrite(rel, oldContent, newContent);
					if (!ok) {
						return `Modifica a ${rel} scartata dall'utente.`;
					}
				}
				await recordOriginal(uri);
				await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
				await vscode.workspace.fs.writeFile(uri, ENC.encode(newContent));
				return `OK: scritto ${rel}`;
			}
			case 'list_dir': {
				const uri = resolve(String(call.args.path ?? '.'));
				const entries = await vscode.workspace.fs.readDirectory(uri);
				return entries.map(([n, t]) => (t === vscode.FileType.Directory ? `${n}/` : n)).join('\n') || '(vuota)';
			}
			case 'create_directory': {
				const rel = String(call.args.path ?? '');
				if (!rel) {
					return 'Errore: path mancante.';
				}
				await vscode.workspace.fs.createDirectory(resolve(rel));
				return `OK: cartella creata ${rel}`;
			}
			case 'run_command': {
				const command = String(call.args.command ?? '');
				if (!command) {
					return 'Errore: comando vuoto.';
				}
				if (remoteMode && !remoteAutoApprove) {
					return `Comando NON eseguito (da remoto serve conferma): ${command}. Attiva "mgcoding.telegram.autoApprove" per consentire i comandi a distanza.`;
				}
				const auto = remoteMode ? remoteAutoApprove : vscode.workspace.getConfiguration('mgcoding').get<boolean>('autoApprove', false);
				if (!auto) {
					const ok = await vscode.window.showWarningMessage(
						`L'agente vuole eseguire:\n\n${command}`,
						{ modal: true }, 'Esegui'
					);
					if (ok !== 'Esegui') {
						return 'Comando annullato dall\'utente.';
					}
				}
				// Comandi long-running (dev server, watch) → terminale integrato: output live e
				// fermabili dall'utente, senza bloccare l'agente in attesa (mai un vero output).
				if (call.args.background === true || LONG_RUNNING_RE.test(command)) {
					const term = getMgTerminal();
					term.show(true);
					term.sendText(command, true);
					return `Comando avviato nel TERMINALE INTEGRATO "MGCoding" (resta in esecuzione, output dal vivo nel pannello Terminale): ${command}\nConsideralo avviato: NON attendere qui il suo output. Se è un dev server, l'app è ora raggiungibile all'URL che mostra nel terminale.`;
				}
				try {
					const { stdout, stderr } = await execAsync(command, {
						cwd: workspaceRoot().fsPath,
						timeout: 120000,
						maxBuffer: 1024 * 1024,
						// Spinge i tool a NON essere interattivi (evita wizard appesi che poi vengono annullati).
						env: { ...process.env, CI: '1', npm_config_yes: 'true', npm_config_audit: 'false', npm_config_fund: 'false', ADBLOCK: '1' }
					});
					return `[stdout]\n${stdout}\n${stderr ? `[stderr]\n${stderr}` : ''}`.trim();
				} catch (err: any) {
					return `[errore comando] ${err?.message ?? String(err)}\n${err?.stdout ?? ''}\n${err?.stderr ?? ''}`.trim();
				}
			}
			case 'apply_patch': {
				const rel = String(call.args.path);
				if (isProtectedSpecFile(rel)) {
					return `Bloccato: i file della spec (requirements/design/tasks.md) non si modificano durante l'esecuzione — ci pensa MGCoding. Implementa il codice negli altri file del workspace.`;
				}
				const uri = resolve(rel);
				const oldStr = String(call.args.old_string ?? '');
				const newStr = String(call.args.new_string ?? '');
				if (!oldStr) {
					return 'Errore: old_string vuoto.';
				}
				let content: string;
				try {
					content = DEC.decode(await vscode.workspace.fs.readFile(uri));
				} catch {
					return `Errore: impossibile leggere ${rel}.`;
				}
				const occurrences = content.split(oldStr).length - 1;
				if (occurrences === 0) {
					return `Errore: old_string non trovato in ${rel}.`;
				}
				const replaceAll = call.args.replaceAll === true;
				if (occurrences > 1 && !replaceAll) {
					return `Errore: old_string presente ${occurrences} volte in ${rel}; rendilo univoco o usa replaceAll:true.`;
				}
				const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
				if (remoteMode && !remoteAutoApprove) {
					return `Modifica a ${rel} NON applicata: da remoto serve la conferma. Attiva "mgcoding.telegram.autoApprove" per consentire le modifiche a distanza.`;
				}
				const cfg = vscode.workspace.getConfiguration('mgcoding');
				const needApproval = !remoteMode && cfg.get<boolean>('diffApproval', true) && !cfg.get<boolean>('autoApprove', false);
				if (needApproval && !(await confirmWrite(rel, content, updated))) {
					return `Modifica a ${rel} scartata dall'utente.`;
				}
				await recordOriginal(uri);
				await vscode.workspace.fs.writeFile(uri, ENC.encode(updated));
				return `OK: applicata patch a ${rel} (${replaceAll ? occurrences : 1} sostituzione/i)`;
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
			case 'update_plan': {
				// Normalmente gestito nel loop agentico (handlePlanTool); qui solo fallback.
				return 'Piano aggiornato.';
			}
			case 'ask_user': {
				// Normalmente gestito nel loop agentico (handleAskTool); qui solo fallback.
				return 'Domanda non posta (contesto non interattivo): procedi con l\'ipotesi più ragionevole.';
			}
			case 'remember': {
				// Normalmente gestito nel loop agentico (handleRememberTool); qui solo fallback.
				return 'Preferenza non salvata (profilo non disponibile in questo contesto).';
			}
			case 'delegate': {
				// Normalmente gestito nel loop agentico (handleDelegateTool); qui solo fallback.
				return 'Delega non disponibile in questo contesto: svolgi tu il compito con gli altri tool.';
			}
			case 'search_code': {
				const query = String(call.args.query ?? '').trim();
				if (!query) {
					return 'Errore: search_code richiede "query".';
				}
				const k = typeof call.args.k === 'number' && call.args.k > 0 ? Math.min(call.args.k, 15) : 6;
				try {
					const hits = await codeIndex.search(query, k);
					if (!hits.length) {
						return 'Nessun risultato (indice vuoto o codebase non indicizzabile). Usa search_text/find_files come alternativa.';
					}
					return hits.map(h => `── ${h.path}:${h.start}-${h.end} (rilevanza ${(h.score * 100).toFixed(0)}%)\n${h.text}`).join('\n\n');
				} catch (err) {
					return `Ricerca semantica non disponibile: ${err instanceof Error ? err.message : String(err)}. Usa search_text/find_files.`;
				}
			}
			case 'get_diagnostics': {
				const sevName = (s: vscode.DiagnosticSeverity): string =>
					s === vscode.DiagnosticSeverity.Error ? 'errore' : s === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info';
				const fmt = (uri: vscode.Uri, diags: readonly vscode.Diagnostic[]): string[] =>
					diags
						.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
						.map(d => `${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sevName(d.severity)} ${d.message.split('\n')[0]}${d.source ? ` [${d.source}]` : ''}`);
				const lines: string[] = [];
				if (call.args.path) {
					lines.push(...fmt(resolve(String(call.args.path)), vscode.languages.getDiagnostics(resolve(String(call.args.path)))));
				} else {
					for (const [uri, diags] of vscode.languages.getDiagnostics()) {
						lines.push(...fmt(uri, diags));
						if (lines.length > 200) {
							break;
						}
					}
				}
				return lines.length ? lines.slice(0, 200).join('\n') : 'Nessun errore o warning rilevato.';
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
