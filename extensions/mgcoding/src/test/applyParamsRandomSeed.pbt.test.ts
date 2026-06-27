/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il seed casuale di `media/workflowMapping.ts`.
 *  Eseguibile con: node out/test/applyParamsRandomSeed.pbt.test.js
 *
 *  Property 23: Seed casuale impostato su tutti i campi seed entro il range
 *  *Per ogni* workflow, applicando i parametri senza seed fisso (seed assente oppure negativo),
 *  ogni nodo che espone un campo seed riceve un intero non negativo entro il range consentito
 *  (0..0xFFFFFFFF) e nessun campo seed resta non impostato.
 *  **Validates: Requirements 10.5**
 *
 *  Nota: `applyParams` usa `Math.random` internamente per il seed casuale; il test non verifica
 *  l'aleatorietà, ma solo che ogni campo seed risulti impostato a un intero nel range valido.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ApiWorkflow, WorkflowValue } from '../media/workflowGraph';
import { applyParams, buildMapping } from '../media/workflowMapping';

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

// Range del seed consentito: intero non negativo a 32 bit (come MAX_SEED in workflowMapping.ts).
const MAX_SEED = 0xffffffff;

// Campi seed riconosciuti da `buildMapping`/`applyParams`.
const SEED_FIELDS = ['seed', 'noise_seed'] as const;
type SeedField = (typeof SEED_FIELDS)[number];

// ---------------------------------------------------------------------------------------------
// Generatore intelligente di workflow con uno o più nodi che espongono un campo seed
// (`seed` e/o `noise_seed`) come valore LETTERALE (non link, così applyParams può impostarlo).
// Vengono aggiunti nodi di "rumore" privi di campi seed, e nodi con campi seed che inizialmente
// hanno un valore letterale distinto, per verificare che il campo venga effettivamente impostato.
// ---------------------------------------------------------------------------------------------

interface SeedNodeSpec {
	hasSeed: boolean;
	hasNoiseSeed: boolean;
	classType: string;
}

// Garantisce che ogni nodo seed esponga almeno un campo seed.
const seedNodeArb: fc.Arbitrary<SeedNodeSpec> = fc
	.record({
		hasSeed: fc.boolean(),
		hasNoiseSeed: fc.boolean(),
		classType: fc.constantFrom('KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'RandomNoise'),
	})
	.map(spec => (spec.hasSeed || spec.hasNoiseSeed ? spec : { ...spec, hasSeed: true }));

interface WorkflowSpec {
	seedNodes: SeedNodeSpec[];
	numNoiseNodes: number;
	// Valore letterale iniziale dei campi seed (volutamente fuori dal modo "casuale").
	initialSeed: number;
}

const specArb: fc.Arbitrary<WorkflowSpec> = fc.record({
	seedNodes: fc.array(seedNodeArb, { minLength: 1, maxLength: 5 }),
	numNoiseNodes: fc.integer({ min: 0, max: 3 }),
	initialSeed: fc.integer({ min: 0, max: 1000 }),
});

function buildSeedWorkflow(spec: WorkflowSpec): ApiWorkflow {
	const wf: ApiWorkflow = {};
	let counter = 0;
	const nextId = () => `n${counter++}`;

	for (const node of spec.seedNodes) {
		const inputs: Record<string, WorkflowValue> = {};
		if (node.hasSeed) {
			inputs.seed = spec.initialSeed;
		}
		if (node.hasNoiseSeed) {
			inputs.noise_seed = spec.initialSeed;
		}
		inputs.steps = 20;
		wf[nextId()] = { class_type: node.classType, inputs };
	}

	// Nodi di rumore senza campi seed.
	for (let i = 0; i < spec.numNoiseNodes; i++) {
		wf[nextId()] = {
			class_type: 'CLIPTextEncode',
			inputs: { text: 'noise', clip: ['missing', 0] },
		};
	}

	return wf;
}

const workflowArb: fc.Arbitrary<ApiWorkflow> = specArb.map(buildSeedWorkflow);

// Seed "non fisso": assente (undefined) oppure negativo (qualsiasi intero < 0).
const noFixedSeedArb: fc.Arbitrary<number | undefined> = fc.oneof(
	fc.constant<number | undefined>(undefined),
	fc.integer({ min: -1_000_000, max: -1 })
);

test('Property 23: senza seed fisso, ogni campo seed è un intero non negativo entro il range', () => {
	fc.assert(
		fc.property(workflowArb, noFixedSeedArb, (wf: ApiWorkflow, seed: number | undefined) => {
			const mapping = buildMapping(wf);
			const result = applyParams(wf, seed === undefined ? {} : { seed }, mapping);

			let seedFieldsSeen = 0;
			for (const [nodeId, node] of Object.entries(result)) {
				for (const field of SEED_FIELDS) {
					if (field in node.inputs) {
						seedFieldsSeen++;
						const value = node.inputs[field as SeedField];
						// Deve essere impostato a un numero (nessun campo seed resta non impostato).
						assert.strictEqual(
							typeof value,
							'number',
							`il campo "${field}" del nodo "${nodeId}" non è un numero: ${String(value)}`
						);
						const n = value as number;
						// Intero.
						assert.ok(Number.isInteger(n), `il campo "${field}" del nodo "${nodeId}" non è un intero: ${n}`);
						// Non negativo.
						assert.ok(n >= 0, `il campo "${field}" del nodo "${nodeId}" è negativo: ${n}`);
						// Entro il range consentito.
						assert.ok(n <= MAX_SEED, `il campo "${field}" del nodo "${nodeId}" supera il range: ${n}`);
					}
				}
			}

			// Il generatore garantisce almeno un nodo con almeno un campo seed.
			assert.ok(seedFieldsSeen > 0, 'nessun campo seed presente nel workflow generato');
		}),
		{ numRuns: 200 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
