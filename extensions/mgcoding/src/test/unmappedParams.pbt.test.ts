/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based della funzione pura `unmappedParams` di
 *  `media/workflowMapping.ts` (eseguibile con: node out/test/unmappedParams.pbt.test.js)
 *
 *  Property 9: I parametri non mappabili sono esattamente la differenza insiemistica
 *  *Per ogni* insieme di parametri logici richiesti e ogni mappatura, `unmappedParams`
 *  restituisce esattamente i parametri richiesti che non compaiono come chiavi nella
 *  mappatura (né più né meno).
 *  **Validates: Requirements 3.4**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { LogicalParams, ParamMapping } from '../media/workflowGraph';
import { unmappedParams } from '../media/workflowMapping';

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

// ---------------------------------------------------------------------------------------------
// Generatori intelligenti, vincolati allo spazio di input reale.
//
// Le chiavi possibili sono ESATTAMENTE le chiavi di `LogicalParams`. Generiamo:
//  - `required`: un array di parametri logici (con possibili duplicati e ordine arbitrario);
//  - `mapping`: una `ParamMapping` le cui chiavi sono un sottoinsieme arbitrario delle chiavi
//    logiche, ciascuna con un elenco NON vuoto di destinazioni `(nodeId, field)` plausibili.
// Questo copre i casi: chiavi mappate presenti/assenti in `required`, parametri richiesti
// mappati e non mappati, duplicati nell'input.
// ---------------------------------------------------------------------------------------------

const ALL_KEYS: (keyof LogicalParams)[] = [
	'positivePrompt',
	'negativePrompt',
	'seed',
	'steps',
	'cfg',
	'width',
	'height',
	'initImageRef',
	'frames',
	'fps',
];

const keyArb: fc.Arbitrary<keyof LogicalParams> = fc.constantFrom(...ALL_KEYS);

// `required`: array di chiavi (consente duplicati e qualsiasi ordine, anche vuoto).
const requiredArb: fc.Arbitrary<(keyof LogicalParams)[]> = fc.array(keyArb, { maxLength: 20 });

// Una destinazione plausibile (nodeId, field).
const destinationArb = fc.record({
	nodeId: fc.string({ minLength: 1, maxLength: 6 }),
	field: fc.string({ minLength: 1, maxLength: 6 }),
});

// `mapping`: sottoinsieme arbitrario di chiavi, ognuna con destinazioni NON vuote.
const mappingArb: fc.Arbitrary<ParamMapping> = fc
	.uniqueArray(keyArb, { maxLength: ALL_KEYS.length })
	.chain(keys =>
		fc
			.tuple(...keys.map(() => fc.array(destinationArb, { minLength: 1, maxLength: 3 })))
			.map(destLists => {
				const mapping: ParamMapping = {};
				keys.forEach((key, i) => {
					mapping[key] = destLists[i] as { nodeId: string; field: string }[];
				});
				return mapping;
			})
	);

test('Property 9: unmappedParams === required \\ keys(mapping) (esatto, deduplicato)', () => {
	fc.assert(
		fc.property(requiredArb, mappingArb, (required: (keyof LogicalParams)[], mapping: ParamMapping) => {
			const result = unmappedParams(required, mapping);

			const requiredSet = new Set(required);
			const mappedKeys = new Set(Object.keys(mapping) as (keyof LogicalParams)[]);
			// Differenza insiemistica attesa: i richiesti (distinti) che non sono chiavi della mappatura.
			const expectedSet = new Set([...requiredSet].filter(k => !mappedKeys.has(k)));
			const resultSet = new Set(result);

			// (1) Nessun duplicato nel risultato.
			assert.strictEqual(result.length, resultSet.size, `risultato con duplicati: ${JSON.stringify(result)}`);

			// (2) Il risultato è esattamente l'insieme differenza (né più né meno).
			assert.strictEqual(resultSet.size, expectedSet.size, `dimensione risultato attesa ${expectedSet.size}, ottenuta ${resultSet.size}`);
			for (const k of result) {
				// (a) ogni elemento del risultato è richiesto...
				assert.ok(requiredSet.has(k), `"${k}" nel risultato ma non in required`);
				// (b) ...e NON è una chiave della mappatura.
				assert.ok(!mappedKeys.has(k), `"${k}" nel risultato ma è una chiave della mappatura`);
			}
			// (c) ogni richiesto non mappato compare nel risultato.
			for (const k of expectedSet) {
				assert.ok(resultSet.has(k), `"${k}" richiesto e non mappato ma assente dal risultato`);
			}
		}),
		{ numRuns: 300 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
