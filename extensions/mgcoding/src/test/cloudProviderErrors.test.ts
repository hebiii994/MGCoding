/*---------------------------------------------------------------------------------------------
 *  MGCoding - test unitari per gli errori dei provider cloud (Task 12.5).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/cloudProviderErrors.test.js
 *
 *  Obiettivi (Req. 9.2, 9.3, 9.4):
 *   1. Chiave API mancante → la richiesta corrente è INTERROTTA e all'utente viene CHIESTA la
 *      chiave. A livello di provider: `ClaudeProvider` lancia un `LLMError` di tipo
 *      `missing_key` PRIMA di contattare la rete (nessuna `fetch`); `OpenAIProvider` lo lancia
 *      al ritorno HTTP non autorizzato senza chiave. A livello di guscio: `handleProviderError`
 *      su un `missing_key` instrada al flusso di richiesta della chiave (Req. 9.2).
 *   2. Chiave non valida (HTTP 401/403, chiave presente) → `classifyHttpError` restituisce
 *      `invalid_key` e il provider lancia un messaggio dedicato di chiave non valida (Req. 9.3).
 *   3. Rate limit (HTTP 429) → `classifyHttpError` restituisce `rate_limit` e
 *      `handleProviderError` PROPONE un provider di ripiego quando ne esiste uno disponibile
 *      (Req. 9.4).
 *
 *  I provider usano `globalThis.fetch`: lo sostituiamo con un handler deterministico e
 *  intercambiabile. Lo stub di `vscode` è importato PER PRIMO perché `llm/registry.ts` fa
 *  `import * as vscode from 'vscode'` al caricamento; popoliamo l'oggetto condiviso prima di
 *  costruire la `ProviderRegistry`.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

// IMPORTANTE: lo stub di `vscode` va importato PRIMA dei moduli sotto test.
import { vscodeMock } from './vscodeStub';
import * as assert from 'assert';
import { ClaudeProvider } from '../llm/claudeProvider';
import { OpenAIProvider } from '../llm/openaiProvider';
// NB: `ProviderRegistry` è importato SOLO come tipo. Il modulo `llm/registry` legge
// `vscode.window`/`vscode.workspace` a load-time tramite `__importStar(require('vscode'))`,
// che con `esModuleInterop` COPIA le proprietà dello stub al momento del require. Va quindi
// caricato (via `require`) DOPO aver popolato `vscodeMock` con `installVscodeMock()`, altrimenti
// catturerebbe uno stub vuoto (vedi il pattern di `ollamaUnreachableWinShell.int.test.ts`).
import type { ProviderRegistry } from '../llm/registry';
import { classifyHttpError, LLMError } from '../llm/types';
import type { AgentStreamParams, LLMRequest } from '../llm/types';

// ============================================================================================
//  Mock di `fetch`: handler intercambiabile + contatore delle chiamate.
// ============================================================================================

type FetchHandler = (url: string, opts?: any) => Promise<any>;

let fetchHandler: FetchHandler = async (url) => { throw new Error(`fetch non gestita: ${url}`); };
let fetchCalls = 0;

(globalThis as any).fetch = (url: unknown, opts?: any): Promise<any> => {
	fetchCalls++;
	return fetchHandler(String(url), opts);
};

/** Costruisce una Response-like di errore (ok=false, niente body) con corpo testuale. */
function errResponse(status: number, text = ''): any {
	return { ok: false, status, body: null, async text() { return text; }, async json() { return {}; } };
}

// ============================================================================================
//  Config dei provider sotto test (valori minimi sufficienti).
// ============================================================================================

const CLAUDE_LABEL = 'Claude (Anthropic)';
const OPENAI_LABEL = 'OpenAI-compatibile';

function makeClaude(getApiKey: () => Promise<string | undefined>): ClaudeProvider {
	return new ClaudeProvider(getApiKey, () => ({ model: 'claude-test', maxTokens: 1024 }));
}

function makeOpenAI(getApiKey: () => Promise<string | undefined>): OpenAIProvider {
	return new OpenAIProvider(getApiKey, () => ({ endpoint: 'https://cloud.test/v1', model: 'gpt-test' }));
}

const agentParams: AgentStreamParams = {
	system: 'sei un assistente',
	messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
	tools: [{ name: 'echo', description: 'ripete', input_schema: { type: 'object', properties: {} } }]
};

