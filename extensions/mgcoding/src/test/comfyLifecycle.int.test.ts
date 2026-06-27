/*---------------------------------------------------------------------------------------------
 *  MGCoding - Integration test del CICLO DI VITA di ComfyUI (`media/comfyLifecycle.ts`).
 *
 *  È un test di INTEGRAZIONE basato su ESEMPI (non property-based): l'adapter usa `vscode`,
 *  `fetch`, `child_process` e `fs`, perciò questi vengono iniettati con dei mock deterministici.
 *
 *  Strategia di iniezione (eseguita PRIMA di caricare il modulo sotto test):
 *   - `./vscodeStub` viene importato per PRIMO (pattern riusabile dell'estensione): intercetta
 *     `require('vscode')`. Poi qui sovrascriviamo l'intercettazione con un mock di `vscode` più
 *     ricco (le sole API effettivamente usate dall'adapter), SENZA modificare `vscodeStub.ts`.
 *   - `require('child_process')` viene intercettato per fornire `spawn`/`exec` mock.
 *   - `globalThis.fetch` viene sostituito per simulare la raggiungibilità dell'endpoint.
 *   - `fs.existsSync` viene reindirizzato a un set di percorsi "esistenti" controllato dal test.
 *
 *  Verifica: probe, attesa di readiness (true rapido / false su abort), avvio/arresto del
 *  processo, installazione; assert dei timeout (3s probe, 120s readiness) e che le azioni
 *  rischiose (avvio/installazione) richiedono SEMPRE una conferma esplicita.
 *
 *  Eseguibile con: node out/test/comfyLifecycle.int.test.js
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */

import './vscodeStub';
import * as assert from 'assert';
import * as path from 'path';
import Module = require('module');

// ============================================================================================
//  Stato controllabile dai test
// ============================================================================================

/** Modalità della `fetch` mock: 'up' = 200 ok, 'down' = 502 non-ok, 'error' = eccezione. */
let fetchMode: 'up' | 'down' | 'error' = 'down';
/** Registrazione delle chiamate a `fetch` (per verificare URL e signal del timeout). */
const fetchCalls: { url: string; signal: unknown }[] = [];

/** Set di percorsi che `fs.existsSync` mock considera esistenti. */
let fakeExisting = new Set<string>();

/** Registrazione delle chiamate a `spawn` (comando + argomenti). */
let spawnCalls: { command: string; args: string[] }[] = [];
/** Registrazione dei comandi passati a `exec` (git/taskkill...). */
let execCalls: string[] = [];

/** Decisione per `showWarningMessage`: ritorna la voce scelta (o undefined = chiuso). */
let warnDecision: (message: string, items: string[]) => string | undefined = () => undefined;
/** Decisione per `showInformationMessage`. */
let infoDecision: (message: string, items: string[]) => string | undefined = () => undefined;
/** Risultato di `showOpenDialog` (lista di Uri-like o undefined). */
let openDialogResult: { fsPath: string }[] | undefined = undefined;

/** Messaggi mostrati, per le asserzioni sulle conferme. */
const warnCalls: string[] = [];
const infoCalls: string[] = [];
const errorCalls: string[] = [];

/** Store di configurazione di `vscode.workspace.getConfiguration('mgcoding')`. */
let configStore: Record<string, unknown> = {};

function resetMocks(): void {
	fetchMode = 'down';
	fetchCalls.length = 0;
	fakeExisting = new Set<string>();
	spawnCalls = [];
	execCalls = [];
	warnDecision = () => undefined;
	infoDecision = () => undefined;
	openDialogResult = undefined;
	warnCalls.length = 0;
	infoCalls.length = 0;
	errorCalls.length = 0;
	configStore = {};
}

// ============================================================================================
//  Mock di `vscode` (solo le API usate dall'adapter; il resto è uno stub profondo per il load)
// ============================================================================================

function deepStub(): any {
	const fn = function (): any { return undefined; };
	return new Proxy(fn, {
		get(_t, prop) {
			if (prop === 'then') { return undefined; }
			return deepStub();
		},
		apply() { return undefined; },
		construct() { return {}; },
	});
}

