/*---------------------------------------------------------------------------------------------
 *  MGCoding - Specs: sviluppo spec-driven (requirements -> design -> tasks)
 *  Cartella: <workspace>/.mg/specs/<feature>/{requirements,design,tasks}.md
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { complete } from '../agent/agent';
import { runAgent } from '../agent/agentLoop';
import { setSpecWriteGuard } from '../agent/tools';
import { ProviderRegistry } from '../llm/registry';
import { RunReporter } from '../run/runView';
import { buildValidationReport, type ValidationReport } from './specValidator';
import type { SpecPhase } from '../llm/types';
import { resolveFeatureDirs } from '../util/featurePaths';
import { splitThink } from '../util/parsing';
import { exec } from 'child_process';

/** Genera un report finale (cosa è stato fatto + come avviarlo), salvato anche in REPORT.md. */
async function generateRunReport(registry: ProviderRegistry, specDir: vscode.Uri, specName: string, completed: string[], reporter: RunReporter): Promise<void> {
	if (!completed.length || !reporter.summary) {
		return;
	}
	try {
		const folders = vscode.workspace.workspaceFolders;
		let scripts = '(nessun package.json)';
		if (folders?.length) {
			try {
				const pkg = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folders[0].uri, 'package.json')))) as { scripts?: Record<string, string> };
				scripts = JSON.stringify(pkg.scripts ?? {}, null, 2);
			} catch { /* nessun package.json */ }
		}
		reporter.log('📝 Genero il report finale…');
		const sys = 'Scrivi un REPORT finale CONCISO in italiano dopo aver implementato una funzionalità. Solo Markdown, con esattamente due sezioni: "## Cosa ho fatto" (elenco puntato sintetico) e "## Come avviarlo e testarlo" (passi e comandi CONCRETI basati sugli script reali di package.json; se le dipendenze non risultano installate indica prima `npm install`). Niente blocchi di codice lunghi. Gli identificatori di codice restano in inglese.';
		const user = `Funzionalità: ${specName}\nTask completati (${completed.length}):\n${completed.map(t => '- ' + t).join('\n')}\n\nscripts di package.json:\n${scripts}`;
		const raw = await complete(registry, [{ role: 'user', content: user }], sys, undefined, undefined, true);
		const report = (splitThink(raw).answer || raw).trim();
		if (report) {
			reporter.summary(`## ✅ Report — ${specName}\n\n${report}`);
			try { await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(specDir, 'REPORT.md'), ENC.encode(`# Report — ${specName}\n\n${report}\n`)); } catch { /* best effort */ }
		}
	} catch { /* il report è opzionale */ }
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export function slugify(name: string): string {
	return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature';
}

export function specsRoot(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? vscode.Uri.joinPath(f[0].uri, '.mg', 'specs') : undefined;
}

/* -------------------------------------------------------------------------------------------
 * Verifica post-task (opt-in): dopo aver implementato un task, esegue un comando di build/test
 * e segna il task come "fatto" SOLO se passa (altrimenti resta da fare → ritentabile).
 * Disattivata di default (`mgcoding.spec.verifyAfterTask`): su repo grandi la build è lenta.
 * ----------------------------------------------------------------------------------------- */

/** Serializza le verifiche così due build non girano mai in parallelo (anche tra wave). */
let verifyChain: Promise<unknown> = Promise.resolve();

/** Comando di verifica da usare: esplicito (`spec.verifyCommand`) o auto-rilevato dagli script. */
async function resolveVerifyCommand(): Promise<string | undefined> {
	const cfg = vscode.workspace.getConfiguration('mgcoding');
	if (!cfg.get<boolean>('spec.verifyAfterTask', false)) {
		return undefined;
	}
	const explicit = cfg.get<string>('spec.verifyCommand', '').trim();
	if (explicit) {
		return explicit;
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return undefined;
	}
	try {
		const pkg = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folders[0].uri, 'package.json')))) as { scripts?: Record<string, string> };
		const s = pkg.scripts ?? {};
		// Preferisci i controlli VELOCI a quelli lenti: typecheck/compile prima di build.
		for (const name of ['typecheck', 'type-check', 'check-types', 'compile', 'lint', 'build', 'test']) {
			if (s[name]) {
				return `npm run ${name}`;
			}
		}
	} catch {
		// nessun package.json: nessuna verifica auto
	}
	return undefined;
}

