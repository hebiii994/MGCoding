/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il budget di ritentativi di planRecovery.
 *  Eseguibile con: node out/test/retryBudget.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 33: Budget di ritentativi limitato a 3
 *  "Per ogni errore e ogni numero di tentativi già effettuati, se la causa è `unknown` oppure
 *   i tentativi hanno raggiunto `MAX_RETRIES` (3) allora l'azione pianificata è `give-up`;
 *   di conseguenza il numero di ritentativi non supera mai 3."
 *  **Validates: Requirements 18.5, 18.6**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ClassifiedError, ErrorCause, MAX_RETRIES, planRecovery } from '../media/errorClassifier';

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

const ALL_CAUSES: readonly ErrorCause[] = ['missing-node', 'missing-model', 'oom-vram', 'unknown'];

// Genera un errore classificato qualsiasi: causa tra quelle note, detail arbitrario,
// subject opzionale. Copre l'intero spazio di input di planRecovery.
const arbError: fc.Arbitrary<ClassifiedError> = fc.record(
	{
		cause: fc.constantFrom(...ALL_CAUSES),
		detail: fc.string(),
		subject: fc.option(fc.string(), { nil: undefined }),
	},
	{ requiredKeys: ['cause', 'detail'] },
);

// Numero di tentativi già effettuati: include valori sotto, pari e oltre il budget,
// più qualche valore negativo/estremo per robustezza.
const arbAttempt: fc.Arbitrary<number> = fc.integer({ min: -2, max: MAX_RETRIES + 5 });

test('Property 33: unknown oppure attempt>=MAX_RETRIES ⇒ give-up', () => {
	fc.assert(
		fc.property(arbError, arbAttempt, (err, attempt) => {
			const action = planRecovery(err, attempt);
			if (err.cause === 'unknown' || attempt >= MAX_RETRIES) {
				assert.strictEqual(
					action.kind, 'give-up',
					`atteso give-up per cause=${err.cause} attempt=${attempt}, ricevuto ${action.kind}`,
				);
			}
		}),
		{ numRuns: 500 },
	);
});

test('Property 33: il numero di ritentativi non supera mai MAX_RETRIES (3)', () => {
	fc.assert(
		fc.property(arbError, (err) => {
			// Simula il ciclo di recupero: si ritenta finché planRecovery non dice give-up.
			let attempt = 0;
			let retries = 0;
			while (planRecovery(err, attempt).kind !== 'give-up') {
				retries++;
				attempt++;
				assert.ok(
					retries <= MAX_RETRIES,
					`il numero di ritentativi (${retries}) ha superato MAX_RETRIES (${MAX_RETRIES}) per cause=${err.cause}`,
				);
			}
			// Garanzia finale: comunque si sia usciti, i ritentativi sono entro il budget.
			assert.ok(retries <= MAX_RETRIES, `retries=${retries} oltre il budget`);
		}),
		{ numRuns: 500 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
