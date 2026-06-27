/*---------------------------------------------------------------------------------------------
 *  MGCoding - Gestore_ComfyUI: adapter del CICLO DI VITA di ComfyUI.
 *
 *  Questo modulo è un ADAPTER di I/O (usa `vscode`, `fetch`, `child_process`, `fs`): incapsula
 *  rilevamento dello stato, avvio del processo (Python embedded portable su Windows), attesa di
 *  readiness, arresto del processo avviato da MGCoding ed elenchi (checkpoint/LoRA/nodi).
 *
 *  La logica PURA di costruzione del comando di avvio e dei percorsi vive in `util/paths.ts`
 *  (`buildWindowsLaunch`), qui solo riusata: nessuna duplicazione. Include inoltre
 *  l'installazione di ComfyUI e ComfyUI-Manager dietro conferma esplicita (Req 14, 22.3).
 *
 *  Convenzioni di configurazione esistenti dell'estensione:
 *   - `mgcoding.image.comfyEndpoint` (default `http://127.0.0.1:8188`)
 *   - `mgcoding.image.comfyRoot`     (cartella di ComfyUI che contiene `models/`)
 *
 *  _Requirements: 12.1, 12.2, 12.3, 13.1, 13.2, 13.3, 13.4, 13.5, 14.1, 14.2, 14.3, 14.4, 22.3, 24.1_
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { buildWindowsLaunch, PYTHON_EMBEDED_DIR, PYTHON_EMBEDED_EXE } from '../util/paths';
import { listCheckpoints, listLoras, pickComfyFolder } from './comfyHelper';

/** Esecuzione di comandi esterni (git/pip) in forma Promise, come in `comfyHelper.ts`. */
const execAsync = promisify(exec);

// ---- Costanti di tempo (named, come da design e Requirements) ----

/** Timeout del probe di raggiungibilità su `/system_stats` (Req 12.1). */
export const PROBE_TIMEOUT_MS = 3000;

/** Timeout massimo di attesa che l'endpoint risponda dopo l'avvio (Req 13.2, 13.5). */
export const READINESS_TIMEOUT_MS = 120000;

/** Intervallo tra un tentativo di probe e il successivo durante l'attesa di readiness. */
export const READINESS_POLL_INTERVAL_MS = 1500;

/** Endpoint predefinito di ComfyUI. */
export const DEFAULT_COMFY_ENDPOINT = 'http://127.0.0.1:8188';

/** Chiave di configurazione dell'endpoint ComfyUI. */
const CFG_ENDPOINT = 'image.comfyEndpoint';
/** Chiave di configurazione della cartella di ComfyUI. */
const CFG_COMFY_ROOT = 'image.comfyRoot';
/** Chiave di configurazione del comando/launcher di avvio di ComfyUI (es. il tuo .bat). */
const CFG_START_COMMAND = 'image.comfyStartCommand';

// ---- Stato del processo avviato da MGCoding ----

/**
 * Processo di ComfyUI avviato da MGCoding (se presente). Solo i processi avviati da qui
 * possono essere arrestati con `stopComfyUI` (Req 13.3).
 */
let managedProcess: ChildProcess | undefined;

/** Vero se MGCoding ha avviato (e sta gestendo) un processo ComfyUI attivo. */
export function isManagedProcessRunning(): boolean {
	return !!managedProcess && managedProcess.exitCode === null && !managedProcess.killed;
}

// ---- Tipi pubblici ----

/** Stato di disponibilità di ComfyUI. */
export type ComfyAvailability = 'available' | 'unavailable';

/** Esito del rilevamento dello stato di ComfyUI. */
export interface ComfyStatus {
	availability: ComfyAvailability;
	endpoint: string;
}

/** Esito di un avvio di ComfyUI. */
export interface StartResult {
	status: 'ready' | 'timeout' | 'cancelled' | 'no-folder' | 'no-python' | 'error';
	endpoint: string;
	/** Messaggio in linguaggio naturale (valorizzato per esiti non 'ready'). */
	detail?: string;
}

