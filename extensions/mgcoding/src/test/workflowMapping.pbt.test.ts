/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based delle funzioni pure di `media/workflowMapping.ts`
 *  (eseguibile con: node out/test/workflowMapping.pbt.test.js)
 *
 *  Property 7: La mappatura risolta referenzia solo nodi e campi esistenti
 *  *Per ogni* workflow in formato API, ogni voce prodotta da `buildMapping` punta a una
 *  coppia `(nodeId, field)` in cui `nodeId` esiste nel workflow e `field` esiste tra gli
 *  input di quel nodo.
 *  **Validates: Requirements 3.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ApiNode, ApiWorkflow, WorkflowValue } from '../media/workflowGraph';
import { buildMapping } from '../media/workflowMapping';

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
// Generatore intelligente di workflow in formato API.
//
// Costruisce workflow realistici e variati assegnando id di nodo univoci, poi cabla i sampler
// agli input positivo/negativo verso nodi di testo (CLIPTextEncode). Copre i casi richiesti:
// sampler con link positivo/negativo a nodi di testo, campi seed/steps/cfg/width/height,
// nodi LoadImage, nodi video con campi frames/fps. Aggiunge anche nodi di "rumore" e link
// potenzialmente penzolanti per stressare la robustezza di `buildMapping`.
// ---------------------------------------------------------------------------------------------

// Valore di testo per i nodi CLIPTextEncode.
const textArb = fc.string({ maxLength: 12 });

// Specifica della "forma" di un workflow da assemblare.
interface WorkflowSpec {
	numTextNodes: number;
	numSamplers: number;
	// Per ogni sampler, indica se positivo/negativo sono link a un nodo testo o letterali.
	samplerLinks: { pos: boolean; neg: boolean; seedField: 'seed' | 'noise_seed' }[];
	numLatent: number;        // EmptyLatentImage con width/height
	numLoadImage: number;     // LoadImage con image
	numVideo: number;         // nodi video con frames/fps
	frameField: 'frames' | 'num_frames' | 'length' | 'video_frames';
	fpsField: 'fps' | 'frame_rate';
	includeDanglingLinks: boolean;
}

const specArb: fc.Arbitrary<WorkflowSpec> = fc.record({
	numTextNodes: fc.integer({ min: 0, max: 4 }),
	numSamplers: fc.integer({ min: 0, max: 3 }),
	samplerLinks: fc.array(
		fc.record({
			pos: fc.boolean(),
			neg: fc.boolean(),
			seedField: fc.constantFrom('seed', 'noise_seed') as fc.Arbitrary<'seed' | 'noise_seed'>,
		}),
		{ maxLength: 3 }
	),
	numLatent: fc.integer({ min: 0, max: 2 }),
	numLoadImage: fc.integer({ min: 0, max: 2 }),
	numVideo: fc.integer({ min: 0, max: 2 }),
	frameField: fc.constantFrom('frames', 'num_frames', 'length', 'video_frames'),
	fpsField: fc.constantFrom('fps', 'frame_rate'),
	includeDanglingLinks: fc.boolean(),
});

// Assembla un ApiWorkflow concreto a partire dalla specifica e dai valori generati.
function buildWorkflow(spec: WorkflowSpec, texts: string[]): ApiWorkflow {
	const wf: ApiWorkflow = {};
	let counter = 0;
	const nextId = () => `n${counter++}`;

	// 1) Nodi di testo CLIPTextEncode (con campo `text`).
	const textIds: string[] = [];
	for (let i = 0; i < spec.numTextNodes; i++) {
		const id = nextId();
		textIds.push(id);
		wf[id] = {
			class_type: 'CLIPTextEncode',
			inputs: { text: texts[i % Math.max(texts.length, 1)] ?? '' },
		};
	}

	const linkTo = (ids: string[], idx: number): WorkflowValue => [ids[idx % ids.length], 0];

	// 2) Sampler (KSampler) con positive/negative + seed/steps/cfg.
	for (let i = 0; i < spec.numSamplers; i++) {
		const id = nextId();
		const cfgSpec = spec.samplerLinks[i] ?? { pos: true, neg: true, seedField: 'seed' as const };
		const inputs: Record<string, WorkflowValue> = {};
		// positive/negative: link a un nodo di testo se richiesto e disponibile, altrimenti letterale.
		inputs.positive = cfgSpec.pos && textIds.length > 0 ? linkTo(textIds, i) : 'positive-literal';
		inputs.negative = cfgSpec.neg && textIds.length > 0 ? linkTo(textIds, i + 1) : 'negative-literal';
		inputs[cfgSpec.seedField] = 42 + i;
		inputs.steps = 20;
		inputs.cfg = 7;
		wf[id] = { class_type: 'KSamplerAdvanced', inputs };
	}

	// 3) EmptyLatentImage con width/height.
	for (let i = 0; i < spec.numLatent; i++) {
		const id = nextId();
		wf[id] = {
			class_type: 'EmptyLatentImage',
			inputs: { width: 512, height: 512, batch_size: 1 },
		};
	}

	// 4) LoadImage con campo image.
	for (let i = 0; i < spec.numLoadImage; i++) {
		const id = nextId();
		wf[id] = {
			class_type: 'LoadImage',
			inputs: { image: 'input.png', upload: 'image' },
		};
	}

	// 5) Nodi video con frames/fps.
	for (let i = 0; i < spec.numVideo; i++) {
		const id = nextId();
		const inputs: Record<string, WorkflowValue> = {};
		inputs[spec.frameField] = 16;
		inputs[spec.fpsField] = 8;
		wf[id] = { class_type: 'VHS_VideoCombine', inputs };
	}

	// 6) Link penzolanti (verso nodi inesistenti) per stressare la risoluzione del grafo.
	if (spec.includeDanglingLinks) {
		const id = nextId();
		wf[id] = {
			class_type: 'CLIPTextEncode',
			inputs: { text: 'dangling', conditioning: ['does-not-exist', 0] },
		};
	}

	// Garantisce un workflow non vuoto (isApiFormat richiede almeno un nodo valido).
	if (Object.keys(wf).length === 0) {
		wf[nextId()] = { class_type: 'SaveImage', inputs: { images: ['n-missing', 0] } };
	}

	return wf;
}

const workflowArb: fc.Arbitrary<ApiWorkflow> = fc
	.tuple(specArb, fc.array(textArb, { minLength: 1, maxLength: 4 }))
	.map(([spec, texts]) => buildWorkflow(spec, texts));

test('Property 7: ogni voce di buildMapping referenzia un (nodeId, field) esistente', () => {
	fc.assert(
		fc.property(workflowArb, (wf: ApiWorkflow) => {
			const mapping = buildMapping(wf);

			for (const [param, destinations] of Object.entries(mapping)) {
				assert.ok(Array.isArray(destinations), `il parametro "${param}" non ha un elenco di destinazioni`);
				for (const dest of destinations!) {
					// (a) il nodeId deve esistere nel workflow
					const node: ApiNode | undefined = wf[dest.nodeId];
					assert.ok(node !== undefined, `parametro "${param}": nodeId "${dest.nodeId}" inesistente nel workflow`);
					// (b) il field deve esistere tra gli inputs di quel nodo
					assert.ok(
						node.inputs !== undefined && Object.prototype.hasOwnProperty.call(node.inputs, dest.field),
						`parametro "${param}": campo "${dest.field}" assente negli inputs del nodo "${dest.nodeId}"`
					);
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
