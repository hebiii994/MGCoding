/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based delle funzioni pure di `media/workflowMapping.ts`
 *  (eseguibile con: node out/test/applyParamsVideo.pbt.test.js)
 *
 *  Property 13: Durata e fps sono applicati ai campi corrispondenti
 *  *Per ogni* workflow video che espone campi di durata (frames) e fps e ogni coppia di
 *  valori, dopo `applyParams` quei campi assumono esattamente i valori richiesti.
 *  **Validates: Requirements 5.3**
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
// Generatore intelligente di workflow video.
//
// Costruisce workflow che contengono uno o più nodi video, ciascuno con un campo di durata
// (uno tra `frames`/`num_frames`/`length`/`video_frames`) e/o un campo fps (uno tra
// `fps`/`frame_rate`), riconosciuti da `buildMapping`. I valori iniziali sono deliberatamente
// distinti dai valori richiesti, così l'asserzione verifica un'effettiva sovrascrittura.
// Si aggiungono nodi di "rumore" (sampler, testo, latent) privi di campi video per assicurare
// che `applyParams` tocchi solo i campi corrispondenti.
// ---------------------------------------------------------------------------------------------

// Nomi di campo riconosciuti per durata (frames) e fps in `workflowMapping.ts`.
const FRAME_FIELDS = ['frames', 'num_frames', 'length', 'video_frames'] as const;
const FPS_FIELDS = ['fps', 'frame_rate'] as const;

type FrameField = (typeof FRAME_FIELDS)[number];
type FpsField = (typeof FPS_FIELDS)[number];

// Specifica di un singolo nodo video: quali campi espone.
interface VideoNodeSpec {
	frameField: FrameField;
	fpsField: FpsField;
	// Quali campi includere effettivamente (almeno uno è garantito a livello di workflow).
	hasFrame: boolean;
	hasFps: boolean;
}

const videoNodeArb: fc.Arbitrary<VideoNodeSpec> = fc.record({
	frameField: fc.constantFrom(...FRAME_FIELDS),
	fpsField: fc.constantFrom(...FPS_FIELDS),
	hasFrame: fc.boolean(),
	hasFps: fc.boolean(),
});

interface WorkflowSpec {
	videoNodes: VideoNodeSpec[];
	numNoiseNodes: number;
}

const specArb: fc.Arbitrary<WorkflowSpec> = fc.record({
	videoNodes: fc.array(videoNodeArb, { minLength: 1, maxLength: 4 }),
	numNoiseNodes: fc.integer({ min: 0, max: 3 }),
});

// Valori di durata/fps richiesti: interi non negativi distinti dai valori iniziali (-1).
const valuesArb = fc.record({
	frames: fc.integer({ min: 0, max: 100000 }),
	fps: fc.integer({ min: 0, max: 240 }),
});

// Valore letterale iniziale, volutamente diverso dai valori richiesti (>=0) per verificare la sovrascrittura.
const INITIAL = -1;

function buildVideoWorkflow(spec: WorkflowSpec): ApiWorkflow {
	const wf: ApiWorkflow = {};
	let counter = 0;
	const nextId = () => `n${counter++}`;

	for (const node of spec.videoNodes) {
		const inputs: Record<string, WorkflowValue> = {};
		// Garantisce che ogni nodo video esponga almeno un campo riconosciuto.
		const includeFrame = node.hasFrame || !node.hasFps;
		const includeFps = node.hasFps || !node.hasFrame;
		if (includeFrame) {
			inputs[node.frameField] = INITIAL;
		}
		if (includeFps) {
			inputs[node.fpsField] = INITIAL;
		}
		inputs.filename_prefix = 'video';
		wf[nextId()] = { class_type: 'VHS_VideoCombine', inputs };
	}

	// Nodi di rumore senza campi video.
	for (let i = 0; i < spec.numNoiseNodes; i++) {
		wf[nextId()] = {
			class_type: 'CLIPTextEncode',
			inputs: { text: 'noise', clip: ['missing', 0] },
		};
	}

	return wf;
}

const workflowArb: fc.Arbitrary<ApiWorkflow> = specArb.map(buildVideoWorkflow);

test('Property 13: frames e fps assumono esattamente i valori richiesti dopo applyParams', () => {
	fc.assert(
		fc.property(workflowArb, valuesArb, (wf: ApiWorkflow, values: { frames: number; fps: number }) => {
			const mapping = buildMapping(wf);
			const result = applyParams(wf, { frames: values.frames, fps: values.fps }, mapping);

			// Ogni campo di durata riconosciuto deve valere esattamente values.frames,
			// ogni campo fps riconosciuto deve valere esattamente values.fps.
			let frameFieldsSeen = 0;
			let fpsFieldsSeen = 0;
			for (const [nodeId, node] of Object.entries(result)) {
				for (const field of FRAME_FIELDS) {
					if (field in node.inputs) {
						frameFieldsSeen++;
						assert.strictEqual(
							node.inputs[field],
							values.frames,
							`il campo durata "${field}" del nodo "${nodeId}" vale ${String(node.inputs[field])} invece di ${values.frames}`
						);
					}
				}
				for (const field of FPS_FIELDS) {
					if (field in node.inputs) {
						fpsFieldsSeen++;
						assert.strictEqual(
							node.inputs[field],
							values.fps,
							`il campo fps "${field}" del nodo "${nodeId}" vale ${String(node.inputs[field])} invece di ${values.fps}`
						);
					}
				}
			}

			// Il generatore garantisce almeno un nodo video con almeno un campo riconosciuto.
			assert.ok(frameFieldsSeen + fpsFieldsSeen > 0, 'nessun campo video presente nel workflow generato');

			// L'input originale non deve essere mutato (applyParams è immutabile).
			for (const node of Object.values(wf)) {
				for (const field of [...FRAME_FIELDS, ...FPS_FIELDS]) {
					if (field in node.inputs) {
						assert.strictEqual(node.inputs[field], INITIAL, 'applyParams ha mutato il workflow originale');
					}
				}
			}
		}),
		{ numRuns: 300 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
