/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test del classificatore di richieste (logica pura).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/requestClassifierAmbiguous.pbt.test.js
 *
 *  Property 2: Richiesta ambigua
 *  Per ogni richiesta SENZA immagine iniziale E SENZA marcatori di tipo (né video né immagine)
 *  nel prompt, `classify` => 'ambiguous'.
 *
 *  **Validates: Requirements 1.6**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { classify } from '../media/requestClassifier';
import { GenRequest } from '../media/genTypes';

const RUNS = 200;

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
 * Parole neutre che NON corrispondono ad alcun marcatore reale del classificatore
 * (né VIDEO_MARKERS né IMAGE_MARKERS in requestClassifier.ts). Verificate manualmente:
 * nessuna combina con i confini di parola dei marcatori (video/clip/gif/png/foto/draw/...).
 */
const NEUTRAL_WORDS = [
	'ciao', 'mondo', 'rosso', 'blu', 'verde', 'grande', 'piccolo', 'casa', 'albero',
	'sole', 'luna', 'gatto', 'cane', 'tavolo', 'sedia', 'bello', 'nuovo', 'vecchio',
	'acqua', 'fuoco', 'terra', 'cielo', 'fiore', 'libro', 'strada', 'montagna', 'mare',
	'hello', 'world', 'tree', 'house', 'mountain', 'river', 'happy', 'quiet', 'simple',
];

/** Separatori innocui (spazi e punteggiatura) che non introducono marcatori. */
const SEPARATORS = [' ', '  ', ', ', '. ', ' - ', '\n', '\t'];

/**
 * Prompt SICURAMENTE privo di marcatori: sequenza (anche vuota) di parole neutre unite da
 * separatori innocui. La lista vuota produce il prompt vuoto, anch'esso senza marcatori.
 */
const arbNoMarkerPrompt: fc.Arbitrary<string> = fc
	.array(fc.constantFrom(...NEUTRAL_WORDS), { minLength: 0, maxLength: 12 })
	.chain(words =>
		fc.array(fc.constantFrom(...SEPARATORS), { minLength: words.length, maxLength: words.length })
			.map(seps => words.map((w, i) => `${seps[i]}${w}`).join(''))
	);

// --- Property 2: nessuna immagine + nessun marcatore => 'ambiguous' -----------------------
test('Property 2: nessuna immagine iniziale e nessun marcatore => ambiguous', () => {
	fc.assert(
		fc.property(
			arbNoMarkerPrompt,
			// initImage assente (undefined) oppure stringa vuota: in entrambi i casi "nessuna immagine".
			fc.option(fc.constant(''), { nil: undefined }),
			(prompt, initImage) => {
				const req: GenRequest = { prompt, initImage };
				// Nessun forcedKind, nessuna immagine iniziale, nessun marcatore di tipo.
				assert.strictEqual(classify(req), 'ambiguous', `prompt inatteso non-ambiguo: ${JSON.stringify(prompt)}`);
			}
		),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
