/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la classificazione degli errori di esecuzione.
 *  Eseguibile con: node out/test/errorClassifier.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 30: Classificazione degli errori di esecuzione
 *  "Per ogni messaggio di errore, `classifyError` restituisce sempre una causa tra
 *   `missing-node`, `missing-model`, `oom-vram`, `unknown`; e per messaggi contenenti i
 *   marcatori caratteristici di una categoria (memoria insufficiente, nodo non trovato,
 *   file modello non trovato) restituisce la categoria corrispondente."
 *  **Validates: Requirements 18.1**
 *
 *  NB: il classificatore ha una priorità deterministica (oom > missing-node > missing-model),
 *  quindi i generatori delle categorie a priorità più bassa escludono i marcatori delle
 *  categorie a priorità più alta per garantire la categoria attesa.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { classifyError, ErrorCause } from '../media/errorClassifier';

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

const ALL_CAUSES: readonly ErrorCause[] = ['missing-node', 'missing-model', 'oom-vram', 'unknown'];

// Frasi che contengono i marcatori OOM_MARKERS di errorClassifier.ts. OOM ha priorità massima,
// quindi ogni frase qui DEVE classificare come 'oom-vram' anche con testo aggiuntivo benigno.
const OOM_PHRASES = [
	'out of memory',
	'OOM',
	'CUDA error: out of memory',
	'insufficient vram',
	'insufficient memory',
	'not enough vram',
	'not enough memory',
	'failed to allocate',
	'cannot allocate memory',
	'allocation failed',
	'allocation on device failed',
	'vram',
];

// Frasi che contengono i marcatori MISSING_NODE_MARKERS e NON contengono marcatori OOM
// (priorità superiore). DEVONO classificare come 'missing-node'.
const NODE_PHRASES = [
	'node type not found',
	'node type was not found',
	'node types not in list',
	'cannot execute because node',
	'this does not exist node',
	'unknown node',
	'unrecognized node',
	'missing node',
	'class_type not found',
	'class type not found',
];

// Frasi che contengono i marcatori MISSING_MODEL_MARKERS e NON contengono marcatori OOM né
// marcatori di nodo (priorità superiori). DEVONO classificare come 'missing-model'.
const MODEL_PHRASES = [
	'model not found',
	'checkpoint not found',
	'lora not found',
	'vae not found',
	'no such file or directory',
	'value not in list',
	'file not found',
	'could not find model checkpoint',
	'errno 2',
];

// Riempitivo benigno: nessuna di queste stringhe contiene marcatori di alcuna categoria
// (in particolare niente "node"/"class_type"/"vram"/"memory"/"allocate").
const FILLER = ['', 'Errore', 'durante esecuzione', 'prompt 42', 'step 3', 'workflow', '[ComfyUI]'];

// Avvolge una frase-marcatore con riempitivo benigno opzionale prima/dopo.
function wrapArb(phrases: readonly string[]): fc.Arbitrary<string> {
	return fc.tuple(
		fc.constantFrom(...FILLER),
		fc.constantFrom(...phrases),
		fc.constantFrom(...FILLER),
	).map(([pre, marker, post]) => `${pre} ${marker} ${post}`.trim());
}

test('Property 30: classifyError restituisce sempre una causa valida (qualsiasi stringa)', () => {
	fc.assert(
		fc.property(fc.string(), (message) => {
			const result = classifyError(message);
			assert.ok(
				ALL_CAUSES.includes(result.cause),
				`cause "${result.cause}" non è tra ${ALL_CAUSES.join(', ')} per il messaggio ${JSON.stringify(message)}`,
			);
			// Il detail preserva sempre il messaggio originale.
			assert.strictEqual(result.detail, message);
		}),
		{ numRuns: 300 },
	);
});

test('Property 30: messaggi con marcatore OOM ⇒ oom-vram', () => {
	fc.assert(
		fc.property(wrapArb(OOM_PHRASES), (message) => {
			assert.strictEqual(classifyError(message).cause, 'oom-vram',
				`atteso oom-vram per ${JSON.stringify(message)}`);
		}),
		{ numRuns: 300 },
	);
});

test('Property 30: messaggi con marcatore nodo (senza OOM) ⇒ missing-node', () => {
	fc.assert(
		fc.property(wrapArb(NODE_PHRASES), (message) => {
			assert.strictEqual(classifyError(message).cause, 'missing-node',
				`atteso missing-node per ${JSON.stringify(message)}`);
		}),
		{ numRuns: 300 },
	);
});

test('Property 30: messaggi con marcatore modello (senza OOM/nodo) ⇒ missing-model', () => {
	fc.assert(
		fc.property(wrapArb(MODEL_PHRASES), (message) => {
			assert.strictEqual(classifyError(message).cause, 'missing-model',
				`atteso missing-model per ${JSON.stringify(message)}`);
		}),
		{ numRuns: 300 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
