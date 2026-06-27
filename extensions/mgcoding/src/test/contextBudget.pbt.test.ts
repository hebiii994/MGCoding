/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) del Context_Manager (nucleo puro).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/contextBudget.pbt.test.js
 *
 *  Copre tre proprietà di correttezza del design (Design > Correctness Properties) sulle
 *  funzioni pure di `llm/contextManager.ts`: `estimateTokens`, `estimateMessagesTokens` e
 *  `computeBudget`. Ogni proprietà è verificata con ≥ 100 iterazioni di fast-check.
 *
 *  ### Property 1: Derivazione valida di num_ctx con precedenza
 *  "Per ogni ContextBudgetInput, computeBudget(input).numCtx è un intero positivo e segue la
 *   precedenza: se configNumCtx è un intero positivo lo restituisce esattamente; altrimenti
 *   restituisce modelMaxCtx se noto; altrimenti DEFAULT_NUM_CTX (8192)."
 *  **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 *
 *  ### Property 3: Riserva minima per la risposta
 *  "Per ogni ContextBudgetInput, lo spazio riservato alla risposta è ≥ 1024 token:
 *   historyBudget ≤ numCtx − systemTokens − toolTokens − 1024."
 *  **Validates: Requirements 4.2**
 *
 *  ### Property 4: Stima dei token non negativa e monotòna
 *  "Per ogni coppia di stringhe a e b, estimateTokens(a) ≥ 0 e
 *   estimateTokens(a + b) ≥ estimateTokens(a) (la concatenazione non riduce mai i token)."
 *  **Validates: Requirements 4.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	computeBudget,
	estimateTokens,
	DEFAULT_NUM_CTX,
	MIN_RESPONSE_RESERVE,
	ContextBudgetInput,
} from '../llm/contextManager';

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

/** Replica del predicato "intero positivo (> 0)" usato dalla logica pura. */
function isPositiveInt(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// --- Generatori condivisi -------------------------------------------------------------------

/**
 * Candidato per num_ctx (configNumCtx/modelMaxCtx): copre interi positivi, zero, negativi,
 * valori non interi e l'assenza (undefined), così da esercitare tutti i rami di precedenza.
 */
const arbCtxCandidate: fc.Arbitrary<number | undefined> = fc.oneof(
	fc.integer({ min: 1, max: 200000 }),            // interi positivi (validi)
	fc.integer({ min: -1000, max: 0 }),             // zero e negativi (non validi)
	fc.double({ min: 0.1, max: 100000, noNaN: true }), // valori non interi (non validi)
	fc.constant(undefined),                          // assente
);

/** Conteggio di token non negativo per system/tool (dominio: token ≥ 0). */
const arbTokenCount: fc.Arbitrary<number> = fc.integer({ min: 0, max: 100000 });

/** Riserva per la risposta: include valori sotto, pari e oltre il minimo, più negativi. */
const arbReserve: fc.Arbitrary<number> = fc.integer({ min: -500, max: 20000 });

/** ContextBudgetInput arbitrario che copre l'intero spazio di input di computeBudget. */
const arbBudgetInput: fc.Arbitrary<ContextBudgetInput> = fc.record({
	modelMaxCtx: arbCtxCandidate,
	configNumCtx: arbCtxCandidate,
	systemTokens: arbTokenCount,
	toolTokens: arbTokenCount,
	responseReserve: arbReserve,
});

// --- Property 1: derivazione valida di num_ctx con precedenza -------------------------------
// Validates: Requirements 1.1, 1.2, 1.3, 1.4
test('Property 1: numCtx è intero positivo e rispetta la precedenza config > modelMax > default', () => {
	fc.assert(
		fc.property(arbBudgetInput, (input) => {
			const { numCtx } = computeBudget(input);

			// numCtx è sempre un intero positivo (Req. 1.1).
			assert.ok(Number.isInteger(numCtx), `numCtx deve essere intero, ricevuto ${numCtx}`);
			assert.ok(numCtx > 0, `numCtx deve essere positivo, ricevuto ${numCtx}`);

			// Precedenza attesa: configNumCtx (Req. 1.3) > modelMaxCtx (Req. 1.2) > default (Req. 1.4).
			let expected: number;
			if (isPositiveInt(input.configNumCtx)) {
				expected = input.configNumCtx;
			} else if (isPositiveInt(input.modelMaxCtx)) {
				expected = input.modelMaxCtx;
			} else {
				expected = DEFAULT_NUM_CTX;
			}
			assert.strictEqual(numCtx, expected, `precedenza non rispettata: atteso ${expected}, ricevuto ${numCtx}`);
		}),
		{ numRuns: RUNS },
	);
});

// --- Property 3: riserva minima per la risposta ---------------------------------------------
// Validates: Requirements 4.2
test('Property 3: la risposta ha sempre ≥ 1024 token riservati (historyBudget ≤ numCtx − sys − tool − 1024)', () => {
	fc.assert(
		fc.property(arbBudgetInput, (input) => {
			const { numCtx, historyBudget } = computeBudget(input);
			// Con system/tool ≥ 0, lo spazio per la cronologia non invade mai la riserva minima.
			const upperBound = numCtx - input.systemTokens - input.toolTokens - MIN_RESPONSE_RESERVE;
			assert.ok(
				historyBudget <= upperBound,
				`historyBudget=${historyBudget} eccede il limite ${upperBound} (numCtx=${numCtx}, sys=${input.systemTokens}, tool=${input.toolTokens})`,
			);
		}),
		{ numRuns: RUNS },
	);
});

// --- Property 4: stima dei token non negativa e monotòna ------------------------------------
// Validates: Requirements 4.1
test('Property 4: estimateTokens è non negativa e monotòna sulla concatenazione', () => {
	fc.assert(
		fc.property(fc.string(), fc.string(), (a, b) => {
			const ta = estimateTokens(a);
			const tab = estimateTokens(a + b);

			// Non negatività.
			assert.ok(ta >= 0, `estimateTokens(a) negativo: ${ta}`);
			assert.ok(tab >= 0, `estimateTokens(a+b) negativo: ${tab}`);

			// Monotonia: concatenare non riduce mai i token stimati.
			assert.ok(tab >= ta, `monotonia violata: estimateTokens(a+b)=${tab} < estimateTokens(a)=${ta}`);
		}),
		{ numRuns: RUNS },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
