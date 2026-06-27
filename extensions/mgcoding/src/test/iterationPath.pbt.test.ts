/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la logica pura del percorso di iterazione
 *  del tool-calling (`chooseIterationPath` e `onSchemaViolation` in `agent/agentLoop.ts`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/iterationPath.pbt.test.js
 *
 *  Lo stub di `vscode` DEVE essere importato PRIMA del modulo sotto test: `agentLoop.ts`
 *  fa `import * as vscode from 'vscode'` al caricamento (per il guscio del loop), modulo che
 *  fuori dall'Extension Host non esiste. Le funzioni pure qui verificate non usano alcuna
 *  API di `vscode`, quindi il mock vuoto è sufficiente.
 *
 *  Design > Correctness Properties
 *  ### Property 8: Il percorso di tool-calling dipende solo da tier e flag
 *  **Validates: Requirements 2.1, 2.4, 2.5, 3.6**
 *  ### Property 9: Retry per singola iterazione poi fallback
 *  **Validates: Requirements 2.2, 2.3**
 *--------------------------------------------------------------------------------------------*/

// Lo stub di `vscode` DEVE essere importato prima del modulo sotto test (vedi vscodeStub.ts).
import './vscodeStub';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { chooseIterationPath, onSchemaViolation, IterationRetryState } from '../agent/agentLoop';
import { CapabilityTier } from '../llm/types';

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

// --- Generatori --------------------------------------------------------------------------

/** Tutti i tier validi. */
const ALL_TIERS: readonly CapabilityTier[] = ['native', 'structured', 'textual'];
const tierArb: fc.Arbitrary<CapabilityTier> = fc.constantFrom(...ALL_TIERS);

/** I tier per i quali il percorso strutturato è ammesso. */
const STRUCTURED_TIERS: ReadonlySet<CapabilityTier> = new Set<CapabilityTier>(['structured', 'native']);

/**
 * IterationRetryState arbitrario con `retries < maxRetries`: il dominio in cui
 * `onSchemaViolation` deve incrementare e restituire `retry`. `maxRetries` è positivo
 * e `retries` è strettamente minore (così esiste sempre almeno un retry residuo).
 */
const retryAvailableArb: fc.Arbitrary<IterationRetryState> = fc
	.tuple(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 4 }), fc.boolean())
	.filter(([maxRetries, retries]) => retries < maxRetries)
	.map(([maxRetries, retries, usedFallback]) => ({ retries, maxRetries, usedFallback }));

/**
 * IterationRetryState arbitrario con `retries >= maxRetries`: il dominio in cui i retry
 * sono esauriti e `onSchemaViolation` deve segnare `usedFallback` e restituire `fallback`.
 */
const retryExhaustedArb: fc.Arbitrary<IterationRetryState> = fc
	.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), fc.boolean())
	.filter(([maxRetries, retries]) => retries >= maxRetries)
	.map(([maxRetries, retries, usedFallback]) => ({ retries, maxRetries, usedFallback }));

// --- Property 8: il percorso dipende solo da tier e flag (Req. 2.1, 2.4, 2.5, 3.6) -----------
// chooseIterationPath restituisce 'structured' SE E SOLO SE tier∈{structured,native} e il
// flag è true; altrimenti 'textual'. La decisione è una funzione pura dei soli due argomenti:
// nessuno stato di iterazioni precedenti la influenza (un fallback pregresso è irrilevante).
test('Property 8: chooseIterationPath è structured sse tier capace e flag true, indipendente dalla storia', () => {
	fc.assert(
		fc.property(tierArb, fc.boolean(), (tier, structuredToolsEnabled) => {
			const result = chooseIterationPath(tier, structuredToolsEnabled);

			// Il risultato è sempre uno dei due percorsi ammessi.
			assert.ok(result === 'structured' || result === 'textual', `percorso non valido: ${result}`);

			// Equivalenza (sse) con la condizione "tier capace AND flag attivo".
			const expectStructured = structuredToolsEnabled && STRUCTURED_TIERS.has(tier);
			assert.strictEqual(
				result,
				expectStructured ? 'structured' : 'textual',
				`tier=${tier} flag=${structuredToolsEnabled} dovrebbe dare ${expectStructured ? 'structured' : 'textual'}`,
			);

			// Indipendenza dalle iterazioni precedenti: la funzione è pura e deterministica,
			// quindi una seconda chiamata con gli stessi argomenti dà lo stesso esito a
			// prescindere da qualunque fallback "pregresso" simulato fra le due chiamate.
			void chooseIterationPath('textual', false); // simula un'iterazione di fallback intermedia
			const again = chooseIterationPath(tier, structuredToolsEnabled);
			assert.strictEqual(again, result, 'il percorso non deve dipendere dalle iterazioni precedenti');
		}),
		{ numRuns: RUNS },
	);
});

// --- Property 9: retry per singola iterazione poi fallback (Req. 2.2, 2.3) -------------------
// Caso retry disponibile: onSchemaViolation incrementa retries di ESATTAMENTE uno e ritorna
// 'retry', senza toccare usedFallback.
test('Property 9a: con retry residui onSchemaViolation incrementa di uno e ritorna retry', () => {
	fc.assert(
		fc.property(retryAvailableArb, (state) => {
			const before = state.retries;
			const fallbackBefore = state.usedFallback;
			const outcome = onSchemaViolation(state);

			assert.strictEqual(outcome, 'retry', 'con retry residui deve ritornare retry');
			assert.strictEqual(state.retries, before + 1, 'i retry devono incrementare di esattamente uno');
			assert.strictEqual(state.usedFallback, fallbackBefore, 'usedFallback non deve cambiare durante un retry');
		}),
		{ numRuns: RUNS },
	);
});

// Caso retry esauriti: onSchemaViolation segna usedFallback e ritorna 'fallback', senza
// incrementare ulteriormente i retry.
test('Property 9b: con retry esauriti onSchemaViolation ritorna fallback e segna usedFallback', () => {
	fc.assert(
		fc.property(retryExhaustedArb, (state) => {
			const before = state.retries;
			const outcome = onSchemaViolation(state);

			assert.strictEqual(outcome, 'fallback', 'con retry esauriti deve ritornare fallback');
			assert.strictEqual(state.usedFallback, true, 'fallback deve segnare usedFallback = true');
			assert.strictEqual(state.retries, before, 'in fallback i retry non devono incrementare');
		}),
		{ numRuns: RUNS },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
