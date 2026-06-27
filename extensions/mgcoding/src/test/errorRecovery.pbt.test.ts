/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la pianificazione dell'azione di recupero.
 *  Eseguibile con: node out/test/errorRecovery.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 31: L'azione di recupero corrisponde alla causa
 *  "Per ogni errore classificato come `missing-node` l'azione di recupero è `install-node` con
 *   conferma richiesta, e per ogni errore `missing-model` l'azione è `download-model` con
 *   conferma richiesta."
 *  **Validates: Requirements 18.2, 18.3**
 *
 *  NB: `planRecovery` restituisce `give-up` quando i tentativi già usati raggiungono
 *  `MAX_RETRIES` (Req. 18.6); pertanto la proprietà vale per i tentativi entro il budget,
 *  cioè `attempt` in [0, MAX_RETRIES - 1].
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ClassifiedError, MAX_RETRIES, planRecovery, RecoveryAction } from '../media/errorClassifier';

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

// Tentativi entro il budget: 0 .. MAX_RETRIES - 1 (oltre, planRecovery → give-up).
const attemptArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: MAX_RETRIES - 1 });

// Genera un ClassifiedError con la causa indicata, `detail` arbitrario e `subject` opzionale.
function classifiedErrorArb(cause: ClassifiedError['cause']): fc.Arbitrary<ClassifiedError> {
	return fc.record(
		{
			cause: fc.constant(cause),
			detail: fc.string(),
			subject: fc.option(fc.string(), { nil: undefined }),
		},
		{ requiredKeys: ['cause', 'detail'] },
	);
}

function assertAction(actual: RecoveryAction, expectedKind: RecoveryAction['kind'], ctx: string): void {
	assert.strictEqual(actual.kind, expectedKind, `atteso kind="${expectedKind}" ${ctx}, ottenuto "${actual.kind}"`);
	assert.strictEqual(actual.requiresConfirmation, true, `attesa conferma richiesta ${ctx}`);
}

test('Property 31: missing-node ⇒ install-node con conferma (entro il budget)', () => {
	fc.assert(
		fc.property(classifiedErrorArb('missing-node'), attemptArb, (err, attempt) => {
			const action = planRecovery(err, attempt);
			assertAction(action, 'install-node', `per missing-node con attempt=${attempt}`);
		}),
		{ numRuns: 200 },
	);
});

test('Property 31: missing-model ⇒ download-model con conferma (entro il budget)', () => {
	fc.assert(
		fc.property(classifiedErrorArb('missing-model'), attemptArb, (err, attempt) => {
			const action = planRecovery(err, attempt);
			assertAction(action, 'download-model', `per missing-model con attempt=${attempt}`);
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
