/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per l'esclusione dei prompt dalla telemetria.
 *  Eseguibile con: node out/test/telemetry.pbt.test.js
 *
 *  `media/telemetryGating.ts` è un modulo PURO (nessun `import` di `vscode`/`fetch`), quindi
 *  non serve alcuno stub: può essere eseguito direttamente sotto node.
 *
 *  Design > Correctness Properties
 *  ### Property 36: I prompt sono esclusi dalla telemetria
 *  "Per ogni prompt, l'evento di telemetria costruito non contiene il testo del prompt in alcun
 *   campo serializzato."
 *  **Validates: Requirements 21.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	buildTelemetryEvent,
	REDACTED,
	TelemetryInput,
	TelemetryValue,
} from '../media/telemetryGating';

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

// Sentinella distintiva: prefissando ogni testo di prompt con questa stringa garantiamo che la
// verifica per sottostringa sia significativa (il testo non comparirà "per caso" altrove).
const SENTINEL = 'PROMPT_SENTINEL_Zx9q7';

// Genera un testo di prompt non vuoto e distintivo (prefisso sentinella + coda arbitraria).
const promptTextArb: fc.Arbitrary<string> = fc
	.string({ minLength: 1, maxLength: 40 })
	.map(s => `${SENTINEL}_${s}`);

// Chiavi note per il trasporto di prompt (devono essere rimosse a prescindere dal valore).
const promptBearingKeyArb: fc.Arbitrary<string> = fc.constantFrom(
	'prompt', 'Prompt', 'PROMPT', 'prompts', 'positivePrompt', 'negativePrompt',
	'positive_prompt', 'negative_prompt', 'promptText', 'prompt_text', 'text',
	'query', 'content', 'message', 'input', 'inputText', 'input_text',
	'userPrompt', 'user_prompt',
);

// Valore di telemetria scalare e serializzabile.
const scalarValueArb: fc.Arbitrary<TelemetryValue> = fc.oneof(
	fc.string({ maxLength: 30 }),
	fc.integer(),
	fc.boolean(),
	fc.constant<TelemetryValue>(null),
);

// Valore di telemetria arbitrario con annidamento limitato (scalari, array, oggetti).
const telemetryValueArb: fc.Arbitrary<TelemetryValue> = fc.oneof(
	scalarValueArb,
	fc.array(scalarValueArb, { maxLength: 4 }),
	fc.dictionary(fc.string({ maxLength: 8 }), scalarValueArb, { maxKeys: 4 }),
);

// Costruisce un input di telemetria che mescola: prompt/negativePrompt distintivi, proprietà
// arbitrarie, valori che embeddano il testo dei prompt, chiavi prompt-bearing, e misurazioni.
const telemetryInputArb: fc.Arbitrary<TelemetryInput> = fc.record({
	event: fc.string({ minLength: 1, maxLength: 20 }),
	prompt: fc.option(promptTextArb, { nil: undefined }),
	negativePrompt: fc.option(promptTextArb, { nil: undefined }),
	properties: fc.dictionary(fc.string({ maxLength: 10 }), telemetryValueArb, { maxKeys: 6 }),
	measurements: fc.dictionary(fc.string({ maxLength: 10 }), fc.double({ noNaN: true, noDefaultInfinity: true }), { maxKeys: 4 }),
}).map(rec => {
	const properties: Record<string, TelemetryValue> = { ...rec.properties };
	// Inietta valori che CONTENGONO il testo dei prompt (per stressare la redazione ricorsiva).
	if (rec.prompt) {
		properties['echoPositive'] = `prefisso ${rec.prompt} suffisso`;
		properties['nested'] = { deep: [rec.prompt, 'innocuo'] };
	}
	if (rec.negativePrompt) {
		properties['echoNegative'] = rec.negativePrompt;
	}
	return {
		event: rec.event,
		prompt: rec.prompt,
		negativePrompt: rec.negativePrompt,
		properties,
		measurements: rec.measurements,
	} satisfies TelemetryInput;
});

// Chiavi note per il trasporto di prompt che inseriamo SEMPRE con un valore distintivo, per
// verificare che vengano effettivamente rimosse dall'evento.
function injectPromptBearingKeys(input: TelemetryInput, key: string): TelemetryInput {
	return {
		...input,
		properties: {
			...(input.properties ?? {}),
			[key]: `${SENTINEL}_BEARING_VALUE`,
		},
	};
}

test('Property 36: l\'evento serializzato non contiene mai il testo dei prompt e scarta le chiavi prompt-bearing', () => {
	fc.assert(
		fc.property(telemetryInputArb, promptBearingKeyArb, (baseInput, bearingKey) => {
			const input = injectPromptBearingKeys(baseInput, bearingKey);
			const event = buildTelemetryEvent(input);

			// 1) Il testo dei prompt (non vuoto) non compare in alcun campo serializzato.
			const serialized = JSON.stringify(event);
			for (const secret of [input.prompt, input.negativePrompt]) {
				if (typeof secret === 'string' && secret.length > 0) {
					assert.ok(
						!serialized.includes(secret),
						`l'evento serializzato non deve contenere il testo del prompt: ${secret}`,
					);
				}
			}

			// 2) Le chiavi note per il trasporto di prompt sono rimosse (case-insensitive),
			//    a tutti i livelli dell'oggetto properties.
			const PROMPT_KEYS = new Set([
				'prompt', 'prompts', 'positiveprompt', 'negativeprompt', 'positive_prompt',
				'negative_prompt', 'prompttext', 'prompt_text', 'text', 'query', 'content',
				'message', 'input', 'inputtext', 'input_text', 'userprompt', 'user_prompt',
			]);
			const assertNoBearingKeys = (value: TelemetryValue): void => {
				if (Array.isArray(value)) {
					value.forEach(assertNoBearingKeys);
				} else if (value !== null && typeof value === 'object') {
					for (const [k, v] of Object.entries(value)) {
						assert.ok(!PROMPT_KEYS.has(k.toLowerCase()), `la chiave prompt-bearing deve essere rimossa: ${k}`);
						assertNoBearingKeys(v);
					}
				}
			};
			assertNoBearingKeys(event.properties);

			// 3) La chiave prompt-bearing iniettata esplicitamente non è presente al primo livello.
			assert.ok(
				!Object.prototype.hasOwnProperty.call(event.properties, bearingKey),
				`la chiave prompt-bearing iniettata deve essere assente: ${bearingKey}`,
			);

			// 4) Il valore distintivo della chiave prompt-bearing non resta nell'evento.
			assert.ok(
				!serialized.includes(`${SENTINEL}_BEARING_VALUE`),
				'il valore della chiave prompt-bearing non deve sopravvivere nell\'evento',
			);

			// 5) Il nome dell'evento è preservato.
			assert.strictEqual(event.event, input.event, 'il nome dell\'evento deve essere preservato');

			// 6) Coerenza: i valori che embeddavano un prompt sono stati redatti col segnaposto.
			if (typeof input.prompt === 'string' && input.prompt.length > 0) {
				assert.strictEqual(event.properties['echoPositive'], REDACTED, 'il valore che conteneva il prompt deve essere redatto');
			}
		}),
		{ numRuns: 300 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
