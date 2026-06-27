/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la deduzione della cartella di destinazione.
 *  Eseguibile con: node out/test/keyToModelDir.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 28: La cartella di destinazione è dedotta correttamente dal tipo di campo
 *  "Per ogni nome di campo modello (es. `ckpt_name`, `vae_name`, `lora_name`, `unet_name`,
 *   `clip_name`, `control_net_name`, campi GGUF), `keyToModelDir` restituisce la cartella di
 *   modelli attesa per quel tipo."
 *  **Validates: Requirements 16.2**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { keyToModelDir } from '../media/modelRefs';

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

// Cartella attesa per ogni nome di campo modello noto (allineata a MODEL_DIR_BY_FIELD in
// modelRefs.ts), inclusi i campi usati dai nodi GGUF (`unet_name`, `gguf_name`, `clip_name`).
const EXPECTED_DIR_BY_FIELD: Readonly<Record<string, string>> = {
	ckpt_name: 'checkpoints',
	checkpoint_name: 'checkpoints',
	vae_name: 'vae',
	lora_name: 'loras',
	lora_name_1: 'loras',
	lora_name_2: 'loras',
	lora_01: 'loras',
	lora_02: 'loras',
	unet_name: 'unet',
	gguf_name: 'unet',
	clip_name: 'clip',
	clip_name1: 'clip',
	clip_name2: 'clip',
	clip_name_1: 'clip',
	clip_name_2: 'clip',
	control_net_name: 'controlnet',
	controlnet_name: 'controlnet',
	style_model_name: 'style_models',
	upscale_model_name: 'upscale_models',
};

const KNOWN_FIELDS = Object.keys(EXPECTED_DIR_BY_FIELD);

// Generatore di un nome di campo modello noto.
const knownFieldArb = fc.constantFrom(...KNOWN_FIELDS);

test('Property 28: keyToModelDir restituisce la cartella attesa per ogni campo noto', () => {
	fc.assert(
		fc.property(knownFieldArb, field => {
			const dir = keyToModelDir(field);
			assert.strictEqual(
				dir,
				EXPECTED_DIR_BY_FIELD[field],
				`keyToModelDir("${field}") deve restituire "${EXPECTED_DIR_BY_FIELD[field]}", ottenuto "${dir}"`,
			);
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