/** Esegue un comando di verifica a completamento, restituendo esito ed estratto dell'output. */
function runVerifyCommand(cmd: string, cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
	return new Promise(resolve => {
		const child = exec(cmd, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			resolve({ ok: !err, output: `${stdout ?? ''}\n${stderr ?? ''}`.trim() });
		});
		signal?.addEventListener('abort', () => { try { child.kill(); } catch { /* */ } }, { once: true });
	});
}

/**
 * Verifica un task appena implementato (se la verifica è attiva). Ritorna `true` se la verifica
 * passa o non è configurata; `false` se la build/test fallisce (il task NON va segnato fatto).
 */
async function verifyTask(reporter: RunReporter, tag: string, signal?: AbortSignal): Promise<boolean> {
	const cmd = await resolveVerifyCommand();
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cmd || !cwd) {
		return true;
	}
	reporter.log(`🧪 ${tag} verifica: ${cmd}`);
	const run = (): Promise<{ ok: boolean; output: string }> => runVerifyCommand(cmd, cwd, signal);
	const p = verifyChain.then(run, run);
	verifyChain = p.catch(() => { /* non bloccare la catena su errore */ });
	const res = await p;
	if (res.ok) {
		reporter.log(`✓ ${tag} verifica superata`);
		return true;
	}
	reporter.log(`✗ ${tag} verifica FALLITA — il task resta da fare e potrà essere ritentato:\n${res.output.slice(-700)}`);
	return false;
}

/** Regola trasversale: gli identificatori di codice sono SEMPRE in inglese. */
export const CODE_IN_ENGLISH = ' REGOLA CODICE: tutti gli identificatori di codice (nomi di funzioni/metodi, variabili, classi, tipi, file, route/URL ed endpoint API) devono essere SEMPRE in inglese (es. validateEmail, calculateDiscount, isPremium, "/user-access"). La prosa descrittiva può restare in italiano, ma gli identificatori di codice no.';

/** System prompt per ciascuna fase del workflow spec-driven. */
export const SPEC_SYS = {
	requirements: `Genera un documento requirements.md spec-driven. Struttura:
# Requisiti: <nome>
## Introduzione (2-3 righe)
## Requisiti
Per ogni requisito numerato:
### Requisito N: <titolo>
**User story:** Come <ruolo>, voglio <obiettivo>, così che <beneficio>.
**Criteri di accettazione** in notazione EARS:
1. WHEN <evento> THE SYSTEM SHALL <comportamento>
2. IF <condizione> THEN THE SYSTEM SHALL <comportamento>
3. WHILE <stato> THE SYSTEM SHALL <comportamento>
Copri casi felici, errori e casi limite. Solo Markdown, nessun preambolo.${CODE_IN_ENGLISH}`,
	design: `Genera un documento design.md (architettura tecnica) coerente con i requisiti dati. Sezioni:
# Design: <nome>
## Panoramica
## Architettura (componenti e responsabilità; usa un diagramma mermaid se utile)
## Componenti e interfacce (firme/API principali)
## Modello dati (tipi/strutture)
## Gestione degli errori
## Strategia di test
Mappa esplicitamente le scelte ai requisiti. Solo Markdown.${CODE_IN_ENGLISH}`,
	bugfix: `Genera un documento di ANALISI BUG (in requirements.md) per un difetto da correggere. Struttura:
# Bugfix: <titolo>
## Sintomo
Cosa non funziona / comportamento osservato.
## Passi per riprodurre
1. …
## Comportamento atteso
## Analisi della causa (ipotesi)
Possibili cause radice, file/componenti coinvolti.
## Criteri di accettazione (EARS)
1. WHEN <evento> THE SYSTEM SHALL <comportamento corretto>
Solo Markdown, nessun preambolo.${CODE_IN_ENGLISH}`,
	tasks: `Genera un documento tasks.md: piano di implementazione come checklist Markdown ("- [ ] ...").
Regole:
- Ogni task è piccolo, concreto e verificabile (idealmente una singola unità di lavoro).
- Ordina i task per dipendenza (prima le fondamenta).
- Ogni task cita i requisiti che soddisfa, es: "(Req 1.2, 3.1)".
- Includi task di test dove sensato.
- Marca i task OPZIONALI (non essenziali per un MVP, es. CI/CD, documentazione extra) aggiungendo " (opzionale)" alla fine della riga del task.
- Solo passi implementabili nel codice (niente deploy/manuali). Solo Markdown.${CODE_IN_ENGLISH}`
};

export async function writeAndOpen(uri: vscode.Uri, content: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, ENC.encode(content));
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, { preview: false });
}

