/*---------------------------------------------------------------------------------------------
 *  MGCoding - Integration test per due garanzie del cablaggio I/O (Requisiti 9.1 e 11.5):
 *
 *   (1) Ollama irraggiungibile (Req. 9.1): quando il server locale non risponde all'endpoint
 *       configurato, ogni metodo del provider che effettua una POST a `/api/chat` (`stream`,
 *       `chatStructured`, `streamAgent`) deve fallire con un `LLMError` di categoria
 *       `unreachable` il cui messaggio CITA l'endpoint configurato. Si simula la rete giù
 *       sostituendo `globalThis.fetch` con un mock che rigetta sempre (errore di rete).
 *
 *   (2) Esecuzione shell su Windows (Req. 11.5): su `win32` il tool `run_command` deve far
 *       passare i comandi per `cmd` (ComSpec). Poiché l'host di test può non essere Windows,
 *       si forza `process.platform = 'win32'` e si popola `process.env.ComSpec` PRIMA di
 *       caricare `agent/tools.ts` (la shell è risolta a load-time), poi si intercetta
 *       `require('child_process')` per CATTURARE l'opzione `shell` passata a `exec`/`spawn`.
 *       Si verifica che sia il percorso sincrono (`execAsync`) sia il percorso in background
 *       (`spawn`) ricevano la shell `cmd` di Windows. Nessun comando reale viene eseguito.
 *
 *  Lo stub di `vscode` è importato PRIMA del modulo sotto test; `vscodeMock` viene popolato
 *  con il minimo necessario (workspace, window, EventEmitter, ...). `child_process` è
 *  intercettato con un mock deterministico che registra le opzioni ma non lancia processi.
 *
 *  Eseguibile con: node out/test/ollamaUnreachableWinShell.int.test.js
 *  _Requirements: 9.1, 11.5_
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lo stub di `vscode` DEVE precedere il caricamento dei moduli sotto test: intercetta
// `require('vscode')` e restituisce il riferimento condiviso `vscodeMock`, che popoliamo qui.
import { vscodeMock } from './vscodeStub';
import Module = require('module');
import * as util from 'util';
import * as assert from 'assert';
import type { AgentStreamParams, LLMRequest } from '../llm/types';

// ============================================================================================
//  Stato controllabile dai test
// ============================================================================================

/** Endpoint Ollama configurato (citato nel messaggio d'errore atteso). */
const EP = 'http://127.0.0.1:11434';
const MODEL = 'test-model';
/** Valore di ComSpec usato come shell `cmd` di Windows (Req. 11.5). */
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

/** Opzioni dell'ultima chiamata a `child_process.exec` (percorso sincrono di run_command). */
let lastExecOptions: any;
/** Opzioni dell'ultima chiamata a `child_process.spawn` (percorso background di run_command). */
let lastSpawnOptions: any;

// ============================================================================================
//  Mock di `child_process` (cattura l'opzione `shell`, non lancia processi reali)
// ============================================================================================

/**
 * `exec` simulato: registra le opzioni e restituisce un output fittizio. Espone il simbolo
 * `util.promisify.custom` perché `agent/tools.ts` usa `promisify(exec)` a load-time.
 */
function mockExec(_command: string, options: any, callback?: any): any {
	if (typeof options === 'function') {
		callback = options;
		options = undefined;
	}
	lastExecOptions = options;
	if (callback) {
		callback(null, 'stdout fittizio', '');
	}
	return {};
}
(mockExec as any)[util.promisify.custom] = (_command: string, options: any) => {
	lastExecOptions = options;
	return Promise.resolve({ stdout: 'stdout fittizio', stderr: '' });
};

/** `spawn` simulato: registra le opzioni e restituisce un child che termina subito. */
function mockSpawn(_command: string, options: any): any {
	lastSpawnOptions = options;
	return {
		stdout: { on: () => { /* no-op */ } },
		stderr: { on: () => { /* no-op */ } },
		// L'evento `close` arriva subito così `waitInitialOutput` non attende il timeout.
		on: (ev: string, cb: (code: number) => void) => { if (ev === 'close') { setImmediate(() => cb(0)); } },
		kill: () => { /* no-op */ }
	};
}

// Si parte dal modulo reale e si sovrascrivono SOLO `exec` e `spawn`: gli altri export
// (es. `execFile`, usato da altri moduli con `promisify` a load-time) restano funzionanti.
const realChildProcess = require('child_process');
const cpMock = { ...realChildProcess, exec: mockExec, spawn: mockSpawn };

// Intercetta `require('child_process')` delegando il resto allo stub già installato (vscode).
const M = Module as any;
const prevLoad = M._load;
M._load = function (request: string, ...args: unknown[]): unknown {
	if (request === 'child_process') {
		return cpMock;
	}
	return prevLoad.apply(this, [request, ...args]);
};

// ============================================================================================
//  Forza l'ambiente Windows PRIMA di caricare `agent/tools.ts` (la shell è risolta a load-time)
// ============================================================================================

process.env.ComSpec = COMSPEC;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

// ============================================================================================
//  Mock di `vscode` (minimo per run_command: workspace, window, EventEmitter)
// ============================================================================================

class EventEmitterMock<T> {
	event = (_listener: (e: T) => void) => ({ dispose: () => { /* no-op */ } });
	fire(_data: T): void { /* no-op */ }
	dispose(): void { /* no-op */ }
}

