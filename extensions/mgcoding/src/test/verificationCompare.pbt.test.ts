/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il verdetto di regressione del Verification_Gate.
 *
 *  Feature: self-healing, Property 4: Semantica del verdetto di regressione
 *  **Validates: Requirements 6.2, 6.3**
 *
 *  Eseguibile con: node out/test/verificationCompare.pbt.test.js
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { test, run } from './_harness';
import { compareVerification } from '../selfHealing/verification';
import { VerificationSnapshot } from '../selfHealing/types';

const RUNS = 300;

/** Snapshot con conteggi piccoli, così aumenti/diminuzioni/parità capitano spesso. */
const snapshotArb: fc.Arbitrary<VerificationSnapshot> = fc.record({
	errorCount: fc.integer({ min: 0, max: 6 }),
	failingTests: fc.integer({ min: 0, max: 6 }),
	totalTests: fc.integer({ min: 0, max: 20 })
});

test('Property 4: regression se errori/test rossi aumentano; ok se errori calano senza nuovi rossi; altrimenti no-change', () => {
	fc.assert(
		fc.property(snapshotArb, snapshotArb, (baseline, after) => {
			const verdict = compareVerification(baseline, after);

			let expected: 'ok' | 'regression' | 'no-change';
			if (after.errorCount > baseline.errorCount || after.failingTests > baseline.failingTests) {
				expected = 'regression';
			} else if (after.errorCount < baseline.errorCount && after.failingTests <= baseline.failingTests) {
				expected = 'ok';
			} else {
				expected = 'no-change';
			}
			assert.strictEqual(verdict, expected);
		}),
		{ numRuns: RUNS }
	);
});

void run();
