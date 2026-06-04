/*---------------------------------------------------------------------------------------------
 *  MGCoding - scarica il motore STT (whisper.cpp server + modello) in fase di build.
 *  Output: extensions/mgcoding/bin/{whisper-server.exe, ggml-*.dll, ggml-base.bin}
 *  Uso: node build/mgcoding/fetch-stt.mjs
 *  Tutto resta locale e offline una volta scaricato. Eseguire prima del packaging (0.5.0+).
 *--------------------------------------------------------------------------------------------*/

import { createWriteStream, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const binDir = join(root, 'extensions', 'mgcoding', 'bin');

const WHISPER_VERSION = process.env.MG_WHISPER_VERSION || 'v1.8.6';
const ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const MODEL_URL = process.env.MG_WHISPER_MODEL_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_FILE = 'ggml-base.bin';
const NEEDED = ['whisper-server.exe', 'ggml-base.dll', 'ggml-cpu.dll', 'ggml.dll', 'whisper.dll'];

async function download(url, dest) {
	if (existsSync(dest)) { console.log(`[fetch-stt] già presente: ${dest}`); return; }
	console.log(`[fetch-stt] scarico ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok || !res.body) { throw new Error(`HTTP ${res.status} per ${url}`); }
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
	mkdirSync(binDir, { recursive: true });

	// 1) Binario del server + DLL (estratto dallo zip della release con `tar`, che su
	//    Windows 10+/macOS/Linux gestisce anche gli zip).
	const haveBin = NEEDED.every(f => existsSync(join(binDir, f)));
	if (!haveBin) {
		const zip = join(tmpdir(), 'mg-whisper-bin.zip');
		const ex = join(tmpdir(), 'mg-whisper-ex');
		await download(ZIP_URL, zip);
		rmSync(ex, { recursive: true, force: true });
		mkdirSync(ex, { recursive: true });
		execFileSync('tar', ['-xf', zip, '-C', ex], { stdio: 'inherit' });
		for (const f of NEEDED) {
			copyFileSync(join(ex, 'Release', f), join(binDir, f));
		}
		console.log('[fetch-stt] binario + DLL estratti.');
	}

	// 2) Modello
	await download(MODEL_URL, join(binDir, MODEL_FILE));
	console.log('[fetch-stt] completato.');
}

main().catch(err => { console.error('[fetch-stt] errore:', err); process.exit(1); });
