/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based della proposta di workflow (`media/workflowProposal.ts`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/workflowProposal.pbt.test.js
 *
 *  Property 10: Il workflow proposto supporta il tipo richiesto
 *  *Per ogni* elenco di workflow locali con le rispettive capacità e ogni tipo richiesto,
 *  se viene proposto un workflow allora quel workflow supporta il tipo richiesto; se nessun
 *  workflow supporta il tipo, non viene proposto alcun workflow (undefined).
 *
 *  **Validates: Requirements 4.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { proposeWorkflow, LocalWorkflow } from '../media/workflowProposal';
import { GenKind } from '../media/genTypes';
import { ApiWorkflow } from '../media/workflowGraph';

const RUNS = 200;
const KINDS: readonly GenKind[] = ['image', 't2v', 'i2v'];

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

const arbKind: fc.Arbitrary<GenKind> = fc.constantFrom(...KINDS);

// Un workflow API minimale e plausibile: la proposta non dipende dal contenuto del grafo,
// solo dalle `kinds` dichiarate, ma usiamo comunque una struttura realistica.
const arbApiWorkflow: fc.Arbitrary<ApiWorkflow> = fc.dictionary(
	fc.integer({ min: 0, max: 50 }).map(n => String(n)),
	fc.record({
		class_type: fc.constantFrom('KSampler', 'CLIPTextEncode', 'VAEDecode', 'LoadImage'),
		inputs: fc.constant({} as Record<string, never>)
	}),
	{ maxKeys: 5 }
) as fc.Arbitrary<ApiWorkflow>;

// Una voce di workflow locale con un sottoinsieme arbitrario (anche vuoto) di kinds supportati.
const arbLocalWorkflow: fc.Arbitrary<LocalWorkflow> = fc.record({
	name: fc.string(),
	kinds: fc.uniqueArray(arbKind, { maxLength: KINDS.length }),
	workflow: arbApiWorkflow
});

const arbLocalList = fc.array(arbLocalWorkflow, { maxLength: 12 });

// --- Clausola A: se viene proposto un workflow, esso supporta il tipo richiesto ----------
test('Property 10: il workflow proposto supporta il tipo richiesto', () => {
	fc.assert(
		fc.property(arbLocalList, arbKind, (local, kind) => {
			const proposed = proposeWorkflow(local, kind);
			if (proposed !== undefined) {
				assert.ok(
					proposed.kinds.includes(kind),
					`proposto "${proposed.name}" con kinds [${proposed.kinds.join(',')}] che non supporta "${kind}"`
				);
				// La proposta proviene sempre dall'elenco fornito.
				assert.ok(local.includes(proposed), 'il workflow proposto non appartiene all\'elenco fornito');
			}
		}),
		{ numRuns: RUNS }
	);
});

// --- Clausola B: se nessuno supporta il tipo, non viene proposto nulla (undefined) -------
test('Property 10: nessun workflow compatibile => undefined', () => {
	fc.assert(
		fc.property(arbLocalList, arbKind, (local, kind) => {
			const anySupports = local.some(w => w.kinds.includes(kind));
			const proposed = proposeWorkflow(local, kind);
			if (!anySupports) {
				assert.strictEqual(proposed, undefined, 'proposto un workflow pur senza alcun supporto al tipo');
			} else {
				assert.notStrictEqual(proposed, undefined, 'nessuna proposta pur esistendo un workflow compatibile');
			}
		}),
		{ numRuns: RUNS }
	);
});

// --- Clausola C: caso garantito con almeno un workflow compatibile inserito --------------
test('Property 10: con un workflow compatibile presente, la proposta lo supporta', () => {
	fc.assert(
		fc.property(arbLocalList, arbKind, arbApiWorkflow, fc.string(), (local, kind, wf, name) => {
			// Inseriamo in posizione arbitraria un workflow che supporta sicuramente `kind`.
			const compatible: LocalWorkflow = { name, kinds: [kind], workflow: wf };
			const list = [...local, compatible];
			const proposed = proposeWorkflow(list, kind);
			assert.notStrictEqual(proposed, undefined, 'nessuna proposta pur essendo presente un compatibile');
			assert.ok(proposed!.kinds.includes(kind), 'la proposta non supporta il tipo richiesto');
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
