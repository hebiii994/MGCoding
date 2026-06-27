/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la selezione automatica del backend.
 *  Eseguibile con: node out/test/backendSelect.pbt.test.js
 *
 *  NOTA: `media/imageGen.ts` fa `import` di moduli che a loro volta caricano `vscode`.
 *  Importiamo PRIMA lo stub `./vscodeStub` per poter eseguire sotto node puro.
 *
 *  Design > Correctness Properties
 *  ### Property 24: Selezione automatica del backend di generazione disponibile
 *  "Per ogni insieme di backend con disponibilità e priorità, quando nessun backend è forzato
 *   la scelta è il primo backend disponibile secondo l'ordine di priorità, e appartiene sempre
 *   all'insieme dei disponibili."
 *  **Validates: Requirements 11.1**
 *--------------------------------------------------------------------------------------------*/

import './vscodeStub';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { chooseGenerationBackend, GenerationBackendDescriptor, BackendSelectionContext } from '../media/imageGen';

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

// Un descrittore di backend: id arbitrario, disponibilità, priorità (anche con pareggi),
// e capacità video (non rilevante per richieste non-video, ma generata per realismo).
const descriptorArb: fc.Arbitrary<GenerationBackendDescriptor> = fc.record({
	id: fc.constantFrom('a1111', 'comfyui', 'gemini', 'openai', 'local-x', 'cloud-y'),
	available: fc.boolean(),
	priority: fc.integer({ min: -5, max: 10 }),
	supportsVideo: fc.boolean(),
});

const descriptorsArb: fc.Arbitrary<GenerationBackendDescriptor[]> = fc.array(descriptorArb, { minLength: 0, maxLength: 8 });

// Contesto che NON forza alcun backend e non chiede video: forcedId assente o 'auto'.
const noForceCtxArb: fc.Arbitrary<BackendSelectionContext> = fc.oneof(
	fc.constant<BackendSelectionContext>({}),
	fc.constant<BackendSelectionContext>({ forcedId: 'auto' }),
	fc.constant<BackendSelectionContext>({ video: false }),
	fc.constant<BackendSelectionContext>({ forcedId: 'auto', video: false }),
);

test('Property 24: senza forzatura sceglie il primo disponibile per priorità ed è nell\'insieme dei disponibili', () => {
	fc.assert(
		fc.property(descriptorsArb, noForceCtxArb, (descriptors, ctx) => {
			const result = chooseGenerationBackend(descriptors, ctx);

			// Insieme dei disponibili (ordine originale preservato).
			const available = descriptors.filter(d => d.available);

			if (available.length === 0) {
				// Nessun candidato => nessuna scelta.
				assert.strictEqual(result, undefined, 'senza backend disponibili la scelta deve essere undefined');
				return;
			}

			// Atteso: primo disponibile per ordine di priorità (sort stabile, come l'implementazione).
			const expected = [...available].sort((a, b) => a.priority - b.priority)[0];

			assert.ok(result, 'con almeno un backend disponibile deve esserci una scelta');
			// La scelta è esattamente il descrittore atteso (stesso riferimento).
			assert.strictEqual(result, expected, 'la scelta deve essere il primo disponibile per priorità');
			// La scelta appartiene sempre all'insieme dei disponibili.
			assert.strictEqual(result!.available, true, 'la scelta deve essere un backend disponibile');
			assert.ok(available.includes(result!), 'la scelta deve appartenere all\'insieme dei disponibili');
			// Nessun disponibile ha priorità strettamente inferiore alla scelta.
			for (const d of available) {
				assert.ok(d.priority >= result!.priority, 'nessun disponibile può avere priorità inferiore alla scelta');
			}
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