const textReq: LLMRequest = { messages: [{ role: 'user', content: 'ciao' }] };

/** Consuma un AsyncIterable catturando l'eventuale errore lanciato. */
async function captureThrow(it: AsyncIterable<unknown>): Promise<unknown> {
	try {
		for await (const _ of it) { /* noop */ }
	} catch (e) {
		return e;
	}
	return undefined;
}

// ============================================================================================
//  Harness asincrono
// ============================================================================================

let passed = 0;
let failed = 0;
const tests: { name: string; fn: () => Promise<void> }[] = [];
function test(name: string, fn: () => Promise<void>): void { tests.push({ name, fn }); }

// --------------------------------------------------------------------------------------------
//  (1) Chiave mancante → interruzione + richiesta della chiave (Req. 9.2)
// --------------------------------------------------------------------------------------------

test('Claude: chiave mancante → LLMError missing_key e richiesta INTERROTTA prima della rete (nessuna fetch)', async () => {
	fetchCalls = 0;
	fetchHandler = async () => { throw new Error('la rete non deve essere contattata senza chiave'); };
	const provider = makeClaude(async () => undefined); // nessuna chiave

	const err = await captureThrow(provider.streamAgent(agentParams));

	assert.ok(err instanceof LLMError, 'deve essere un LLMError');
	assert.strictEqual((err as LLMError).kind, 'missing_key', 'kind atteso missing_key');
	assert.strictEqual((err as LLMError).providerId, 'claude', 'providerId atteso claude');
	// La richiesta è interrotta PRIMA di qualunque chiamata di rete.
	assert.strictEqual(fetchCalls, 0, 'nessuna fetch deve partire senza la chiave');
	assert.match((err as LLMError).message, /Chiave API mancante/i, 'messaggio di chiave mancante');
});

test('OpenAI: chiave mancante → 401 senza chiave classificato come missing_key', async () => {
	fetchCalls = 0;
	fetchHandler = async () => errResponse(401, 'missing authorization');
	const provider = makeOpenAI(async () => undefined); // nessuna chiave

	const err = await captureThrow(provider.stream(textReq));

	assert.ok(err instanceof LLMError, 'deve essere un LLMError');
	assert.strictEqual((err as LLMError).kind, 'missing_key', 'senza chiave un 401 è missing_key');
	assert.strictEqual((err as LLMError).providerId, 'openai', 'providerId atteso openai');
	assert.ok(fetchCalls >= 1, 'OpenAI scopre la chiave mancante alla risposta HTTP');
});

// --------------------------------------------------------------------------------------------
//  (2) Chiave non valida (401/403 con chiave presente) → invalid_key (Req. 9.3)
// --------------------------------------------------------------------------------------------

test('Claude: chiave presente + HTTP 401 → LLMError invalid_key con messaggio dedicato', async () => {
	fetchHandler = async () => errResponse(401, 'invalid api key');
	const provider = makeClaude(async () => 'sk-ant-presente');

	const err = await captureThrow(provider.streamAgent(agentParams));

	assert.ok(err instanceof LLMError, 'deve essere un LLMError');
	assert.strictEqual((err as LLMError).kind, 'invalid_key', 'con chiave un 401 è invalid_key');
	assert.match((err as LLMError).message, /non valida/i, 'messaggio dedicato di chiave non valida');
});

test('OpenAI: chiave presente + HTTP 403 → LLMError invalid_key', async () => {
	fetchHandler = async () => errResponse(403, 'forbidden');
	const provider = makeOpenAI(async () => 'key-presente');

	const err = await captureThrow(provider.stream(textReq));

	assert.ok(err instanceof LLMError, 'deve essere un LLMError');
	assert.strictEqual((err as LLMError).kind, 'invalid_key', 'con chiave un 403 è invalid_key');
});

// --------------------------------------------------------------------------------------------
//  (3) Rate limit (HTTP 429) → rate_limit (Req. 9.4)
// --------------------------------------------------------------------------------------------

test('Claude: HTTP 429 → LLMError rate_limit', async () => {
	fetchHandler = async () => errResponse(429, 'too many requests');
	const provider = makeClaude(async () => 'sk-ant-presente');

	const err = await captureThrow(provider.streamAgent(agentParams));

	assert.ok(err instanceof LLMError, 'deve essere un LLMError');
	assert.strictEqual((err as LLMError).kind, 'rate_limit', 'un 429 è rate_limit');
	assert.match((err as LLMError).message, /limite di rate|429/i, 'messaggio di rate limit');
});