/** Elenchi resi disponibili quando ComfyUI è raggiungibile (Req 12.3). */
export interface ComfyLists {
	checkpoints: string[];
	loras: string[];
	nodes: string[];
}

// ---- Lettura configurazione ----

/** Endpoint ComfyUI configurato (normalizzato, senza slash finale). */
export function comfyEndpoint(): string {
	const ep = vscode.workspace.getConfiguration('mgcoding').get<string>(CFG_ENDPOINT, DEFAULT_COMFY_ENDPOINT);
	return (ep || DEFAULT_COMFY_ENDPOINT).replace(/\/$/, '');
}

/** Cartella di ComfyUI configurata (quella che contiene `models/`), o stringa vuota. */
export function comfyRoot(): string {
	return vscode.workspace.getConfiguration('mgcoding').get<string>(CFG_COMFY_ROOT, '').trim();
}

/**
 * Comando/launcher con cui avviare ComfyUI (es. il `.bat` portable dell'utente con i suoi flag
 * lowvram/sageattention). Se impostato, `startComfyUI` lo usa così MGCoding gestisce il processo
 * mantenendo i flag dell'utente. Vuoto = avvio con il Python embedded.
 */
export function comfyStartCommand(): string {
	return vscode.workspace.getConfiguration('mgcoding').get<string>(CFG_START_COMMAND, '').trim();
}

// ---- Rilevamento (Req 12.1, 12.2) ----

/**
 * Probe di raggiungibilità: `GET <endpoint>/system_stats` con timeout di 3s (Req 12.1).
 * Ritorna `true` se ComfyUI risponde con esito positivo entro il timeout.
 */
