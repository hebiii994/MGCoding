/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la selezione di un backend con capacità video.
 *  Eseguibile con: node out/test/backendVideo.pbt.test.js
 *
 *  NOTA: `media/imageGen.ts` fa `import` di moduli che a loro volta caricano `vscode`.
 *  Importiamo PRIMA lo stub `./vscodeStub` per poter eseguire sotto node puro.
 *
 *  Design > Correctness Properties
 *  ### Property 25: La generazione video sceglie un backend con capacità video
 *  "Per ogni insieme di backend disponibili e ogni richiesta video, se viene selezionato un
 *   backend allora quel backend supporta i workflow video."
 *  **Validates: Requirements 11.2**
 *--------------------------------------------------------------------------------------------*/

import './vscodeStub';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { chooseGenerationBackend, GenerationBackendDescriptor, BackendSelectionContext } from '../media/imageGen';

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

// Un descrittore di backend: id arbitrario, disponibilità, priorità (anche con pareggi),
// e capacità video (rilevante per le richieste video di questa proprietà).
const descriptorArb: fc.Arbitrary<GenerationBackendDescriptor> = fc.record({
	id: fc.constantFrom('a1111', 'comfyui', 'gemini', 'openai', 'local-x', 'cloud-y'),
	available: fc.boolean(),
	priority: fc.integer({ min: -5, max: 10 }),
	supportsVideo: fc.boolean(),
});

const descriptorsArb: fc.Arbitrary<GenerationBackendDescriptor[]> = fc.array(descriptorArb, { minLength: 0, maxLength: 8 });

// Contesto di richiesta VIDEO. forcedId arbitrario (assente, 'auto' o un id concreto) per
// verificare che il vincolo "capacità video" valga anche con una forzatura.
const videoCtxArb: fc.Arbitrary<BackendSelectionContext> = fc.record(
	{
		video: fc.constant<true>(true),
		forcedId: fc.option(fc.constantFrom('auto', 'a1111', 'comfyui', 'gemini', 'openai', 'local-x', 'cloud-y'), { nil: undefined }),
	},
	{ requiredKeys: ['video'] },
);

test('Property 25: per una richiesta video, il backend selezionato (se esiste) supporta i video', () => {
	fc.assert(
		fc.property(descriptorsArb, videoCtxArb, (descriptors, ctx) => {
			const result = chooseGenerationBackend(descriptors, ctx);

			// Candidati validi per una richiesta video: disponibili E con capacità video.
			const videoCapable = descriptors.filter(d => d.available && d.supportsVideo);

			if (result === undefined) {
				// Nessuna scelta è ammessa solo quando non esiste alcun backend video disponibile.
				assert.strictEqual(videoCapable.length, 0, 'undefined ammesso solo se nessun backend video è disponibile');
				return;
			}

			// Invariante centrale della proprietà: se viene selezionato un backend, supporta i video.
			assert.strictEqual(result.supportsVideo, true, 'il backend selezionato per un video deve supportare i video');
			// Deve anche essere disponibile e appartenere ai candidati video.
			assert.strictEqual(result.available, true, 'il backend selezionato deve essere disponibile');
			assert.ok(videoCapable.includes(result), 'il backend selezionato deve appartenere ai backend video disponibili');
		}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
