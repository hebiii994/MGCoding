/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il parsing PURO degli eventi di avanzamento.
 *  Eseguibile con: node out/test/progressMonitor.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 18: Gli eventi di avanzamento mappano a stati validi
 *  "Per ogni evento di avanzamento ricevuto, l'aggiornamento prodotto ha `percent`
 *   nell'intervallo `[0, 100]`; e per ogni evento di esecuzione di un nodo, `currentNode` è
 *   valorizzato col nodo indicato dall'evento."
 *  **Validates: Requirements 8.1**
 *
 *  Nota: importiamo SOLO la funzione pura `parseProgressEvent`. Il modulo dichiara
 *  `import type * as vscode from 'vscode'` (cancellato a runtime), quindi l'esecuzione con
 *  node puro non istanzia l'adapter WebSocket (che userebbe globali di runtime).
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	ComfyExecutingEvent,
	ComfyProgressEvent,
	parseProgressEvent,
} from '../media/progressMonitor';

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

// Identificatore di nodo non vuoto e privo di separatori, come usato da ComfyUI.
const nodeIdArb = fc.stringMatching(/^[A-Za-z0-9_:.-]{1,16}$/);

// Numeri che coprono l'intero spazio di input: finiti (incl. negativi e grandi) e non finiti
// (NaN/±Infinity) per esercitare la robustezza del clamp.
const numberArb = fc.oneof(
	fc.double(),                                   // include NaN/±Infinity
	fc.double({ min: -1e6, max: 1e6, noNaN: true }), // finiti "tipici"
	fc.integer({ min: -1000, max: 1000 }),         // interi su step/max realistici
);

// Evento `progress`: value/max numerici, node opzionale (stringa | null | assente).
const progressEventArb: fc.Arbitrary<ComfyProgressEvent> = fc.record({
	type: fc.constant('progress' as const),
	data: fc.record({
		value: numberArb,
		max: numberArb,
		node: fc.option(fc.oneof(nodeIdArb, fc.constant(null)), { nil: undefined }),
	}),
});

// Evento `executing` con un nodo non vuoto indicato (caso "esecuzione di un nodo").
const executingWithNodeArb: fc.Arbitrary<{ evt: ComfyExecutingEvent; node: string }> = nodeIdArb.map(
	(node) => ({ evt: { type: 'executing' as const, data: { node } }, node }),
);

test('Property 18a: ogni evento progress produce percent in [0, 100]', () => {
	fc.assert(
		fc.property(progressEventArb, (evt) => {
			const update = parseProgressEvent(evt);
			assert.ok(update !== undefined, 'un evento progress ben formato deve produrre un update');
			assert.ok(Number.isFinite(update!.percent), `percent deve essere finito, era ${update!.percent}`);
			assert.ok(update!.percent >= 0, `percent deve essere >= 0, era ${update!.percent}`);
			assert.ok(update!.percent <= 100, `percent deve essere <= 100, era ${update!.percent}`);
		}),
		{ numRuns: 200 },
	);
});

test('Property 18b: ogni evento executing valorizza currentNode col nodo indicato', () => {
	fc.assert(
		fc.property(executingWithNodeArb, ({ evt, node }) => {
			const update = parseProgressEvent(evt);
			assert.ok(update !== undefined, 'un evento executing ben formato deve produrre un update');
			assert.strictEqual(update!.currentNode, node,
				`currentNode deve essere '${node}', era '${update!.currentNode}'`);
			// L'evento executing non porta informazione di completamento: percent resta 0 in [0,100].
			assert.strictEqual(update!.percent, 0, `percent deve essere 0 per executing, era ${update!.percent}`);
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
