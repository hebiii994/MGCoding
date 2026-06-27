/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la preservazione del formato video nel
 *  salvataggio in Galleria. Eseguibile con: node out/test/outputFormat.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 16: Il salvataggio preserva il formato originale del video
 *  "Per ogni file video recuperato, il percorso di destinazione nella Galleria mantiene la
 *   stessa estensione/formato del file di origine."
 *  **Validates: Requirements 6.3**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { destinationPath, extensionOf } from '../media/outputClassifier';

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

// Estensioni video riconosciute (PURE_VIDEO_EXTENSIONS + animazioni) di outputClassifier.ts.
// Ogni file video recuperato avrà una di queste estensioni.
const VIDEO_EXTENSIONS = [
	'mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'flv', 'gifv', 'gif',
];

// Identificatore "sicuro" per percorsi: solo lettere/cifre/underscore, niente punti né
// separatori, così da non introdurre estensioni o segmenti spuri nei nomi generati.
const ident: fc.Arbitrary<string> = fc
	.array(
		fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
		{ minLength: 1, maxLength: 12 },
	)
	.map(chars => chars.join(''));

// Estensione video, eventualmente con casing misto: il file di origine può arrivare in
// MAIUSCOLO/minuscolo; outputClassifier normalizza l'estensione a minuscolo.
const videoExtArb: fc.Arbitrary<string> = fc
	.constantFrom(...VIDEO_EXTENSIONS)
	.chain(ext => fc.boolean().map(upper => (upper ? ext.toUpperCase() : ext)));

// Prefisso di cartella opzionale per il file di origine (per esercitare baseName con
// separatori `/` e `\`). Può essere vuoto.
const sourceDirPrefixArb: fc.Arbitrary<string> = fc.oneof(
	fc.constant(''),
	fc.array(ident, { minLength: 1, maxLength: 3 }).chain(segs =>
		fc.constantFrom('/', '\\').map(sep => segs.join(sep) + sep),
	),
);

// File video di origine: <prefisso opzionale><base>.<estVideo>
const sourceFilenameArb: fc.Arbitrary<string> = fc
	.tuple(sourceDirPrefixArb, ident, videoExtArb)
	.map(([prefix, base, ext]) => `${prefix}${base}.${ext}`);

// Cartella di destinazione: 0..3 segmenti, eventualmente con separatori finali ripetuti.
const destDirArb: fc.Arbitrary<string> = fc
	.array(ident, { minLength: 0, maxLength: 3 })
	.chain(segs =>
		fc.constantFrom('', '/', '//', '\\', '/\\').map(trailing =>
			(segs.length > 0 ? segs.join('/') : '') + (segs.length > 0 ? trailing : ''),
		),
	);

// Nuovo nome base opzionale, SENZA estensione (niente punti) per rispettare il contratto.
const newBaseNameArb: fc.Arbitrary<string | undefined> = fc.option(ident, { nil: undefined });

test('Property 16: destinationPath preserva l\'estensione/formato del video di origine', () => {
	fc.assert(
		fc.property(sourceFilenameArb, destDirArb, newBaseNameArb, (source, destDir, newBaseName) => {
			const dest = destinationPath(source, destDir, newBaseName);
			const sourceExt = extensionOf(source);

			// Precondizione: il file di origine è un video con estensione nota (lowercased).
			assert.ok(VIDEO_EXTENSIONS.includes(sourceExt),
				`estensione di origine inattesa: ${sourceExt} (${source})`);

			// Cuore della Property 16: il percorso di destinazione mantiene la stessa
			// estensione/formato del file di origine.
			assert.strictEqual(extensionOf(dest), sourceExt,
				`il formato deve essere preservato: source=${source} dest=${dest}`);

			// Il nome di destinazione deve terminare con la medesima estensione.
			assert.ok(dest.toLowerCase().endsWith(`.${sourceExt}`),
				`il nome di destinazione deve finire con .${sourceExt}: ${dest}`);
		}),
		{ numRuns: 300 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
