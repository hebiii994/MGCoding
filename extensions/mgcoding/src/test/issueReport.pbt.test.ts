/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per l'Issue_Report del Self_Healing.
 *
 *  Feature: self-healing, Property 2: L'Issue_Report è raggruppato per file e coerente col totale
 *  **Validates: Requirements 2.1, 2.2**
 *
 *  Eseguibile con: node out/test/issueReport.pbt.test.js
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { test, run } from './_harness';
import { buildIssueReport, dedupeIssues } from '../selfHealing/issues';
import { Issue, IssueCategory } from '../selfHealing/types';

const RUNS = 200;

const categoryArb: fc.Arbitrary<IssueCategory> = fc.constantFrom('diagnostica', 'build', 'test', 'runtime');

const issueArb: fc.Arbitrary<Issue> = fc.record({
	category: categoryArb,
	file: fc.option(fc.constantFrom('a.ts', 'b.ts', 'c.ts'), { nil: undefined }),
	line: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
	message: fc.constantFrom('err1', 'err2', 'err3'),
	source: fc.constantFrom('ts', 'eslint')
});

test('Property 2: report raggruppato per file, unione = issues, total coerente, deterministico', () => {
	fc.assert(
		fc.property(fc.array(issueArb, { maxLength: 30 }), (raw) => {
			const report = buildIssueReport(raw);

			// total coincide con la lunghezza di issues, che è il deduplicato dell'input.
			assert.strictEqual(report.total, report.issues.length);
			assert.strictEqual(report.issues.length, dedupeIssues(raw).length);

			// File dei gruppi tutti distinti (ogni Issue in esattamente un gruppo).
			const files = report.byFile.map(g => g.file);
			assert.strictEqual(new Set(files).size, files.length, 'i gruppi devono avere file distinti');

			// L'unione (in ordine) dei gruppi è esattamente issues.
			const flattened = report.byFile.flatMap(g => g.issues);
			assert.deepStrictEqual(flattened, report.issues, 'la concatenazione dei gruppi deve uguagliare issues');

			// Ogni Issue di un gruppo appartiene davvero a quel file.
			for (const g of report.byFile) {
				assert.ok(g.issues.every(it => (it.file ?? '') === g.file), 'ogni Issue deve stare nel gruppo del suo file');
			}

			// Determinismo: stessa input → stessa output.
			assert.deepStrictEqual(buildIssueReport(raw), report);
		}),
		{ numRuns: RUNS }
	);
});

void run();
