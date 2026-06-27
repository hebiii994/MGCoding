/*---------------------------------------------------------------------------------------------
 *  MGCoding - test unitari di retrocompatibilità della configurazione (Task 1.4).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/configCompat.test.js
 *
 *  Obiettivo (Req. 11.1, 11.4):
 *   1. Le configurazioni esistenti dei provider Ollama / Claude / OpenAI restano operative:
 *      le chiavi legacy sono ancora dichiarate in package.json con i loro default storici e
 *      i nuovi Config_Key non collidono con esse (sono additivi).
 *   2. I default dei nuovi Config_Key preservano il comportamento precedente per gli utenti
 *      esistenti: numCtx=0 (auto), autonomyMode='supervised', context.summarize=true,
 *      localFirst=true, route.heavy='claude' (invariato).
 *   3. `readFeatureConfig` restituisce il default fornito quando né `.mg/` né `.kiro/` hanno la
 *      chiave, e legge la configurazione legacy sotto `.kiro/` quando `.mg/` non la contiene
 *      (l'aggiornamento non interrompe il flusso di lavoro esistente).
 *
 *  Il modulo `util/mgConfig.ts` usa `vscode` a RUNTIME: importiamo `./vscodeStub` PER PRIMO e
 *  popoliamo l'oggetto condiviso con un filesystem in-memory minimale prima di esercitarlo.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
// IMPORTANTE: lo stub di `vscode` va importato PRIMA del modulo sotto test.
import { vscodeMock } from './vscodeStub';

// --- Filesystem in-memory + Uri minimale per popolare lo stub di `vscode` ------------------

/** URI minimale: incapsula un percorso POSIX-like e fornisce le proprietà usate dal modulo. */
class FakeUri {
	constructor(public readonly path: string) { }
	get fsPath(): string { return this.path; }
	toString(): string { return this.path; }
}

/** Unisce segmenti a un URI base normalizzando `.` e `..` (necessario per joinPath(uri, '..')). */
function joinPath(base: FakeUri, ...segments: string[]): FakeUri {
	const parts = base.path.split('/').filter((p) => p.length > 0);
	for (const segment of segments) {
		for (const piece of segment.split('/')) {
			if (piece === '' || piece === '.') {
				continue;
			}
			if (piece === '..') {
				parts.pop();
			} else {
				parts.push(piece);
			}
		}
	}
	return new FakeUri('/' + parts.join('/'));
}

/** Store del filesystem in-memory: file (path→bytes) e directory (insieme di path). */
const memFiles = new Map<string, Uint8Array>();
const memDirs = new Set<string>();
const ENC = new TextEncoder();

/** Azzera lo stato del filesystem in-memory tra un test e l'altro. */
function resetFs(): void {
	memFiles.clear();
	memDirs.clear();
}

const fakeFs = {
	async readFile(uri: FakeUri): Promise<Uint8Array> {
		const data = memFiles.get(uri.path);
		if (!data) {
			throw new Error(`ENOENT: ${uri.path}`);
		}
		return data;
	},
	async writeFile(uri: FakeUri, content: Uint8Array): Promise<void> {
		memFiles.set(uri.path, content);
	},
	async createDirectory(uri: FakeUri): Promise<void> {
		memDirs.add(uri.path);
	},
	async stat(uri: FakeUri): Promise<{ type: number }> {
		if (memFiles.has(uri.path) || memDirs.has(uri.path)) {
			return { type: 1 };
		}
		throw new Error(`ENOENT: ${uri.path}`);
	},
};

const ROOT = new FakeUri('/ws');

// Popola l'oggetto `vscode` condiviso PRIMA di importare/esercitare il modulo sotto test.
vscodeMock.Uri = { joinPath, file: (p: string) => new FakeUri(p.replace(/\\/g, '/')) };
vscodeMock.workspace = { workspaceFolders: [{ uri: ROOT }], fs: fakeFs };

// Import del modulo sotto test DOPO aver installato lo stub.
import { readFeatureConfig } from '../util/mgConfig';

/** Percorsi canonici dei file di configurazione di feature nel filesystem in-memory. */
const MG_FILE = '/ws/.mg/settings/feature.json';
const KIRO_FILE = '/ws/.kiro/settings/feature.json';

/** Scrive direttamente un oggetto di configurazione in uno dei due file (setup del test). */
function seedConfigFile(p: string, obj: Record<string, unknown>): void {
	memFiles.set(p, ENC.encode(JSON.stringify(obj)));
}

// --- Caricamento dei contributi di configurazione da package.json ---------------------------

/** Percorso del package.json dell'estensione, relativo alla posizione del JS compilato (out/test). */
const PKG_PATH = path.resolve(__dirname, '..', '..', 'package.json');

interface ConfigProp { type?: string; default?: unknown; enum?: string[] }

/** Mappa "mgcoding.*" → contributo di configurazione dichiarato in package.json. */
function loadConfigProps(): Record<string, ConfigProp> {
	const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
	const props = pkg?.contributes?.configuration?.properties;
	assert.ok(props && typeof props === 'object', 'contributes.configuration.properties mancante');
	return props as Record<string, ConfigProp>;
}

// --- Harness --------------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// --- Test ------------------------------------------------------------------------------------

