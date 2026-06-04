/*---------------------------------------------------------------------------------------------
 *  MGCoding - ricompila i moduli nativi per l'ABI di Electron.
 *
 *  I moduli nativi dell'app (es. @vscode/sqlite3 per lo storage state.vscdb, native-keymap
 *  per le scorciatoie) DEVONO essere compilati per l'ABI di Electron, non di Node. Se restano
 *  compilati per Node (o non compilati affatto), Electron non li carica: lo storage SQLite va
 *  in fallback in-memory e NON persiste globalState/layout tra i riavvii.
 *
 *  Esegui questo script dopo ogni `npm install` e PRIMA di buildare l'installer:
 *      node build/mgcoding/rebuild-natives.mjs
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Versione target di Electron presa da .npmrc (target=...).
function electronTarget() {
	const npmrc = join(root, '.npmrc');
	if (existsSync(npmrc)) {
		const m = readFileSync(npmrc, 'utf8').match(/^target\s*=\s*"?([\d.]+)"?/m);
		if (m) {
			return m[1];
		}
	}
	throw new Error('Impossibile determinare la versione target di Electron da .npmrc');
}

const MODULES = ['@vscode/sqlite3', 'native-keymap'];

const target = electronTarget();
console.log(`[mgcoding] Ricompilo i moduli nativi per Electron ${target}: ${MODULES.join(', ')}`);

execFileSync(
	process.platform === 'win32' ? 'npx.cmd' : 'npx',
	['--yes', '@electron/rebuild@latest', '-v', target, '-f', '--only', MODULES.join(','), '--arch', process.arch],
	{ cwd: root, stdio: 'inherit' }
);

console.log('[mgcoding] Moduli nativi ricompilati. Ora puoi buildare l\'installer.');
