/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la preferenza GGUF a bassa VRAM.
 *  Eseguibile con: node out/test/vramGguf.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 35: A bassa VRAM si preferisce la variante GGUF quando disponibile
 *  "Per ogni modello richiesto con limite di VRAM basso, se è disponibile una variante
 *   quantizzata GGUF allora la variante proposta è quella GGUF."
 *  **Validates: Requirements 19.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { LOW_VRAM_GB, ModelVariant, preferVariant, VramProfile } from '../media/vramProfile';

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

// Profilo a bassa VRAM: ogni limite positivo fino a 8 GB (incluso), granularità 0.5 GB.
const lowVramProfileArb: fc.Arbitrary<VramProfile> = fc
	.integer({ min: 1, max: LOW_VRAM_GB * 2 })
	.map(half => ({ limitGB: half / 2 })); // 0.5, 1, 1.5, ... 8

// Una singola variante con nome file e flag GGUF.
const variantArb: fc.Arbitrary<ModelVariant> = fc.record({
	filename: fc.string({ minLength: 1, maxLength: 40 }),
	gguf: fc.boolean(),
});

// Lista di varianti che contiene almeno una variante GGUF (precondizione della Property 35):
// si genera una lista qualsiasi e si garantisce la presenza del GGUF inserendone uno in una
// posizione arbitraria, così la preferenza non dipende dall'ordine.
const variantsWithGgufArb: fc.Arbitrary<ModelVariant[]> = fc
	.tuple(
		fc.array(variantArb, { maxLength: 8 }),
		fc.record({ filename: fc.string({ minLength: 1, maxLength: 40 }), gguf: fc.constant(true) }),
		fc.nat(),
	)
	.map(([others, gguf, idx]) => {
		const list = others.slice();
		const at = list.length === 0 ? 0 : idx % (list.length + 1);
		list.splice(at, 0, gguf);
		return list;
	});

test('Property 35: a bassa VRAM, se esiste una variante GGUF allora la proposta è GGUF', () => {
	fc.assert(
		fc.property(variantsWithGgufArb, lowVramProfileArb, (variants, profile) => {
			// Precondizioni del dominio testato.
			assert.ok(profile.limitGB <= LOW_VRAM_GB, `il limite testato (${profile.limitGB}) deve essere <= ${LOW_VRAM_GB}`);
			assert.ok(variants.some(v => v.gguf), 'la lista generata deve contenere almeno una variante GGUF');

			const chosen = preferVariant(variants, profile);

			// La variante proposta deve esistere ed essere quella GGUF (Req. 19.3).
			assert.ok(chosen !== undefined, 'deve essere proposta una variante quando la lista non è vuota');
			assert.strictEqual(chosen!.gguf, true, `a ${profile.limitGB}GB deve essere preferita la variante GGUF, scelta: ${chosen!.filename}`);
		}),
		{ numRuns: 200 },
	);
});

// Caso esplicito: con una sola variante GGUF e una non-GGUF, a bassa VRAM si sceglie la GGUF
// anche quando la non-GGUF precede nella lista.
test('Property 35 (esempio): GGUF preferita anche se non è la prima della lista', () => {
	const variants: ModelVariant[] = [
		{ filename: 'wan2.2.safetensors', gguf: false },
		{ filename: 'wan2.2-Q4_K_M.gguf', gguf: true },
	];
	const chosen = preferVariant(variants, { limitGB: LOW_VRAM_GB });
	assert.ok(chosen !== undefined);
	assert.strictEqual(chosen!.gguf, true, 'a 8GB deve essere scelta la variante GGUF');
	assert.strictEqual(chosen!.filename, 'wan2.2-Q4_K_M.gguf');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