async function run(): Promise<void> {
	const props = loadConfigProps();

	// (1) Le configurazioni esistenti dei provider restano dichiarate con i default storici.
	//     Req. 11.1: l'aggiornamento non richiede una riconfigurazione.
	const legacyDefaults: Record<string, unknown> = {
		'mgcoding.ollama.endpoint': 'http://localhost:11434',
		'mgcoding.ollama.model': 'qwen2.5-coder:14b',
		'mgcoding.openai.endpoint': 'http://localhost:1234/v1',
		'mgcoding.openai.model': 'local-model',
		'mgcoding.claude.model': 'claude-opus-4-8',
		'mgcoding.claude.maxTokens': 8192,
		'mgcoding.route.light': 'ollama',
	};
	for (const [key, def] of Object.entries(legacyDefaults)) {
		test(`config legacy presente e invariata: ${key}`, () => {
			assert.ok(Object.prototype.hasOwnProperty.call(props, key), `chiave legacy assente: ${key}`);
			assert.deepStrictEqual(props[key].default, def, `default legacy cambiato per ${key}`);
		});
	}

	// (2) I nuovi Config_Key sono additivi: non sostituiscono né rimuovono le chiavi legacy.
	const newKeys = [
		'mgcoding.ollama.numCtx',
		'mgcoding.context.summarize',
		'mgcoding.context.responseReserve',
		'mgcoding.model.capabilityTier',
		'mgcoding.autonomyMode',
		'mgcoding.glm.useAnthropicEndpoint',
		'mgcoding.glm.model',
		'mgcoding.localFirst',
	];
	test('i nuovi Config_Key sono additivi (nessuna collisione con le chiavi legacy)', () => {
		for (const k of newKeys) {
			assert.ok(Object.prototype.hasOwnProperty.call(props, k), `nuovo Config_Key assente: ${k}`);
			assert.ok(!Object.prototype.hasOwnProperty.call(legacyDefaults, k), `collisione legacy/nuovo: ${k}`);
		}
	});

	// (3) I default dei nuovi Config_Key preservano il comportamento precedente (Req. 11.4).
	const preservingDefaults: Array<[string, unknown]> = [
		['mgcoding.ollama.numCtx', 0],                  // 0 = auto: riproduce l'auto-derivazione precedente
		['mgcoding.autonomyMode', 'supervised'],        // = precedente richiesta di conferma
		['mgcoding.context.summarize', true],           // gestione contesto attiva ma non distruttiva
		['mgcoding.context.responseReserve', 1024],     // riserva minima di default
		['mgcoding.localFirst', true],                  // privilegia i locali come prima
		['mgcoding.glm.useAnthropicEndpoint', false],   // GLM opt-in, disattivo di default
	];
	for (const [key, def] of preservingDefaults) {
		test(`default che preserva il comportamento: ${key} = ${JSON.stringify(def)}`, () => {
			assert.deepStrictEqual(props[key].default, def, `default non conservativo per ${key}`);
		});
	}

	// route.heavy resta invariato ('claude') ma aggiunge 'glm' tra i valori ammessi (Req. 11.4, 8.5).
	test("mgcoding.route.heavy: default invariato 'claude' con 'glm' aggiunto all'enum", () => {
		assert.deepStrictEqual(props['mgcoding.route.heavy'].default, 'claude', 'default route.heavy cambiato');
		assert.ok(
			Array.isArray(props['mgcoding.route.heavy'].enum) && props['mgcoding.route.heavy'].enum!.includes('glm'),
			"il valore 'glm' deve essere aggiunto all'enum di route.heavy",
		);
		// I provider storici restano selezionabili.
		for (const legacy of ['claude', 'openai', 'ollama']) {
			assert.ok(props['mgcoding.route.heavy'].enum!.includes(legacy), `route.heavy non offre più ${legacy}`);
		}
	});

	// model.capabilityTier ha default {} (nessun override: comportamento automatico precedente).
	test('mgcoding.model.capabilityTier: default {} (nessun override)', () => {
		assert.deepStrictEqual(props['mgcoding.model.capabilityTier'].default, {}, 'capabilityTier non vuoto di default');
	});

	// (4) readFeatureConfig: quando né .mg/ né .kiro/ hanno la chiave, ritorna il default fornito.
	//     Req. 11.4: un nuovo Config_Key non impostato applica un valore di default.
	await testAsync('readFeatureConfig ritorna il default quando .mg/ e .kiro/ non hanno la chiave', async () => {
		resetFs();
		assert.strictEqual(await readFeatureConfig('mgcoding.localFirst', true), true);
		assert.strictEqual(await readFeatureConfig('mgcoding.autonomyMode', 'supervised'), 'supervised');
		assert.strictEqual(await readFeatureConfig('mgcoding.ollama.numCtx', 0), 0);
	});

	// (5) Retrocompatibilità di lettura: una configurazione legacy sotto .kiro/ resta operativa
	//     quando .mg/ non contiene il dato (Req. 11.1, 11.2).
	await testAsync('readFeatureConfig legge la configurazione legacy .kiro/ se .mg/ non la contiene', async () => {
		resetFs();
		seedConfigFile(KIRO_FILE, { 'legacy.provider': 'ollama' });
		assert.strictEqual(await readFeatureConfig('legacy.provider', 'fallback'), 'ollama');
	});

	// (6) Precedenza: il valore .mg/ vince sul legacy .kiro/ senza ignorarlo del tutto.
	await testAsync('readFeatureConfig: .mg/ ha precedenza ma .kiro/ resta il ripiego', async () => {
		resetFs();
		seedConfigFile(MG_FILE, { 'shared.key': 'mg' });
		seedConfigFile(KIRO_FILE, { 'shared.key': 'kiro', 'only.kiro': 'legacy' });
		assert.strictEqual(await readFeatureConfig('shared.key', 'def'), 'mg');
		assert.strictEqual(await readFeatureConfig('only.kiro', 'def'), 'legacy');
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void run();
