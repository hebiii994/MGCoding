/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la classificazione della Fix_Proposal.
 *
 *  Feature: self-healing, Property 3: Classificazione della proposta in funzione di diff e spiegazione
 *  **Validates: Requirements 3.2, 3.4**
 *
 *  Eseguibile con: node out/test/proposalClassify.pbt.test.js
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { test, run } from './_harness';
import { classifyProposal } from '../selfHealing/issues';

const RUNS = 300;

/** Stringhe che includono spesso casi "vuoti dopo trim" (spazi, tab, newline) e undefined. */
const maybeBlankArb: fc.Arbitrary<string | undefined> = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom('', '   ', '\t', '\n  \t'),
	fc.string(),
	fc.constantFrom('--- a/x', 'fix: usa const', 'spiegazione valida')
);

test('Property 3: proposed sse diff ed explanation sono entrambi non vuoti dopo trim', () => {
	fc.assert(
		fc.property(maybeBlankArb, maybeBlankArb, (diff, explanation) => {
			const status = classifyProposal({ diff, explanation });
			const expectProposed = !!diff && diff.trim().length > 0 && !!explanation && explanation.trim().length > 0;
			assert.strictEqual(status, expectProposed ? 'proposed' : 'unresolved');
		}),
		{ numRuns: RUNS }
	);
});

void run();
