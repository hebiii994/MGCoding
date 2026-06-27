/*---------------------------------------------------------------------------------------------
 *  MGCoding - test unitari per il flag Anthropic-compat e il salvataggio della chiave GLM
 *  nel Secret_Store (Task 10.3).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/glmFlagSecret.test.js
 *
 *  Obiettivi (Req. 8.3, 8.4):
 *   1. Con `useAnthropicEndpoint=true` il GLM_Provider instrada sul percorso Anthropic-native
 *      (endpoint Messages API con header `x-api-key`/`anthropic-version` e `tools` nativi nel
 *      body); con `false` instrada sul percorso OpenAI-compat (`/chat/completions` con header
 *      `Authorization: Bearer`). La scelta del percorso dipende SOLO dal flag (Req. 8.3).
 *   2. La chiave API GLM è custodita nel Secret_Store sotto la chiave `mgcoding.glm.apiKey`:
 *      `setGlmKey` la salva, `hasGlmKey` la rileva e il GLM_Provider la recupera tramite la
 *      `getApiKey` iniettata, esattamente come fa il guscio in `llm/registry.ts` (Req. 8.4).
 *
 *  Il GLM_Provider usa `fetch` (tramite i sotto-provider Claude/OpenAI) per dialogare con gli
 *  endpoint: `globalThis.fetch` viene sostituito con un mock deterministico che registra ogni
 *  richiesta (URL, metodo, header, body) e risponde con uno stream SSE minimale.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

// IMPORTANTE: lo stub di `vscode` va importato PRIMA del modulo sotto test (alcuni moduli
// della catena di import potrebbero risolvere `require('vscode')` al caricamento).
import './vscodeStub';
import * as assert from 'assert';
import { GLMProvider, GLMConfig } from '../llm/glmProvider';
import type { AgentStreamParams } from '../llm/types';

// ============================================================================================
//  Costante del Secret_Store: DEVE combaciare con `SECRET_GLM_KEY` in `llm/registry.ts`.
// ============================================================================================

const SECRET_GLM_KEY = 'mgcoding.glm.apiKey';

// ============================================================================================
//  Mock minimale di VS Code SecretStorage (get/store/delete) con backing in-memory.
// ============================================================================================

class FakeSecretStorage {
	private readonly mem = new Map<string, string>();
	async get(key: string): Promise<string | undefined> {
		return this.mem.get(key);
	}
	async store(key: string, value: string): Promise<void> {
		this.mem.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.mem.delete(key);
	}
}

// ----- Repliche del cablaggio del guscio (registry.ts) attorno alla SecretStorage ----------
// `setGlmKey`/`hasGlmKey` riproducono il comportamento del registry: salvataggio e rilevazione
// della chiave sotto `mgcoding.glm.apiKey`. `getApiKey` è la stessa funzione iniettata nel
// GLM_Provider dal registry: `() => Promise.resolve(secrets.get(SECRET_GLM_KEY))`.

async function setGlmKey(secrets: FakeSecretStorage, key: string): Promise<void> {
	await secrets.store(SECRET_GLM_KEY, key.trim());
}

async function hasGlmKey(secrets: FakeSecretStorage): Promise<boolean> {
	const key = await secrets.get(SECRET_GLM_KEY);
	return !!(key && key.trim());
}

function makeGetApiKey(secrets: FakeSecretStorage): () => Promise<string | undefined> {
	return () => secrets.get(SECRET_GLM_KEY);
}

// ============================================================================================
//  Mock di `fetch`: registra ogni richiesta e risponde con uno stream SSE minimale.
// ============================================================================================

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: any;
}

let requests: RecordedRequest[] = [];

function resetRequests(): void {
	requests = [];
}

/** Costruisce una Response-like con corpo SSE a partire da eventi (oggetti JSON). */
function makeSseResponse(events: object[]): any {
	const text = events.map(e => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
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
		},
		async text() { return ''; },
		async json() { return {}; }
	};
}

