/*---------------------------------------------------------------------------------------------
 *  MGCoding - Integration test del cablaggio di `options.num_ctx` nel guscio Ollama
 *  (`llm/ollamaProvider.ts`).
 *
 *  È un test di INTEGRAZIONE basato su ESEMPI (non property-based): verifica che OGNI POST a
 *  `/api/chat` includa nel body `options.num_ctx` con un valore intero positivo (Req. 1.1).
 *  Il provider usa `fetch` per dialogare col server Ollama, quindi `globalThis.fetch` viene
 *  sostituito con un mock deterministico che:
 *   - registra il body di ogni POST a `/api/chat` (per le asserzioni su `options.num_ctx`);
 *   - risponde a `/api/show` con la finestra di contesto del modello (o senza, per il default);
 *   - risponde a `/api/chat` con uno stream NDJSON minimale oppure con JSON non-stream.
 *
 *  Copre i due percorsi del requisito:
 *   (a) config `mgcoding.ollama.numCtx` con intero positivo → inviato verbatim;
 *   (b) config a 0/auto → valore derivato comunque intero positivo (finestra del modello da
 *       `/api/show`, oppure il default 8192 quando non determinabile).
 *
 *  Esercita i tre POST a `/api/chat`: `stream`, `chatStructured` e `streamAgent`.
 *
 *  Eseguibile con: node out/test/ollamaNumCtx.int.test.js
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import './vscodeStub';
import * as assert from 'assert';
import { DEFAULT_NUM_CTX } from '../llm/contextManager';
import type { AgentStreamParams, LLMRequest } from '../llm/types';

// ============================================================================================
//  Stato controllabile dai test
// ============================================================================================

/** Body (parsati) di ogni POST a `/api/chat`, in ordine di invio. */
let chatBodies: any[] = [];
/** `model_info` restituito da `/api/show` (per la finestra di contesto). undefined = nessuno. */
let modelInfo: Record<string, unknown> | undefined;
/** `capabilities` restituite da `/api/show` (per vision/tools). */
let capabilities: string[] = [];

function resetMocks(): void {
	chatBodies = [];
	modelInfo = undefined;
	capabilities = [];
}

// ============================================================================================
//  Mock di `fetch`
// ============================================================================================

/** Costruisce una Response-like con stream NDJSON a partire da righe (oggetti JSON). */
function makeNdjsonResponse(events: object[]): any {
	const text = events.map(e => JSON.stringify(e)).join('\n') + '\n';
	const chunk = new TextEncoder().encode(text);
	let sent = false;
	return {
		ok: true,
		status: 200,
		body: {
			getReader() {
				return {
					async read() {
						if (sent) {
							return { done: true, value: undefined };
						}
						sent = true;
						return { done: false, value: chunk };
					}
				};
			}
		}
	};
}

(globalThis as any).fetch = async (url: unknown, opts?: any): Promise<any> => {
	const u = String(url);
	const method = (opts?.method ?? 'GET').toUpperCase();

	if (u.endsWith('/api/tags')) {
		return { ok: true, status: 200, json: async () => ({ models: [{ name: 'test-model' }] }) };
	}

	if (u.endsWith('/api/show')) {
		return { ok: true, status: 200, json: async () => ({ model_info: modelInfo ?? {}, capabilities }) };
	}

	if (u.endsWith('/api/chat') && method === 'POST') {
		const body = JSON.parse(String(opts?.body ?? '{}'));
		chatBodies.push(body);
		if (body.stream === true) {
			// Stream minimale: un delta di testo e la chiusura del turno.
			return makeNdjsonResponse([{ message: { content: 'ok' } }, { done: true }]);
		}
		// Percorso non-stream (chatStructured / probe): JSON diretto.
		return { ok: true, status: 200, json: async () => ({ message: { content: '{}' } }) };
	}

	throw new Error(`URL non gestito dal mock: ${u}`);
};

// Carica il modulo sotto test DOPO aver installato i mock.
const { OllamaProvider } = require('../llm/ollamaProvider') as typeof import('../llm/ollamaProvider');

// ============================================================================================
//  Helper
// ============================================================================================

const EP = 'http://127.0.0.1:11434';
const MODEL = 'test-model';

/** Crea un provider con un eventuale override di num_ctx via config. */
function makeProvider(configNumCtx?: number): InstanceType<typeof OllamaProvider> {
	return new OllamaProvider(() => ({ endpoint: EP, model: MODEL, numCtx: configNumCtx, temperature: 0.2 }));
}

/** Consuma un AsyncIterable fino in fondo (scarta i valori). */
async function drain<T>(it: AsyncIterable<T>): Promise<void> {
	for await (const _ of it) { /* noop */ }
}

/** Estrae il solo body dell'ultimo POST a `/api/chat`. */
function lastChatBody(): any {
	assert.ok(chatBodies.length > 0, 'nessun POST a /api/chat registrato');
	return chatBodies[chatBodies.length - 1];
}

