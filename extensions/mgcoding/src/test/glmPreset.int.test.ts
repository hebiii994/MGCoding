/*---------------------------------------------------------------------------------------------
 *  MGCoding - Integration test del provider GLM (Zhipu/Z.ai) come preset selezionabile e del
 *  suo funzionamento sull'endpoint OpenAI-compatibile (`llm/registry.ts` + `llm/glmProvider.ts`).
 *
 *  È un test di INTEGRAZIONE basato su ESEMPI (non property-based). Verifica due aspetti del
 *  Requisito 8:
 *   (1) GLM è disponibile/selezionabile tra i preset (Req. 8.1):
 *       - l'enum `mgcoding.route.heavy` in package.json include il valore `glm`;
 *       - la UI `switchProvider` propone un'opzione `glm`;
 *       - il registry risolve l'id `glm` sul GLMProvider (label/model attesi) quando selezionato.
 *   (2) GLM funziona via endpoint OpenAI-compatibile (Req. 8.2):
 *       - con `mgcoding.glm.useAnthropicEndpoint=false`, `GLMProvider.stream()` invia la POST a
 *         `${mgcoding.glm.endpoint}/chat/completions` con il modello GLM e restituisce il testo
 *         in streaming, delegando interamente a OpenAIProvider.
 *
 *  Lo stub di `vscode` è importato PRIMA del modulo sotto test; `vscodeMock` viene popolato con
 *  un mock minimale di workspace.getConfiguration, SecretStorage, window e status bar. `fetch` è
 *  sostituito con un mock deterministico per il percorso OpenAI-compat (`/chat/completions`).
 *
 *  Eseguibile con: node out/test/glmPreset.int.test.js
 *  _Requirements: 8.1, 8.2_
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lo stub di `vscode` DEVE precedere il caricamento del modulo sotto test: intercetta
// `require('vscode')` e restituisce il riferimento condiviso `vscodeMock`, che popoliamo qui.
import { vscodeMock } from './vscodeStub';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { LLMRequest } from '../llm/types';

// ============================================================================================
//  Stato controllabile dai test
// ============================================================================================

/** Endpoint OpenAI-compat GLM usato nel test (valore di `mgcoding.glm.endpoint`). */
const GLM_ENDPOINT = 'https://test.z.ai/api/paas/v4';
/** Modello GLM atteso nel body della richiesta (valore di `mgcoding.glm.model`). */
const GLM_MODEL = 'glm-4.6-test';

/** Override di configurazione `mgcoding.*` letti dal mock di getConfiguration. */
let configValues: Record<string, unknown> = {};
/** SecretStorage simulata: chiave segreta → valore. */
let secrets: Record<string, string> = {};
/** Body (parsati) di ogni POST a `/chat/completions`, in ordine di invio. */
let chatBodies: any[] = [];
/** URL di ogni richiesta `fetch` registrata. */
let fetchUrls: string[] = [];
/** Item passati all'ultima `showQuickPick` (per verificare i preset proposti). */
let lastQuickPickItems: any[] = [];
/** Item che `showQuickPick` restituirà (scelta simulata dell'utente). */
let quickPickChoice: any;

function resetState(): void {
	configValues = {};
	secrets = {};
	chatBodies = [];
	fetchUrls = [];
	lastQuickPickItems = [];
	quickPickChoice = undefined;
}

// ============================================================================================
//  Mock di `vscode`
// ============================================================================================

/** Oggetto di configurazione `mgcoding`: legge gli override, altrimenti il default fornito. */
const configObject = {
	get: (key: string, def?: unknown) => (key in configValues ? configValues[key] : def),
	update: async (key: string, value: unknown) => { configValues[key] = value; }
};

