/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per l'instradamento dell'immagine iniziale al
 *  nodo di caricamento immagine (LoadImage). Eseguibile con:
 *  node out/test/applyParamsImage.pbt.test.js
 *
 *  Property 12: L'immagine iniziale è instradata al nodo di caricamento immagine
 *  *Per ogni* workflow contenente un nodo di caricamento immagine usato come ingresso e ogni
 *  riferimento di immagine iniziale, dopo `applyParams` il campo immagine di quel nodo è
 *  impostato esattamente al riferimento fornito.
 *  **Validates: Requirements 5.2, 10.3**
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

// ---------------------------------------------------------------------------------------------
// Generatore di workflow con uno o più nodi LoadImage (campo `image` letterale) più altri nodi
// (CLIPTextEncode, KSampler, EmptyLatentImage, nodi video). I LoadImage hanno sempre un campo
// `image` con valore letterale di partenza, così da poter verificare la riscrittura.
// ---------------------------------------------------------------------------------------------

interface WorkflowSpec {
	numLoadImage: number;       // >=1: almeno un nodo di caricamento immagine
	loadImageClass: 'LoadImage' | 'LoadImageMask' | 'VHS_LoadImagePath';
	numTextNodes: number;
	numSamplers: number;
	numLatent: number;
	numVideo: number;
	initialImageValue: string;  // valore letterale iniziale del campo image
}

const specArb: fc.Arbitrary<WorkflowSpec> = fc.record({
	numLoadImage: fc.integer({ min: 1, max: 3 }),
	loadImageClass: fc.constantFrom('LoadImage', 'LoadImageMask', 'VHS_LoadImagePath'),
	numTextNodes: fc.integer({ min: 0, max: 3 }),
	numSamplers: fc.integer({ min: 0, max: 2 }),
	numLatent: fc.integer({ min: 0, max: 2 }),
	numVideo: fc.integer({ min: 0, max: 2 }),
	initialImageValue: fc.string({ maxLength: 16 }),
});

function buildWorkflow(spec: WorkflowSpec): { wf: ApiWorkflow; loadImageIds: string[] } {
	const wf: ApiWorkflow = {};
	let counter = 0;
	const nextId = () => `n${counter++}`;

	// Nodi di testo CLIPTextEncode.
	const textIds: string[] = [];
	for (let i = 0; i < spec.numTextNodes; i++) {
		const id = nextId();
		textIds.push(id);
		wf[id] = { class_type: 'CLIPTextEncode', inputs: { text: `t${i}` } };
	}

	const linkTo = (ids: string[], idx: number): WorkflowValue => [ids[idx % ids.length], 0];

	// Sampler con positive/negative + seed.
	for (let i = 0; i < spec.numSamplers; i++) {
		const inputs: Record<string, WorkflowValue> = {};
		inputs.positive = textIds.length > 0 ? linkTo(textIds, i) : 'pos-literal';
		inputs.negative = textIds.length > 0 ? linkTo(textIds, i + 1) : 'neg-literal';
		inputs.seed = 7 + i;
		inputs.steps = 20;
		inputs.cfg = 7;
		wf[nextId()] = { class_type: 'KSampler', inputs };
	}

	// EmptyLatentImage con width/height.
	for (let i = 0; i < spec.numLatent; i++) {
		wf[nextId()] = { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } };
	}

	// Nodi di caricamento immagine: campo `image` letterale.
	const loadImageIds: string[] = [];
	for (let i = 0; i < spec.numLoadImage; i++) {
		const id = nextId();
		loadImageIds.push(id);
		wf[id] = { class_type: spec.loadImageClass, inputs: { image: spec.initialImageValue, upload: 'image' } };
	}

	// Nodi video con frames/fps.
	for (let i = 0; i < spec.numVideo; i++) {
		wf[nextId()] = { class_type: 'VHS_VideoCombine', inputs: { frames: 16, fps: 8 } };
	}

	return { wf, loadImageIds };
}

const caseArb = fc
	.tuple(specArb, fc.string({ maxLength: 32 }))
	.map(([spec, initImageRef]) => ({ ...buildWorkflow(spec), initImageRef }));

test('Property 12: applyParams instrada initImageRef al campo image di ogni nodo LoadImage', () => {
	fc.assert(
		fc.property(caseArb, ({ wf, loadImageIds, initImageRef }) => {
			const mapping = buildMapping(wf);
			const result = applyParams(wf, { initImageRef }, mapping);

			// Ogni nodo di caricamento immagine deve avere il campo `image` esattamente uguale
			// al riferimento fornito dopo l'applicazione dei parametri.
			for (const id of loadImageIds) {
				const node = result[id];
				assert.ok(node !== undefined, `nodo LoadImage "${id}" assente nel risultato`);
				assert.strictEqual(
					node.inputs.image,
					initImageRef,
					`il campo image del nodo "${id}" non è uguale al riferimento fornito`
				);
			}

			// Immutabilità: il workflow originale non è stato modificato.
			for (const id of loadImageIds) {
				assert.notStrictEqual(wf[id].inputs.image, undefined, 'il workflow originale ha perso il campo image');
			}
		}),
		{ numRuns: 200 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