async function readIfExists(uri: vscode.Uri): Promise<string> {
	try {
		return DEC.decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return '';
	}
}

async function generatePhase(
	registry: ProviderRegistry,
	title: string,
	systemExtra: string,
	userPrompt: string
): Promise<string> {
	return await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `MGCoding: genero ${title}...`, cancellable: false },
		async () => complete(registry, [{ role: 'user', content: userPrompt }], systemExtra)
	);
}

/* -------------------------------------------------------------------------------------------
 * Gating del workflow Spec (Spec_Validator): al passaggio di fase si valida il documento
 * appena generato. Se la validazione non è superata (`canAdvance === false`) si mostrano le
 * sezioni mancanti / i criteri scoperti e si BLOCCA l'avvio della fase successiva, lasciando
 * comunque completata la fase corrente (Req. 6.3, 6.5). La fase successiva non parte finché
 * l'approvazione esplicita dell'utente non è registrata (Req. 6.6).
 * ----------------------------------------------------------------------------------------- */

/** Formatta in modo leggibile i problemi di validazione (sezioni mancanti / criteri scoperti). */
function formatValidationIssues(report: ValidationReport): string {
	const parts: string[] = [];
	const missing = report.structural.filter(s => !s.present).map(s => s.section);
	if (missing.length) {
		parts.push(`Sezioni mancanti: ${missing.join(', ')}`);
	}
	const uncovered = report.coverage.filter(c => !c.covered).map(c => c.criterion);
	if (uncovered.length) {
		parts.push(`Criteri non coperti da alcun task: ${uncovered.join(', ')}`);
	}
	return parts.length ? parts.join('\n') : 'Validazione non superata.';
}

/**
 * Esegue il gating tra fasi dello workflow Spec (Req. 6.3, 6.5, 6.6):
 *  - valida il documento appena generato per la fase corrente;
 *  - se `canAdvance` è false, mostra le sezioni mancanti / i criteri scoperti e BLOCCA
 *    l'avvio della fase successiva (la fase corrente resta comunque completata);
 *  - altrimenti chiede l'approvazione esplicita: la fase successiva non parte finché
 *    l'approvazione non è registrata.
 * Ritorna `true` solo quando è consentito avviare la fase successiva.
 */
export async function gatePhaseTransition(
	phase: SpecPhase,
	phaseDocument: string,
	approvalPrompt: string,
	requirementsMd?: string,
	tasksMd?: string
): Promise<boolean> {
	const report = buildValidationReport({ phase, phaseDocument, requirementsMd, tasksMd });
	if (!report.canAdvance) {
		// Validazione non superata: mostra i problemi e impedisce l'avanzamento (Req. 6.3, 6.5).
		const issues = formatValidationIssues(report);
		await vscode.window.showWarningMessage(
			`Validazione della fase "${phase}" non superata: impossibile avanzare alla fase successiva.\n\n${issues}\n\nCorreggi il documento e rigenera la spec per procedere.`,
			{ modal: true }, 'Ho capito'
		);
		return false;
	}
	// Approvazione esplicita: solo dopo la registrazione si avvia la fase successiva (Req. 6.6).
	const ok = await vscode.window.showInformationMessage(
		approvalPrompt, { modal: true }, 'Approva e continua'
	);
	return ok === 'Approva e continua';
}

