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
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Su Windows, node-pty richiede a runtime i binari ConPTY di Microsoft
 * (conpty.dll + OpenConsole.exe) in build/Release/conpty/. @electron/rebuild ricompila
 * solo il .node e NON li ripristina: senza, il terminale fallisce con
 * "Cannot find conpty.dll". Li copiamo dalle prebuilds incluse (estensione copilot).
 */
function restoreConpty() {
	if (process.platform !== 'win32') {
		return;
	}
	const arch = process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
	const src = join(root, 'extensions', 'copilot', 'node_modules', '@github', 'copilot', 'prebuilds', arch, 'conpty');
	const dest = join(root, 'node_modules', 'node-pty', 'build', 'Release', 'conpty');
	const files = ['conpty.dll', 'OpenConsole.exe'];
	if (!files.every(f => existsSync(join(src, f)))) {
		console.warn(`[mgcoding] ATTENZIONE: binari ConPTY non trovati in ${src}; il terminale potrebbe non avviarsi.`);
		return;
	}
	mkdirSync(dest, { recursive: true });
	for (const f of files) {
		copyFileSync(join(src, f), join(dest, f));
	}
	console.log('[mgcoding] Binari ConPTY ripristinati per node-pty (terminale).');
}

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

const MODULES = ['@vscode/sqlite3', 'native-keymap', 'native-is-elevated', '@parcel/watcher', 'node-pty'];

const target = electronTarget();
console.log(`[mgcoding] Ricompilo i moduli nativi per Electron ${target}: ${MODULES.join(', ')}`);

execFileSync(
	process.platform === 'win32' ? 'npx.cmd' : 'npx',
	['--yes', '@electron/rebuild@latest', '-v', target, '-f', '--only', MODULES.join(','), '--arch', process.arch],
	{ cwd: root, stdio: 'inherit' }
);

restoreConpty();

console.log('[mgcoding] Moduli nativi ricompilati. Ora puoi buildare l\'installer.');