export async function probeComfy(endpoint: string = comfyEndpoint(), timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
	const ep = endpoint.replace(/\/$/, '');
	try {
		const res = await fetch(`${ep}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Rileva lo stato di ComfyUI sull'endpoint configurato/fornito entro 3s (Req 12.1).
 * Non interagisce con l'utente: la proposta di avvio è demandata a `proposeStartIfUnavailable`.
 */
export async function detectComfyStatus(endpoint: string = comfyEndpoint()): Promise<ComfyStatus> {
	const reachable = await probeComfy(endpoint);
	return { availability: reachable ? 'available' : 'unavailable', endpoint };
}

/**
 * Se ComfyUI non è raggiungibile, segnala lo stato non disponibile e PROPONE l'avvio (Req 12.2).
 * Se l'utente accetta, avvia ComfyUI (con conferma per l'azione rischiosa) e attende la readiness.
 * Ritorna lo stato finale: `available` se è raggiungibile (già attivo o avviato con successo).
 */
export async function proposeStartIfUnavailable(endpoint: string = comfyEndpoint()): Promise<ComfyStatus> {
	const status = await detectComfyStatus(endpoint);
	if (status.availability === 'available') {
		return status;
	}
	const pick = await vscode.window.showWarningMessage(
		`ComfyUI non è raggiungibile su ${status.endpoint}.`,
		'Avvia ComfyUI'
	);
	if (pick !== 'Avvia ComfyUI') {
		return status;
	}
	const result = await startComfyUI(endpoint);
	return { availability: result.status === 'ready' ? 'available' : 'unavailable', endpoint: result.endpoint };
}

// ---- Risoluzione dell'interprete Python embedded (Req 24.1) ----

/**
 * Individua la radice della distribuzione portable di ComfyUI che contiene
 * `python_embeded\python.exe` (Req 24.1), a partire dalla cartella ComfyUI configurata
 * (quella con `models/`). Prova: la cartella stessa, la sua cartella padre e la nonna
 * (copre i layout `ComfyUI_windows_portable\ComfyUI` e simili). Ritorna `undefined` se
 * l'interprete embedded non è trovato.
 */
export function resolveInstallRoot(comfyFolder: string): string | undefined {
	if (!comfyFolder) {
		return undefined;
	}
	const candidates = [comfyFolder, path.dirname(comfyFolder), path.dirname(path.dirname(comfyFolder))];
	for (const root of candidates) {
		if (!root) {
			continue;
		}
		const python = path.join(root, PYTHON_EMBEDED_DIR, PYTHON_EMBEDED_EXE);
		try {
			if (fs.existsSync(python)) {
				return root;
			}
		} catch {
			// ignora e prova il candidato successivo
		}
	}
	return undefined;
}

/** Estrae la porta dall'endpoint (default 8188 se non specificata o non valida). */
function portFromEndpoint(endpoint: string): number {
	try {
		const port = Number(new URL(endpoint).port);
		return Number.isInteger(port) && port > 0 ? port : 8188;
	} catch {
		return 8188;
	}
}

// ---- Avvio (Req 13.1, 13.2, 13.4, 13.5, 22.3, 24.1, 24.2) ----

/**
 * Avvia ComfyUI usando l'interprete Python embedded della distribuzione portable su Windows
 * (Req 13.1, 24.1, 24.2) e attende che l'endpoint risponda entro 120s (Req 13.2, 13.5).
 *
 * - Se la cartella di ComfyUI non è configurata, chiede all'utente di selezionarla (Req 13.4).
 * - Chiede conferma modale prima di avviare il processo esterno (Req 22.3).
 * - Riusa `buildWindowsLaunch` (logica pura) per comporre `python_embeded\python.exe -s ComfyUI\main.py`.
 *
 * @param endpoint Endpoint su cui attendere la readiness (default: quello configurato).
 * @param signal   Segnale opzionale per annullare l'attesa di readiness.
 */
export async function startComfyUI(endpoint: string = comfyEndpoint(), signal?: AbortSignal): Promise<StartResult> {
	const ep = endpoint.replace(/\/$/, '');

	// Già in esecuzione? Niente da fare.
	if (await probeComfy(ep)) {
		return { status: 'ready', endpoint: ep };
	}

	// 0) Comando/launcher personalizzato (es. il .bat dell'utente): se impostato, MGCoding lo
	// usa per avviare il processo MANTENENDO i flag dell'utente (lowvram/sageattention/...).
	const custom = comfyStartCommand();
	if (custom) {
		const okCustom = await vscode.window.showWarningMessage(
			'Avvio ComfyUI con il comando configurato?',
			{ modal: true, detail: custom },
			'Avvia'
		);
		if (okCustom !== 'Avvia') {
			return { status: 'cancelled', endpoint: ep, detail: 'Avvio annullato dall\'utente.' };
		}
		try {
			// `shell: true` consente di lanciare un .bat o una riga di comando completa.
			managedProcess = spawn(custom, { shell: true, cwd: comfyRoot() || undefined, windowsHide: false });
			managedProcess.on('exit', () => { managedProcess = undefined; });
		} catch (err) {
			managedProcess = undefined;
			return { status: 'error', endpoint: ep, detail: err instanceof Error ? err.message : String(err) };
		}
		const readyCustom = await waitForReadiness(ep, READINESS_TIMEOUT_MS, signal);
		return readyCustom
			? { status: 'ready', endpoint: ep }
			: { status: 'timeout', endpoint: ep, detail: `ComfyUI non ha risposto entro ${READINESS_TIMEOUT_MS / 1000}s dall'avvio.` };
	}

	// 1) Cartella di ComfyUI: se non configurata, chiedi all'utente di selezionarla (Req 13.4).
	let folder = comfyRoot();
	if (!folder) {
		const picked = await pickComfyFolder();
		if (!picked) {
			return { status: 'no-folder', endpoint: ep, detail: 'Cartella di ComfyUI non configurata.' };
		}
		folder = comfyRoot();
		if (!folder) {
			return { status: 'no-folder', endpoint: ep, detail: 'Cartella di ComfyUI non configurata.' };
		}
	}

	// 2) Individua l'interprete Python embedded (Req 24.1).
	const installRoot = resolveInstallRoot(folder);
	if (!installRoot) {
		return {
			status: 'no-python',
			endpoint: ep,
			detail: `Interprete Python embedded non trovato (atteso ${PYTHON_EMBEDED_DIR}\\${PYTHON_EMBEDED_EXE} sotto "${folder}" o nella cartella superiore).`
		};
	}

	// 3) Comando di avvio (logica pura riusata) con la porta dell'endpoint.
	const port = portFromEndpoint(ep);
	const launch = buildWindowsLaunch(installRoot, ['--port', String(port)]);

	// 4) Conferma esplicita prima di avviare un processo esterno (Req 22.3).
	const ok = await vscode.window.showWarningMessage(
		'Avvio ComfyUI come processo esterno?',
		{ modal: true, detail: `${launch.command} ${launch.args.join(' ')}\n(cartella: ${installRoot})` },
		'Avvia'
	);
	if (ok !== 'Avvia') {
		return { status: 'cancelled', endpoint: ep, detail: 'Avvio annullato dall\'utente.' };
	}

	// 5) Avvia il processo.
	try {
		managedProcess = spawn(launch.command, launch.args, { cwd: installRoot, windowsHide: false });
		managedProcess.on('exit', () => { managedProcess = undefined; });
	} catch (err) {
		managedProcess = undefined;
		return { status: 'error', endpoint: ep, detail: err instanceof Error ? err.message : String(err) };
	}

	// 6) Attendi la readiness (Req 13.2) con timeout di 120s (Req 13.5).
	const ready = await waitForReadiness(ep, READINESS_TIMEOUT_MS, signal);
	if (!ready) {
		return {
			status: 'timeout',
			endpoint: ep,
			detail: `ComfyUI non ha risposto entro ${READINESS_TIMEOUT_MS / 1000}s dall'avvio.`
		};
	}
	return { status: 'ready', endpoint: ep };
}

/**
 * Attende che l'Endpoint_ComfyUI risponda, riprovando il probe a intervalli regolari, fino a
 * `timeoutMs` (Req 13.2). Ritorna `true` se diventa raggiungibile entro il tempo, `false` se
 * scade il timeout (Req 13.5) o se l'attesa viene annullata.
 */
export async function waitForReadiness(
	endpoint: string = comfyEndpoint(),
	timeoutMs: number = READINESS_TIMEOUT_MS,
	signal?: AbortSignal
): Promise<boolean> {
	const ep = endpoint.replace(/\/$/, '');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) {
			return false;
		}
		if (await probeComfy(ep)) {
			return true;
		}
		// Pausa prima del prossimo tentativo (senza sforare la deadline inutilmente).
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			break;
		}
		await delay(Math.min(READINESS_POLL_INTERVAL_MS, remaining), signal);
	}
	// Ultimo tentativo allo scadere (copre il caso di readiness proprio sul limite).
	return probeComfy(ep);
}