const vscodeExplicit: any = {
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: (_section: string) => ({
			get: (key: string, def?: unknown) => (key in configStore ? configStore[key] : def),
			update: async (key: string, value: unknown) => { configStore[key] = value; },
		}),
	},
	window: {
		showWarningMessage: (message: string, a?: unknown, b?: unknown, c?: unknown) => {
			const items = [a, b, c].filter((x): x is string => typeof x === 'string');
			warnCalls.push(message);
			return Promise.resolve(warnDecision(message, items));
		},
		showInformationMessage: (message: string, a?: unknown, b?: unknown, c?: unknown) => {
			const items = [a, b, c].filter((x): x is string => typeof x === 'string');
			infoCalls.push(message);
			return Promise.resolve(infoDecision(message, items));
		},
		showErrorMessage: (message: string) => { errorCalls.push(message); return Promise.resolve(undefined); },
		showOpenDialog: async () => openDialogResult,
		withProgress: async (_opts: unknown, task: (p: any, t: any) => any) =>
			task({ report: () => { /* noop */ } }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { /* noop */ } }) }),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
		parse: (s: string) => ({ toString: () => s }),
		joinPath: (u: any, ...segs: string[]) => ({ fsPath: [u?.fsPath, ...segs].join('/') }),
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	env: { openExternal: async () => true },
};

const vscodeMock: any = new Proxy(vscodeExplicit, {
	get(target, prop) {
		if (prop in target) { return (target as any)[prop]; }
		if (prop === 'then') { return undefined; }
		return deepStub();
	},
});

// ============================================================================================
//  Mock di `child_process`
// ============================================================================================

function makeFakeChild(): any {
	const listeners: Record<string, ((...a: any[]) => void)[]> = {};
	return {
		pid: 4242,
		exitCode: null as number | null,
		killed: false,
		on(evt: string, cb: (...a: any[]) => void) { (listeners[evt] = listeners[evt] || []).push(cb); return this; },
		kill() { this.killed = true; this.exitCode = 0; return true; },
	};
}

const childProcessMock: any = {
	spawn: (command: string, args: string[]) => {
		spawnCalls.push({ command, args: args || [] });
		// Simula che il processo, una volta avviato, renda l'endpoint raggiungibile.
		fetchMode = 'up';
		return makeFakeChild();
	},
	exec: (cmd: string, optsOrCb?: unknown, maybeCb?: unknown) => {
		execCalls.push(cmd);
		const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
			| ((err: unknown, stdout: string, stderr: string) => void)
			| undefined;
		if (cb) { process.nextTick(() => cb(null, '', '')); }
		return makeFakeChild();
	},
	ChildProcess: class { },
};

// ============================================================================================
//  Installazione delle intercettazioni PRIMA di caricare il modulo sotto test
// ============================================================================================

const M = Module as any;
const prevLoad = M._load; // già patchato da vscodeStub (vscode -> {})

// Wrapper di `fs` con `existsSync` reindirizzato al set controllato dal test. Su Node recenti
// `fs.existsSync` è una proprietà con solo getter, perciò non si può sovrascrivere in place:
// intercettiamo `require('fs')` e restituiamo un oggetto che eredita il resto del modulo reale.
const realFs: any = prevLoad.apply(Module, ['fs', module, false]);
const fsWrap: any = Object.create(realFs);
fsWrap.existsSync = (p: unknown) => fakeExisting.has(String(p));

M._load = function (request: string, ...rest: unknown[]): unknown {
	if (request === 'vscode') { return vscodeMock; }
	if (request === 'child_process') { return childProcessMock; }
	if (request === 'fs') { return fsWrap; }
	return prevLoad.apply(this, [request, ...rest]);
};

// fetch globale
(globalThis as any).fetch = async (url: unknown, opts?: any) => {
	fetchCalls.push({ url: String(url), signal: opts?.signal });
	if (fetchMode === 'error') { throw new Error('ECONNREFUSED'); }
	if (fetchMode === 'down') { return { ok: false, status: 502, json: async () => ({}) } as any; }
	return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
};

// Carica il modulo sotto test DOPO aver installato i mock.
const lifecycle = require('../media/comfyLifecycle') as typeof import('../media/comfyLifecycle');

// ============================================================================================
//  Harness di test (stile parsing.test.ts, ma asincrono)
// ============================================================================================

