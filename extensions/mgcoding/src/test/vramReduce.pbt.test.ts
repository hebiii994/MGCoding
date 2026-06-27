/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la riduzione di memoria per livelli.
 *  Eseguibile con: node out/test/vramReduce.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 32: La riduzione di memoria non aumenta i parametri e rispetta il minimo
 *  "Per ogni configurazione di parametri e ogni livello di riduzione, i parametri ridotti hanno
 *   `steps`, `width`, `height` non maggiori dei correnti e non inferiori ai minimi consentiti."
 *  **Validates: Requirements 18.4, 19.2**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { GenParams, MemoryTier, MIN_GEN_PARAMS, reduceForTier } from '../media/vramProfile';

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

// Tutti i livelli di riduzione disponibili.
const tierArb: fc.Arbitrary<MemoryTier> = fc.constantFrom<MemoryTier>(0, 1, 2, 3);

// Generatore di parametri al minimo o superiore: steps/frames >= minimo,
// width/height multipli di 8 e >= minimo (i sampler ComfyUI richiedono multipli di 8).
const dimArb = fc
	.integer({ min: 0, max: 256 })
	.map(k => MIN_GEN_PARAMS.width + k * 8); // dal minimo in su, in passi di 8

// Genera params con `frames` opzionale (presente per le generazioni video).
const paramsArb: fc.Arbitrary<GenParams> = fc
	.record({
		steps: fc.integer({ min: MIN_GEN_PARAMS.steps, max: 200 }),
		cfg: fc.float({ min: 0, max: 30, noNaN: true }),
		width: dimArb,
		height: dimArb,
		frames: fc.option(fc.integer({ min: MIN_GEN_PARAMS.frames, max: 200 }), { nil: undefined }),
	})
	.map(p => {
		const out: GenParams = { steps: p.steps, cfg: p.cfg, width: p.width, height: p.height };
		if (p.frames !== undefined) {
			out.frames = p.frames;
		}
		return out;
	});

test('Property 32: la riduzione non aumenta i parametri e rispetta i minimi', () => {
	fc.assert(
		fc.property(paramsArb, tierArb, (params, tier) => {
			const r = reduceForTier(params, tier);

			// 1) Non aumenta mai rispetto ai valori correnti.
			assert.ok(r.steps <= params.steps, `steps ridotti (${r.steps}) non devono superare i correnti (${params.steps})`);
			assert.ok(r.width <= params.width, `width ridotta (${r.width}) non deve superare la corrente (${params.width})`);
			assert.ok(r.height <= params.height, `height ridotta (${r.height}) non deve superare la corrente (${params.height})`);

			// 2) Non scende mai sotto i minimi consentiti.
			assert.ok(r.steps >= MIN_GEN_PARAMS.steps, `steps (${r.steps}) non devono scendere sotto il minimo (${MIN_GEN_PARAMS.steps})`);
			assert.ok(r.width >= MIN_GEN_PARAMS.width, `width (${r.width}) non deve scendere sotto il minimo (${MIN_GEN_PARAMS.width})`);
			assert.ok(r.height >= MIN_GEN_PARAMS.height, `height (${r.height}) non deve scendere sotto il minimo (${MIN_GEN_PARAMS.height})`);

			// 3) Dimensioni sempre multipli di 8 (vincolo dei sampler ComfyUI).
			assert.strictEqual(r.width % 8, 0, `width (${r.width}) deve essere multiplo di 8`);
			assert.strictEqual(r.height % 8, 0, `height (${r.height}) deve essere multiplo di 8`);

			// 4) `frames`: presente sse e solo se presente nell'input; stessa invariante.
			if (params.frames !== undefined) {
				assert.ok(r.frames !== undefined, 'frames deve essere preservato quando presente nell\'input');
				assert.ok(r.frames! <= params.frames, `frames ridotti (${r.frames}) non devono superare i correnti (${params.frames})`);
				assert.ok(r.frames! >= MIN_GEN_PARAMS.frames, `frames (${r.frames}) non devono scendere sotto il minimo (${MIN_GEN_PARAMS.frames})`);
			} else {
				assert.strictEqual(r.frames, undefined, 'frames non deve essere introdotto quando assente nell\'input');
			}

			// 5) `cfg` non incide sulla memoria e resta invariato.
			assert.strictEqual(r.cfg, params.cfg, 'cfg non deve essere modificato');
		}),
		{ numRuns: 200 },
	);
});

// Caso esplicito: il livello 0 è l'identità per input già conformi ai minimi.
test('Property 32 (esempio): il livello 0 lascia invariati i parametri', () => {
	const params: GenParams = { steps: 30, cfg: 7, width: 1024, height: 1024, frames: 16 };
	assert.deepStrictEqual(reduceForTier(params, 0), params);
});

// Caso esplicito: input già al minimo non scende ulteriormente a nessun livello.
test('Property 32 (esempio): input al minimo resta al minimo per ogni livello', () => {
	const params: GenParams = { steps: MIN_GEN_PARAMS.steps, cfg: 7, width: MIN_GEN_PARAMS.width, height: MIN_GEN_PARAMS.height, frames: MIN_GEN_PARAMS.frames };
	for (const tier of [0, 1, 2, 3] as MemoryTier[]) {
		const r = reduceForTier(params, tier);
		assert.deepStrictEqual(r, params, `il livello ${tier} non deve scendere sotto il minimo`);
	}
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
