/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il guard sui Protected_Path.
 *
 *  Feature: self-healing, Property 5: Il guard rifiuta le proposte che toccano Protected_Path
 *  **Validates: Requirements 7.1, 7.2**
 *
 *  Eseguibile con: node out/test/guardProtectedPath.pbt.test.js
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { test, run } from './_harness';
import { checkPathsGuard, isProtectedPath } from '../selfHealing/guard';
import { DEFAULT_PROTECTED_GLOBS, FixProposal, GuardConfig, Issue } from '../selfHealing/types';

const RUNS = 300;

const issue: Issue = { category: 'build', message: 'x', source: 'tsc' };

/** Mix di percorsi: alcuni chiaramente protetti (test/config), altri no. */
const pathArb: fc.Arbitrary<string> = fc.constantFrom(
	'src/app.ts',
	'src/util/math.ts',
	'src/app.test.ts',
	'src/foo.spec.ts',
	'src/test/helper.ts',
	'tests/e2e.ts',
	'src/__tests__/a.ts',
	'vitest.config.ts',
	'packages/x/tsconfig.json',
	'README.md',
	'lib\\win\\path.ts'
);

const configArb: fc.Arbitrary<GuardConfig> = fc.record({
	protectedGlobs: fc.subarray([...DEFAULT_PROTECTED_GLOBS], { minLength: 0 })
});

test('Property 5: checkPathsGuard rifiuta sse almeno un touchedPath è protetto, con motivo non vuoto', () => {
	fc.assert(
		fc.property(fc.array(pathArb, { maxLength: 6 }), configArb, (touchedPaths, config) => {
			const proposal: FixProposal = { issue, diff: 'd', explanation: 'e', touchedPaths };
			const verdict = checkPathsGuard(proposal, config);

			const anyProtected = touchedPaths.some(p => isProtectedPath(p, config));
			assert.strictEqual(verdict.ok, !anyProtected, 'ok deve essere falso sse esiste un percorso protetto');
			if (!verdict.ok) {
				assert.ok(verdict.reason.length > 0, 'il rifiuto deve avere un motivo non vuoto');
			}
		}),
		{ numRuns: RUNS }
	);
});

void run();