Object.assign(vscodeMock, {
	StatusBarAlignment: { Left: 1, Right: 2 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	ProgressLocation: { Notification: 15 },
	QuickPickItemKind: { Separator: -1, Default: 0 },
	workspace: {
		getConfiguration: () => configObject,
		onDidChangeConfiguration: () => ({ dispose: () => { /* no-op */ } })
	},
	window: {
		createStatusBarItem: () => ({
			text: '', tooltip: '', command: '',
			show: () => { /* no-op */ },
			hide: () => { /* no-op */ },
			dispose: () => { /* no-op */ }
		}),
		showQuickPick: async (items: any[]) => { lastQuickPickItems = items; return quickPickChoice; },
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showInputBox: async () => undefined
	}
});

/** ExtensionContext minimale: espone solo `secrets` (usato dal registry) e `subscriptions`. */
function makeContext(): any {
	return {
		subscriptions: [],
		secrets: {
			get: async (k: string) => secrets[k],
			store: async (k: string, v: string) => { secrets[k] = v; },
			delete: async (k: string) => { delete secrets[k]; }
		}
	};
}

// ============================================================================================
//  Mock di `fetch` (percorso OpenAI-compat: /chat/completions in SSE)
// ============================================================================================

/** Costruisce una Response-like con stream SSE OpenAI a partire dai delta di testo. */
function makeSseResponse(deltas: string[]): any {
	const lines = deltas.map(d => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}`);
	lines.push('data: [DONE]');
	const chunk = new TextEncoder().encode(lines.join('\n') + '\n');
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
	fetchUrls.push(u);
	const method = (opts?.method ?? 'GET').toUpperCase();
	if (u.endsWith('/chat/completions') && method === 'POST') {
		chatBodies.push(JSON.parse(String(opts?.body ?? '{}')));
		return makeSseResponse(['Hello', ' world']);
	}
	throw new Error(`URL non gestito dal mock: ${u}`);
};

// Carica il modulo sotto test DOPO aver installato i mock.
const { ProviderRegistry } = require('../llm/registry') as typeof import('../llm/registry');

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

/** Consuma un AsyncIterable raccogliendone i valori. */
async function collect(it: AsyncIterable<string>): Promise<string> {
	let out = '';
	for await (const s of it) {
		out += s;
	}
	return out;
}

async function main(): Promise<void> {

	// ---- (1) GLM disponibile/selezionabile tra i preset (Req. 8.1) ----

	// package.json: l'enum `mgcoding.route.heavy` deve includere `glm`, così GLM è instradabile
	// come provider heavy tra i preset di configurazione.
	await test('package.json: l\'enum mgcoding.route.heavy include il valore "glm"', async () => {
		// out/test/glmPreset.int.test.js → ../../package.json = extensions/mgcoding/package.json
		const pkgPath = path.join(__dirname, '..', '..', 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		const prop = pkg?.contributes?.configuration?.properties?.['mgcoding.route.heavy'];
		assert.ok(prop, 'la proprietà mgcoding.route.heavy deve esistere in package.json');
		assert.ok(Array.isArray(prop.enum), 'mgcoding.route.heavy deve dichiarare un enum');
		assert.ok(prop.enum.includes('glm'), 'l\'enum di mgcoding.route.heavy deve includere "glm"');
	});

	// switchProvider: la UI di selezione provider deve proporre un'opzione GLM (id `glm`).
	await test('switchProvider: propone GLM tra i provider selezionabili', async () => {
		resetState();
		secrets['mgcoding.glm.apiKey'] = 'glm-key'; // chiave presente → nessun prompt di setup
		quickPickChoice = undefined; // l'utente annulla: ci interessano solo gli item proposti
		const registry = new ProviderRegistry(makeContext());
		await registry.switchProvider();
		const glmItem = lastQuickPickItems.find(i => i.id === 'glm');
		assert.ok(glmItem, 'switchProvider deve proporre un\'opzione con id "glm"');
		assert.ok(/glm/i.test(String(glmItem.label)), 'l\'etichetta dell\'opzione deve menzionare GLM');
		registry.dispose();
	});

	// Selezione di GLM: il registry imposta provider=glm e lo risolve sul GLMProvider, di cui
	// verifichiamo label e modello (prova che `byId('glm')` instrada al provider corretto).
	await test('selezione GLM: il registry risolve l\'id "glm" sul GLMProvider', async () => {
		resetState();
		configValues['glm.model'] = GLM_MODEL;
		secrets['mgcoding.glm.apiKey'] = 'glm-key';
		quickPickChoice = { label: 'GLM (Zhipu/Z.ai)', id: 'glm' };
		const registry = new ProviderRegistry(makeContext());
		await registry.switchProvider();
		assert.strictEqual(configValues['provider'], 'glm', 'switchProvider deve impostare provider=glm');
		const current = registry.current();
		assert.strictEqual(current.id, 'glm', 'il provider corrente deve avere id "glm"');
		assert.strictEqual(current.label, 'GLM (Zhipu/Z.ai)', 'il provider risolto deve essere il GLMProvider');
		assert.strictEqual(current.modelName(), GLM_MODEL, 'il modello deve provenire da mgcoding.glm.model');
		registry.dispose();
	});

	// ---- (2) GLM funziona via endpoint OpenAI-compatibile (Req. 8.2) ----

	// Con useAnthropicEndpoint=false, GLMProvider.stream() delega a OpenAIProvider e colpisce
	// `${mgcoding.glm.endpoint}/chat/completions` con il modello GLM, restituendo il testo SSE.
	await test('stream OpenAI-compat: la POST colpisce mgcoding.glm.endpoint con il modello GLM', async () => {
		resetState();
		configValues['provider'] = 'glm';
		configValues['glm.endpoint'] = GLM_ENDPOINT;
		configValues['glm.model'] = GLM_MODEL;
		configValues['glm.useAnthropicEndpoint'] = false; // percorso OpenAI-compat (default)
		secrets['mgcoding.glm.apiKey'] = 'glm-key';

		const registry = new ProviderRegistry(makeContext());
		const provider = registry.current();
		assert.strictEqual(provider.id, 'glm', 'il provider corrente deve essere GLM');

		const req: LLMRequest = { messages: [{ role: 'user', content: 'ciao' }] };
		const text = await collect(provider.stream(req));

		// La richiesta deve raggiungere l'endpoint OpenAI-compat configurato per GLM.
		assert.strictEqual(fetchUrls.length, 1, 'deve essere effettuata esattamente una richiesta');
		assert.strictEqual(fetchUrls[0], `${GLM_ENDPOINT}/chat/completions`,
			'la POST deve colpire `${mgcoding.glm.endpoint}/chat/completions`');
		// Il body deve usare il modello GLM ed essere in streaming.
		assert.strictEqual(chatBodies.length, 1, 'deve essere registrato un solo body');
		assert.strictEqual(chatBodies[0].model, GLM_MODEL, 'il body deve usare il modello GLM configurato');
		assert.strictEqual(chatBodies[0].stream, true, 'lo stream OpenAI-compat usa stream=true');
		// Il testo in streaming deve essere ricomposto dai delta SSE.
		assert.strictEqual(text, 'Hello world', 'lo stream deve restituire il testo concatenato dai delta');
		registry.dispose();
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void main();
