/*---------------------------------------------------------------------------------------------
 *  MGCoding - sync dell'estensione compilata DENTRO l'app MGCoding installata (per-utente).
 *
 *  Loop di sviluppo veloce senza ricompilare il core né rifare l'installer:
 *    1) `npm run compile` (o il watch) aggiorna `extensions/mgcoding/out`;
 *    2) `node scripts/dev-install.mjs` copia out/ + package.json (+ asset runtime) nell'app
 *       installata sotto %LOCALAPPDATA%\Programs\MGCoding;
 *    3) in MGCoding premi Ctrl+R (Reload Window) per caricare il nuovo codice.
 *
 *  Va eseguito dalla cartella dell'estensione (cwd = extensions/mgcoding). Se l'app è aperta e
 *  un file risulta bloccato, chiudi la finestra, rilancia lo script e riapri MGCoding.
 *--------------------------------------------------------------------------------------------*/

import { cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
	console.error('LOCALAPPDATA non impostata: impossibile trovare l\'app installata.');
	process.exit(1);
}
const target = join(localAppData, 'Programs', 'MGCoding', 'resources', 'app', 'extensions', 'mgcoding');
if (!existsSync(target)) {
	console.error(`App installata non trovata in: ${target}\nInstalla prima MGCoding (MGCodingSetup.exe).`);
	process.exit(1);
}

// Copia il codice compilato (out/ ripulito per evitare file orfani) e il manifest. Gli asset
// runtime (media/, themes/) vengono copiati se presenti, così cambi di icone/temi si riflettono.
const items = ['out', 'package.json', 'media', 'themes'];
for (const item of items) {
	const src = join(extRoot, item);
	if (!existsSync(src)) {
		continue;
	}
	const dst = join(target, item);
	try {
		// Sovrascrittura in-place (niente rm di out/): così la copia funziona anche con l'app
		// aperta, evitando i lock dei .js già caricati. Per il solo Ctrl+R non serve chiuderla.
		cpSync(src, dst, { recursive: true, force: true });
		console.log(`ok   - ${item}`);
	} catch (err) {
		console.error(`FAIL - ${item}: ${err instanceof Error ? err.message : String(err)}`);
		console.error('Se l\'app è aperta, chiudila del tutto e riprova (file bloccato).');
		process.exit(1);
	}
}

console.log(`\nSync completato in: ${target}\nApri MGCoding e premi Ctrl+R per caricare le modifiche.`);
