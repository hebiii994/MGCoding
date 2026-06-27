/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based del round-trip di persistenza della mappatura
 *  (eseguibile con: node out/test/mappingRoundtrip.pbt.test.js)
 *
 *  Property 8: Round-trip di persistenza della mappatura
 *  *Per ogni* `ParamMapping` (incapsulata in una `SavedWorkflowMapping`), serializzarla con
 *  `serializeMapping` e poi deserializzarla con `deserializeMapping` produce una mappatura
 *  uguale all'originale.
 *  **Validates: Requirements 3.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { LogicalParams, ParamMapping } from '../media/workflowGraph';
import {
	SavedWorkflowMapping,
	createSavedMapping,
	deserializeMapping,
	serializeMapping,
} from '../media/workflowMapping';

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
// Generatori intelligenti per ParamMapping.
//
// Le chiavi sono esattamente i parametri logici di `LogicalParams`; ogni chiave (quando
// presente) punta a un elenco di destinazioni `(nodeId, field)`. Si genera un sottoinsieme
// arbitrario di chiavi per coprire mappature parziali, vuote e complete.
// ---------------------------------------------------------------------------------------------

// Tutte le chiavi logiche mappabili.
const LOGICAL_KEYS: (keyof LogicalParams)[] = [
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

// Una destinazione concreta `(nodeId, field)`.
const destinationArb: fc.Arbitrary<{ nodeId: string; field: string }> = fc.record({
	nodeId: fc.string({ maxLength: 8 }),
	field: fc.string({ maxLength: 8 }),
});

// Elenco (anche vuoto) di destinazioni per una singola chiave.
const destinationsArb: fc.Arbitrary<{ nodeId: string; field: string }[]> = fc.array(destinationArb, {
	maxLength: 4,
});

// Costruisce una ParamMapping scegliendo un sottoinsieme arbitrario di chiavi, ciascuna con
// il proprio elenco di destinazioni.
const mappingArb: fc.Arbitrary<ParamMapping> = fc
	.subarray(LOGICAL_KEYS)
	.chain(keys =>
		fc.tuple(...keys.map(() => destinationsArb)).map(lists => {
			const mapping: ParamMapping = {};
			keys.forEach((key, i) => {
				mapping[key] = lists[i];
			});
			return mapping;
		})
	);

// Incapsula la ParamMapping in una SavedWorkflowMapping con hash e timestamp arbitrari.
const savedArb: fc.Arbitrary<SavedWorkflowMapping> = fc.record({
	workflowHash: fc.string({ maxLength: 16 }),
	mapping: mappingArb,
	resolvedAt: fc
		.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') })
		.map(d => d.toISOString()),
});

test('Property 8: serialize -> deserialize preserva la SavedWorkflowMapping (mappatura inclusa)', () => {
	fc.assert(
		fc.property(savedArb, (saved: SavedWorkflowMapping) => {
			const roundTripped = deserializeMapping(serializeMapping(saved));
			// La mappatura deserializzata è uguale all'originale (cuore della Property 8)...
			assert.deepStrictEqual(roundTripped.mapping, saved.mapping);
			// ...e così l'intera SavedWorkflowMapping (hash + timestamp + mappatura).
			assert.deepStrictEqual(roundTripped, saved);
		}),
		{ numRuns: 300 }
	);
});

test('Property 8: round-trip via createSavedMapping su mappature arbitrarie', () => {
	fc.assert(
		fc.property(mappingArb, (mapping: ParamMapping) => {
			// createSavedMapping su un workflow minimo, poi round-trip della persistenza.
			const saved = createSavedMapping({ n0: { class_type: 'SaveImage', inputs: {} } }, mapping, '2024-01-01T00:00:00.000Z');
			const roundTripped = deserializeMapping(serializeMapping(saved));
			assert.deepStrictEqual(roundTripped.mapping, mapping);
			assert.deepStrictEqual(roundTripped, saved);
		}),
		{ numRuns: 300 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
