/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) della Coverage_Map e della validazione
 *  strutturale dello Spec_Validator (logica pura in `specs/specValidator.ts`).
 *
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/coverageStructural.pbt.test.js
 *
 *  `specs/specValidator.ts` è logica PURA (nessuna dipendenza da `vscode`/`fetch`/filesystem),
 *  quindi non è necessario alcuno stub per eseguire sotto node puro.
 *
 *  Proprietà coperte (una sola property-based test per proprietà):
 *   - Property 19: Completezza della Coverage_Map e blocco sui criteri scoperti (Validates: 6.2, 6.3)
 *   - Property 20: La validazione strutturale segnala le sezioni mancanti e blocca
 *                  l'avanzamento (Validates: 6.4, 6.5)
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	buildCoverageMap,
	validateStructure,
	buildValidationReport,
	type AcceptanceCriterion,
} from '../specs/specValidator';
import type { SpecPhase } from '../llm/types';

const RUNS = 200;

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

/**
 * Sezioni strutturali attese per ciascuna fase (rispecchia EXPECTED_SECTIONS del nucleo puro,
 * costante non esportata): serve a verificare l'output di `validateStructure` (Req. 6.4).
 */
const PHASE_SECTIONS: Record<SpecPhase, readonly string[]> = {
	requirements: ['Introduction', 'Requirements'],
	design: ['Overview', 'Architecture', 'Components and Interfaces', 'Data Models'],
	tasks: ['Tasks'],
};

// =================== Property 19: Coverage_Map e blocco sui criteri scoperti ===================
// **Validates: Requirements 6.2, 6.3**

/**
 * Un gruppo = un requisito (numero univoco) con un insieme di criteri (indici univoci),
 * ciascuno con il flag `cited` che indica se sarà citato da almeno un task.
 */
const arbCriterionSpec = fc.record({
	idx: fc.integer({ min: 1, max: 9 }),
	cited: fc.boolean(),
});
const arbGroup = fc.record({
	req: fc.integer({ min: 1, max: 30 }),
	criteria: fc.uniqueArray(arbCriterionSpec, { selector: (c) => c.idx, minLength: 1, maxLength: 4 }),
});
const arbGroups = fc.uniqueArray(arbGroup, { selector: (g) => g.req, minLength: 1, maxLength: 5 });

type Group = { req: number; criteria: { idx: number; cited: boolean }[] };

/** Costruisce un `requirements.md` ben formato a partire dai gruppi (criteri EARS validi). */
function buildRequirementsMd(groups: Group[]): string {
	let s = '# Spec Document\n\n## Introduction\n\nIntro.\n\n## Requirements\n';
	for (const g of groups) {
		s += `\n### Requirement ${g.req}: Titolo\n\n#### Acceptance Criteria\n\n`;
		for (const c of g.criteria) {
			// Testo EARS valido (irrilevante per canAdvance, ma realistico).
			s += `${c.idx}. WHEN un evento accade THE SYSTEM SHALL gestire il criterio ${g.req}.${c.idx}.\n`;
		}
	}
	return s;
}

/** Costruisce un `tasks.md` con una riga "_Requirements: N.M_" per ogni criterio citato. */
function buildTasksMd(citedKeys: string[]): { md: string; lines: string[] } {
	const lines = ['# Implementation Plan', '', '## Tasks', ''];
	for (const key of citedKeys) {
		lines.push(`  - _Requirements: ${key}_`);
	}
	return { md: lines.join('\n'), lines };
}

test('Property 19: ogni criterio compare una volta, è covered sse citato, e gli scoperti azzerano canAdvance', () => {
	fc.assert(
		fc.property(arbGroups, (groups) => {
			// Insieme dei criteri (univoci per costruzione) con esito di copertura.
			const allKeys = groups.flatMap((g) =>
				g.criteria.map((c) => ({ req: g.req, idx: c.idx, cited: c.cited }))
			);
			const citedKeys = allKeys.filter((k) => k.cited).map((k) => `${k.req}.${k.idx}`);
			const citedSet = new Set(citedKeys);

			// Array di criteri con DUPLICATI deliberati (ogni chiave compare due volte),
			// per esercitare la deduplicazione della Coverage_Map (Req. 6.2).
			const criteriaArr: AcceptanceCriterion[] = [];
			for (const k of allKeys) {
				criteriaArr.push({ requirement: k.req, index: k.idx, text: 'primo' });
				criteriaArr.push({ requirement: k.req, index: k.idx, text: 'duplicato' });
			}

			const { md: tasksMd, lines: taskLines } = buildTasksMd(citedKeys);

			const coverage = buildCoverageMap(criteriaArr, tasksMd);

			// (a) Ogni criterio compare esattamente una volta nella Coverage_Map (Req. 6.2).
			assert.strictEqual(
				coverage.length,
				allKeys.length,
				'la Coverage_Map deve contenere ogni criterio una sola volta'
			);
			const criterionStrings = coverage.map((c) => c.criterion);
			assert.strictEqual(
				new Set(criterionStrings).size,
				coverage.length,
				'i criteri della Coverage_Map non devono essere duplicati'
			);

			// (b) covered sse almeno un task cita il criterio (Req. 6.3).
			for (const entry of coverage) {
				const key = entry.criterion.replace(/^Req\s+/, '');
				assert.strictEqual(
					entry.covered,
					citedSet.has(key),
					`covered incoerente con la citazione del criterio ${key}`
				);
				// covered è equivalente alla presenza di righe di task.
				assert.strictEqual(
					entry.covered,
					entry.taskLines.length > 0,
					'covered deve coincidere con la presenza di taskLines'
				);
				// Le righe citate devono effettivamente referenziare il criterio.
				for (const li of entry.taskLines) {
					assert.ok(
						taskLines[li] !== undefined && taskLines[li].includes(key),
						`taskLines[${li}] non referenzia il criterio ${key}`
					);
				}
			}

			// (c) I criteri scoperti azzerano canAdvance, struttura tasks integra a parte (Req. 6.3).
			const requirementsMd = buildRequirementsMd(groups);
			const report = buildValidationReport({
				phase: 'tasks',
				phaseDocument: tasksMd, // contiene "## Tasks" → struttura presente
				requirementsMd,
				tasksMd,
			});
			const allCovered = allKeys.every((k) => k.cited);
			assert.strictEqual(
				report.canAdvance,
				allCovered,
				'canAdvance deve essere true sse ogni criterio è coperto'
			);
			if (!allCovered) {
				assert.strictEqual(report.canAdvance, false, 'un criterio scoperto deve azzerare canAdvance');
			}
		}),
		{ numRuns: RUNS }
	);
});