// --------------------------------------------------------------------------------------------
//  (2-bis) classifyHttpError: tabella di verità diretta (funzione pura, Req. 9.2, 9.3, 9.4)
// --------------------------------------------------------------------------------------------

test('classifyHttpError: 401 senza chiave → missing_key', async () => {
	const e = classifyHttpError({ status: 401, bodyText: 'unauthorized', hasKey: false, providerId: 'openai', providerLabel: OPENAI_LABEL });
	assert.strictEqual(e.kind, 'missing_key');
});

test('classifyHttpError: 401 con chiave → invalid_key', async () => {
	const e = classifyHttpError({ status: 401, bodyText: 'unauthorized', hasKey: true, providerId: 'claude', providerLabel: CLAUDE_LABEL });
	assert.strictEqual(e.kind, 'invalid_key');
});

test('classifyHttpError: 403 con chiave → invalid_key', async () => {
	const e = classifyHttpError({ status: 403, bodyText: 'forbidden', hasKey: true, providerId: 'claude', providerLabel: CLAUDE_LABEL });
	assert.strictEqual(e.kind, 'invalid_key');
});

test('classifyHttpError: 429 → rate_limit (indipendente dalla presenza della chiave)', async () => {
	for (const hasKey of [true, false]) {
		const e = classifyHttpError({ status: 429, bodyText: 'rate', hasKey, providerId: 'glm', providerLabel: 'GLM' });
		assert.strictEqual(e.kind, 'rate_limit', `429 con hasKey=${hasKey} deve essere rate_limit`);
	}
});

test('classifyHttpError: 400 con indizi di autorizzazione e chiave presente → invalid_key', async () => {
	const e = classifyHttpError({ status: 400, bodyText: 'invalid api_key provided', hasKey: true, providerId: 'openai', providerLabel: OPENAI_LABEL });
	assert.strictEqual(e.kind, 'invalid_key', '400 con indizi auth + chiave → invalid_key');
});

// ============================================================================================
//  Guscio: ProviderRegistry.handleProviderError (Req. 9.2 prompt chiave, 9.4 ripiego)
// ============================================================================================
//  Costruiamo la VERA ProviderRegistry con un mock di `vscode` sufficiente: configurazione
//  con i soli default, status bar fittizia e `showInputBox` come spia (registra ogni richiesta
//  di chiave). La SecretStorage in-memory controlla la raggiungibilità di Claude/GLM.

const SECRET_CLAUDE_KEY = 'mgcoding.claude.apiKey';

/** Spia delle richieste di input (chiave) e dei quick pick (procedura guidata). */
let inputBoxPrompts: string[] = [];
let quickPickShown = 0;

class FakeSecretStorage {
	private readonly mem = new Map<string, string>();
	get(key: string): string | undefined { return this.mem.get(key); }
	store(key: string, value: string): void { this.mem.set(key, value); }
	delete(key: string): void { this.mem.delete(key); }
}

/** Popola l'oggetto `vscode` condiviso con la superficie minima usata dalla registry. */
function installVscodeMock(): void {
	vscodeMock.StatusBarAlignment = { Left: 1, Right: 2 };
	vscodeMock.window = {
		createStatusBarItem: () => ({ text: '', command: '', tooltip: '', show() { }, hide() { }, dispose() { } }),
		showInputBox: async (opts?: any) => { inputBoxPrompts.push(String(opts?.prompt ?? '')); return undefined; },
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => { quickPickShown++; return undefined; }
	};
	vscodeMock.workspace = {
		getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
		onDidChangeConfiguration: () => ({ dispose() { } })
	};
}

/**
 * Costruisce una ProviderRegistry reale con la SecretStorage data. Il modulo `llm/registry`
 * è caricato qui in modo PIGRO (`require`), così la prima istanza viene creata solo dopo che
 * `installVscodeMock()` ha popolato `vscodeMock`: in questo modo `__importStar` copia uno stub
 * già completo (con `window`/`workspace`/`StatusBarAlignment`).
 */
let ProviderRegistryCtor: typeof import('../llm/registry').ProviderRegistry | undefined;
function makeRegistry(secrets: FakeSecretStorage): ProviderRegistry {
	if (!ProviderRegistryCtor) {
		ProviderRegistryCtor = (require('../llm/registry') as typeof import('../llm/registry')).ProviderRegistry;
	}
	const context: any = { secrets, subscriptions: [] };
	return new ProviderRegistryCtor(context);
}