Object.assign(vscodeMock, {
	EventEmitter: EventEmitterMock,
	FileType: { File: 1, Directory: 2 },
	DiagnosticSeverity: { Error: 0, Warning: 1 },
	workspace: {
		workspaceFolders: [{ uri: { fsPath: 'C:\\fake\\ws' } }],
		// autoApprove=true → run_command non chiede conferma e procede all'esecuzione.
		getConfiguration: () => ({ get: (key: string, def?: unknown) => (key === 'autoApprove' ? true : def) })
	},
	window: {
		createTerminal: () => ({ show: () => { /* no-op */ }, dispose: () => { /* no-op */ } }),
		showWarningMessage: async () => 'Esegui'
	},
	Uri: {
		joinPath: (...parts: any[]) => ({ fsPath: parts.map(p => (typeof p === 'string' ? p : p.fsPath)).join('\\') })
	}
});

// ============================================================================================
//  Mock di `fetch`: simula Ollama irraggiungibile (errore di rete su ogni richiesta)
// ============================================================================================

(globalThis as any).fetch = async (_url: unknown, _opts?: any): Promise<any> => {
	throw new TypeError('fetch failed: ECONNREFUSED (mock rete giù)');
};

// Carica i moduli sotto test DOPO aver installato tutti i mock e forzato win32.
const { OllamaProvider } = require('../llm/ollamaProvider') as typeof import('../llm/ollamaProvider');
const { LLMError } = require('../llm/types') as typeof import('../llm/types');
const tools = require('../agent/tools') as typeof import('../agent/tools');

// ============================================================================================
//  Harness di test (stile *.int.test.ts: asincrono)
// ============================================================================================

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
	}
}

/** Consuma un AsyncIterable fino in fondo (scarta i valori). */
async function drain<T>(it: AsyncIterable<T>): Promise<void> {
	for await (const _ of it) { /* noop */ }
}

/** Crea un OllamaProvider che punta all'endpoint configurato. */
function makeProvider(): InstanceType<typeof OllamaProvider> {
	return new OllamaProvider(() => ({ endpoint: EP, model: MODEL, temperature: 0.2 }));
}

/** Cattura l'errore lanciato da una promise (o undefined se non lancia). */
async function captureError(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
		return undefined;
	} catch (e) {
		return e;
	}
}

/** Asserzioni comuni: l'errore è un LLMError `unreachable` che cita l'endpoint (Req. 9.1). */
function assertUnreachableCitingEndpoint(err: unknown): void {
	assert.ok(err instanceof LLMError, `atteso un LLMError, ricevuto ${err}`);
	assert.strictEqual((err as InstanceType<typeof LLMError>).kind, 'unreachable',
		'la categoria dell\'errore deve essere "unreachable"');
	assert.strictEqual((err as InstanceType<typeof LLMError>).providerId, 'ollama',
		'il providerId deve essere "ollama"');
	assert.ok((err as Error).message.includes(EP),
		`il messaggio deve citare l'endpoint configurato (${EP}); ricevuto: "${(err as Error).message}"`);
}

const exampleRequest: LLMRequest = { messages: [{ role: 'user', content: 'ciao' }] };
const exampleAgentParams: AgentStreamParams = {
	system: 'sei un assistente',
	messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
	tools: [{ name: 'echo', description: 'ripete', input_schema: { type: 'object', properties: {} } }]
};

async function main(): Promise<void> {

	// ---- (1) Ollama irraggiungibile → LLMError unreachable con endpoint citato (Req. 9.1) ----

	await test('stream(): Ollama irraggiungibile → LLMError unreachable che cita l\'endpoint', async () => {
		const provider = makeProvider();
		const err = await captureError(drain(provider.stream(exampleRequest)));
		assertUnreachableCitingEndpoint(err);
	});

	await test('chatStructured(): Ollama irraggiungibile → LLMError unreachable che cita l\'endpoint', async () => {
		const provider = makeProvider();
		const err = await captureError(provider.chatStructured('sys', [{ role: 'user', content: 'x' }], { type: 'object' }));
		assertUnreachableCitingEndpoint(err);
	});

	await test('streamAgent(): Ollama irraggiungibile → LLMError unreachable che cita l\'endpoint', async () => {
		const provider = makeProvider();
		const err = await captureError(drain(provider.streamAgent(exampleAgentParams)));
		assertUnreachableCitingEndpoint(err);
	});

	// ---- (2) Esecuzione shell su Windows via `cmd` (Req. 11.5) ----

	await test('run_command (percorso sincrono): execAsync usa la shell `cmd` di Windows (ComSpec)', async () => {
		lastExecOptions = undefined;
		// `echo` non è long-running → passa per execAsync (non per spawn).
		const out = await tools.executeTool({ tool: 'run_command', args: { command: 'echo ciao' } });
		assert.ok(lastExecOptions, 'execAsync deve essere stato invocato');
		assert.strictEqual(lastExecOptions.shell, COMSPEC,
			`su Windows il comando deve passare per cmd (ComSpec=${COMSPEC}); ricevuto: ${lastExecOptions.shell}`);
		assert.ok(out.includes('stdout fittizio'), 'l\'output deve includere lo stdout del comando');
	});

	await test('run_command (background): spawn usa la shell `cmd` di Windows (ComSpec)', async () => {
		lastSpawnOptions = undefined;
		await tools.executeTool({ tool: 'run_command', args: { command: 'echo bg', background: true } });
		assert.ok(lastSpawnOptions, 'spawn deve essere stato invocato per il processo in background');
		assert.strictEqual(lastSpawnOptions.shell, COMSPEC,
			`su Windows il processo in background deve passare per cmd (ComSpec=${COMSPEC}); ricevuto: ${lastSpawnOptions.shell}`);
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void main();