export async function createSpec(registry: ProviderRegistry, refresh: () => void): Promise<void> {
	const root = specsRoot();
	if (!root) {
		vscode.window.showWarningMessage('Apri una cartella per creare una Spec.');
		return;
	}
	const name = await vscode.window.showInputBox({ prompt: 'Nome della funzionalità', placeHolder: 'es. Autenticazione utenti' });
	if (!name) {
		return;
	}
	const desc = await vscode.window.showInputBox({ prompt: 'Descrivi cosa deve fare', ignoreFocusOut: true });
	if (desc === undefined) {
		return;
	}

	const dir = vscode.Uri.joinPath(root, slugify(name));
	await vscode.workspace.fs.createDirectory(dir);

	// Fase 1: requirements (EARS)
	const requirements = await generatePhase(
		registry,
		'requirements',
		SPEC_SYS.requirements,
		`Funzionalità: ${name}\nDescrizione: ${desc}`
	);
	await writeAndOpen(vscode.Uri.joinPath(dir, 'requirements.md'), requirements);
	refresh();

	// Gating requirements → design: valida la struttura e registra l'approvazione (Req. 6.5, 6.6).
	if (!(await gatePhaseTransition('requirements', requirements, `Requirements per "${name}" generati. Procedo col design?`))) {
		return;
	}

	// Fase 2: design
	const design = await generatePhase(
		registry,
		'design',
		SPEC_SYS.design,
		`Funzionalità: ${name}\nRequisiti:\n${requirements}`
	);
	await writeAndOpen(vscode.Uri.joinPath(dir, 'design.md'), design);

	// Gating design → tasks: valida la struttura e registra l'approvazione (Req. 6.5, 6.6).
	if (!(await gatePhaseTransition('design', design, `Design per "${name}" generato. Procedo coi task?`, requirements))) {
		return;
	}

	// Fase 3: tasks
	const tasks = await generatePhase(
		registry,
		'tasks',
		SPEC_SYS.tasks,
		`Funzionalità: ${name}\nDesign:\n${design}`
	);
	await writeAndOpen(vscode.Uri.joinPath(dir, 'tasks.md'), tasks);
	refresh();

	// Validazione finale della fase tasks: segnala i criteri di accettazione non coperti
	// da alcun task (Req. 6.3); la fase resta comunque completata.
	const tasksReport = buildValidationReport({ phase: 'tasks', phaseDocument: tasks, requirementsMd: requirements, tasksMd: tasks });
	if (!tasksReport.canAdvance) {
		vscode.window.showWarningMessage(
			`Spec "${name}" completata, ma la validazione dei task ha rilevato problemi:\n\n${formatValidationIssues(tasksReport)}`,
			{ modal: true }, 'Ho capito'
		);
		return;
	}

	vscode.window.showInformationMessage(`Spec "${name}" completata in .mg/specs/${slugify(name)}/`);
}

// ---- Esecuzione dei task ----

interface ParsedTask {
	lineIdx: number;
	text: string;
	done: boolean;
	inProgress: boolean;
	optional: boolean;
}

const TASK_RE = /^(\s*[-*]\s*\[)( |x|X|~)(\]\s*)(.+)$/;
const OPTIONAL_RE = /\((opzionale|optional)\)/i;

function parseTasks(md: string): ParsedTask[] {
	const lines = md.split('\n');
	const tasks: ParsedTask[] = [];
	lines.forEach((line, lineIdx) => {
		const m = TASK_RE.exec(line);
		if (m) {
			const text = m[4].trim();
			tasks.push({ lineIdx, text, done: m[2].toLowerCase() === 'x', inProgress: m[2] === '~', optional: OPTIONAL_RE.test(text) });
		}
	});
	return tasks;
}

/** Imposta lo stato del checkbox di un task: ' ' (da fare), '~' (in corso), 'x' (fatto). */
function setTaskMark(md: string, lineIdx: number, mark: ' ' | '~' | 'x'): string {
	const lines = md.split('\n');
	const line = lines[lineIdx];
	if (line !== undefined) {
		lines[lineIdx] = line.replace(/\[[ xX~]\]/, `[${mark}]`);
	}
	return lines.join('\n');
}

/**
 * Esegue (o riprende) tutti i task non completati di una spec, uno alla volta,
 * usando l'agente con il contesto di requirements e design. Spunta i task completati.
 */
