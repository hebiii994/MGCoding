/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per i separatori di percorso coerenti con l'OS.
 *  Eseguibile con: node out/test/pathsSeparators.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 39: La costruzione dei percorsi usa separatori coerenti con l'OS
 *  "Per ogni sequenza di segmenti di percorso, il percorso costruito usa il separatore dell'OS
 *   corrente in modo coerente, senza mischiare separatori."
 *  Per `joinPath(platform, ...segments)`, con platform in {'win32','posix'}:
 *    - il risultato usa esclusivamente il separatore della piattaforma (mai `\` e `/` insieme),
 *      verificato tramite `usesConsistentSeparators(result, platform)`.
 *  **Validates: Requirements 24.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	joinPath,
	separatorFor,
	usesConsistentSeparators,
	type OsPlatform,
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

// Entrambe le piattaforme supportate: la coerenza dei separatori deve valere per ciascuna.
const platformArb = fc.constantFrom<OsPlatform>('win32', 'posix');

// Segmenti di percorso arbitrari: possono includere separatori misti (`\` e/o `/`), segmenti
// vuoti e caratteri qualsiasi, così da esercitare la normalizzazione di joinPath.
const segmentArb = fc.string({ minLength: 0, maxLength: 10 });

test("Property 39: joinPath usa separatori coerenti con l'OS", () => {
	fc.assert(
		fc.property(
			platformArb,
			fc.array(segmentArb, { minLength: 0, maxLength: 6 }),
			(platform, segments) => {
				const result = joinPath(platform, ...segments);
				const sep = separatorFor(platform);
				const foreign = sep === '\\' ? '/' : '\\';

				// Il percorso costruito non mischia mai i separatori delle due piattaforme.
				assert.ok(
					usesConsistentSeparators(result, platform),
					`il risultato "${result}" deve usare solo il separatore "${sep}" (platform=${platform})`,
				);

				// Verifica diretta: nessuna occorrenza del separatore "estraneo".
				assert.ok(
					!result.includes(foreign),
					`il risultato "${result}" non deve contenere il separatore estraneo "${foreign}"`,
				);
			},
		),
		{ numRuns: 300 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
