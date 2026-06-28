/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il budget dei tentativi del Self_Healing.
 *
 *  Feature: self-healing, Property 7: Budget dei tentativi e arresto sull'assenza di progresso
 *  **Validates: Requirements 8.1, 8.2**
 *
 *  Eseguibile con: node out/test/attemptBudget.pbt.test.js
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { test, run } from './_harness';
import { decideAttempt } from '../selfHealing/budget';
import { AttemptState } from '../selfHealing/types';

const RUNS = 300;

const stateArb: fc.Arbitrary<AttemptState> = fc.record({
	attempts: fc.integer({ min: 0, max: 5 }),
	maxAttempts: fc.integer({ min: 1, max: 5 }),
	errorsBefore: fc.integer({ min: 0, max: 10 }),
	errorsAfter: fc.integer({ min: 0, max: 10 })
});

test('Property 7: stop-budget se attempts>=max; altrimenti stop-no-progress se errori non calano; altrimenti continue', () => {
	fc.assert(
		fc.property(stateArb, (state) => {
			const decision = decideAttempt(state);

			let expected: 'continue' | 'stop-budget' | 'stop-no-progress';
			if (state.attempts >= state.maxAttempts) {
				expected = 'stop-budget';
			} else if (state.errorsAfter >= state.errorsBefore) {
				expected = 'stop-no-progress';
			} else {
				expected = 'continue';
			}
			assert.strictEqual(decision, expected);
		}),
		{ numRuns: RUNS }
	);
});

void run();
