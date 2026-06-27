/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la coerenza "produce video" / nodi output.
 *  Eseguibile con: node out/test/outputClassifier.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 14: Coerenza tra rilevazione "produce video" e presenza di nodi di output video
 *  "Per ogni workflow, la rilevazione 'produce video' è vera se e solo se il workflow contiene
 *   almeno un nodo di output video."
 *  **Validates: Requirements 5.5**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ApiWorkflow } from '../media/workflowGraph';
import { producesVideo, isVideoOutputNode } from '../media/outputClassifier';

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

// `class_type` che corrispondono ai VIDEO_OUTPUT_NODE_PATTERNS di outputClassifier.ts
// (videocombine, video*combine, combine*video, savevideo, createvideo, saveanimated,
//  savewebm, savegif). Ogni voce qui DEVE essere riconosciuta come nodo di output video.
const VIDEO_OUTPUT_CLASS_TYPES = [
	'VHS_VideoCombine', 'VideoCombine', 'SaveVideo', 'CreateVideo',
	'SaveAnimatedWEBP', 'SaveAnimatedPNG', 'SaveWEBM', 'SaveGIF',
];

// `class_type` che NON corrispondono a nessun pattern di output video. Nessuna di queste
// deve contenere le sottostringhe video/combine/savevideo/createvideo/saveanimated/savewebm/savegif.
const NON_VIDEO_CLASS_TYPES = [
	'CheckpointLoaderSimple', 'KSampler', 'KSamplerAdvanced', 'CLIPTextEncode',
	'VAEDecode', 'VAELoader', 'SaveImage', 'PreviewImage', 'LoadImage',
	'EmptyLatentImage', 'LoraLoader', 'ControlNetApply',
];

// Un nodo etichettato: `isVideo` indica se il suo class_type appartiene all'insieme video.
const labeledNode = fc.oneof(
	fc.constantFrom(...VIDEO_OUTPUT_CLASS_TYPES).map(ct => ({ classType: ct, isVideo: true })),
	fc.constantFrom(...NON_VIDEO_CLASS_TYPES).map(ct => ({ classType: ct, isVideo: false })),
);

// Genera un workflow API da un elenco di nodi etichettati (può essere vuoto).
const workflowArb: fc.Arbitrary<{ wf: ApiWorkflow; expected: boolean }> = fc
	.array(labeledNode, { minLength: 0, maxLength: 8 })
	.map(nodes => {
		const wf: ApiWorkflow = {};
		nodes.forEach((node, idx) => {
			wf[`${idx}`] = { class_type: node.classType, inputs: {} };
		});
		const expected = nodes.some(n => n.isVideo);
		return { wf, expected };
	});

test('Property 14: producesVideo iff esiste almeno un nodo di output video', () => {
	fc.assert(
		fc.property(workflowArb, ({ wf, expected }) => {
			const result = producesVideo(wf);

			// Bicondizionale rispetto all'etichetta usata per costruire il workflow.
			assert.strictEqual(result, expected,
				`producesVideo deve essere ${expected} per il workflow ${JSON.stringify(wf)}`);

			// Coerenza indipendente: producesVideo è vero sse qualche nodo è isVideoOutputNode.
			const anyVideoNode = Object.values(wf).some(n => isVideoOutputNode(n.class_type));
			assert.strictEqual(result, anyVideoNode,
				'producesVideo deve coincidere con la presenza di un nodo isVideoOutputNode');
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
