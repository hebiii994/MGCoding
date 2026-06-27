/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) del ripristino del checkpoint dell'agente.
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/checkpointRevert.pbt.test.js
 *
 *  Il modulo sotto test `edit/checkpoint.ts` fa `import * as vscode from 'vscode'` e usa a
 *  RUNTIME `vscode.workspace.fs` (readFile/writeFile/delete) e `vscode.Uri.parse`. Importiamo
 *  quindi `./vscodeStub` PER PRIMO (intercetta `require('vscode')` restituendo l'oggetto
 *  condiviso `vscodeMock`) e popoliamo quell'oggetto con un filesystem in-memory minimale e
 *  un'implementazione di `Uri`. Tutte le API di `vscode` usate dal modulo sono invocate dentro
 *  le funzioni (non al caricamento), perciò popolare `vscodeMock` dopo l'import basta.
 *
 *  ### Property 17: Il ripristino del checkpoint riporta i file all'originale
 *  "Per ogni insieme di contenuti originali (inclusi file inesistenti), dopo aver registrato
 *   gli originali, applicato modifiche arbitrarie e poi eseguito il revert, ogni file torna
 *   esattamente al contenuto originale (i file che non esistevano vengono rimossi)."
 *  **Validates: Requirements 5.5**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
// IMPORTANTE: lo stub di `vscode` va importato PRIMA del modulo sotto test.
import { vscodeMock } from './vscodeStub';

const RUNS = 200;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// --- Filesystem in-memory + Uri minimale per popolare lo stub di `vscode` ------------------

/** URI minimale: incapsula un percorso e fornisce `toString()`/`fsPath` usati dal modulo. */
class FakeUri {
	constructor(public readonly path: string) { }
	get fsPath(): string { return this.path; }
	// `recordOriginal` usa `uri.toString()` come chiave; `revertCheckpoint` la ricostruisce
	// con `Uri.parse(key)`: il round-trip toString → parse deve restituire lo stesso percorso.
	toString(): string { return this.path; }
}

/** Store del filesystem in-memory: percorso → bytes. */
const files = new Map<string, Uint8Array>();

/** Azzera lo stato del filesystem in-memory tra un'iterazione e l'altra. */
function resetFs(): void {
	files.clear();
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
	async delete(uri: FakeUri): Promise<void> {
		files.delete(uri.path);
	},
};

// Popola l'oggetto `vscode` condiviso PRIMA di importare/esercitare il modulo sotto test.
vscodeMock.Uri = { parse: (s: string) => new FakeUri(s) };
vscodeMock.workspace = { fs: fakeFs };

// Import del modulo sotto test (gli import sono issati: lo stub `vscode` è già installato e
// le sue API sono usate solo a runtime, quindi la popolazione di `vscodeMock` qui sopra basta).
import { beginCheckpoint, recordOriginal, revertCheckpoint } from '../edit/checkpoint';

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

/** Percorso di file (chiave URI): stringa non vuota senza caratteri di controllo. */
const arbPath: fc.Arbitrary<string> = fc
	.string({ minLength: 1, maxLength: 32 })
	.filter((p) => !p.includes('\u0000'))
	.map((p) => '/ws/' + p.replace(/\//g, '_'));

/** Modifica arbitraria applicata a un file durante il checkpoint. */
type Mutation =
	| { readonly op: 'write'; readonly content: string }
	| { readonly op: 'delete' };

/** Descrittore di un file nello scenario: esistenza iniziale, contenuto originale e modifica. */
interface FileSpec {
	readonly path: string;
	readonly existedBefore: boolean;
	readonly originalContent: string;
	readonly mutation: Mutation;
}

const arbMutation: fc.Arbitrary<Mutation> = fc.oneof(
	fc.record({ op: fc.constant<'write'>('write'), content: fc.string({ maxLength: 64 }) }),
	fc.record({ op: fc.constant<'delete'>('delete') }),
);

/** Insieme di file con percorsi univoci (un solo originale registrato per percorso). */
const arbFileSpecs: fc.Arbitrary<readonly FileSpec[]> = fc
	.uniqueArray(
		fc.record({
			path: arbPath,
			existedBefore: fc.boolean(),
			originalContent: fc.string({ maxLength: 64 }),
			mutation: arbMutation,
		}),
		{ selector: (f) => f.path, maxLength: 8 },
	);

// --- Property 17: il revert ripristina ogni file all'originale (file inesistenti rimossi) ----
// Validates: Requirements 5.5
async function run(): Promise<void> {
	await test('Property 17: revertCheckpoint riporta ogni file al contenuto originale', async () => {
		await fc.assert(
			fc.asyncProperty(arbFileSpecs, async (specs) => {
				resetFs();

				// Predisposizione: i file "esistenti" partono col loro contenuto originale.
				for (const f of specs) {
					if (f.existedBefore) {
						files.set(f.path, ENC.encode(f.originalContent));
					}
				}

				// Inizio del checkpoint e registrazione degli originali (prima di toccarli).
				beginCheckpoint();
				for (const f of specs) {
					// FakeUri implementa solo la superficie usata dal modulo: cast verso il tipo `Uri`.
					await recordOriginal(new FakeUri(f.path) as unknown as import('vscode').Uri);
				}

				// Applicazione di modifiche arbitrarie (scrittura o cancellazione).
				for (const f of specs) {
					if (f.mutation.op === 'write') {
						files.set(f.path, ENC.encode(f.mutation.content));
					} else {
						files.delete(f.path);
					}
				}

				// Ripristino dell'ultimo gruppo di modifiche.
				await revertCheckpoint();

				// Verifica: ogni file torna all'originale; gli inesistenti vengono rimossi.
				for (const f of specs) {
					if (f.existedBefore) {
						const data = files.get(f.path);
						assert.ok(data !== undefined, `il file ripristinato deve esistere: ${f.path}`);
						assert.strictEqual(
							DEC.decode(data),
							f.originalContent,
							`contenuto ripristinato non corrispondente per ${f.path}`,
						);
					} else {
						assert.strictEqual(
							files.has(f.path),
							false,
							`un file originariamente inesistente deve essere rimosso: ${f.path}`,
						);
					}
				}
			}),
			{ numRuns: RUNS },
		);
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void run();
