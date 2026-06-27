/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il comando di avvio di ComfyUI su Windows.
 *  Eseguibile con: node out/test/pathsLaunch.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 38: Il comando di avvio su Windows usa l'invocazione attesa
 *  "Per ogni layout di installazione su piattaforma Windows, il comando di avvio costruito usa
 *   l'interprete/eseguibile e gli argomenti attesi per quella piattaforma."
 *  Per `buildWindowsLaunch(installRoot, extraArgs)`:
 *    - command === `<installRoot>\python_embeded\python.exe`  (separatori Windows)
 *    - args     === ['-s', 'ComfyUI\\main.py', ...extraArgs]
 *  **Validates: Requirements 24.2**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	buildWindowsLaunch,
	COMFYUI_DIR,
	COMFYUI_MAIN,
	PYTHON_EMBEDED_DIR,
	PYTHON_EMBEDED_EXE,
} from '../util/paths';

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

const WIN_SEP = '\\';

// Un segmento di percorso "pulito": non vuoto e privo di separatori, così da costruire un
// installRoot Windows canonico con esiti prevedibili (indipendenti da joinPath).
const segmentArb = fc
	.string({ minLength: 1, maxLength: 8 })
	.filter(s => s.length > 0 && !s.includes('/') && !s.includes('\\'));

// Eventuale prefisso di radice (lettera di unità Windows) oppure percorso relativo ('').
const driveArb = fc.constantFrom('', 'C:', 'D:', 'Z:');

// Argomenti aggiuntivi arbitrari (es. --listen, --port 8188): passano inalterati in coda.
const extraArgsArb = fc.array(fc.string(), { minLength: 0, maxLength: 4 });

test('Property 38: buildWindowsLaunch usa interprete embedded e argomenti attesi', () => {
	fc.assert(
		fc.property(driveArb, fc.array(segmentArb, { minLength: 1, maxLength: 5 }), extraArgsArb,
			(drive, segs, extraArgs) => {
				// Costruisce un installRoot Windows canonico (solo separatori `\`).
				const installRoot = drive
					? drive + WIN_SEP + segs.join(WIN_SEP)
					: segs.join(WIN_SEP);

				const { command, args } = buildWindowsLaunch(installRoot, extraArgs);

				// L'eseguibile è l'interprete embedded sotto installRoot.
				const expectedCommand =
					installRoot + WIN_SEP + PYTHON_EMBEDED_DIR + WIN_SEP + PYTHON_EMBEDED_EXE;
				assert.strictEqual(
					command,
					expectedCommand,
					`command deve essere "${expectedCommand}", ottenuto "${command}"`,
				);

				// Gli argomenti sono -s, lo script principale e poi gli extra, in ordine.
				const expectedMain = COMFYUI_DIR + WIN_SEP + COMFYUI_MAIN; // ComfyUI\main.py
				assert.deepStrictEqual(
					args,
					['-s', expectedMain, ...extraArgs],
					`args devono essere ['-s', '${expectedMain}', ...extraArgs]`,
				);

				// Separatori coerenti con Windows: nessuna barra in avanti nei percorsi prodotti.
				assert.ok(!command.includes('/'), `command non deve contenere '/': "${command}"`);
				assert.ok(!args[1].includes('/'), `lo script main non deve contenere '/': "${args[1]}"`);
			}),
		{ numRuns: 200 },
	);
});

test('Property 38: extraArgs assente equivale a nessun argomento aggiuntivo', () => {
	fc.assert(
		fc.property(driveArb, fc.array(segmentArb, { minLength: 1, maxLength: 5 }),
			(drive, segs) => {
				const installRoot = drive
					? drive + WIN_SEP + segs.join(WIN_SEP)
					: segs.join(WIN_SEP);
				const { args } = buildWindowsLaunch(installRoot);
				assert.deepStrictEqual(args, ['-s', COMFYUI_DIR + WIN_SEP + COMFYUI_MAIN]);
			}),
		{ numRuns: 200 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
