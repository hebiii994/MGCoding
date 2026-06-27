/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test dell'ordine canonico del piano di generazione (logica pura).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/plan.pbt.test.js
 *
 *  Property 3: Il piano contiene le fasi richieste in ordine canonico
 *  Per ogni `GenKind`, il piano prodotto da `plan(kind)` contiene le fasi
 *  `select-workflow`, `check-deps`, `set-inputs`, `execute` (e `report`) e i loro indici
 *  sono in ordine strettamente crescente in quell'ordine canonico.
 *
 *  **Validates: Requirements 1.2**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { plan } from '../agent/genOrchestrator';
import { GenKind, PlanStepGen } from '../media/genTypes';

const RUNS = 200;

/** Ordine canonico atteso delle fasi del piano (Req. 1.2). */
const CANONICAL_ORDER: readonly PlanStepGen['kind'][] = [
	'select-workflow',
	'check-deps',
	'set-inputs',
	'execute',
	'report',
];

/** Fasi obbligatoriamente presenti secondo la Property 3. */
const REQUIRED_PHASES: readonly PlanStepGen['kind'][] = [
	'select-workflow',
	'check-deps',
	'set-inputs',
	'execute',
	'report',
];

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

/** Genera uno qualunque dei tipi di generazione ammessi. */
const arbKind: fc.Arbitrary<GenKind> = fc.constantFrom('image', 't2v', 'i2v');

// --- Clausola A: tutte le fasi richieste sono presenti -----------------------------------
test('Property 3: il piano contiene tutte le fasi richieste', () => {
	fc.assert(
		fc.property(arbKind, (kind) => {
			const steps = plan(kind).map(s => s.kind);
			for (const phase of REQUIRED_PHASES) {
				assert.ok(steps.includes(phase), `manca la fase '${phase}' per kind='${kind}'`);
			}
		}),
		{ numRuns: RUNS }
	);
});

// --- Clausola B: gli indici delle fasi sono strettamente crescenti in ordine canonico ----
test('Property 3: indici delle fasi strettamente crescenti in ordine canonico', () => {
	fc.assert(
		fc.property(arbKind, (kind) => {
			const steps = plan(kind).map(s => s.kind);
			const indices = CANONICAL_ORDER.map(phase => steps.indexOf(phase));
			// Ogni fase canonica deve esistere e gli indici devono crescere strettamente.
			for (let i = 0; i < indices.length; i++) {
				assert.ok(indices[i] >= 0, `fase '${CANONICAL_ORDER[i]}' assente per kind='${kind}'`);
				if (i > 0) {
					assert.ok(
						indices[i] > indices[i - 1],
						`ordine non strettamente crescente: '${CANONICAL_ORDER[i - 1]}'(${indices[i - 1]}) -> '${CANONICAL_ORDER[i]}'(${indices[i]}) per kind='${kind}'`
					);
				}
			}
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
