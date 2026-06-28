/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la deduplica delle Issue del Self_Healing.
 *
 *  Feature: self-healing, Property 1: Dedup deterministica e categorizzata delle Issue
 *  **Validates: Requirements 1.3, 1.4**
 *
 *  `selfHealing/issues.ts` è puro (nessun `vscode`): nessuno stub necessario.
 *  Eseguibile con: node out/test/selfHealDedup.pbt.test.js
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { test, run } from './_harness';
import { dedupeIssues } from '../selfHealing/issues';
import { Issue, IssueCategory } from '../selfHealing/types';

const RUNS = 200;

const categoryArb: fc.Arbitrary<IssueCategory> = fc.constantFrom('diagnostica', 'build', 'test', 'runtime');

/** Genera Issue da un dominio PICCOLO, così le collisioni (e quindi i duplicati) sono frequenti. */
const issueArb: fc.Arbitrary<Issue> = fc.record({
	category: categoryArb,
	file: fc.option(fc.constantFrom('a.ts', 'b.ts', 'c.ts'), { nil: undefined }),
	line: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
	message: fc.constantFrom('err1', 'err2', 'err3'),
	source: fc.constantFrom('ts', 'eslint', 'vitest')
});

/** Dedup di riferimento per prima comparsa, sulla stessa chiave (category, file, line, message). */
function referenceDedupe(raw: Issue[]): Issue[] {
	const seen = new Set<string>();
	const out: Issue[] = [];
	for (const it of raw) {
		const key = `${it.category} ${it.file ?? ''} ${it.line ?? ''} ${it.message}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(it);
		}
	}
	return out;
}

test('Property 1: dedup per chiave, ordine di prima comparsa, categorie invariate, idempotente', () => {
	fc.assert(
		fc.property(fc.array(issueArb, { maxLength: 30 }), (raw) => {
			const out = dedupeIssues(raw);

			// Coincide con la dedup di riferimento (chiave + ordine di prima comparsa + campi invariati).
			assert.deepStrictEqual(out, referenceDedupe(raw));

			// Nessuna coppia con la stessa chiave nel risultato.
			const keys = out.map(it => `${it.category} ${it.file ?? ''} ${it.line ?? ''} ${it.message}`);
			assert.strictEqual(new Set(keys).size, keys.length, 'il risultato non deve contenere duplicati');

			// Idempotenza: applicarla due volte non cambia nulla.
			assert.deepStrictEqual(dedupeIssues(out), out);
		}),
		{ numRuns: RUNS }
	);
});

void run();
