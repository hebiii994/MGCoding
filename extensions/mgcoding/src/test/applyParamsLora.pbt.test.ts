/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based di `applyParams` in `media/workflowMapping.ts`
 *  (eseguibile con: node out/test/applyParamsLora.pbt.test.js)
 *
 *  Property 21: I collegamenti dei LoRA sono preservati
 *  *Per ogni* workflow contenente nodi LoRA e ogni insieme di parametri, dopo `applyParams`
 *  tutti gli input che sono collegamenti (tuple `[nodeId, slot]`) restano identici a prima
 *  dell'applicazione.
 *  **Validates: Requirements 9.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ApiWorkflow, LogicalParams, WorkflowValue, isLink } from '../media/workflowGraph';
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
// Generatore di workflow che contengono una catena di nodi LoraLoader, ciascuno collegato al
// precedente (o al checkpoint iniziale) tramite i link `model`/`clip`. Sui LoRA si appoggiano
// nodi di testo (CLIPTextEncode), un EmptyLatentImage e uno o più sampler che collegano model,
// positive, negative e latent_image. Il grafo mescola quindi input collegati (link) e input
// letterali sugli stessi campi che `applyParams` potrebbe voler scrivere (seed, steps, ...),
// così da verificare che i collegamenti non vengano MAI sovrascritti.
// ---------------------------------------------------------------------------------------------

interface WorkflowSpec {
	// Numero di nodi LoraLoader nella catena (>=1 per garantire la presenza di LoRA).
	numLoras: number;
	// Numero di nodi di testo CLIPTextEncode collegati alla catena LoRA.
	numTexts: number;
	// Numero di sampler che consumano la catena.
	numSamplers: number;
	// Se includere un nodo LoadImage (campo immagine letterale) collegato a un VAEEncode.
	withImage: boolean;
	// Se includere un nodo video con campi frames/fps letterali alimentati da un link.
	withVideo: boolean;
}

const specArb: fc.Arbitrary<WorkflowSpec> = fc.record({
	numLoras: fc.integer({ min: 1, max: 4 }),
	numTexts: fc.integer({ min: 1, max: 3 }),
	numSamplers: fc.integer({ min: 1, max: 3 }),
	withImage: fc.boolean(),
	withVideo: fc.boolean(),
});

function buildWorkflow(spec: WorkflowSpec): ApiWorkflow {
	const wf: ApiWorkflow = {};
	let counter = 0;
	const nextId = () => `n${counter++}`;
	const link = (id: string, slot: number): [string, number] => [id, slot];

	// 1) Checkpoint iniziale: produce MODEL (slot 0) e CLIP (slot 1).
	const ckptId = nextId();
	wf[ckptId] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } };

	// 2) Catena di LoraLoader: ogni nodo collega model/clip al precedente (o al checkpoint).
	let prevModel: [string, number] = link(ckptId, 0);
	let prevClip: [string, number] = link(ckptId, 1);
	for (let i = 0; i < spec.numLoras; i++) {
		const id = nextId();
		wf[id] = {
			class_type: 'LoraLoader',
			inputs: {
				model: prevModel,
				clip: prevClip,
				lora_name: `lora_${i}.safetensors`,
				strength_model: 1,
				strength_clip: 1,
			},
		};
		prevModel = link(id, 0);
		prevClip = link(id, 1);
	}

	// 3) Nodi di testo CLIPTextEncode: clip collegato all'ultimo LoRA, testo letterale.
	const textIds: string[] = [];
	for (let i = 0; i < spec.numTexts; i++) {
		const id = nextId();
		textIds.push(id);
		wf[id] = { class_type: 'CLIPTextEncode', inputs: { clip: prevClip, text: `text-${i}` } };
	}

	// 4) Latent iniziale (campi width/height letterali) o, se withImage, via VAEEncode da LoadImage.
	let latent: [string, number];
	if (spec.withImage) {
		const loadId = nextId();
		wf[loadId] = { class_type: 'LoadImage', inputs: { image: 'init.png' } };
		const vaeId = nextId();
		wf[vaeId] = { class_type: 'VAEEncode', inputs: { pixels: link(loadId, 0), vae: link(ckptId, 2) } };
		latent = link(vaeId, 0);
	} else {
		const emptyId = nextId();
		wf[emptyId] = { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } };
		latent = link(emptyId, 0);
	}

	// 5) Sampler: model dalla catena LoRA, positive/negative dai nodi di testo, latent collegato,
	//    più campi letterali (seed/steps/cfg) che `applyParams` potrebbe scrivere.
	for (let i = 0; i < spec.numSamplers; i++) {
		const id = nextId();
		const pos = textIds[i % textIds.length];
		const neg = textIds[(i + 1) % textIds.length];
		wf[id] = {
			class_type: 'KSampler',
			inputs: {
				model: prevModel,
				positive: link(pos, 0),
				negative: link(neg, 0),
				latent_image: latent,
				seed: 42,
				steps: 20,
				cfg: 7,
			},
		};
	}

	// 6) Nodo video opzionale: campi frames/fps letterali alimentati da un input collegato.
	if (spec.withVideo) {
		const id = nextId();
		wf[id] = {
			class_type: 'VHS_VideoCombine',
			inputs: { images: latent, frames: 16, fps: 8 },
		};
	}

	return wf;
}