let passed = 0;
let failed = 0;
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }); }

const EP = 'http://127.0.0.1:8188';

// ---- Costanti di timeout (Req 12.1, 13.2, 13.5) ----

test('le costanti di timeout sono 3s (probe) e 120s (readiness)', () => {
	assert.strictEqual(lifecycle.PROBE_TIMEOUT_MS, 3000);
	assert.strictEqual(lifecycle.READINESS_TIMEOUT_MS, 120000);
});

// ---- Probe (Req 12.1) ----

test('probeComfy: true quando l\'endpoint risponde ok, con GET /system_stats e signal di timeout', async () => {
	resetMocks();
	fetchMode = 'up';
	const ok = await lifecycle.probeComfy(EP);
	assert.strictEqual(ok, true);
	const last = fetchCalls[fetchCalls.length - 1];
	assert.ok(last.url.endsWith('/system_stats'), `URL atteso .../system_stats, ricevuto ${last.url}`);
	assert.ok(last.signal instanceof AbortSignal, 'il probe deve passare un AbortSignal (timeout 3s)');
});

test('probeComfy: false su risposta non-ok e su errore di rete', async () => {
	resetMocks();
	fetchMode = 'down';
	assert.strictEqual(await lifecycle.probeComfy(EP), false);
	fetchMode = 'error';
	assert.strictEqual(await lifecycle.probeComfy(EP), false);
});

// ---- Rilevamento stato (Req 12.2) ----

test('detectComfyStatus: available/unavailable secondo il probe', async () => {
	resetMocks();
	fetchMode = 'up';
	assert.deepStrictEqual(await lifecycle.detectComfyStatus(EP), { availability: 'available', endpoint: EP });
	fetchMode = 'down';
	assert.deepStrictEqual(await lifecycle.detectComfyStatus(EP), { availability: 'unavailable', endpoint: EP });
});

// ---- Attesa readiness (Req 13.2, 13.5) ----

test('waitForReadiness: risolve true rapidamente quando il probe risponde ok', async () => {
	resetMocks();
	fetchMode = 'up';
	const t0 = Date.now();
	const ready = await lifecycle.waitForReadiness(EP, lifecycle.READINESS_TIMEOUT_MS);
	assert.strictEqual(ready, true);
	// Deve risolvere SUBITO, senza avvicinarsi ai 120s.
	assert.ok(Date.now() - t0 < 2000, 'readiness deve risolvere immediatamente quando ComfyUI risponde');
});

test('waitForReadiness: ritorna false (rapidamente) se l\'attesa viene annullata', async () => {
	resetMocks();
	fetchMode = 'down';
	const t0 = Date.now();
	const ready = await lifecycle.waitForReadiness(EP, lifecycle.READINESS_TIMEOUT_MS, AbortSignal.abort());
	assert.strictEqual(ready, false);
	assert.ok(Date.now() - t0 < 2000, 'su abort la readiness deve terminare subito (non attende il timeout)');
});

// ---- Avvio (Req 13.1, 13.2, 22.3) e arresto (Req 13.3) ----

test('startComfyUI: ritorna ready senza avviare processi se ComfyUI è già raggiungibile', async () => {
	resetMocks();
	fetchMode = 'up';
	const res = await lifecycle.startComfyUI(EP);
	assert.strictEqual(res.status, 'ready');
	assert.strictEqual(spawnCalls.length, 0, 'non deve avviare un processo se ComfyUI risponde già');
});

test('startComfyUI: richiede conferma; se l\'utente rifiuta NON avvia il processo (cancelled)', async () => {
	resetMocks();
	fetchMode = 'down';
	configStore['image.comfyRoot'] = 'C:\\Comfy\\ComfyUI';
	fakeExisting.add(path.join('C:\\Comfy\\ComfyUI', 'python_embeded', 'python.exe'));
	warnDecision = () => undefined; // utente chiude il dialogo di conferma
	const res = await lifecycle.startComfyUI(EP);
	assert.strictEqual(res.status, 'cancelled');
	assert.strictEqual(spawnCalls.length, 0, 'senza conferma non si deve avviare alcun processo');
	assert.ok(warnCalls.some(m => /Avvio ComfyUI come processo esterno/i.test(m)), 'deve essere mostrata una conferma di avvio');
});

