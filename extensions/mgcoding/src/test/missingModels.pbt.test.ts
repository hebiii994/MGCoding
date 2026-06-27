/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per i modelli mancanti.
 *  Eseguibile con: node out/test/missingModels.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 27: I modelli mancanti sono la differenza tra referenziati e disponibili
 *  "Per ogni insieme di modelli referenziati e ogni insieme di nomi-file disponibili,
 *   `missingModels(refs, available)` restituisce esattamente i riferimenti il cui `filename`
 *   non è presente tra quelli disponibili."
 *  **Validates: Requirements 16.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ModelRef, missingModels } from '../media/modelRefs';

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

// Generatore di un nome-file di modello non vuoto (es. `sd_xl_base.safetensors`, `wan2.2.gguf`).
const filenameArb = fc
	.stringMatching(/^[A-Za-z0-9_.\-]{1,24}$/)
	.map(base => {
		const ext = base.length % 2 === 0 ? '.safetensors' : '.gguf';
		return `${base}${ext}`;
	});

// Generatore di un riferimento a modello.
const modelRefArb: fc.Arbitrary<ModelRef> = fc.record({
	filename: filenameArb,
	dir: fc.constantFrom('checkpoints', 'vae', 'loras', 'unet', 'clip', 'controlnet'),
	viaGguf: fc.boolean(),
});

// Insieme di riferimenti referenziati dal workflow.
const refsArb = fc.array(modelRefArb, { minLength: 0, maxLength: 12 });

// Insieme di nomi-file disponibili (indipendente dai refs, può intersecarli o meno).
const availableArb = fc.array(filenameArb, { minLength: 0, maxLength: 12 }).map(a => new Set(a));

test('Property 27: missingModels = refs con filename non disponibile (differenza insiemistica)', () => {
	fc.assert(
		fc.property(refsArb, availableArb, (refs, available) => {
			const result = missingModels(refs, available);

			// 1) Ogni elemento del risultato è un ref il cui filename NON è disponibile.
			for (const ref of result) {
				assert.ok(
					!available.has(ref.filename),
					`il risultato non deve contenere "${ref.filename}" (presente fra i disponibili)`,
				);
			}

			// 2) Ogni ref il cui filename è disponibile NON deve comparire nel risultato.
			for (const ref of refs) {
				if (available.has(ref.filename)) {
					assert.ok(
						!result.includes(ref),
						`"${ref.filename}" è disponibile e non deve comparire fra i mancanti`,
					);
				}
			}

			// 3) Completezza: il risultato è esattamente il filtro dei refs non disponibili,
			//    nello stesso ordine (preservazione di ordine e unicità dell'input).
			const expected = refs.filter(r => !available.has(r.filename));
			assert.deepStrictEqual(result, expected, 'missingModels deve coincidere con la differenza insiemistica');
		}),
		{ numRuns: 200 },
	);
});

// Caso esplicito: nessun disponibile ⇒ tutti i refs sono mancanti.
test('Property 27 (esempio): senza modelli disponibili tutti i refs sono mancanti', () => {
	const refs: ModelRef[] = [
		{ filename: 'a.safetensors', dir: 'checkpoints', viaGguf: false },
		{ filename: 'b.gguf', dir: 'unet', viaGguf: true },
	];
	assert.deepStrictEqual(missingModels(refs, new Set()), refs);
});

// Caso esplicito: tutti disponibili ⇒ nessun mancante.
test('Property 27 (esempio): con tutti i modelli disponibili nessun ref è mancante', () => {
	const refs: ModelRef[] = [
		{ filename: 'a.safetensors', dir: 'checkpoints', viaGguf: false },
		{ filename: 'b.gguf', dir: 'unet', viaGguf: true },
	];
	const available = new Set(['a.safetensors', 'b.gguf']);
	assert.deepStrictEqual(missingModels(refs, available), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