export async function runSpecTasks(registry: ProviderRegistry, specDir: vscode.Uri, refresh: () => void, reporter: RunReporter, includeOptional = true, signal?: AbortSignal): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	let tasksMd = await readIfExists(tasksUri);
	if (!tasksMd) {
		vscode.window.showWarningMessage('Nessun tasks.md in questa spec. Genera prima la spec.');
		return;
	}
	const requirements = await readIfExists(vscode.Uri.joinPath(specDir, 'requirements.md'));
	const design = await readIfExists(vscode.Uri.joinPath(specDir, 'design.md'));
	const specName = specDir.path.split('/').pop() ?? 'spec';

	const all = parseTasks(tasksMd);
	const doneCount = all.filter(t => t.done).length;
	const pending = all.filter(t => !t.done && (includeOptional || !t.optional));
	if (pending.length === 0) {
		vscode.window.showInformationMessage(`Nessun task da eseguire per "${specName}"${includeOptional ? '' : ' (esclusi gli opzionali)'}.`);
		return;
	}

	const resumeNote = doneCount > 0 ? ` — riprendo: ${doneCount} già completati, ${pending.length} rimanenti` : '';
	reporter.start(`Spec: ${specName}${resumeNote}`, pending.map(t => t.text));
	if (doneCount > 0) {
		reporter.log(`↩️ Riprendo dal task non completato (saltati ${doneCount} già fatti).`);
	}

	const completed: string[] = [];
	setSpecWriteGuard(true);
	try {
		for (let i = 0; i < pending.length; i++) {
			if (signal?.aborted) {
				reporter.log('⏹ Esecuzione interrotta.');
				break;
			}
			const task = pending[i];
			reporter.setStatus(i, 'running');
			reporter.log(`▶ [${i + 1}/${pending.length} da fare] ${task.text}`);

			// Segna il task come "in corso" ([~]) nel file, così è visibile ovunque.
			tasksMd = setTaskMark(tasksMd, task.lineIdx, '~');
			await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
			refresh();

			const prompt = `Stai implementando la funzionalità "${specName}" in modo spec-driven. Implementa SOLO il task indicato, usando i tool per leggere e scrivere i file necessari nel workspace.

# Requisiti
${requirements || '(non disponibili)'}

# Design
${design || '(non disponibile)'}

# Task da implementare ora
${task.text}

NON modificare i file della spec (requirements.md, design.md, tasks.md): allo stato dei task (spunte) ci pensa MGCoding.
Quando hai finito di implementare questo task, fornisci un breve riepilogo di cosa hai fatto.`;

			const messages = [{ role: 'user' as const, content: prompt }];
			let ok = false;
			try {
				await runAgent(registry, messages, {
					onAssistantText: t => reporter.log(`🤖 ${t.slice(0, 300)}`),
					onToolStart: c => reporter.log(`🔧 ${c.tool} ${JSON.stringify(c.args).slice(0, 160)}`),
					onToolResult: r => reporter.log(`↳ ${r.slice(0, 200)}`)
				}, signal);
				ok = true;
			} catch (err) {
				reporter.setStatus(i, 'error');
				reporter.log(`[errore] ${String(err)}`);
			}
			// Verifica post-task (opt-in): segna fatto SOLO se build/test passa.
			if (ok && !(await verifyTask(reporter, `[${i + 1}/${pending.length}]`, signal))) {
				ok = false;
				reporter.setStatus(i, 'error');
			}
			if (ok) {
				reporter.setStatus(i, 'done');
				completed.push(task.text);
			}

			// Aggiorna lo stato sulla NOSTRA copia autorevole: fatto ([x]) se riuscito,
			// altrimenti torna da fare ([ ]) così è ritentabile.
			tasksMd = setTaskMark(tasksMd, task.lineIdx, ok ? 'x' : ' ');
			await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
			refresh();
		}
	} finally {
		setSpecWriteGuard(false);
	}

	if (!signal?.aborted) {
		await generateRunReport(registry, specDir, specName, completed, reporter);
	}
	reporter.finish('=== Esecuzione task terminata ===');
}

/**
 * Pianifica le "wave": raggruppa i task in ondate dove i task della stessa wave
 * sono indipendenti (eseguibili in parallelo) e le wave successive dipendono dalle
 * precedenti. Usa l'LLM; in caso di fallback esegue tutto in sequenza.
 * Ritorna array di wave, ciascuna con gli indici (0-based) in `tasks`.
 */
async function planWaves(registry: ProviderRegistry, tasks: ParsedTask[]): Promise<number[][]> {
	if (tasks.length <= 1) {
		return tasks.map((_, i) => [i]);
	}
	const list = tasks.map((t, i) => `${i + 1}. ${t.text}`).join('\n');
	const sys = `Sei un pianificatore di esecuzione. Dati dei task di implementazione, raggruppali in "wave".
Regole:
- I task nella STESSA wave devono essere INDIPENDENTI: file/aree di codice diversi, nessuna dipendenza reciproca, eseguibili in parallelo senza conflitti.
- Una wave può dipendere dai risultati delle wave precedenti.
- Metti nella stessa wave solo task realmente sicuri da eseguire insieme; nel dubbio, separali in wave diverse.
Rispondi SOLO con JSON valido nella forma {"waves":[[1,2],[3],[4,5]]} usando i NUMERI dei task elencati. Nessun altro testo.`;
	try {
		const raw = await complete(registry, [{ role: 'user', content: `Task:\n${list}` }], sys, undefined, undefined, true);
		const m = raw.match(/\{[\s\S]*\}/);
		if (m) {
			const obj = JSON.parse(m[0]) as { waves?: unknown };
			if (Array.isArray(obj.waves)) {
				const seen = new Set<number>();
				const clean: number[][] = [];
				for (const w of obj.waves) {
					if (!Array.isArray(w)) {
						continue;
					}
					const ww = w.map(x => Number(x) - 1).filter(i => Number.isInteger(i) && i >= 0 && i < tasks.length && !seen.has(i));
					ww.forEach(i => seen.add(i));
					if (ww.length) {
						clean.push(ww);
					}
				}
				// Task non assegnati → ognuno come wave finale sequenziale.
				for (let i = 0; i < tasks.length; i++) {
					if (!seen.has(i)) {
						clean.push([i]);
					}
				}
				if (clean.length) {
					return clean;
				}
			}
		}
	} catch {
		// fallback sotto
	}
	return tasks.map((_, i) => [i]);
}

