/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per i parametri predefiniti entro il limite VRAM.
 *  Eseguibile con: node out/test/vramDefaults.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 34: I parametri predefiniti rispettano il limite di VRAM
 *  "Per ogni limite di VRAM minore o uguale a 8 GB, i parametri predefiniti prodotti da
 *   `defaultParams` stanno entro le soglie compatibili definite per quel limite."
 *  **Validates: Requirements 19.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { defaultParams, LOW_VRAM_GB, vramThresholds } from '../media/vramProfile';

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

// Limiti di VRAM "a bassa VRAM": ogni valore positivo fino a 8 GB (incluso), con
// granularità di 0.5 GB per coprire anche i confini frazionari delle soglie.
const lowVramLimitArb: fc.Arbitrary<number> = fc
	.integer({ min: 1, max: LOW_VRAM_GB * 2 })
	.map(half => half / 2); // 0.5, 1, 1.5, ... 8

test('Property 34: i parametri predefiniti restano entro le soglie compatibili (VRAM <= 8GB)', () => {
	fc.assert(
		fc.property(lowVramLimitArb, limitGB => {
			const params = defaultParams(limitGB);
			const thr = vramThresholds(limitGB);

			// Precondizione del dominio testato: limite a bassa VRAM.
			assert.ok(limitGB <= LOW_VRAM_GB, `il limite testato (${limitGB}) deve essere <= ${LOW_VRAM_GB}`);

			// I parametri predefiniti stanno entro le soglie compatibili per quel limite (Req. 19.1).
			assert.ok(
				params.steps <= thr.maxSteps,
				`steps predefiniti (${params.steps}) non devono superare maxSteps (${thr.maxSteps}) a ${limitGB}GB`,
			);
			assert.ok(
				params.width <= thr.maxWidth,
				`width predefinita (${params.width}) non deve superare maxWidth (${thr.maxWidth}) a ${limitGB}GB`,
			);
			assert.ok(
				params.height <= thr.maxHeight,
				`height predefinita (${params.height}) non deve superare maxHeight (${thr.maxHeight}) a ${limitGB}GB`,
			);
		}),
		{ numRuns: 200 },
	);
});

// Caso esplicito: i confini delle fasce di VRAM rispettano le soglie.
test('Property 34 (esempio): ogni confine di fascia <= 8GB resta entro le soglie', () => {
	for (const limitGB of [4, 6, LOW_VRAM_GB]) {
		const params = defaultParams(limitGB);
		const thr = vramThresholds(limitGB);
		assert.ok(params.steps <= thr.maxSteps, `steps a ${limitGB}GB`);
		assert.ok(params.width <= thr.maxWidth, `width a ${limitGB}GB`);
		assert.ok(params.height <= thr.maxHeight, `height a ${limitGB}GB`);
	}
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
