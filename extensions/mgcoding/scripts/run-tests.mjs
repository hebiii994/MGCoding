/*---------------------------------------------------------------------------------------------
 *  MGCoding - runner della suite di test dell'estensione.
 *
 *  I test girano con node puro (`node out/test/<nome>.test.js`), senza un runner esterno. Questo
 *  script trova tutti i file `out/test/*.test.js`, li esegue in sequenza ereditando lo stdio e
 *  termina con codice ≠ 0 se anche un solo file fallisce. È invocato da `npm test` (che prima
 *  ricompila via lo script `pretest`). Richiede che le sorgenti siano già compilate sotto `out/`.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'test');

let files;
try {
	files = readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
} catch {
	console.error(`Nessuna cartella ${testDir}: compila prima le sorgenti (npm run compile / gulp compile-extension:mgcoding).`);
	process.exit(1);
}

if (files.length === 0) {
	console.error(`Nessun file *.test.js in ${testDir}.`);
	process.exit(1);
}

let failed = 0;
for (const f of files) {
	const res = spawnSync(process.execPath, [join(testDir, f)], { stdio: 'inherit' });
	if (res.status !== 0) {
		failed++;
		console.error(`\n>>> FALLITO: ${f}\n`);
	}
}

console.log(`\n=== ${files.length - failed}/${files.length} file di test OK ===`);
process.exit(failed > 0 ? 1 : 0);
