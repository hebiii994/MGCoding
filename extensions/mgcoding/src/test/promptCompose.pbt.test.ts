/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) del Prompt_Composer (logica pura `compose`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/promptCompose.pbt.test.js
 *
 *  `agent/promptComposer.ts` è logica PURA (nessuna dipendenza da `vscode`/`fetch`/filesystem),
 *  quindi non è necessario alcuno stub per eseguire sotto node puro.
 *
 *  Design > Correctness Properties
 *  ### Property 21: Composizione del prompt in funzione del solo budget
 *  "Per ogni Capability_Tier, Context_Budget e insieme di tool disponibili, `compose`
 *   sceglie la variante e il sottoinsieme di tool in funzione del SOLO Context_Budget:
 *   con budget <= COMPACT_BUDGET_THRESHOLD (8192) restituisce la variante `compact` ed espone
 *   esattamente l'intersezione tra SMALL_WINDOW_TOOLS e i tool disponibili; con budget > 8192
 *   restituisce la variante `full` ed espone tutti i tool disponibili. La decisione non dipende
 *   dal tier né dal nome del modello."
 *  **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { CapabilityTier } from '../llm/capability';
import { compose, COMPACT_BUDGET_THRESHOLD, SMALL_WINDOW_TOOLS } from '../agent/promptComposer';

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

/** Un Capability_Tier arbitrario tra i tre ammessi. */
const arbTier: fc.Arbitrary<CapabilityTier> = fc.constantFrom<CapabilityTier>('native', 'structured', 'textual');

/**
 * Budget di contesto arbitrario su un intervallo che attraversa la soglia (8192), così da
 * coprire sia il ramo `compact` (<= soglia) sia il ramo `full` (> soglia), inclusi i bordi.
 */
const arbBudget: fc.Arbitrary<number> = fc.integer({ min: 0, max: 200000 });

/**
 * Insieme di nomi di tool disponibili: mescola nomi appartenenti a SMALL_WINDOW_TOOLS e nomi
 * arbitrari (potenzialmente non presenti nel sottoinsieme), per esercitare l'intersezione.
 */
const arbToolNames: fc.Arbitrary<string[]> = fc.array(
	fc.oneof(
		fc.constantFrom(...SMALL_WINDOW_TOOLS),
		fc.string({ minLength: 1, maxLength: 16 })
	),
	{ maxLength: 20 }
);

/** Intersezione attesa SMALL_WINDOW_TOOLS ∩ disponibili, preservando l'ordine del sottoinsieme. */
function expectedCompactTools(allToolNames: readonly string[]): string[] {
	const available = new Set(allToolNames);
	return SMALL_WINDOW_TOOLS.filter(name => available.has(name));
}

// --- Clausola A: la variante e i tool esposti dipendono solo dal budget --------------------
test('Property 21: budget <= soglia => compact + intersezione SMALL_WINDOW_TOOLS; budget > soglia => full + tutti i tool', () => {
	fc.assert(
		fc.property(arbTier, arbBudget, arbToolNames, (tier, budget, allToolNames) => {
			const result = compose(tier, budget, allToolNames);

			if (budget <= COMPACT_BUDGET_THRESHOLD) {
				// Variante compatta (Req. 7.2) ed esposizione esclusiva del sottoinsieme ridotto
				// effettivamente disponibile (Req. 7.3).
				assert.strictEqual(result.variant, 'compact', 'con budget <= soglia la variante deve essere compact');
				assert.deepStrictEqual(
					result.exposedTools,
					expectedCompactTools(allToolNames),
					'in compact i tool esposti devono essere esattamente SMALL_WINDOW_TOOLS ∩ disponibili'
				);
				// Nessun tool esposto fuori dal sottoinsieme ridotto.
				assert.ok(
					result.exposedTools.every(t => (SMALL_WINDOW_TOOLS as readonly string[]).includes(t)),
					'in compact non possono comparire tool fuori da SMALL_WINDOW_TOOLS'
				);
				// Nessun tool esposto che non sia effettivamente disponibile.
				const available = new Set(allToolNames);
				assert.ok(result.exposedTools.every(t => available.has(t)), 'i tool esposti devono essere disponibili');
			} else {
				// Variante completa (Req. 7.5): tutti i tool disponibili, nell'ordine ricevuto.
				assert.strictEqual(result.variant, 'full', 'con budget > soglia la variante deve essere full');
				assert.deepStrictEqual(result.exposedTools, [...allToolNames], 'in full devono essere esposti tutti i tool disponibili');
			}
		}),
		{ numRuns: RUNS }
	);
});

// --- Clausola B: la decisione è indipendente dal tier e dal nome del modello (Req. 7.4) ----
test('Property 21: a parità di budget e tool, il risultato non cambia al variare del tier', () => {
	fc.assert(
		fc.property(arbBudget, arbToolNames, (budget, allToolNames) => {
			const tiers: CapabilityTier[] = ['native', 'structured', 'textual'];
			const results = tiers.map(t => compose(t, budget, allToolNames));
			// Tutti i risultati devono coincidere: la scelta dipende dal solo budget, non dal tier.
			for (let i = 1; i < results.length; i++) {
				assert.strictEqual(results[i].variant, results[0].variant, 'la variante non deve dipendere dal tier');
				assert.deepStrictEqual(results[i].exposedTools, results[0].exposedTools, 'i tool esposti non devono dipendere dal tier');
			}
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
