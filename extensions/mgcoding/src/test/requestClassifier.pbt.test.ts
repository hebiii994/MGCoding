/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test del classificatore di richieste (logica pura).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/requestClassifier.pbt.test.js
 *
 *  Property 1: Classificazione I2V con immagine iniziale
 *  Per ogni richiesta con intento video E immagine iniziale, `classify` => 'i2v';
 *  per ogni richiesta con intento video SENZA immagine, `classify` => 't2v';
 *  e il risultato è sempre uno tra 'image' | 't2v' | 'i2v' | 'ambiguous'.
 *
 *  **Validates: Requirements 1.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { classify, Classification } from '../media/requestClassifier';
import { GenKind, GenRequest } from '../media/genTypes';

const RUNS = 200;
const CLASSIFICATIONS: ReadonlySet<Classification> = new Set<Classification>(['image', 't2v', 'i2v', 'ambiguous']);

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

/**
 * Marcatori di intento video allineati alla logica reale del classificatore
 * (sottoinsieme di VIDEO_MARKERS in requestClassifier.ts). Usati con confini di parola.
 */
const VIDEO_WORDS = ['video', 'videos', 't2v', 'i2v', 'animation', 'animate', 'animazione', 'clip', 'movie', 'gif', 'mp4', 'webm', 'wan', 'animatediff', 'svd', 'motion', 'frames', 'fps'];

/** Frammento di testo libero (può confondere ma non deve cambiare l'esito video). */
const arbFiller = fc.string();

/** Prompt che contiene SICURAMENTE almeno un marcatore di intento video. */
const arbVideoPrompt = fc.tuple(arbFiller, fc.constantFrom(...VIDEO_WORDS), arbFiller)
	.map(([pre, word, post]) => `${pre} ${word} ${post}`);

/** Immagine iniziale non vuota (base64-like). */
const arbInitImage = fc.string({ minLength: 1 }).map(s => (s.trim().length === 0 ? `img${s}x` : s));

// --- Clausola A: intento video + immagine iniziale => 'i2v' -------------------------------
test('Property 1: intento video + immagine iniziale => i2v', () => {
	fc.assert(
		fc.property(arbVideoPrompt, arbInitImage, (prompt, initImage) => {
			const req: GenRequest = { prompt, initImage };
			return classify(req) === 'i2v';
		}),
		{ numRuns: RUNS }
	);
});

// --- Clausola B: intento video senza immagine => 't2v' -----------------------------------
test('Property 1: intento video senza immagine => t2v', () => {
	fc.assert(
		fc.property(arbVideoPrompt, fc.option(fc.constant(''), { nil: undefined }), (prompt, initImage) => {
			const req: GenRequest = { prompt, initImage };
			return classify(req) === 't2v';
		}),
		{ numRuns: RUNS }
	);
});

// --- Clausola C: il risultato è sempre uno dei quattro valori ammessi ---------------------
test('Property 1: risultato sempre in {image, t2v, i2v, ambiguous}', () => {
	const arbKind: fc.Arbitrary<GenKind> = fc.constantFrom('image', 't2v', 'i2v');
	const arbRequest: fc.Arbitrary<GenRequest> = fc.record(
		{
			prompt: fc.string(),
			initImage: fc.option(fc.string(), { nil: undefined }),
			forcedKind: fc.option(arbKind, { nil: undefined }),
			seed: fc.option(fc.integer(), { nil: undefined }),
			frames: fc.option(fc.nat(), { nil: undefined }),
			fps: fc.option(fc.nat(), { nil: undefined }),
		},
		{ requiredKeys: ['prompt'] }
	);
	fc.assert(
		fc.property(arbRequest, (req) => {
			const result = classify(req);
			assert.ok(CLASSIFICATIONS.has(result), `risultato inatteso: ${String(result)}`);
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
