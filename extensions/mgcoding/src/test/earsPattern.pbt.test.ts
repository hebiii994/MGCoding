/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il riconoscimento dei pattern EARS.
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/earsPattern.pbt.test.js
 *
 *  Il modulo `specs/specValidator.ts` è PURO (nessuna dipendenza da `vscode`/`fetch`/filesystem),
 *  quindi non è necessario alcuno stub per eseguire sotto node puro.
 *
 *  Design > Correctness Properties
 *  ### Property 18: Riconoscimento round-trip dei pattern EARS
 *  "Per ogni pattern EARS p ∈ {ubiquitous, event, state, optional, unwanted, complex} e per ogni
 *   criterio di accettazione generato secondo la forma canonica di p, `matchEarsPattern`
 *   classifica il criterio esattamente come p (round-trip pattern → testo → pattern)."
 *  **Validates: Requirements 6.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import type { EarsPattern } from '../llm/types';
import { matchEarsPattern } from '../specs/specValidator';

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

// --- Vocabolari di frammenti privi di parole chiave EARS ------------------------------------
// Le parole chiave EARS (WHEN/WHILE/WHERE/IF/THEN/SHALL/THE) sono in inglese maiuscolo; i
// frammenti seguenti sono prosa italiana o nomi di componenti che NON contengono tali parole
// come token interi, così da non perturbare la classificazione.

/** Soggetti normativi (nomi di componenti), inseriti dopo "THE" nei template. */
const SUBJECTS: readonly string[] = [
	'Ollama_Provider',
	'Context_Manager',
	'Spec_Validator',
	'Provider_Router',
	'MGCoding',
	'Capability_Detector',
];

/** Precondizioni/condizioni in prosa italiana, prive di parole chiave EARS. */
const CONDITIONS: readonly string[] = [
	'il budget stimato supera la soglia corrente',
	'il modello locale risulta disponibile',
	'la cache di sessione è vuota',
	'la richiesta è classificata come heavy',
	'la chiave API risulta assente',
	'il documento manca di una sezione attesa',
	'l\'utente avvia una nuova fase del workflow',
];

/** Azioni normative in prosa italiana, prive di parole chiave EARS. */
const ACTIONS: readonly string[] = [
	'impostare options.num_ctx a un intero positivo',
	'ridurre la cronologia inviata al modello',
	'classificare il modello in un tier di capacità',
	'registrare il motivo del ripiego al cloud',
	'bloccare l\'avanzamento alla fase successiva',
	'memorizzare la chiave nel Secret_Store',
];

const subjectArb = fc.constantFrom(...SUBJECTS);
const conditionArb = fc.constantFrom(...CONDITIONS);
const actionArb = fc.constantFrom(...ACTIONS);

/** Coppia {pattern atteso, testo del criterio} generata secondo la forma canonica del pattern. */
interface TaggedCriterion {
	pattern: EarsPattern;
	text: string;
}

// --- Generatori per ciascuno dei sei pattern EARS ------------------------------------------

/** ubiquitous: "THE <subject> SHALL <action>." — nessun costrutto di precondizione. */
const ubiquitousArb: fc.Arbitrary<TaggedCriterion> = fc
	.tuple(subjectArb, actionArb)
	.map(([s, a]) => ({ pattern: 'ubiquitous', text: `THE ${s} SHALL ${a}.` }));

/** event: "WHEN <cond>, THE <subject> SHALL <action>." — solo WHEN. */
const eventArb: fc.Arbitrary<TaggedCriterion> = fc
	.tuple(conditionArb, subjectArb, actionArb)
	.map(([c, s, a]) => ({ pattern: 'event', text: `WHEN ${c}, THE ${s} SHALL ${a}.` }));

/** state: "WHILE <cond>, THE <subject> SHALL <action>." — solo WHILE. */
const stateArb: fc.Arbitrary<TaggedCriterion> = fc
	.tuple(conditionArb, subjectArb, actionArb)
	.map(([c, s, a]) => ({ pattern: 'state', text: `WHILE ${c}, THE ${s} SHALL ${a}.` }));

/** optional: "WHERE <cond>, THE <subject> SHALL <action>." — solo WHERE. */
const optionalArb: fc.Arbitrary<TaggedCriterion> = fc
	.tuple(conditionArb, subjectArb, actionArb)
	.map(([c, s, a]) => ({ pattern: 'optional', text: `WHERE ${c}, THE ${s} SHALL ${a}.` }));

/** unwanted: "IF <cond>, THEN THE <subject> SHALL <action>." — solo IF...THEN. */
const unwantedArb: fc.Arbitrary<TaggedCriterion> = fc
	.tuple(conditionArb, subjectArb, actionArb)
	.map(([c, s, a]) => ({ pattern: 'unwanted', text: `IF ${c}, THEN THE ${s} SHALL ${a}.` }));

/**
 * complex: combinazione di due o più costrutti di precondizione (es. WHEN/WHILE/WHERE + IF/THEN
 * oppure due costrutti temporali/condizionali insieme). Tutti i template producono >= 2 costrutti.
 */
const complexArb: fc.Arbitrary<TaggedCriterion> = fc
	.tuple(conditionArb, conditionArb, subjectArb, actionArb)
	.chain(([c1, c2, s, a]) =>
		fc
			.constantFrom<(x: string, y: string, sub: string, act: string) => string>(
				(x, y, sub, act) => `WHEN ${x}, IF ${y}, THEN THE ${sub} SHALL ${act}.`,
				(x, y, sub, act) => `WHILE ${x}, WHEN ${y}, THE ${sub} SHALL ${act}.`,
				(x, y, sub, act) => `WHERE ${x}, WHEN ${y}, THE ${sub} SHALL ${act}.`,
				(x, y, sub, act) => `WHILE ${x}, IF ${y}, THEN THE ${sub} SHALL ${act}.`,
				(x, y, sub, act) => `WHERE ${x}, IF ${y}, THEN THE ${sub} SHALL ${act}.`,
			)
			.map((build) => ({ pattern: 'complex' as EarsPattern, text: build(c1, c2, s, a) }))
	);

/** Un criterio etichettato per uno qualunque dei sei pattern EARS. */
const taggedCriterionArb: fc.Arbitrary<TaggedCriterion> = fc.oneof(
	ubiquitousArb,
	eventArb,
	stateArb,
	optionalArb,
	unwantedArb,
	complexArb,
);

// --- Property 18: round-trip pattern → testo → pattern (Req. 6.1) --------------------------
test('Property 18: matchEarsPattern riclassifica ogni criterio canonico esattamente come il suo pattern', () => {
	fc.assert(
		fc.property(taggedCriterionArb, ({ pattern, text }) => {
			const recognized = matchEarsPattern(text);
			assert.strictEqual(
				recognized,
				pattern,
				`il criterio "${text}" doveva essere classificato come ${pattern}, ottenuto ${recognized}`,
			);
		}),
		{ numRuns: RUNS },
	);
});

// --- Clausola di robustezza: un criterio privo di SHALL non è un pattern EARS valido --------
test('Property 18: senza il verbo normativo SHALL il riconoscimento restituisce undefined', () => {
	fc.assert(
		fc.property(conditionArb, subjectArb, actionArb, (c, s, a) => {
			// Stessa forma "event" ma priva di SHALL: non deve essere riconosciuto alcun pattern.
			const text = `WHEN ${c}, THE ${s} ${a}.`;
			assert.strictEqual(matchEarsPattern(text), undefined, 'senza SHALL il pattern non è valido');
		}),
		{ numRuns: RUNS },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
