/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) della precedenza della configurazione di feature.
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/featureConfig.pbt.test.js
 *
 *  Il modulo sotto test `util/mgConfig.ts` (e il suo ausiliario `util/featurePaths.ts`) fa
 *  `import * as vscode from 'vscode'` e usa `vscode.workspace.fs`, `vscode.workspace.workspaceFolders`
 *  e `vscode.Uri` a RUNTIME. Importiamo perciò `./vscodeStub` PER PRIMO (intercetta
 *  `require('vscode')` restituendo l'oggetto condiviso `vscodeMock`) e popoliamo quell'oggetto con
 *  un filesystem in-memory minimale e un'implementazione di `Uri`. Tutte le API di `vscode` usate
 *  dal modulo sono invocate dentro le funzioni (non al caricamento), quindi popolare `vscodeMock`
 *  dopo l'import ma prima di esercitare le funzioni è sufficiente.
 *
 *  ### Property 28: Precedenza della configurazione di feature .mg → .kiro → default
 *  "Per ogni combinazione di presenza/assenza di un valore sotto `.mg/` e `.kiro/`,
 *   `readFeatureConfig` restituisce il valore di `.mg/` se presente, altrimenti quello di
 *   `.kiro/`, altrimenti il default; la scrittura ha sempre come destinazione `.mg/`."
 *  **Validates: Requirements 11.2, 11.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
// IMPORTANTE: lo stub di `vscode` va importato PRIMA del modulo sotto test.
import { vscodeMock } from './vscodeStub';

const RUNS = 200;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

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
const files = new Map<string, Uint8Array>();
const dirs = new Set<string>();

/** Azzera lo stato del filesystem in-memory tra un'iterazione e l'altra. */
function resetFs(): void {
	files.clear();
	dirs.clear();
}

const fakeFs = {
	async readFile(uri: FakeUri): Promise<Uint8Array> {
		const data = files.get(uri.path);
		if (!data) {
			throw new Error(`ENOENT: ${uri.path}`);
		}
		return data;
	},
	async writeFile(uri: FakeUri, content: Uint8Array): Promise<void> {
		files.set(uri.path, content);
	},
	async createDirectory(uri: FakeUri): Promise<void> {
		dirs.add(uri.path);
	},
	async stat(uri: FakeUri): Promise<{ type: number }> {
		if (files.has(uri.path) || dirs.has(uri.path)) {
			return { type: 1 };
		}
		throw new Error(`ENOENT: ${uri.path}`);
	},
};

const ROOT = new FakeUri('/ws');

// Popola l'oggetto `vscode` condiviso PRIMA di importare/esercitare il modulo sotto test.
vscodeMock.Uri = { joinPath, file: (p: string) => new FakeUri(p.replace(/\\/g, '/')) };
vscodeMock.workspace = { workspaceFolders: [{ uri: ROOT }], fs: fakeFs };

// Import del modulo sotto test (gli import sono issati: lo stub `vscode` è già installato e
// le sue API sono usate solo a runtime, quindi la popolazione di `vscodeMock` qui sopra basta).
import { readFeatureConfig, writeFeatureConfig } from '../util/mgConfig';

/** Percorsi canonici dei file di configurazione di feature nel filesystem in-memory. */
const MG_FILE = '/ws/.mg/settings/feature.json';
const KIRO_FILE = '/ws/.kiro/settings/feature.json';

/** Scrive direttamente un oggetto di configurazione in uno dei due file (setup del test). */
function seedConfigFile(path: string, obj: Record<string, unknown>): void {
	files.set(path, ENC.encode(JSON.stringify(obj)));
}

/** Legge e deserializza il contenuto corrente di un file di configurazione in-memory. */
function readConfigFileRaw(path: string): Record<string, unknown> {
	const data = files.get(path);
	return data ? JSON.parse(DEC.decode(data)) : {};
}

// --- Harness asincrono ----------------------------------------------------------------------

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// --- Generatori ------------------------------------------------------------------------------

/** Chiave di configurazione: stringa non vuota, esclusi i nomi che inquinano il prototipo. */
const arbKey: fc.Arbitrary<string> = fc
	.string({ minLength: 1, maxLength: 24 })
	.filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && !k.includes('\u0000'));

/** Valore di configurazione JSON-serializzabile (stabile sotto round-trip JSON). */
const arbValue: fc.Arbitrary<unknown> = fc.oneof(
	fc.string(),
	fc.integer({ min: -1_000_000, max: 1_000_000 }),
	fc.boolean(),
	fc.constant(null),
	fc.array(fc.string(), { maxLength: 4 }),
	fc.dictionary(arbKeyForNested(), fc.string(), { maxKeys: 4 }),
);

/** Chiavi sicure per oggetti annidati nei valori generati. */
function arbKeyForNested(): fc.Arbitrary<string> {
	return fc.string({ minLength: 1, maxLength: 8 }).filter((k) => k !== '__proto__' && !k.includes('\u0000'));
}

// --- Property 28: precedenza .mg → .kiro → default + scrittura sempre sotto .mg/ ------------
// Validates: Requirements 11.2, 11.3
async function run(): Promise<void> {
	await test('Property 28: readFeatureConfig segue .mg → .kiro → default e writeFeatureConfig scrive sotto .mg/', async () => {
		await fc.assert(
			fc.asyncProperty(
				arbKey,
				fc.boolean(),
				fc.boolean(),
				arbValue,
				arbValue,
				arbValue,
				async (key, presentInMg, presentInKiro, mgValue, kiroValue, def) => {
					resetFs();

					// Predisposizione: presenza/assenza della chiave nei due file (round-trip JSON).
					if (presentInMg) {
						seedConfigFile(MG_FILE, { [key]: mgValue });
					}
					if (presentInKiro) {
						// Manteniamo eventuale presenza in .mg e aggiungiamo la stessa chiave in .kiro.
						seedConfigFile(KIRO_FILE, { [key]: kiroValue });
					}

					// Esito atteso: .mg vince, poi .kiro, infine il default fornito.
					const expected = presentInMg ? mgValue : presentInKiro ? kiroValue : def;
					const actual = await readFeatureConfig(key, def);
					assert.deepStrictEqual(
						actual,
						expected,
						`precedenza violata (mg=${presentInMg}, kiro=${presentInKiro})`,
					);

					// La scrittura ha SEMPRE come destinazione .mg/, mai .kiro/.
					const writeKey = key + '__written';
					const writeValue = mgValue;
					const kiroBefore = readConfigFileRaw(KIRO_FILE);
					await writeFeatureConfig(writeKey, writeValue);

					const mgAfter = readConfigFileRaw(MG_FILE);
					assert.ok(
						Object.prototype.hasOwnProperty.call(mgAfter, writeKey),
						'la scrittura deve atterrare nel file .mg/',
					);
					assert.deepStrictEqual(mgAfter[writeKey], writeValue, 'valore scritto non corrispondente');

					// Il file legacy .kiro/ non viene mai toccato dalla scrittura.
					assert.deepStrictEqual(
						readConfigFileRaw(KIRO_FILE),
						kiroBefore,
						'la scrittura non deve modificare il file legacy .kiro/',
					);
				},
			),
			{ numRuns: RUNS },
		);
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void run();
