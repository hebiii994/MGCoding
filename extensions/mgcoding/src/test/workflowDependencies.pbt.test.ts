/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based delle dipendenze di un workflow (`media/workflowProposal.ts`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/workflowDependencies.pbt.test.js
 *
 *  Property 11: Le dipendenze indicate per un workflow coincidono con i suoi riferimenti
 *  *Per ogni* workflow in formato API, l'insieme di modelli e nodi indicati come richiesti da
 *  `workflowDependencies(wf)` coincide esattamente con `referencedModels(wf)` e
 *  `usedClassTypes(wf)` del workflow.
 *
 *  **Validates: Requirements 4.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { workflowDependencies } from '../media/workflowProposal';
import { referencedModels } from '../media/modelRefs';
import { usedClassTypes } from '../media/nodeRefs';
import { ApiWorkflow, WorkflowValue } from '../media/workflowGraph';

const RUNS = 200;

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

// --- Generatori --------------------------------------------------------------------------

// Nomi di campo nome-modello noti (allineati a MODEL_DIR_BY_FIELD in modelRefs.ts).
const MODEL_FIELDS = [
	'ckpt_name', 'checkpoint_name', 'vae_name', 'lora_name', 'unet_name',
	'gguf_name', 'clip_name', 'clip_name1', 'control_net_name', 'upscale_model_name',
];

// `class_type` realistiche, con collisioni frequenti per stressare la deduplicazione.
const classTypeArb = fc.constantFrom(
	'KSampler', 'CLIPTextEncode', 'VAEDecode', 'VAEEncode', 'CheckpointLoaderSimple',
	'LoraLoader', 'EmptyLatentImage', 'SaveImage', 'LoadImage', 'ControlNetApply',
	'UnetLoaderGGUF', 'CLIPLoaderGGUF', 'VAELoader', 'CustomNodeA', 'CustomNodeB',
);

// Nome di file modello: GGUF, safetensors o altra estensione.
const modelFilenameArb = fc.oneof(
	fc.stringMatching(/^[A-Za-z0-9_.\-]{1,20}$/).map(b => `${b}.gguf`),
	fc.stringMatching(/^[A-Za-z0-9_.\-]{1,20}$/).map(b => `${b}.safetensors`),
	fc.stringMatching(/^[A-Za-z0-9_.\-]{1,20}$/).map(b => `${b}.ckpt`),
);

// Valore "rumore" non-modello: link [nodeId, slot], numero, booleano, testo, null.
const noiseValueArb: fc.Arbitrary<WorkflowValue> = fc.oneof(
	fc.tuple(fc.stringMatching(/^[0-9]{1,3}$/), fc.nat({ max: 8 })) as fc.Arbitrary<[string, number]>,
	fc.integer({ min: 0, max: 1000 }),
	fc.boolean(),
	fc.constantFrom('testo positivo', 'beta', 'normal', ''),
	fc.constant(null),
);

// Un input "modello": un campo nome-modello noto con un valore filename.
const modelInputArb = fc.record({
	field: fc.constantFrom(...MODEL_FIELDS),
	value: modelFilenameArb,
});

// Un input "rumore": un campo generico con un valore non-modello.
const noiseInputArb = fc.record({
	field: fc.constantFrom('text', 'seed', 'steps', 'cfg', 'width', 'height', 'latent', 'model'),
	value: noiseValueArb,
});

// Genera un workflow API arbitrario: nodi con class_type e mix di input modello/rumore.
const workflowArb: fc.Arbitrary<ApiWorkflow> = fc
	.array(
		fc.record({
			classType: classTypeArb,
			models: fc.array(modelInputArb, { maxLength: 3 }),
			noise: fc.array(noiseInputArb, { maxLength: 3 }),
		}),
		{ maxLength: 8 },
	)
	.map(nodes => {
		const wf: ApiWorkflow = {};
		nodes.forEach((node, nodeIdx) => {
			const inputs: Record<string, WorkflowValue> = {};
			node.noise.forEach((inp, i) => { inputs[`${inp.field}_n${i}`] = inp.value; });
			node.models.forEach((inp, i) => { inputs[`${inp.field}_m${i}`] = inp.value; });
			wf[`${nodeIdx}`] = { class_type: node.classType, inputs };
		});
		return wf;
	});

// --- Proprietà ---------------------------------------------------------------------------

test('Property 11: workflowDependencies coincide con referencedModels e usedClassTypes', () => {
	fc.assert(
		fc.property(workflowArb, wf => {
			const deps = workflowDependencies(wf);
			const expectedModels = referencedModels(wf);
			const expectedNodes = usedClassTypes(wf);

			// I modelli riportati coincidono esattamente (ordine e contenuto) coi riferimenti.
			assert.deepStrictEqual(
				deps.models, expectedModels,
				'deps.models non coincide con referencedModels(wf)',
			);

			// I nodi riportati coincidono esattamente (ordine e contenuto) con le class_type usate.
			assert.deepStrictEqual(
				deps.nodes, expectedNodes,
				'deps.nodes non coincide con usedClassTypes(wf)',
			);

			// Coincidenza insiemistica (indipendente dall'ordine) come controllo aggiuntivo.
			const modelKeys = (refs: typeof expectedModels) => new Set(refs.map(r => `${r.dir}/${r.filename}/${r.viaGguf}`));
			assert.deepStrictEqual(modelKeys(deps.models), modelKeys(expectedModels), 'insieme modelli diverso');
			assert.deepStrictEqual(new Set(deps.nodes), new Set(expectedNodes), 'insieme nodi diverso');
		}),
		{ numRuns: RUNS },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
