/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il guard sulla riduzione del numero di test.
 *
 *  Feature: self-healing, Property 6: Il guard rifiuta la riduzione del numero di test
 *  **Validates: Requirements 7.3**
 *
 *  Eseguibile con: node out/test/guardTestCount.pbt.test.js
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { test, run } from './_harness';
import { checkTestCountGuard } from '../selfHealing/guard';
import { VerificationSnapshot } from '../selfHealing/types';

const RUNS = 300;

const snapshotArb: fc.Arbitrary<VerificationSnapshot> = fc.record({
	errorCount: fc.integer({ min: 0, max: 6 }),
	failingTests: fc.integer({ min: 0, max: 6 }),
	totalTests: fc.integer({ min: 0, max: 50 })
});

test('Property 6: checkTestCountGuard rifiuta sse after.totalTests < baseline.totalTests', () => {
	fc.assert(
		fc.property(snapshotArb, snapshotArb, (baseline, after) => {
			const verdict = checkTestCountGuard(baseline, after);
			const reduced = after.totalTests < baseline.totalTests;
			assert.strictEqual(verdict.ok, !reduced, 'ok deve essere falso sse i test sono diminuiti');
			if (!verdict.ok) {
				assert.ok(verdict.reason.length > 0, 'il rifiuto deve avere un motivo non vuoto');
			}
		}),
		{ numRuns: RUNS }
	);
});

void run();