test('startComfyUI: con conferma avvia col Python embedded e attende la readiness (ready)', async () => {
	resetMocks();
	fetchMode = 'down';
	configStore['image.comfyRoot'] = 'C:\\Comfy\\ComfyUI';
	fakeExisting.add(path.join('C:\\Comfy\\ComfyUI', 'python_embeded', 'python.exe'));
	warnDecision = (_m, items) => (items.includes('Avvia') ? 'Avvia' : undefined);
	const res = await lifecycle.startComfyUI(EP);
	assert.strictEqual(res.status, 'ready');
	assert.strictEqual(spawnCalls.length, 1, 'deve avviare esattamente un processo');
	const expectedCmd = path.join('C:\\Comfy\\ComfyUI', 'python_embeded', 'python.exe');
	assert.strictEqual(spawnCalls[0].command, expectedCmd);
	assert.strictEqual(spawnCalls[0].args[0], '-s', 'il launcher portable usa -s');
	assert.ok(spawnCalls[0].args.includes('--port'), 'deve passare la porta dell\'endpoint');
	assert.ok(spawnCalls[0].args.includes('8188'));
	assert.strictEqual(lifecycle.isManagedProcessRunning(), true, 'il processo avviato deve risultare gestito');
});

test('stopComfyUI: termina il processo avviato da MGCoding', async () => {
	// Dipende dallo stato lasciato dal test precedente (processo gestito attivo).
	const stopped = await lifecycle.stopComfyUI();
	assert.strictEqual(stopped, true);
	assert.strictEqual(lifecycle.isManagedProcessRunning(), false);
	if (process.platform === 'win32') {
		assert.ok(execCalls.some(c => /taskkill/i.test(c)), 'su Windows deve usare taskkill per terminare l\'albero');
	}
});

test('stopComfyUI: ritorna false se non c\'è alcun processo gestito', async () => {
	const stopped = await lifecycle.stopComfyUI();
	assert.strictEqual(stopped, false);
});

// ---- Installazione (Req 14.1, 14.4, 22.3): la conferma è obbligatoria ----

test('installComfyUI: richiede conferma; se l\'utente rifiuta NON scarica nulla (cancelled)', async () => {
	resetMocks();
	fetchMode = 'down';            // ComfyUI non raggiungibile
	configStore['image.comfyRoot'] = ''; // non installato/non configurato
	warnDecision = () => undefined;       // utente rifiuta l'installazione
	const res = await lifecycle.installComfyUI(EP);
	assert.strictEqual(res.status, 'cancelled');
	assert.ok(warnCalls.some(m => /Installo ComfyUI/i.test(m)), 'deve chiedere conferma prima di installare');
	assert.ok(!execCalls.some(c => /git clone/i.test(c)), 'senza conferma non deve clonare nulla');
	assert.strictEqual(spawnCalls.length, 0);
});

test('installComfyManager: senza ComfyUI installato ritorna no-comfyui (nessuna clonazione)', async () => {
	resetMocks();
	const res = await lifecycle.installComfyManager('');
	assert.strictEqual(res.status, 'no-comfyui');
	assert.ok(!execCalls.some(c => /git clone/i.test(c)));
});

test('installComfyManager: con ComfyUI presente richiede conferma per il codice di terzi (cancelled)', async () => {
	resetMocks();
	const root = 'C:\\Comfy\\ComfyUI';
	fakeExisting.add(path.join(root, 'main.py')); // ComfyUI risulta installato
	warnDecision = () => undefined;                // utente rifiuta la clonazione
	const res = await lifecycle.installComfyManager(root);
	assert.strictEqual(res.status, 'cancelled');
	assert.ok(warnCalls.some(m => /ComfyUI-Manager/i.test(m)), 'deve chiedere conferma prima di clonare codice di terzi');
	assert.ok(!execCalls.some(c => /git clone/i.test(c)), 'senza conferma non deve clonare nulla');
});

// ============================================================================================
//  Esecuzione
// ============================================================================================

(async () => {
	for (const t of tests) {
		try {
			await t.fn();
			passed++;
			console.log(`ok   - ${t.name}`);
		} catch (e) {
			failed++;
			console.error(`FAIL - ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
})();
