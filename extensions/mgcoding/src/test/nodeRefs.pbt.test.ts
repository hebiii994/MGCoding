/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based delle funzioni pure di `media/nodeRefs.ts`
 *  (eseguibile con: node out/test/nodeRefs.pbt.test.js)
 *
 *  Property 29: I nodi mancanti sono la differenza tra usati e noti
 *  *Per ogni* insieme di `class_type` usate da un workflow e ogni insieme di `class_type`
 *  note a ComfyUI, `missingNodes` restituisce esattamente le usate che non sono note
 *  (né più né meno).
 *  **Validates: Requirements 17.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { missingNodes } from '../media/nodeRefs';

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

// Generatore di una `class_type`: nomi realistici, con collisioni frequenti per
// stressare l'intersezione tra usati e noti.
const classTypeArb = fc.constantFrom(
	'KSampler', 'CLIPTextEncode', 'VAEDecode', 'VAEEncode', 'CheckpointLoaderSimple',
	'LoraLoader', 'EmptyLatentImage', 'SaveImage', 'LoadImage', 'ControlNetApply',
	'RMBG', 'UpscaleModelLoader', 'FluxGuidance', 'CustomNodeA', 'CustomNodeB'
);

test('Property 29: missingNodes = differenza insiemistica (used \\ known)', () => {
	fc.assert(
		fc.property(
			fc.array(classTypeArb, { maxLength: 30 }),
			fc.array(classTypeArb, { maxLength: 30 }),
			(usedArr, knownArr) => {
				const known = new Set(knownArr);
				const result = missingNodes(usedArr, known);

				const usedSet = new Set(usedArr);

				// 1) Tutto ciò che esce è "usato e non noto" (nessun elemento di troppo).
				for (const r of result) {
					assert.ok(usedSet.has(r), `output contiene "${r}" non presente tra gli usati`);
					assert.ok(!known.has(r), `output contiene "${r}" che è invece noto`);
				}

				// 2) Nessun elemento mancante: ogni usato non noto deve comparire nell'output.
				for (const u of usedSet) {
					if (!known.has(u)) {
						assert.ok(result.includes(u), `manca "${u}" (usato e non noto) nell'output`);
					}
				}

				// 3) Nessun duplicato nell'output.
				assert.strictEqual(result.length, new Set(result).size, 'output contiene duplicati');

				// 4) L'insieme dell'output è ESATTAMENTE la differenza insiemistica.
				const expected = new Set([...usedSet].filter(x => !known.has(x)));
				assert.strictEqual(result.length, expected.size, 'cardinalità diversa dalla differenza attesa');
				assert.deepStrictEqual(new Set(result), expected, 'insieme diverso dalla differenza attesa');
			}
		),
		{ numRuns: 200 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
