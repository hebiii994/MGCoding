/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il Capability_Detector.
 *  Eseguibile con: node out/test/capabilityTier.pbt.test.js
 *
 *  Il modulo `llm/capability.ts` è PURO (niente `vscode`/`fetch`/fs), quindi non serve
 *  lo stub `./vscodeStub`.
 *
 *  Design > Correctness Properties
 *  ### Property 10: Semantica della classificazione del tier
 *  **Validates: Requirements 3.1, 3.2, 3.3, 3.5**
 *  ### Property 11: Round-trip della cache delle capacità
 *  **Validates: Requirements 3.4**
 *  ### Property 12: Il declassamento abbassa di un rango, con limite inferiore
 *  **Validates: Requirements 9.6**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	CapabilityCache,
	CapabilityTier,
	classifyTier,
	downgradeTier,
	TierInputs,
} from '../llm/capability';

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

// Tutti i tier validi e il loro ordinamento dal più capace al meno capace.
const ALL_TIERS: readonly CapabilityTier[] = ['native', 'structured', 'textual'];
const tierArb: fc.Arbitrary<CapabilityTier> = fc.constantFrom(...ALL_TIERS);

// Un TierInputs arbitrario: l'override è opzionale (undefined oppure un tier valido),
// la probe può essere superata, fallita o non eseguita (undefined).
const tierInputsArb: fc.Arbitrary<TierInputs> = fc.record({
	declaresTools: fc.boolean(),
	functionalProbePassed: fc.option(fc.boolean(), { nil: undefined }),
	configOverride: fc.option(tierArb, { nil: undefined }),
});

// Nomi di modello realistici, con possibili collisioni per esercitare la cache.
const modelArb: fc.Arbitrary<string> = fc.constantFrom(
	'llama3.1',
	'qwen2.5-coder',
	'mistral',
	'phi3',
	'gemma2',
	'deepseek-r1',
);

// --- Property 10: Semantica della classificazione del tier (Req. 3.1, 3.2, 3.3, 3.5) ---
test('Property 10: classifyTier rispetta override, probe e divieto di native senza prova', () => {
	fc.assert(
		fc.property(tierInputsArb, (inputs) => {
			const result = classifyTier(inputs);

			// Req. 3.1: il risultato è sempre uno dei tre tier validi.
			assert.ok(ALL_TIERS.includes(result), `tier non valido: ${result}`);

			if (inputs.configOverride !== undefined) {
				// Req. 3.5: l'override di config vince e salta la probe.
				assert.strictEqual(result, inputs.configOverride, 'l\'override deve essere restituito esattamente');
				return;
			}

			// Req. 3.2: senza override, native se e solo se la probe è stata superata.
			if (inputs.functionalProbePassed === true) {
				assert.strictEqual(result, 'native', 'probe superata deve dare native');
			} else {
				assert.notStrictEqual(result, 'native', 'senza probe superata non può essere native');
				// Req. 3.3: chi dichiara tools ma fallisce/salta la probe è al massimo structured.
				if (inputs.declaresTools) {
					assert.strictEqual(result, 'structured', 'tools dichiarati ma probe non superata => structured');
				} else {
					assert.strictEqual(result, 'textual', 'nessun tool dichiarato né provato => textual');
				}
			}
		}),
		{ numRuns: 200 },
	);
});

// --- Property 11: Round-trip della cache delle capacità (Req. 3.4) ---
test('Property 11: dopo set la get restituisce il tier e il set ripetuto è idempotente', () => {
	fc.assert(
		fc.property(modelArb, tierArb, (model, tier) => {
			const cache = new CapabilityCache();

			// Round-trip: ciò che si scrive si rilegge.
			cache.set(model, tier);
			assert.strictEqual(cache.get(model), tier, 'get deve restituire il tier appena impostato');

			// Idempotenza: ripetere lo stesso set non cambia il risultato.
			cache.set(model, tier);
			assert.strictEqual(cache.get(model), tier, 'set ripetuto con lo stesso valore è idempotente');
		}),
		{ numRuns: 200 },
	);
});

// --- Property 12: Il declassamento abbassa di un rango, con limite inferiore (Req. 9.6) ---
test('Property 12: downgradeTier scende di un rango e non va sotto textual', () => {
	fc.assert(
		fc.property(tierArb, (tier) => {
			const result = downgradeTier(tier);
			const index = ALL_TIERS.indexOf(tier);

			if (tier === 'textual') {
				// Limite inferiore: idempotente al minimo.
				assert.strictEqual(result, 'textual', 'textual non può scendere oltre');
			} else {
				// Scende di esattamente un rango secondo l'ordinamento.
				assert.strictEqual(result, ALL_TIERS[index + 1], 'deve scendere di esattamente un rango');
			}
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
