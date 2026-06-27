/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based di `applyParams` in `media/workflowMapping.ts`
 *  (eseguibile con: node out/test/applyParamsPrompt.pbt.test.js)
 *
 *  Property 22: Il prompt è iniettato solo nel nodo di testo risolto via link del sampler
 *  *Per ogni* workflow con uno o più nodi di testo e ogni prompt positivo/negativo, dopo
 *  `applyParams` cambia il testo del solo nodo risolto seguendo il link `positive`/`negative`
 *  del sampler, mentre il testo di tutti gli altri nodi di testo resta invariato.
 *  **Validates: Requirements 9.4, 10.1, 10.2**
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
// Generatore di workflow con uno o più nodi di testo (CLIPTextEncode), zero o più sampler che
// collegano il proprio input positive/negative a uno dei nodi di testo (oppure usano un valore
// letterale), più nodi di "contorno" non collegati. Alcuni nodi di testo restano quindi non
// referenziati da alcun sampler: il loro testo NON deve cambiare dopo `applyParams`.
// ---------------------------------------------------------------------------------------------

interface WorkflowSpec {
	// Testi iniziali (univoci) dei nodi CLIPTextEncode; la lunghezza definisce il numero di nodi.
	texts: string[];
	// Per ogni sampler: indice del nodo testo collegato a positive/negative (oppure null = letterale).
	samplers: { pos: number | null; neg: number | null }[];
	// Nodi di contorno (EmptyLatentImage) per arricchire il grafo.
	numNoise: number;
}

const specArb: fc.Arbitrary<WorkflowSpec> = fc.record({
	texts: fc
		.array(fc.string({ maxLength: 10 }), { minLength: 1, maxLength: 5 })
		// Rende i testi univoci suffissandoli con l'indice: così i confronti per nodo sono netti.
		.map(arr => arr.map((s, i) => `${s}#${i}`)),
	samplers: fc.array(
		fc.record({
			pos: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
			neg: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
		}),
		{ maxLength: 3 }
	),
	numNoise: fc.integer({ min: 0, max: 2 }),
});

function buildWorkflow(spec: WorkflowSpec): ApiWorkflow {
	const wf: ApiWorkflow = {};
	let counter = 0;
	const nextId = () => `n${counter++}`;

	// 1) Nodi di testo CLIPTextEncode con testo letterale univoco.
	const textIds: string[] = [];
	for (let i = 0; i < spec.texts.length; i++) {
		const id = nextId();
		textIds.push(id);
		wf[id] = { class_type: 'CLIPTextEncode', inputs: { text: spec.texts[i] } };
	}

	// 2) Sampler che collegano positive/negative a un nodo di testo (o usano un letterale).
	const n = textIds.length;
	const linkOrLiteral = (idx: number | null, fallback: string): WorkflowValue =>
		idx !== null && n > 0 ? ([textIds[idx % n], 0] as [string, number]) : fallback;
	for (const s of spec.samplers) {
		const id = nextId();
		wf[id] = {
			class_type: 'KSampler',
			inputs: {
				positive: linkOrLiteral(s.pos, 'positive-literal'),
				negative: linkOrLiteral(s.neg, 'negative-literal'),
				seed: 42,
				steps: 20,
				cfg: 7,
			},
		};
	}

	// 3) Nodi di contorno non collegati (non sono nodi di testo).
	for (let i = 0; i < spec.numNoise; i++) {
		wf[nextId()] = { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } };
	}

	return wf;
}

const workflowArb: fc.Arbitrary<ApiWorkflow> = specArb.map(buildWorkflow);

// Prompt distinti tra loro (e dai testi iniziali, che terminano con `#<indice>`).
const promptsArb = fc.record({
	positivePrompt: fc.string({ maxLength: 16 }).map(s => `POS::${s}`),
	negativePrompt: fc.string({ maxLength: 16 }).map(s => `NEG::${s}`),
});

// Insieme degli id dei nodi che sono nodi di testo (espongono un input `text` stringa).
function textNodeIds(wf: ApiWorkflow): string[] {
	return Object.keys(wf).filter(id => typeof wf[id].inputs.text === 'string');
}

test('Property 22: il prompt è iniettato solo nei nodi di testo risolti via link del sampler', () => {
	fc.assert(
		fc.property(workflowArb, promptsArb, (wf: ApiWorkflow, prompts) => {
			const mapping = buildMapping(wf);
			const params: LogicalParams = {
				positivePrompt: prompts.positivePrompt,
				negativePrompt: prompts.negativePrompt,
			};
			const result = applyParams(wf, params, mapping);

			// Insiemi dei nodi risolti via link positive/negative del sampler.
			const posSet = new Set((mapping.positivePrompt ?? []).map(d => d.nodeId));
			const negSet = new Set((mapping.negativePrompt ?? []).map(d => d.nodeId));

			for (const id of textNodeIds(wf)) {
				const original = wf[id].inputs.text;
				const actual = result[id].inputs.text;

				// `applyParams` applica prima il prompt positivo poi il negativo: in caso un
				// nodo sia risolto da entrambi gli slot, prevale il negativo (ultimo scritto).
				let expected: WorkflowValue;
				if (negSet.has(id)) {
					expected = prompts.negativePrompt;
				} else if (posSet.has(id)) {
					expected = prompts.positivePrompt;
				} else {
					// Nodo di testo NON risolto via sampler: il testo deve restare invariato.
					expected = original;
				}

				assert.strictEqual(
					actual,
					expected,
					`nodo testo "${id}": atteso ${JSON.stringify(expected)}, ottenuto ${JSON.stringify(actual)}`
				);
			}

			// L'input originale non deve mai essere mutato (applyParams è immutabile).
			for (const id of textNodeIds(wf)) {
				assert.ok(typeof wf[id].inputs.text === 'string', `il workflow originale è stato mutato sul nodo "${id}"`);
			}
		}),
		{ numRuns: 200 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