(globalThis as any).fetch = async (url: unknown, opts?: any): Promise<any> => {
	const u = String(url);
	const method = (opts?.method ?? 'GET').toUpperCase();
	const headers = (opts?.headers ?? {}) as Record<string, string>;
	const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
	requests.push({ url: u, method, headers, body });

	// GET /models per `OpenAIProvider.isConfigured()`.
	if (u.endsWith('/models') && method === 'GET') {
		return { ok: true, status: 200, json: async () => ({ data: [{ id: 'glm-4.6' }] }) };
	}

	// POST Anthropic Messages API (percorso Anthropic-compat).
	if (method === 'POST' && /messages$/.test(u)) {
		return makeSseResponse([
			{ type: 'content_block_start', index: 0, content_block: { type: 'text' } },
			{ type: 'message_stop' }
		]);
	}

	// POST /chat/completions (percorso OpenAI-compat).
	if (method === 'POST' && /\/chat\/completions$/.test(u)) {
		return makeSseResponse([
			{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
		]);
	}

	throw new Error(`URL non gestito dal mock: ${method} ${u}`);
};

// ============================================================================================
//  Helper
// ============================================================================================

const OPENAI_ENDPOINT = 'https://glm-openai.test/api/paas/v4';
const ANTHROPIC_ENDPOINT = 'https://glm-anthropic.test/api/anthropic/v1/messages';
const MODEL = 'glm-4.6';

/** Costruisce un GLM_Provider con la SecretStorage data e il flag indicato. */
function makeProvider(secrets: FakeSecretStorage, useAnthropicEndpoint: boolean): GLMProvider {
	const cfg: GLMConfig = {
		openaiEndpoint: OPENAI_ENDPOINT,
		anthropicEndpoint: ANTHROPIC_ENDPOINT,
		model: MODEL,
		useAnthropicEndpoint
	};
	return new GLMProvider(makeGetApiKey(secrets), () => cfg);
}

/** Consuma un AsyncIterable fino in fondo (scarta i valori). */
async function drain<T>(it: AsyncIterable<T>): Promise<void> {
	for await (const _ of it) { /* noop */ }
}

const agentParams: AgentStreamParams = {
	system: 'sei un assistente',
	messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
	tools: [{ name: 'echo', description: 'ripete', input_schema: { type: 'object', properties: {} } }]
};

/** Ultima richiesta POST registrata. */
function lastPost(): RecordedRequest {
	const posts = requests.filter(r => r.method === 'POST');
	assert.ok(posts.length > 0, 'nessuna richiesta POST registrata');
	return posts[posts.length - 1];
}

// ============================================================================================
//  Harness asincrono
// ============================================================================================

let passed = 0;
let failed = 0;
const tests: { name: string; fn: () => Promise<void> }[] = [];
function test(name: string, fn: () => Promise<void>): void { tests.push({ name, fn }); }

// --- (1) Routing in base al flag useAnthropicEndpoint (Req. 8.3) ---------------------------

test('useAnthropicEndpoint=true: streamAgent usa l\'endpoint Anthropic-native con tool-use nativo', async () => {
	resetRequests();
	const secrets = new FakeSecretStorage();
	await setGlmKey(secrets, 'glm-secret-key');
	const provider = makeProvider(secrets, true);

	await drain(provider.streamAgent(agentParams));

	const post = lastPost();
	// Endpoint Anthropic-compat (Messages API), non l'OpenAI /chat/completions.
	assert.strictEqual(post.url, ANTHROPIC_ENDPOINT, 'deve colpire l\'endpoint Anthropic-compat');
	assert.ok(!/\/chat\/completions$/.test(post.url), 'non deve usare il percorso OpenAI');
	// Header tipici del percorso Anthropic-native.
	assert.ok(post.headers['x-api-key'], 'manca l\'header x-api-key (percorso Anthropic-native)');
	assert.ok(post.headers['anthropic-version'], 'manca l\'header anthropic-version');
	// Tool-use NATIVO: i tool sono inviati nel formato Anthropic (array `tools` con input_schema).
	assert.ok(Array.isArray(post.body.tools) && post.body.tools.length === 1, 'i tool nativi devono essere nel body');
	assert.ok(post.body.tools[0].input_schema, 'lo schema del tool nativo deve essere preservato');
});

test('useAnthropicEndpoint=false: streamAgent usa il percorso OpenAI-compat (/chat/completions)', async () => {
	resetRequests();
	const secrets = new FakeSecretStorage();
	await setGlmKey(secrets, 'glm-secret-key');
	const provider = makeProvider(secrets, false);

	await drain(provider.streamAgent(agentParams));

	const post = lastPost();
	assert.strictEqual(post.url, `${OPENAI_ENDPOINT}/chat/completions`, 'deve colpire /chat/completions di GLM');
	assert.ok(!/messages$/.test(post.url), 'non deve usare il percorso Anthropic Messages');
	// Header Bearer del percorso OpenAI-compat.
	assert.strictEqual(post.headers['authorization'], 'Bearer glm-secret-key', 'manca/è errato l\'header Authorization Bearer');
	assert.ok(!post.headers['x-api-key'], 'il percorso OpenAI non deve usare x-api-key');
	// Tool-use in formato OpenAI function calling (type:function), distinto da quello Anthropic.
	assert.ok(Array.isArray(post.body.tools) && post.body.tools[0].type === 'function', 'i tool devono essere in formato OpenAI function');
});

test('il percorso dipende SOLO dal flag: lo stesso provider, due config, due endpoint distinti', async () => {
	const secrets = new FakeSecretStorage();
	await setGlmKey(secrets, 'k');

	resetRequests();
	await drain(makeProvider(secrets, true).streamAgent(agentParams));
	const anthropicUrl = lastPost().url;

	resetRequests();
	await drain(makeProvider(secrets, false).streamAgent(agentParams));
	const openaiUrl = lastPost().url;

	assert.notStrictEqual(anthropicUrl, openaiUrl, 'i due flag devono produrre endpoint diversi');
	assert.strictEqual(anthropicUrl, ANTHROPIC_ENDPOINT);
	assert.strictEqual(openaiUrl, `${OPENAI_ENDPOINT}/chat/completions`);
});

// --- (2) Salvataggio/recupero della chiave nel Secret_Store sotto mgcoding.glm.apiKey (Req. 8.4) ---

test('setGlmKey salva la chiave nel Secret_Store sotto mgcoding.glm.apiKey e hasGlmKey la rileva', async () => {
	const secrets = new FakeSecretStorage();
	assert.strictEqual(await hasGlmKey(secrets), false, 'senza chiave hasGlmKey deve essere false');

	await setGlmKey(secrets, '  glm-secret-key  '); // viene normalizzata (trim)

	// La chiave è custodita ESATTAMENTE sotto `mgcoding.glm.apiKey`.
	assert.strictEqual(await secrets.get(SECRET_GLM_KEY), 'glm-secret-key', 'chiave non salvata sotto mgcoding.glm.apiKey');
	assert.strictEqual(await hasGlmKey(secrets), true, 'hasGlmKey deve rilevare la chiave salvata');
});

test('il GLM_Provider recupera la chiave dal Secret_Store: isConfigured() riflette la presenza', async () => {
	resetRequests();
	const secrets = new FakeSecretStorage();
	// Percorso Anthropic-native: isConfigured() dipende dalla sola presenza della chiave iniettata.
	const provider = makeProvider(secrets, true);

	assert.strictEqual(await provider.isConfigured(), false, 'senza chiave nel Secret_Store deve essere non configurato');
	await setGlmKey(secrets, 'glm-secret-key');
	assert.strictEqual(await provider.isConfigured(), true, 'con la chiave salvata deve risultare configurato');
});

test('la chiave inviata agli endpoint proviene dal Secret_Store (entrambi i percorsi)', async () => {
	const secrets = new FakeSecretStorage();
	await setGlmKey(secrets, 'top-secret-glm');

	// Percorso Anthropic-native: la chiave finisce nell'header x-api-key.
	resetRequests();
	await drain(makeProvider(secrets, true).streamAgent(agentParams));
	assert.strictEqual(lastPost().headers['x-api-key'], 'top-secret-glm', 'la chiave del Secret_Store deve viaggiare in x-api-key');

	// Percorso OpenAI-compat: la chiave finisce nell'header Authorization Bearer.
	resetRequests();
	await drain(makeProvider(secrets, false).streamAgent(agentParams));
	assert.strictEqual(lastPost().headers['authorization'], 'Bearer top-secret-glm', 'la chiave del Secret_Store deve viaggiare in Bearer');
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