// =============== Property 20: validazione strutturale e blocco dell'avanzamento ===============
// **Validates: Requirements 6.4, 6.5**

/** Pool di intestazioni "extra" innocue: nessuna contiene il nome di una sezione attesa. */
const EXTRA_HEADINGS = ['Notes', 'Appendix', 'Glossary', 'Misc'];

const arbStructuralCase = fc.constantFrom<SpecPhase>('requirements', 'design', 'tasks').chain((phase) => {
	const sections = PHASE_SECTIONS[phase];
	return fc.record({
		phase: fc.constant(phase),
		include: fc.tuple(...sections.map(() => fc.boolean())),
		extras: fc.subarray(EXTRA_HEADINGS),
		caseFlip: fc.boolean(),
	});
});

/** Costruisce un documento di fase includendo solo le sezioni attese selezionate. */
function buildPhaseDoc(
	phase: SpecPhase,
	include: boolean[],
	extras: string[],
	caseFlip: boolean
): string {
	const sections = PHASE_SECTIONS[phase];
	// Titolo neutro: non deve contenere il nome di alcuna sezione attesa.
	const lines: string[] = ['# Spec Document', ''];
	sections.forEach((sec, i) => {
		if (include[i]) {
			const title = caseFlip ? sec.toUpperCase() : sec;
			lines.push(`## ${title}`, '', 'Contenuto della sezione.', '');
		}
	});
	for (const ex of extras) {
		lines.push(`## ${ex}`, '', 'Altro contenuto.', '');
	}
	return lines.join('\n');
}

test('Property 20: validateStructure segnala le sezioni mancanti e canAdvance le blocca, fase corrente completabile', () => {
	fc.assert(
		fc.property(arbStructuralCase, ({ phase, include, extras, caseFlip }) => {
			const sections = PHASE_SECTIONS[phase];
			const md = buildPhaseDoc(phase, include, extras, caseFlip);

			const issues = validateStructure(phase, md);

			// (a) Vengono valutate esattamente le sezioni attese della fase, nell'ordine (Req. 6.4).
			assert.deepStrictEqual(
				issues.map((i) => i.section),
				[...sections],
				'validateStructure deve valutare esattamente le sezioni attese della fase'
			);

			// (b) Il flag present riflette l'inclusione effettiva della sezione (case-insensitive).
			issues.forEach((issue, i) => {
				assert.strictEqual(
					issue.present,
					include[i],
					`present incoerente per la sezione "${issue.section}"`
				);
			});

			const missing = issues.filter((i) => !i.present);

			// Report di fase: coverage neutralizzata (nessun criterio) così canAdvance dipende
			// dalla sola struttura, isolando l'effetto delle sezioni mancanti.
			const report = buildValidationReport({
				phase,
				phaseDocument: md,
				requirementsMd: '',
				tasksMd: '',
			});

			// (c) Le sezioni mancanti sono SEGNALATE nel report (Req. 6.4): il report è prodotto
			//     comunque, lasciando la fase corrente completabile (Req. 6.5).
			assert.deepStrictEqual(
				report.structural,
				issues,
				'il report deve riportare le sezioni strutturali (incluse quelle mancanti)'
			);

			// (d) Una sezione mancante blocca l'avanzamento; nessuna mancante lo consente (Req. 6.5).
			assert.strictEqual(
				report.canAdvance,
				missing.length === 0,
				'canAdvance deve essere true sse nessuna sezione attesa è mancante'
			);
			if (missing.length > 0) {
				assert.strictEqual(report.canAdvance, false, 'una sezione mancante deve bloccare l\'avanzamento');
			}
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