const workflowArb: fc.Arbitrary<ApiWorkflow> = specArb.map(buildWorkflow);

// Insieme di parametri logici vari: tutti i campi opzionali possono comparire o meno e con
// valori variabili (incluso seed casuale quando assente/negativo).
const paramsArb: fc.Arbitrary<LogicalParams> = fc.record(
	{
		positivePrompt: fc.string({ maxLength: 16 }).map(s => `POS::${s}`),
		negativePrompt: fc.string({ maxLength: 16 }).map(s => `NEG::${s}`),
		seed: fc.integer({ min: -1, max: 1_000_000 }),
		steps: fc.integer({ min: 1, max: 150 }),
		cfg: fc.double({ min: 0, max: 30, noNaN: true }),
		width: fc.integer({ min: 64, max: 2048 }),
		height: fc.integer({ min: 64, max: 2048 }),
		initImageRef: fc.string({ maxLength: 12 }).map(s => `img-${s}.png`),
		frames: fc.integer({ min: 1, max: 240 }),
		fps: fc.integer({ min: 1, max: 60 }),
	},
	{ requiredKeys: [] }
);

// Raccoglie tutti gli input che sono link `[nodeId, slot]`, indicizzati per `nodeId/field`.
function collectLinks(wf: ApiWorkflow): Map<string, [string, number]> {
	const links = new Map<string, [string, number]>();
	for (const [nodeId, node] of Object.entries(wf)) {
		for (const [field, value] of Object.entries(node.inputs)) {
			if (isLink(value)) {
				links.set(`${nodeId}/${field}`, value);
			}
		}
	}
	return links;
}

test('Property 21: i collegamenti (link) — LoRA inclusi — restano identici dopo applyParams', () => {
	fc.assert(
		fc.property(workflowArb, paramsArb, (wf: ApiWorkflow, params: LogicalParams) => {
			const before = collectLinks(wf);
			// Pre-condizione del generatore: esistono effettivamente dei collegamenti LoRA.
			assert.ok(before.size > 0, 'il workflow generato deve contenere almeno un collegamento');

			const mapping = buildMapping(wf);
			const result = applyParams(wf, params, mapping);

			// Ogni link presente prima deve esistere identico dopo (stessi nodeId e slot).
			for (const [key, originalLink] of before) {
				const [nodeId, field] = key.split('/');
				const actual: WorkflowValue | undefined = result[nodeId]?.inputs?.[field];
				assert.ok(
					isLink(actual),
					`il campo "${key}" non è più un collegamento dopo applyParams: ${JSON.stringify(actual)}`
				);
				assert.deepStrictEqual(
					actual,
					originalLink,
					`il collegamento "${key}" è cambiato: atteso ${JSON.stringify(originalLink)}, ottenuto ${JSON.stringify(actual)}`
				);
			}

			// Nessun collegamento nuovo deve sparire né cambiare numero: l'insieme dei link è invariato.
			const after = collectLinks(result);
			assert.strictEqual(after.size, before.size, 'il numero di collegamenti è cambiato dopo applyParams');

			// L'input originale non deve mai essere mutato (applyParams è immutabile).
			const beforeAgain = collectLinks(wf);
			assert.strictEqual(beforeAgain.size, before.size, 'il workflow originale è stato mutato da applyParams');
		}),
		{ numRuns: 200 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