function resetSpies(): void {
	inputBoxPrompts = [];
	quickPickShown = 0;
}

// --- (1) missing_key → la chiave viene CHIESTA e la richiesta resta interrotta (Req. 9.2) ---

test('handleProviderError(missing_key, claude): chiede la chiave Anthropic (showInputBox)', async () => {
	installVscodeMock();
	resetSpies();
	const reg = makeRegistry(new FakeSecretStorage());
	const err = new LLMError('Chiave API mancante per Claude (Anthropic).', undefined, { kind: 'missing_key', providerId: 'claude' });

	const msg = await reg.handleProviderError(err);

	assert.strictEqual(inputBoxPrompts.length, 1, 'deve essere mostrato esattamente un prompt di chiave');
	assert.match(inputBoxPrompts[0], /Anthropic/i, 'il prompt deve riguardare la chiave Anthropic');
	assert.strictEqual(msg, err.message, 'il messaggio restituito è quello dell\'errore (richiesta già interrotta)');
	reg.dispose();
});

test('handleProviderError(missing_key, openai): chiede la chiave dell\'endpoint OpenAI-compat', async () => {
	installVscodeMock();
	resetSpies();
	const reg = makeRegistry(new FakeSecretStorage());
	const err = new LLMError('Chiave API mancante.', undefined, { kind: 'missing_key', providerId: 'openai' });

	await reg.handleProviderError(err);

	assert.strictEqual(inputBoxPrompts.length, 1, 'deve chiedere la chiave OpenAI-compat');
	assert.match(inputBoxPrompts[0], /API key/i, 'il prompt deve riguardare una API key');
	reg.dispose();
});

test('handleProviderError(missing_key, glm): chiede la chiave GLM', async () => {
	installVscodeMock();
	resetSpies();
	const reg = makeRegistry(new FakeSecretStorage());
	const err = new LLMError('Chiave API mancante.', undefined, { kind: 'missing_key', providerId: 'glm' });

	await reg.handleProviderError(err);

	assert.strictEqual(inputBoxPrompts.length, 1, 'deve chiedere la chiave GLM');
	assert.match(inputBoxPrompts[0], /GLM/i, 'il prompt deve riguardare la chiave GLM');
	reg.dispose();
});

// --- (3) rate_limit → propone un provider di ripiego se disponibile (Req. 9.4) -------------

test('handleProviderError(rate_limit): propone il ripiego quando un altro provider è disponibile', async () => {
	installVscodeMock();
	resetSpies();
	// Claude raggiungibile (chiave presente); Ollama e gli endpoint OpenAI/GLM giù.
	const secrets = new FakeSecretStorage();
	secrets.store(SECRET_CLAUDE_KEY, 'sk-ant-presente');
	fetchHandler = async () => errResponse(503, 'down'); // /api/tags e /models non ok
	const reg = makeRegistry(secrets);
	// Il provider in rate limit è OpenAI: il ripiego deve cadere su Claude.
	const err = new LLMError('OpenAI-compatibile ha raggiunto il limite di rate (HTTP 429).', undefined, { kind: 'rate_limit', providerId: 'openai' });

	const msg = await reg.handleProviderError(err);

	assert.match(msg, /Provider di ripiego disponibile/i, 'deve proporre un ripiego');
	assert.match(msg, /Claude/i, 'il ripiego proposto deve essere Claude (l\'unico raggiungibile)');
	reg.dispose();
});

test('handleProviderError(rate_limit): senza altri provider non propone ripiego, ritorna il messaggio base', async () => {
	installVscodeMock();
	resetSpies();
	// Nessuna chiave salvata e tutti gli endpoint giù → nessun provider raggiungibile.
	fetchHandler = async () => errResponse(503, 'down');
	const reg = makeRegistry(new FakeSecretStorage());
	const err = new LLMError('Claude (Anthropic) ha raggiunto il limite di rate (HTTP 429).', undefined, { kind: 'rate_limit', providerId: 'claude' });

	const msg = await reg.handleProviderError(err);

	assert.strictEqual(msg, err.message, 'senza ripiego disponibile ritorna il solo messaggio base');
	assert.doesNotMatch(msg, /Provider di ripiego disponibile/i, 'non deve proporre alcun ripiego');
	reg.dispose();
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