/**
 * Esegue i task per WAVE (come Kiro): all'interno di una wave i task girano in
 * parallelo come subagent indipendenti (cap di concorrenza), le wave sono
 * sequenziali. La marcatura su tasks.md è serializzata.
 */
export async function runSpecTasksParallel(
	registry: ProviderRegistry,
	specDir: vscode.Uri,
	refresh: () => void,
	reporter: RunReporter,
	includeOptional = true,
	signal?: AbortSignal,
	concurrency = 2
): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	let tasksMd = await readIfExists(tasksUri);
	if (!tasksMd) {
		vscode.window.showWarningMessage('Nessun tasks.md in questa spec. Genera prima la spec.');
		return;
	}
	const requirements = await readIfExists(vscode.Uri.joinPath(specDir, 'requirements.md'));
	const design = await readIfExists(vscode.Uri.joinPath(specDir, 'design.md'));
	const specName = specDir.path.split('/').pop() ?? 'spec';

	const pending = parseTasks(tasksMd).filter(t => !t.done && (includeOptional || !t.optional));
	if (pending.length === 0) {
		vscode.window.showInformationMessage(`Nessun task da eseguire per "${specName}".`);
		return;
	}

	reporter.start(`Spec (wave): ${specName}`, pending.map(t => t.text));
	reporter.log('🔎 Analizzo le dipendenze e pianifico le wave…');
	const waves = await planWaves(registry, pending);
	reporter.log(`📋 ${waves.length} wave pianificate (concorrenza max ×${concurrency}).`);

	// Lock per serializzare le scritture su tasks.md.
	let writeLock: Promise<void> = Promise.resolve();
	const setMark = (lineIdx: number, mark: ' ' | '~' | 'x'): Promise<void> => {
		writeLock = writeLock.then(async () => {
			tasksMd = setTaskMark(tasksMd, lineIdx, mark);
			await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
			refresh();
		});
		return writeLock;
	};

	const completedP: string[] = [];
	const runOne = async (i: number, waveNo: number): Promise<void> => {
		const task = pending[i];
		const tag = `[W${waveNo}·${i + 1}]`;
		reporter.log(`▶ ${tag} ${task.text}`);
		await setMark(task.lineIdx, '~');
		const prompt = `Stai implementando la funzionalità "${specName}" in modo spec-driven, come uno di più subagent in parallelo nella stessa wave. Implementa SOLO questo task usando i tool. Tocca solo i file necessari a QUESTO task per non confliggere con gli altri subagent.

# Requisiti
${requirements || '(non disponibili)'}

# Design
${design || '(non disponibile)'}

# Task da implementare ora
${task.text}

NON modificare i file della spec (requirements/design/tasks.md). Al termine un breve riepilogo.`;
		let ok = false;
		try {
			await runAgent(registry, [{ role: 'user', content: prompt }], {
				onAssistantText: t => reporter.log(`🤖 ${tag} ${t.slice(0, 180)}`),
				onToolStart: c => reporter.log(`🔧 ${tag} ${c.tool} ${JSON.stringify(c.args).slice(0, 110)}`),
				onToolResult: r => reporter.log(`↳ ${tag} ${r.slice(0, 140)}`)
			}, signal);
			ok = true;
		} catch (err) {
			reporter.log(`✗ ${tag} ${String(err)}`);
		}
		// Verifica post-task (opt-in, serializzata): completa solo se build/test passa.
		if (ok && !(await verifyTask(reporter, tag, signal))) {
			ok = false;
		}
		if (ok) {
			reporter.log(`✓ ${tag} completato`);
			completedP.push(task.text);
		}
		await setMark(task.lineIdx, ok ? 'x' : ' ');
	};

	setSpecWriteGuard(true);
	try {
		for (let w = 0; w < waves.length; w++) {
			if (signal?.aborted) {
				reporter.log('⏹ Interrotto.');
				break;
			}
			const wave = waves[w];
			reporter.log(`\n── Wave ${w + 1}/${waves.length} · ${wave.length} task in parallelo ──`);
			// Esegue la wave a gruppi di `concurrency` per non sovraccaricare.
			for (let s = 0; s < wave.length; s += Math.max(1, concurrency)) {
				if (signal?.aborted) {
					break;
				}
				const slice = wave.slice(s, s + Math.max(1, concurrency));
				await Promise.all(slice.map(i => runOne(i, w + 1)));
			}
		}
	} finally {
		setSpecWriteGuard(false);
	}

	await writeLock;
	if (!signal?.aborted) {
		await generateRunReport(registry, specDir, specName, completedP, reporter);
	}
	reporter.finish(`=== Esecuzione a wave terminata (${specName}) ===`);
}

