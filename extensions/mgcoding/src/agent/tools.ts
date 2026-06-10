/*---------------------------------------------------------------------------------------------
 *  MGCoding - tool dell'agente (filesystem + comandi shell)
 *--------------------------------------------------------------------------------------------*/

import { exec, spawn } from 'child_process';
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
		description: 'Esegue un comando shell nella radice del workspace (può richiedere conferma). I comandi che non terminano (dev server, watch: es. "npm run dev") vengono avviati in BACKGROUND con output catturato: ricevi subito l\'output iniziale reale (lì compaiono gli errori di avvio) e puoi rileggere il resto in qualsiasi momento con get_command_output. Per forzare il background passa "background": true.',
		args: '{"command": "npm run dev", "background": true}',
		inputSchema: { type: 'object', properties: { command: { type: 'string' }, background: { type: 'boolean', description: 'true = avvia in background senza attendere la fine (per processi che restano attivi)' } }, required: ['command'] }
	},
	{
		name: 'get_command_output',
		description: 'Legge l\'output ACCUMULATO REALE di un processo avviato in background con run_command (dev server, watch): usalo per verificare che sia partito davvero o per leggere gli errori (es. errori di compilazione/import di Vite) quando qualcosa non funziona. Senza id legge l\'ultimo processo avviato.',
		args: '{"id": 1}',
		inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Id del processo (restituito da run_command); default: ultimo avviato' }, tailChars: { type: 'number', description: 'Quanti caratteri finali leggere (default 6000)' } } }
	},
	{
		name: 'fetch_url',
		description: 'Scarica una URL via HTTP GET (tipicamente il dev server locale, es. http://localhost:5173/) e restituisce status e corpo (testo/HTML troncato). Usalo per VERIFICARE TU che l\'app risponda davvero (non chiederlo all\'utente) e per diagnosticare pagine bianche: controlla che l\'HTML serva il <div> di mount e lo <script> dell\'entry giusto.',
		args: '{"url": "http://localhost:5173/"}',
		inputSchema: { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'number', description: 'Max caratteri del corpo (default 4000)' } }, required: ['url'] }
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

/**
 * Trova old_string nel contenuto in modo TOLLERANTE: prova il match esatto, poi senza i
 * numeri di riga di read_file ("N\t") che i modelli copiano per sbaglio, poi confrontando
 * le righe trimmate (whitespace/indentazione diversi). Ritorna il frammento reale trovato.
 */
