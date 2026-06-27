/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based delle funzioni pure di `media/workflowMapping.ts`
 *  (eseguibile con: node out/test/applyParamsSeedFixed.pbt.test.js)
 *
 *  Property 20: Seed fisso applicato in modo coerente a tutti gli stadi
 *  *Per ogni* workflow multi-stadio e ogni seed fisso (>=0), dopo `applyParams` tutti i nodi
 *  che espongono un campo seed (`seed`/`noise_seed`) hanno esattamente quel valore.
 *  **Validates: Requirements 9.2, 10.4**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ApiWorkflow, LogicalParams, WorkflowValue } from '../media/workflowGraph';
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

// ---------------------------------------------------------------------------------------------
// Generatore di workflow multi-stadio con più sampler che espongono campi seed/noise_seed.
//
// Ogni "stadio" è un sampler (KSampler/KSamplerAdvanced) che espone uno o entrambi i campi
// seed (`seed`, `noise_seed`) come valori letterali, con valori iniziali eterogenei tra gli
// stadi. Si aggiungono nodi accessori (testo, latent, video) senza campi seed per verificare
// che restino estranei al seed. I valori seed iniziali sono diversi dal seed fisso applicato,
// così la coerenza finale è significativa.
// ---------------------------------------------------------------------------------------------

// Campi seed possibili per uno stadio: almeno uno tra `seed`/`noise_seed`.
const seedFieldsArb: fc.Arbitrary<('seed' | 'noise_seed')[]> = fc
	.constantFrom(['seed'], ['noise_seed'], ['seed', 'noise_seed']);

interface StageSpec {
	classType: 'KSampler' | 'KSamplerAdvanced' | 'SamplerCustom';
	fields: ('seed' | 'noise_seed')[];
	// Valore seed iniziale (diverso dal seed fisso applicato).
	initial: number;
}

const stageArb: fc.Arbitrary<StageSpec> = fc.record({
	classType: fc.constantFrom('KSampler', 'KSamplerAdvanced', 'SamplerCustom'),
	fields: seedFieldsArb,
	initial: fc.integer({ min: -5, max: 1000 }),
});

interface WorkflowSpec {
	// Almeno 2 stadi => workflow multi-stadio.
	stages: StageSpec[];
	numText: number;
	numVideo: number;
}

const specArb: fc.Arbitrary<WorkflowSpec> = fc.record({
	stages: fc.array(stageArb, { minLength: 2, maxLength: 5 }),
	numText: fc.integer({ min: 0, max: 3 }),
	numVideo: fc.integer({ min: 0, max: 2 }),
});

// Assembla un ApiWorkflow concreto multi-stadio. Restituisce anche l'elenco delle
// destinazioni seed effettive `(nodeId, field)` per la verifica.
function buildWorkflow(spec: WorkflowSpec): { wf: ApiWorkflow; seedDests: { nodeId: string; field: string }[] } {
	const wf: ApiWorkflow = {};
	const seedDests: { nodeId: string; field: string }[] = [];
	let counter = 0;
	const nextId = () => `n${counter++}`;

	// Nodi di testo (senza campi seed).
	for (let i = 0; i < spec.numText; i++) {
		wf[nextId()] = { class_type: 'CLIPTextEncode', inputs: { text: `prompt-${i}` } };
	}

	// Stadi sampler con campi seed letterali.
	spec.stages.forEach((stage, i) => {
		const id = nextId();
		const inputs: Record<string, WorkflowValue> = { steps: 20, cfg: 7 };
		for (const field of stage.fields) {
			inputs[field] = stage.initial + i;
			seedDests.push({ nodeId: id, field });
		}
		wf[id] = { class_type: stage.classType, inputs };
	});

	// Nodi video (senza campi seed) per rumore strutturale.
	for (let i = 0; i < spec.numVideo; i++) {
		wf[nextId()] = { class_type: 'VHS_VideoCombine', inputs: { frames: 16, fps: 8 } };
	}

	return { wf, seedDests };
}

const caseArb: fc.Arbitrary<{ wf: ApiWorkflow; seedDests: { nodeId: string; field: string }[]; seed: number }> = fc
	.tuple(specArb, fc.integer({ min: 0, max: 0xffffffff }))
	.map(([spec, seed]) => {
		const { wf, seedDests } = buildWorkflow(spec);
		return { wf, seedDests, seed };
	});

test('Property 20: seed fisso applicato in modo coerente a tutti i campi seed degli stadi', () => {
	fc.assert(
		fc.property(caseArb, ({ wf, seedDests, seed }) => {
			const params: LogicalParams = { seed };
			const mapping = buildMapping(wf);
			const result = applyParams(wf, params, mapping);

			// Tutti i campi seed/noise_seed esposti devono avere esattamente il seed fisso.
			for (const dest of seedDests) {
				const node = result[dest.nodeId];
				assert.ok(node !== undefined, `nodo "${dest.nodeId}" assente nel risultato`);
				assert.strictEqual(
					node.inputs[dest.field],
					seed,
					`campo "${dest.field}" del nodo "${dest.nodeId}" = ${String(node.inputs[dest.field])}, atteso ${seed}`
				);
			}

			// Coerenza globale: ogni campo seed presente nell'output vale esattamente il seed.
			for (const node of Object.values(result)) {
				for (const field of ['seed', 'noise_seed']) {
					if (field in node.inputs) {
						assert.strictEqual(node.inputs[field], seed, `campo seed "${field}" non coerente`);
					}
				}
			}
		}),
		{ numRuns: 200 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