/** Esegue un singolo task (per lineIdx) di una spec con l'agente. */
export async function runSpecTask(registry: ProviderRegistry, specDir: vscode.Uri, lineIdx: number, refresh: () => void, reporter: RunReporter, signal?: AbortSignal): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	let tasksMd = await readIfExists(tasksUri);
	const task = parseTasks(tasksMd).find(t => t.lineIdx === lineIdx);
	if (!task) {
		vscode.window.showWarningMessage('Task non trovato.');
		return;
	}
	if (task.done) {
		vscode.window.showInformationMessage('Task già completato.');
		return;
	}
	const requirements = await readIfExists(vscode.Uri.joinPath(specDir, 'requirements.md'));
	const design = await readIfExists(vscode.Uri.joinPath(specDir, 'design.md'));
	const specName = specDir.path.split('/').pop() ?? 'spec';

	reporter.start(`Task · ${specName}`, [task.text]);
	reporter.setStatus(0, 'running');
	// Segna "in corso" ([~]) prima di iniziare.
	tasksMd = setTaskMark(tasksMd, lineIdx, '~');
	await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
	refresh();
	const prompt = `Stai implementando la funzionalità "${specName}" in modo spec-driven. Implementa SOLO questo task usando i tool.

# Requisiti
${requirements || '(non disponibili)'}

# Design
${design || '(non disponibile)'}

# Task
${task.text}

NON modificare i file della spec (requirements.md, design.md, tasks.md): allo stato dei task ci pensa MGCoding.
Al termine fornisci un breve riepilogo.`;
	let ok = false;
	setSpecWriteGuard(true);
	try {
		await runAgent(registry, [{ role: 'user', content: prompt }], {
			onAssistantText: t => reporter.log(`🤖 ${t.slice(0, 300)}`),
			onToolStart: c => reporter.log(`🔧 ${c.tool} ${JSON.stringify(c.args).slice(0, 160)}`),
			onToolResult: r => reporter.log(`↳ ${r.slice(0, 200)}`)
		}, signal);
		ok = true;
	} catch (err) {
		reporter.setStatus(0, 'error');
		reporter.log(`[errore] ${String(err)}`);
	} finally {
		setSpecWriteGuard(false);
	}
	// Verifica post-task (opt-in), fuori dal write-guard.
	if (ok && !(await verifyTask(reporter, 'task', signal))) {
		ok = false;
		reporter.setStatus(0, 'error');
	} else if (ok) {
		reporter.setStatus(0, 'done');
	}
	tasksMd = setTaskMark(await readIfExists(tasksUri) || tasksMd, lineIdx, ok ? 'x' : ' ');
	await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(tasksMd));
	refresh();
	reporter.finish('=== Task terminato ===');
}

// ---- CodeLens su tasks.md: "Start task" per riga + Run all in cima (stile Kiro) ----

/** Inverte lo stato (fatto/da fare) di un task nel tasks.md. */
export async function toggleSpecTask(specDir: vscode.Uri, lineIdx: number): Promise<void> {
	const tasksUri = vscode.Uri.joinPath(specDir, 'tasks.md');
	const md = await readIfExists(tasksUri);
	if (!md) {
		return;
	}
	const lines = md.split('\n');
	const line = lines[lineIdx] ?? '';
	// Fatto → da fare; da fare o in corso ([~]) → fatto.
	if (/\[[xX]\]/.test(line)) {
		lines[lineIdx] = line.replace(/\[[xX]\]/, '[ ]');
	} else if (/\[[ ~]\]/.test(line)) {
		lines[lineIdx] = line.replace(/\[[ ~]\]/, '[x]');
	} else {
		return;
	}
	await vscode.workspace.fs.writeFile(tasksUri, ENC.encode(lines.join('\n')));
}