function flexibleMatch(content: string, oldStr: string): { actual: string; count: number } | undefined {
	let count = content.split(oldStr).length - 1;
	if (count > 0) {
		return { actual: oldStr, count };
	}
	const stripped = oldStr.split('\n').map(l => l.replace(/^\s*\d+\t/, '')).join('\n');
	if (stripped !== oldStr && stripped) {
		count = content.split(stripped).length - 1;
		if (count > 0) {
			return { actual: stripped, count };
		}
	}
	const target = (stripped || oldStr).split('\n').map(l => l.trim());
	if (!target.some(l => l)) {
		return undefined;
	}
	const lines = content.split('\n');
	const starts: number[] = [];
	for (let i = 0; i + target.length <= lines.length; i++) {
		let ok = true;
		for (let j = 0; j < target.length; j++) {
			if (lines[i + j].trim() !== target[j]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			starts.push(i);
		}
	}
	if (starts.length > 0) {
		return { actual: lines.slice(starts[0], starts[0] + target.length).join('\n'), count: starts.length };
	}
	return undefined;
}

/** Comandi che NON terminano (dev server, watcher): vanno nel terminale integrato. */
const LONG_RUNNING_RE = /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b|\bvite\b|\bnext\s+(dev|start)\b|\bnodemon\b|--watch\b|\bwatch\b|http-server\b|http\.server\b|\bserve\b|\buvicorn\b|\bflask\s+run\b|\bng\s+serve\b|\brails\s+server\b|bootRun/i;

/**
 * Processo long-running GESTITO da MGCoding: l'output è catturato in un buffer (leggibile
 * dall'agente con get_command_output) e mostrato dal vivo in un terminale dedicato.
 * Così l'agente VEDE gli errori reali (es. errori di import di Vite) invece di andare alla cieca.
 */
interface ManagedProcess {
	id: number;
	command: string;
	buffer: string;
	running: boolean;
	exitCode: number | null;
	kill(): void;
}

const managedProcs = new Map<number, ManagedProcess>();
let lastProcId = 0;
const PROC_BUFFER_MAX = 200000;

function startManagedProcess(command: string): ManagedProcess {
	const id = ++lastProcId;
	const writeEmitter = new vscode.EventEmitter<string>();
	const child = spawn(command, {
		cwd: workspaceRoot().fsPath,
		shell: true,
		env: { ...process.env, CI: '1', npm_config_yes: 'true', npm_config_audit: 'false', npm_config_fund: 'false', ADBLOCK: '1', FORCE_COLOR: '0' }
	});
	const mp: ManagedProcess = {
		id, command, buffer: '', running: true, exitCode: null,
		kill: () => { try { child.kill(); } catch { /* già terminato */ } }
	};
	const append = (chunk: Buffer) => {
		const text = chunk.toString();
		mp.buffer = (mp.buffer + text).slice(-PROC_BUFFER_MAX);
		writeEmitter.fire(text.replace(/(?<!\r)\n/g, '\r\n'));
	};
	child.stdout?.on('data', append);
	child.stderr?.on('data', append);
	child.on('close', code => {
		mp.running = false;
		mp.exitCode = code;
		writeEmitter.fire(`\r\n[processo terminato con codice ${code}]\r\n`);
	});
	child.on('error', err => {
		mp.running = false;
		mp.buffer += `\n[errore avvio] ${err.message}`;
	});
	const pty: vscode.Pseudoterminal = {
		onDidWrite: writeEmitter.event,
		open: () => { /* il processo è già partito */ },
		close: () => mp.kill()
	};
	vscode.window.createTerminal({ name: `MGCoding · ${command.slice(0, 40)}`, pty }).show(true);
	managedProcs.set(id, mp);
	return mp;
}

/** Attende l'output iniziale del processo: max maxMs, o prima se l'output si assesta. */
async function waitInitialOutput(mp: ManagedProcess, maxMs = 8000, quietMs = 1500): Promise<void> {
	const start = Date.now();
	let lastLen = mp.buffer.length;
	let lastChange = Date.now();
	while (Date.now() - start < maxMs) {
		await new Promise(r => setTimeout(r, 250));
		if (!mp.running) {
			return;
		}
		if (mp.buffer.length !== lastLen) {
			lastLen = mp.buffer.length;
			lastChange = Date.now();
		} else if (mp.buffer.length > 0 && Date.now() - lastChange >= quietMs) {
			return;
		}
	}
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
				// Comandi long-running (dev server, watch) → processo gestito: output dal vivo in
				// un terminale dedicato E catturato in un buffer, così l'agente vede gli errori
				// reali (Vite, webpack, ecc.) e può rileggerli con get_command_output.
				if (call.args.background === true || LONG_RUNNING_RE.test(command)) {
					// Se lo STESSO comando è già in esecuzione, non avviarne un duplicato (porte
					// che scalano, processi zombie): ritorna l'output aggiornato di quello attivo.
					for (const existing of [...managedProcs.values()].reverse()) {
						if (existing.running && existing.command === command) {
							return `GIÀ IN ESECUZIONE (id ${existing.id}): "${command}" — NON l'ho riavviato, non serve. I dev server moderni (Vite, webpack, next) hanno l'hot reload: le modifiche ai file si applicano da sole senza riavvio.\n[output recente REALE]\n${existing.buffer.slice(-4000).trim() || '(nessun output)'}`;
						}
					}
					const mp = startManagedProcess(command);
					await waitInitialOutput(mp);
					const out = mp.buffer.trim().slice(-4000);
					const status = mp.running ? `IN ESECUZIONE (id ${mp.id})` : `TERMINATO subito con codice ${mp.exitCode}`;
					return `Processo "${command}" avviato — stato: ${status}.\n[output iniziale REALE]\n${out || '(ancora nessun output)'}\n\nL'output prosegue nel terminale dedicato; per rileggerlo più avanti usa il tool get_command_output (id ${mp.id}). Se l'output qui sopra mostra ERRORI, correggili ORA prima di concludere. Non inventare output diverso da questo.`;
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
			case 'fetch_url': {
				const url = String(call.args.url ?? '').trim();
				if (!/^https?:\/\//i.test(url)) {
					return 'Errore: fetch_url richiede una URL http(s) completa (es. http://localhost:5173/).';
				}
				const maxChars = Math.min(Number(call.args.maxChars ?? 4000) || 4000, 20000);
				try {
					const ctrl = new AbortController();
					const timer = setTimeout(() => ctrl.abort(), 10000);
					const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
					clearTimeout(timer);
					const ctype = res.headers.get('content-type') ?? '';
					const body = (!ctype || /text|json|javascript|xml|html|css/i.test(ctype))
						? (await res.text()).slice(0, maxChars)
						: `(contenuto binario: ${ctype})`;
					return `HTTP ${res.status} ${res.statusText} — ${url}\ncontent-type: ${ctype}\n\n${body}`;
				} catch (err) {
					return `Errore fetch ${url}: ${err instanceof Error ? err.message : String(err)} (il server è in esecuzione? La porta è giusta? Controlla con get_command_output).`;
				}
			}
			case 'get_command_output': {
				const id = call.args.id !== undefined ? Number(call.args.id) : lastProcId;
				const mp = managedProcs.get(id);
				if (!mp) {
					return lastProcId === 0 ? 'Nessun processo in background avviato in questa sessione.' : `Errore: nessun processo con id ${id}.`;
				}
				const tail = Math.min(Number(call.args.tailChars ?? 6000) || 6000, 20000);
				const status = mp.running ? 'IN ESECUZIONE' : `TERMINATO (codice ${mp.exitCode})`;
				return `Processo ${mp.id} "${mp.command}" — ${status}\n[output recente REALE]\n${mp.buffer.slice(-tail).trim() || '(nessun output)'}`;
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
				const match = flexibleMatch(content, oldStr);
				if (!match) {
					return `Errore: old_string non trovato in ${rel} (nemmeno ignorando numeri di riga e differenze di spazi). Rileggi il file e riprova con un frammento copiato ESATTAMENTE.`;
				}
				const { actual, count: occurrences } = match;
				const replaceAll = call.args.replaceAll === true;
				if (occurrences > 1 && !replaceAll) {
					return `Errore: old_string presente ${occurrences} volte in ${rel}; rendilo univoco (aggiungi righe di contesto) o usa replaceAll:true.`;
				}
				const updated = replaceAll ? content.split(actual).join(newStr) : content.replace(actual, newStr);
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
