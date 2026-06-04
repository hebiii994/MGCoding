/*---------------------------------------------------------------------------------------------
 *  MGCoding - scarica il motore STT (whisper.cpp server + modello) in fase di build.
 *  Output: extensions/mgcoding/bin/{whisper-server.exe, ggml-*.bin}
 *  Uso: node build/mgcoding/fetch-stt.mjs   (eseguito prima del packaging per la 0.5.0)
 *
 *  NB: gli URL sono parametrizzabili; verifica l'asset corretto della release whisper.cpp
 *  per la tua piattaforma. Il modello "base" (~142MB) è un buon compromesso qualità/peso;
 *  "tiny" (~75MB) è più leggero. Tutto resta locale e offline una volta scaricato.
 *--------------------------------------------------------------------------------------------*/

import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const binDir = join(root, 'extensions', 'mgcoding', 'bin');

// --- Configurazione (adatta gli URL alla release/piattaforma desiderata) ---
const MODEL_URL = process.env.MG_WHISPER_MODEL_URL
	|| 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_FILE = 'ggml-base.bin';

// Binario del server whisper.cpp per Windows x64 (zip della release ufficiale).
// Lascia vuoto per saltare il download del binario (es. lo fornisci a mano).
const SERVER_ZIP_URL = process.env.MG_WHISPER_SERVER_URL || '';

async function download(url, dest) {
	if (existsSync(dest)) {
		console.log(`[fetch-stt] già presente: ${dest}`);
		return;
	}
	console.log(`[fetch-stt] scarico ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok || !res.body) {
		throw new Error(`HTTP ${res.status} per ${url}`);
	}
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
	console.log(`[fetch-stt] salvato: ${dest}`);
}

async function main() {
	mkdirSync(binDir, { recursive: true });
	await download(MODEL_URL, join(binDir, MODEL_FILE));
	if (SERVER_ZIP_URL) {
		// Lo zip va estratto in binDir (whisper-server.exe). L'estrazione si aggiunge
		// quando si fissa la release/asset esatti per la 0.5.0.
		await download(SERVER_ZIP_URL, join(binDir, 'whisper-server.zip'));
		console.log('[fetch-stt] NB: estrai whisper-server.zip in bin/ (passo da finalizzare).');
	} else {
		console.log('[fetch-stt] SERVER_ZIP_URL non impostato: binario del server da fornire (MG_WHISPER_SERVER_URL).');
	}
	console.log('[fetch-stt] fatto.');
}

main().catch(err => { console.error('[fetch-stt] errore:', err); process.exit(1); });