/** Asserisce che `options.num_ctx` sia un intero positivo nel body dato. */
function assertPositiveIntNumCtx(body: any): number {
	assert.ok(body.options, 'il body deve contenere `options`');
	const n = body.options.num_ctx;
	assert.strictEqual(typeof n, 'number', '`options.num_ctx` deve essere un numero');
	assert.ok(Number.isInteger(n), `\`options.num_ctx\` deve essere intero, ricevuto ${n}`);
	assert.ok(n > 0, `\`options.num_ctx\` deve essere positivo, ricevuto ${n}`);
	return n;
}

// ============================================================================================
//  Harness di test (stile *.int.test.ts: asincrono)
// ============================================================================================

let passed = 0;
let failed = 0;
const tests: { name: string; fn: () => Promise<void> }[] = [];
function test(name: string, fn: () => Promise<void>): void { tests.push({ name, fn }); }

const exampleRequest: LLMRequest = { messages: [{ role: 'user', content: 'ciao' }] };

const exampleAgentParams: AgentStreamParams = {
	system: 'sei un assistente',
	messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
	tools: [{ name: 'echo', description: 'ripete', input_schema: { type: 'object', properties: {} } }]
};

// ---- (a) Config esplicita: num_ctx intero positivo inviato verbatim (Req. 1.1, 1.3) ----

test('stream(): la config numCtx (intero positivo) è inviata verbatim in options.num_ctx', async () => {
	resetMocks();
	const provider = makeProvider(4096);
	await drain(provider.stream(exampleRequest));
	const body = lastChatBody();
	const n = assertPositiveIntNumCtx(body);
	assert.strictEqual(n, 4096, 'la config numCtx deve essere inviata esattamente');
});

test('chatStructured(): la config numCtx (intero positivo) è inviata verbatim', async () => {
	resetMocks();
	const provider = makeProvider(12288);
	await provider.chatStructured('sys', [{ role: 'user', content: 'x' }], { type: 'object' });
	const body = lastChatBody();
	const n = assertPositiveIntNumCtx(body);
	assert.strictEqual(n, 12288);
	assert.strictEqual(body.stream, false, 'chatStructured usa il percorso non-stream');
});

test('streamAgent(): la config numCtx (intero positivo) è inviata verbatim', async () => {
	resetMocks();
	capabilities = ['tools'];
	const provider = makeProvider(2048);
	await drain(provider.streamAgent(exampleAgentParams));
	const body = lastChatBody();
	const n = assertPositiveIntNumCtx(body);
	assert.strictEqual(n, 2048);
});

// ---- (b) Config a 0/auto: valore derivato comunque intero positivo (Req. 1.1, 1.2, 1.4) ----

test('stream(): con config a 0 e finestra del modello nota, num_ctx = finestra del modello', async () => {
	resetMocks();
	modelInfo = { 'qwen2.context_length': 32768 };
	const provider = makeProvider(0);
	await drain(provider.stream(exampleRequest));
	const n = assertPositiveIntNumCtx(lastChatBody());
	assert.strictEqual(n, 32768, 'senza override deve usare la finestra max del modello da /api/show');
});

test('stream(): con config a 0 e finestra non determinabile, num_ctx = DEFAULT_NUM_CTX (8192)', async () => {
	resetMocks();
	modelInfo = {}; // nessun *context_length
	const provider = makeProvider(0);
	await drain(provider.stream(exampleRequest));
	const n = assertPositiveIntNumCtx(lastChatBody());
	assert.strictEqual(n, DEFAULT_NUM_CTX);
	assert.strictEqual(n, 8192);
});

test('chatStructured(): con config undefined e finestra non nota, num_ctx resta intero positivo (default)', async () => {
	resetMocks();
	modelInfo = {};
	const provider = makeProvider(undefined);
	await provider.chatStructured(undefined, [{ role: 'user', content: 'x' }], { type: 'object' });
	const n = assertPositiveIntNumCtx(lastChatBody());
	assert.strictEqual(n, DEFAULT_NUM_CTX);
});

test('streamAgent(): con config a 0 e finestra del modello nota, num_ctx = finestra del modello', async () => {
	resetMocks();
	capabilities = ['tools'];
	modelInfo = { 'llama.context_length': 16384 };
	const provider = makeProvider(0);
	await drain(provider.streamAgent(exampleAgentParams));
	const n = assertPositiveIntNumCtx(lastChatBody());
	assert.strictEqual(n, 16384);
});

// ---- Invariante trasversale: TUTTI i POST a /api/chat hanno num_ctx intero positivo ----

test('ogni POST a /api/chat registrato include options.num_ctx intero positivo', async () => {
	resetMocks();
	modelInfo = { 'qwen2.context_length': 8192 };
	capabilities = ['tools', 'vision'];
	const p1 = makeProvider(0);
	await drain(p1.stream(exampleRequest));
	await p1.chatStructured('s', [{ role: 'user', content: 'x' }], { type: 'object' });
	await drain(p1.streamAgent(exampleAgentParams));
	assert.ok(chatBodies.length >= 3, 'devono esserci almeno tre POST a /api/chat');
	for (const body of chatBodies) {
		assertPositiveIntNumCtx(body);
	}
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
