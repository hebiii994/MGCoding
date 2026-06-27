/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il degrado controllato delle funzioni.
 *  Eseguibile con: node out/test/degradation.pbt.test.js
 *
 *  `media/telemetryGating.ts` è logica PURA (nessuna dipendenza da `vscode`/`fetch`), quindi
 *  non è necessario alcuno stub per eseguire sotto node puro.
 *
 *  Design > Correctness Properties
 *  ### Property 37: Il degrado disabilita solo le funzioni dipendenti da ComfyUI
 *  "Per ogni stato di disponibilità di ComfyUI, quando ComfyUI non è disponibile l'insieme
 *   delle funzioni abilitate esclude esattamente quelle che dipendono da ComfyUI e mantiene
 *   tutte le altre."
 *  **Validates: Requirements 23.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { enabledFeatures, disabledFeatures, FeatureDescriptor } from '../media/telemetryGating';

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

// Un descrittore di funzione: id arbitrario, label opzionale, e flag di dipendenza da ComfyUI.
const featureArb: fc.Arbitrary<FeatureDescriptor> = fc.record({
	id: fc.string({ minLength: 1, maxLength: 12 }),
	label: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
	dependsOnComfy: fc.boolean(),
});

const featuresArb: fc.Arbitrary<FeatureDescriptor[]> = fc.array(featureArb, { minLength: 0, maxLength: 12 });

test('Property 37: indisponibile => esclude esattamente le funzioni ComfyUI; disponibile => tutte abilitate', () => {
	fc.assert(
		fc.property(featuresArb, fc.boolean(), (features, comfyAvailable) => {
			const enabled = enabledFeatures(features, comfyAvailable);
			const disabled = disabledFeatures(features, comfyAvailable);

			if (comfyAvailable) {
				// ComfyUI disponibile: TUTTE le funzioni sono abilitate, nessuna disabilitata.
				assert.deepStrictEqual(enabled, [...features], 'con ComfyUI disponibile tutte le funzioni devono essere abilitate');
				assert.strictEqual(disabled.length, 0, 'con ComfyUI disponibile non ci devono essere funzioni disabilitate');
				return;
			}

			// ComfyUI NON disponibile.
			// 1) L'insieme abilitato è ESATTAMENTE quello delle funzioni che NON dipendono da ComfyUI.
			const expectedEnabled = features.filter(f => !f.dependsOnComfy);
			assert.deepStrictEqual(enabled, expectedEnabled, 'devono restare abilitate esattamente le funzioni non-ComfyUI');

			// 2) Nessuna funzione abilitata dipende da ComfyUI (esclusione esatta).
			assert.ok(enabled.every(f => !f.dependsOnComfy), 'nessuna funzione abilitata può dipendere da ComfyUI');

			// 3) Tutte le funzioni non-ComfyUI sono mantenute (nessuna persa).
			for (const f of features) {
				if (!f.dependsOnComfy) {
					assert.ok(enabled.includes(f), 'ogni funzione non-ComfyUI deve restare abilitata');
				}
			}

			// 4) Il disabilitato è esattamente il complemento: le funzioni dipendenti da ComfyUI.
			const expectedDisabled = features.filter(f => f.dependsOnComfy);
			assert.deepStrictEqual(disabled, expectedDisabled, 'devono essere disabilitate esattamente le funzioni ComfyUI');

			// 5) Abilitate e disabilitate partizionano l'insieme di partenza (per cardinalità).
			assert.strictEqual(enabled.length + disabled.length, features.length, 'abilitate + disabilitate = totale');
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
