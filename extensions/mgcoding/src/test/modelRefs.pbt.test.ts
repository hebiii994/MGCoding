/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per i riferimenti a modelli GGUF.
 *  Eseguibile con: node out/test/modelRefs.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 19: I file GGUF sono riferimenti di modello da risolvere
 *  "Per ogni workflow che usa campi nome-modello con estensione `.gguf`, ogni file `.gguf`
 *   compare in `referencedModels` con `viaGguf` vero."
 *  **Validates: Requirements 9.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ApiWorkflow, WorkflowValue } from '../media/workflowGraph';
import { referencedModels } from '../media/modelRefs';

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

// Nomi di campo nome-modello noti (allineati a MODEL_DIR_BY_FIELD in modelRefs.ts), inclusi
// i campi usati dai nodi GGUF.
const MODEL_FIELDS = [
	'ckpt_name', 'checkpoint_name', 'vae_name', 'lora_name', 'unet_name',
	'gguf_name', 'clip_name', 'clip_name1', 'control_net_name', 'upscale_model_name',
];

// Generatore di un nome di file GGUF non vuoto (es. `wan2.2-Q4.gguf`).
const ggufFilename = fc
	.stringMatching(/^[A-Za-z0-9_.\-]{1,20}$/)
	.map(base => `${base}.gguf`);

// Valore non-GGUF: nome di modello con altra estensione, link [nodeId, slot], numero o testo.
const nonGgufValue: fc.Arbitrary<WorkflowValue> = fc.oneof(
	fc.stringMatching(/^[A-Za-z0-9_.\-]{1,20}$/).map(b => `${b}.safetensors`),
	fc.tuple(fc.stringMatching(/^[0-9]{1,3}$/), fc.nat({ max: 8 })) as fc.Arbitrary<[string, number]>,
	fc.integer({ min: 0, max: 1000 }),
	fc.constantFrom('texto positivo', 'beta', 'normal'),
);

// Un input GGUF: un campo nome-modello (noto) con valore `.gguf`.
const ggufInput = fc.record({
	field: fc.constantFrom(...MODEL_FIELDS),
	value: ggufFilename,
});

// Un input "rumore": un campo qualsiasi con un valore non-GGUF (non deve generare viaGguf).
const noiseInput = fc.record({
	field: fc.oneof(fc.constantFrom(...MODEL_FIELDS), fc.constantFrom('text', 'seed', 'steps', 'cfg', 'width')),
	value: nonGgufValue,
});

// Genera un workflow API contenente almeno un input GGUF, distribuito su più nodi.
const workflowArb: fc.Arbitrary<ApiWorkflow> = fc
	.array(
		fc.record({
			ggufs: fc.array(ggufInput, { minLength: 0, maxLength: 3 }),
			noise: fc.array(noiseInput, { minLength: 0, maxLength: 3 }),
			classType: fc.constantFrom('UnetLoaderGGUF', 'CheckpointLoaderSimple', 'CLIPLoaderGGUF', 'VAELoader'),
		}),
		{ minLength: 1, maxLength: 5 },
	)
	.map(nodes => {
		const wf: ApiWorkflow = {};
		nodes.forEach((node, nodeIdx) => {
			const inputs: Record<string, WorkflowValue> = {};
			// I campi rumore prima, così un eventuale campo GGUF con lo stesso nome prevale.
			node.noise.forEach((inp, i) => { inputs[`${inp.field}_n${i}`] = inp.value; });
			node.ggufs.forEach((inp, i) => { inputs[`${inp.field}_g${i}`] = inp.value; });
			wf[`${nodeIdx}`] = { class_type: node.classType, inputs };
		});
		return wf;
	})
	// Garantisce almeno un riferimento GGUF nel workflow.
	.filter(wf => Object.values(wf).some(n => Object.values(n.inputs).some(v => typeof v === 'string' && v.toLowerCase().endsWith('.gguf'))));

test('Property 19: ogni file .gguf compare in referencedModels con viaGguf vero', () => {
	fc.assert(
		fc.property(workflowArb, wf => {
			const refs = referencedModels(wf);

			// Insieme atteso: tutti i valori stringa `.gguf` presenti negli input del workflow.
			const expectedGgufs = new Set<string>();
			for (const node of Object.values(wf)) {
				for (const value of Object.values(node.inputs)) {
					if (typeof value === 'string' && value.toLowerCase().endsWith('.gguf')) {
						expectedGgufs.add(value);
					}
				}
			}

			// Ogni file .gguf deve comparire in referencedModels con viaGguf === true.
			for (const filename of expectedGgufs) {
				const match = refs.find(r => r.filename === filename);
				assert.ok(match, `il file GGUF "${filename}" deve comparire in referencedModels`);
				assert.strictEqual(match!.viaGguf, true, `"${filename}" deve avere viaGguf === true`);
			}

			// Coerenza inversa: ogni ref con estensione .gguf ha viaGguf vero.
			for (const ref of refs) {
				if (ref.filename.toLowerCase().endsWith('.gguf')) {
					assert.strictEqual(ref.viaGguf, true, `ref "${ref.filename}" .gguf deve avere viaGguf true`);
				}
			}
		}),
		{ numRuns: 100 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