/** Attesa cancellabile. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

// ---- Arresto (Req 13.3) ----

/**
 * Termina il processo di ComfyUI avviato da MGCoding (Req 13.3). Non agisce su processi
 * ComfyUI avviati esternamente all'estensione. Ritorna `true` se un processo gestito è stato
 * terminato.
 */
export async function stopComfyUI(): Promise<boolean> {
	const proc = managedProcess;
	if (!proc || proc.exitCode !== null || proc.killed) {
		managedProcess = undefined;
		return false;
	}
	// Su Windows termina l'intero albero del processo (taskkill /T) per chiudere anche i figli.
	if (process.platform === 'win32' && typeof proc.pid === 'number') {
		await new Promise<void>(resolve => {
			exec(`taskkill /pid ${proc.pid} /T /F`, () => resolve());
		});
	} else {
		proc.kill();
	}
	managedProcess = undefined;
	return true;
}

/**
 * Termina (best-effort, solo Windows) il processo in ascolto sulla porta indicata. Usato per
 * riavviare un'istanza di ComfyUI avviata FUORI da MGCoding (es. dal `.bat` dell'utente).
 */
async function killProcessOnPort(port: number): Promise<void> {
	if (process.platform !== 'win32') {
		return;
	}
	await new Promise<void>(resolve => {
		// netstat individua il PID in LISTENING sulla porta; taskkill ne termina l'albero.
		exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /T /PID %a`, () => resolve());
	});
}

/**
 * Riavvia ComfyUI:
 *  - se il processo è GESTITO da MGCoding → arresto pulito + riavvio;
 *  - se non è in esecuzione → equivale a un avvio;
 *  - se è in esecuzione ma avviato ESTERNAMENTE (es. dal `.bat` dell'utente) → con conferma
 *    termina il processo in ascolto sulla porta e lo riavvia, usando il comando configurato
 *    (`image.comfyStartCommand`) se presente — così mantiene i flag dell'utente — altrimenti
 *    con il Python embedded.
 */
export async function restartComfyUI(endpoint: string = comfyEndpoint(), signal?: AbortSignal): Promise<StartResult> {
	const ep = endpoint.replace(/\/$/, '');
	if (isManagedProcessRunning()) {
		await stopComfyUI();
		await delay(1500, signal);
		return startComfyUI(ep, signal);
	}
	if (!(await probeComfy(ep))) {
		return startComfyUI(ep, signal);
	}
	const custom = comfyStartCommand();
	const port = portFromEndpoint(ep);
	const ok = await vscode.window.showWarningMessage(
		`ComfyUI non è stato avviato da MGCoding. Per riavviarlo termino il processo sulla porta ${port} e lo riavvio.`,
		{
			modal: true,
			detail: custom
				? `Verrà riavviato con il comando configurato:\n${custom}`
				: 'Suggerimento: imposta "mgcoding.image.comfyStartCommand" con il tuo launcher (.bat) per mantenere i tuoi flag (lowvram/sageattention). Senza, sarà avviato con il Python embedded.'
		},
		'Riavvia'
	);
	if (ok !== 'Riavvia') {
		return { status: 'cancelled', endpoint: ep, detail: 'Riavvio annullato dall\'utente.' };
	}
	await killProcessOnPort(port);
	await delay(2000, signal);
	return startComfyUI(ep, signal);
}

// ---- Elenchi (Req 12.3) ----

/**
 * Elenca le `class_type` dei nodi installati in ComfyUI leggendo `/object_info`.
 * Ritorna un elenco vuoto se ComfyUI non è raggiungibile.
 */
export async function listInstalledNodes(endpoint: string = comfyEndpoint()): Promise<string[]> {
	const ep = endpoint.replace(/\/$/, '');
	try {
		const res = await fetch(`${ep}/object_info`, { signal: AbortSignal.timeout(25000) });
		if (!res.ok) {
			return [];
		}
		const info = await res.json() as Record<string, unknown>;
		return Object.keys(info);
	} catch {
		return [];
	}
}

/**
 * Rende disponibili gli elenchi di checkpoint, LoRA e nodi installati quando ComfyUI è
 * raggiungibile (Req 12.3). Se non è raggiungibile, ritorna elenchi vuoti.
 */
export async function comfyLists(endpoint: string = comfyEndpoint()): Promise<ComfyLists> {
	const ep = endpoint.replace(/\/$/, '');
	if (!(await probeComfy(ep))) {
		return { checkpoints: [], loras: [], nodes: [] };
	}
	const [checkpoints, loras, nodes] = await Promise.all([
		listCheckpoints(ep),
		listLoras(ep),
		listInstalledNodes(ep),
	]);
	return { checkpoints, loras, nodes };
}

// ============================================================================================
//  Installazione di ComfyUI e di ComfyUI-Manager (Req 14.1, 14.2, 14.3, 14.4, 22.3)
//
//  Tutte le azioni di rete/installazione sono dietro CONFERMA ESPLICITA (modale) e mostrano
//  l'avanzamento con `withProgress`. In caso di errore si riporta la causa in linguaggio
//  naturale e si lascia il sistema in uno stato utilizzabile (nessuna eccezione propagata).
// ============================================================================================

/** Repository ufficiale di ComfyUI (clone --depth 1). */
const COMFYUI_REPO = 'https://github.com/comfyanonymous/ComfyUI.git';
/** Repository ufficiale di ComfyUI-Manager. */
const COMFY_MANAGER_REPO = 'https://github.com/ltdrdata/ComfyUI-Manager.git';
/** Pagina delle release ufficiali (per il pacchetto portable Windows). */
const COMFY_RELEASES_URL = 'https://github.com/comfyanonymous/ComfyUI/releases';

/** Esito dell'installazione di ComfyUI. */
export interface InstallResult {
	status: 'installed' | 'already-present' | 'cancelled' | 'failed' | 'no-git' | 'no-location';
	/** Cartella di ComfyUI configurata (quella che contiene `models/`), se disponibile. */
	root?: string;
	/** Messaggio in linguaggio naturale (valorizzato per esiti non 'installed'). */
	detail?: string;
}

/** Esito dell'installazione di ComfyUI-Manager. */
export interface ManagerInstallResult {
	status: 'installed' | 'already-present' | 'cancelled' | 'failed' | 'no-git' | 'no-comfyui';
	/** Cartella di destinazione di ComfyUI-Manager (sotto `custom_nodes/`), se disponibile. */
	managerDir?: string;
	/** Messaggio in linguaggio naturale (valorizzato per esiti non 'installed'). */
	detail?: string;
}

/** Vero se `git` è disponibile nel PATH (necessario per clonare i repository). */
async function isGitAvailable(): Promise<boolean> {
	try {
		await execAsync('git --version', { timeout: 15000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Vero se ComfyUI risulta installato nella cartella indicata (presenza di `main.py` o `models/`).
 * Usa la cartella configurata se non ne viene passata una.
 */
export function isComfyUIInstalled(root: string = comfyRoot()): boolean {
	if (!root) {
		return false;
	}
	try {
		return fs.existsSync(path.join(root, 'main.py')) || fs.existsSync(path.join(root, 'models'));
	} catch {
		return false;
	}
}

/** Cartella attesa di ComfyUI-Manager (`<root>/custom_nodes/ComfyUI-Manager`), o `undefined`. */
export function comfyManagerDir(root: string = comfyRoot()): string | undefined {
	if (!root) {
		return undefined;
	}
	return path.join(root, 'custom_nodes', 'ComfyUI-Manager');
}

/** Vero se ComfyUI-Manager è già clonato sotto `custom_nodes/`. */
export function isComfyManagerInstalled(root: string = comfyRoot()): boolean {
	const dir = comfyManagerDir(root);
	if (!dir) {
		return false;
	}
	try {
		return fs.existsSync(dir);
	} catch {
		return false;
	}
}

/**
 * Installa ComfyUI quando non è presente (Req 14.1). Chiede SEMPRE conferma esplicita prima di
 * scaricare/installare (Req 14.1, 22.3). Su conferma installa ComfyUI e ne configura la cartella
 * in MGCoding (Req 14.2), quindi propone l'installazione di ComfyUI-Manager (Req 14.3). In caso
 * di fallimento riporta la causa e lascia il sistema utilizzabile, senza lanciare (Req 14.4).
 *
 * Metodi offerti: clone del repository ufficiale (automatico, richiede `git`) oppure download
 * guidato del pacchetto portable Windows (apre la pagina release e poi configura la cartella).
 */
export async function installComfyUI(endpoint: string = comfyEndpoint()): Promise<InstallResult> {
	// Già presente (configurato o raggiungibile)? Non reinstallare; semmai proponi il Manager.
	if (isComfyUIInstalled() || await probeComfy(endpoint)) {
		await maybeProposeComfyManager();
		return { status: 'already-present', root: comfyRoot() || undefined, detail: 'ComfyUI risulta già presente o configurato.' };
	}

	// Conferma esplicita prima di scaricare/installare (Req 14.1, 22.3).
	const CLONE = 'Clona da GitHub';
	const PORTABLE = 'Scarica release portable';
	const choice = await vscode.window.showWarningMessage(
		'Installo ComfyUI? Verranno scaricati e installati componenti di terzi.',
		{
			modal: true,
			detail:
				`"${CLONE}": clona ${COMFYUI_REPO} (richiede git nel PATH).\n` +
				`"${PORTABLE}": apre la pagina release di ComfyUI per scaricare il pacchetto portable Windows e poi ne configura la cartella.`
		},
		CLONE, PORTABLE
	);
	if (choice !== CLONE && choice !== PORTABLE) {
		return { status: 'cancelled', detail: 'Installazione annullata dall\'utente.' };
	}
	if (choice === PORTABLE) {
		return installComfyUIPortableGuided();
	}

	// --- Metodo: clone del repository ufficiale ---
	if (!(await isGitAvailable())) {
		const detail = 'git non è disponibile nel PATH: impossibile clonare ComfyUI. Installa git oppure scegli il pacchetto portable.';
		vscode.window.showErrorMessage(detail);
		return { status: 'no-git', detail };
	}

	const sel = await vscode.window.showOpenDialog({
		canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		title: 'Seleziona la cartella in cui installare ComfyUI', openLabel: 'Installa qui'
	});
	if (!sel?.length) {
		return { status: 'no-location', detail: 'Nessuna cartella di installazione selezionata.' };
	}
	const dest = path.join(sel[0].fsPath, 'ComfyUI');

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Installo ComfyUI', cancellable: false },
			async progress => {
				progress.report({ message: 'clono il repository…' });
				if (fs.existsSync(dest)) {
					await execAsync(`git -C "${dest}" pull`, { timeout: 300000 });
				} else {
					await execAsync(`git clone --depth 1 "${COMFYUI_REPO}" "${dest}"`, { timeout: 600000 });
				}
				// Se è presente un interprete Python embedded (layout portable), installa i requirements.
				const installRoot = resolveInstallRoot(dest);
				const embeddedPy = installRoot ? path.join(installRoot, PYTHON_EMBEDED_DIR, PYTHON_EMBEDED_EXE) : undefined;
				const reqs = path.join(dest, 'requirements.txt');
				if (embeddedPy && fs.existsSync(embeddedPy) && fs.existsSync(reqs)) {
					progress.report({ message: 'installo le dipendenze Python…' });
					await execAsync(`"${embeddedPy}" -m pip install -r "${reqs}"`, { timeout: 1800000 });
				}
			}
		);
	} catch (err) {
		// Fallimento: riporta la causa e lascia il sistema utilizzabile (Req 14.4). Non rilanciare.
		const detail = `Installazione di ComfyUI non riuscita: ${err instanceof Error ? err.message : String(err)}`;
		vscode.window.showErrorMessage(detail);
		return { status: 'failed', detail };
	}

	// Configura la cartella di ComfyUI in MGCoding (Req 14.2).
	await vscode.workspace.getConfiguration('mgcoding').update(CFG_COMFY_ROOT, dest, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(
		`ComfyUI installato in "${dest}" e configurato. Potrebbe essere necessario installarne le dipendenze Python prima dell'avvio.`
	);

	// Proponi ComfyUI-Manager (Req 14.3).
	await maybeProposeComfyManager(dest);
	return { status: 'installed', root: dest };
}

/**
 * Percorso guidato per il pacchetto portable Windows: apre la pagina delle release ufficiali,
 * poi chiede all'utente di selezionare la cartella estratta per configurarla in MGCoding.
 */
async function installComfyUIPortableGuided(): Promise<InstallResult> {
	await vscode.env.openExternal(vscode.Uri.parse(COMFY_RELEASES_URL));
	const SELECT = 'Seleziona cartella';
	const pick = await vscode.window.showInformationMessage(
		'Ho aperto la pagina delle release di ComfyUI. Scarica ed estrai il pacchetto portable, poi seleziona la cartella estratta per configurarla.',
		SELECT
	);
	if (pick !== SELECT) {
		return { status: 'cancelled', detail: 'Configurazione del pacchetto portable annullata.' };
	}
	const ok = await pickComfyFolder();
	if (!ok) {
		return { status: 'cancelled', detail: 'Cartella di ComfyUI non configurata.' };
	}
	const root = comfyRoot();
	await maybeProposeComfyManager(root);
	return { status: 'installed', root: root || undefined };
}

/**
 * Se ComfyUI è presente ma ComfyUI-Manager è assente, propone di installarlo (Req 14.3).
 * Non fa nulla se la cartella non è nota o se il Manager è già installato.
 */
async function maybeProposeComfyManager(root: string = comfyRoot()): Promise<void> {
	if (!root || isComfyManagerInstalled(root)) {
		return;
	}
	const INSTALL = 'Installa ComfyUI-Manager';
	const pick = await vscode.window.showInformationMessage(
		'ComfyUI-Manager non risulta installato. Vuoi installarlo? Semplifica la gestione di nodi e modelli.',
		INSTALL
	);
	if (pick === INSTALL) {
		await installComfyManager(root);
	}
}

/**
 * Installa ComfyUI-Manager clonandolo in `custom_nodes/` (Req 14.3). Chiede conferma esplicita
 * prima di clonare codice di terzi (Req 22.3). In caso di fallimento riporta la causa e lascia il
 * sistema utilizzabile, senza lanciare (Req 14.4).
 */
export async function installComfyManager(root: string = comfyRoot()): Promise<ManagerInstallResult> {
	if (!root || !isComfyUIInstalled(root)) {
		const detail = 'ComfyUI non è installato o configurato: imposta prima la cartella di ComfyUI.';
		vscode.window.showWarningMessage(detail);
		return { status: 'no-comfyui', detail };
	}
	const managerDir = comfyManagerDir(root)!;
	if (isComfyManagerInstalled(root)) {
		return { status: 'already-present', managerDir, detail: 'ComfyUI-Manager è già installato.' };
	}

	// Conferma esplicita prima di clonare codice di terzi / avviare un'installazione (Req 22.3).
	const INSTALL = 'Installa';
	const ok = await vscode.window.showWarningMessage(
		'Installo ComfyUI-Manager? Verrà clonato da GitHub in custom_nodes/ (codice di terzi).',
		{ modal: true, detail: `${COMFY_MANAGER_REPO}\n→ ${managerDir}` },
		INSTALL
	);
	if (ok !== INSTALL) {
		return { status: 'cancelled', detail: 'Installazione di ComfyUI-Manager annullata dall\'utente.' };
	}

	if (!(await isGitAvailable())) {
		const detail = 'git non è disponibile nel PATH: impossibile clonare ComfyUI-Manager.';
		vscode.window.showErrorMessage(detail);
		return { status: 'no-git', detail };
	}

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Installo ComfyUI-Manager', cancellable: false },
			async () => {
				const customNodes = path.join(root, 'custom_nodes');
				await fs.promises.mkdir(customNodes, { recursive: true });
				await execAsync(`git clone --depth 1 "${COMFY_MANAGER_REPO}" "${managerDir}"`, { timeout: 300000 });
			}
		);
	} catch (err) {
		// Fallimento: riporta la causa e lascia il sistema utilizzabile (Req 14.4). Non rilanciare.
		const detail = `Installazione di ComfyUI-Manager non riuscita: ${err instanceof Error ? err.message : String(err)}`;
		vscode.window.showErrorMessage(detail);
		return { status: 'failed', detail };
	}

	vscode.window.showInformationMessage('ComfyUI-Manager installato in custom_nodes/. RIAVVIA ComfyUI per caricarlo.');
	return { status: 'installed', managerDir };
}