/** Mostra azioni eseguibili direttamente nel tasks.md di una spec. */
export class SpecTasksCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const p = document.uri.path;
		if (!/tasks\.md$/i.test(p) || !/specs/i.test(p)) {
			return [];
		}
		const specDir = vscode.Uri.joinPath(document.uri, '..');
		const top = new vscode.Range(0, 0, 0, 0);
		const lenses: vscode.CodeLens[] = [
			new vscode.CodeLens(top, { title: '$(run-all) Run all tasks', command: 'mgcoding.runSpecTasksHere', arguments: [document.uri] }),
			new vscode.CodeLens(top, { title: '$(rocket) Run waves (subagent)', command: 'mgcoding.runSpecTasksParallel', arguments: [document.uri] }),
			new vscode.CodeLens(top, { title: '$(play-circle) Run all + optional', command: 'mgcoding.runSpecTasksHereOptional', arguments: [document.uri] }),
			new vscode.CodeLens(top, { title: '$(sync) Sync', command: 'mgcoding.specSync', arguments: [document.uri] })
		];
		for (const t of parseTasks(document.getText())) {
			const range = new vscode.Range(t.lineIdx, 0, t.lineIdx, 0);
			if (t.inProgress) {
				lenses.push(new vscode.CodeLens(range, { title: '$(sync~spin) In corso…', command: 'mgcoding.runSpecTask', arguments: [{ specDir, lineIdx: t.lineIdx }] }));
			} else if (!t.done) {
				const title = t.optional ? '$(play) Start task (opzionale)' : '$(play) Start task';
				lenses.push(new vscode.CodeLens(range, { title, command: 'mgcoding.runSpecTask', arguments: [{ specDir, lineIdx: t.lineIdx }] }));
			}
			lenses.push(new vscode.CodeLens(range, {
				title: t.done ? '$(check) Fatto (segna da fare)' : '$(circle-large-outline) Segna fatto',
				command: 'mgcoding.toggleSpecTask',
				arguments: [{ specDir, lineIdx: t.lineIdx }]
			}));
		}
		return lenses;
	}
}

// ---- Tree view ----

type SpecNode =
	| { kind: 'spec'; uri: vscode.Uri; label: string }
	| { kind: 'file'; uri: vscode.Uri; label: string }
	| { kind: 'task'; specDir: vscode.Uri; lineIdx: number; label: string; done: boolean; inProgress: boolean };

export class SpecsTreeProvider implements vscode.TreeDataProvider<SpecNode> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	getTreeItem(node: SpecNode): vscode.TreeItem {
		if (node.kind === 'spec') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('checklist');
			item.resourceUri = node.uri;
			item.contextValue = 'mgcoding.spec';
			return item;
		}
		if (node.kind === 'task') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			const icon = node.done ? 'pass-filled' : node.inProgress ? 'sync~spin' : 'circle-large-outline';
			item.iconPath = new vscode.ThemeIcon(icon);
			item.contextValue = 'mgcoding.task';
			item.tooltip = node.done ? 'Completato' : node.inProgress ? 'In corso…' : 'Da fare — esegui con ▶';
			return item;
		}
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('file');
		item.command = { command: 'vscode.open', title: 'Apri', arguments: [node.uri] };
		return item;
	}

	async getChildren(node?: SpecNode): Promise<SpecNode[]> {
		if (!node) {
			const roots = await resolveFeatureDirs('specs');
			const seen = new Set<string>();
			const out: SpecNode[] = [];
			for (const root of roots) {
				let entries: [string, vscode.FileType][];
				try {
					entries = await vscode.workspace.fs.readDirectory(root);
				} catch {
					continue;
				}
				for (const [dirName, t] of entries) {
					if (t === vscode.FileType.Directory && !seen.has(dirName)) {
						seen.add(dirName);
						out.push({ kind: 'spec', uri: vscode.Uri.joinPath(root, dirName), label: dirName });
					}
				}
			}
			return out;
		}
		if (node.kind === 'spec') {
			// Solo i documenti della spec (i singoli task si vedono in tasks.md/chat,
			// non come nodi dell'albero).
			const out: SpecNode[] = [];
			for (const fname of ['requirements.md', 'design.md', 'tasks.md']) {
				const uri = vscode.Uri.joinPath(node.uri, fname);
				if (await readIfExists(uri)) {
					out.push({ kind: 'file', uri, label: fname });
				}
			}
			return out;
		}
		return [];
	}
}
