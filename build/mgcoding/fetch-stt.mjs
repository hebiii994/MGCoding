/*---------------------------------------------------------------------------------------------
 *  MGCoding - scarica il motore STT (whisper.cpp server + modello) in fase di build.
 *  Output: extensions/mgcoding/bin/{whisper-server.exe, ggml-*.dll, ggml-base.bin}
 *  Uso: node build/mgcoding/fetch-stt.mjs
 *  Tutto resta locale e offline una volta scaricato. Eseguire prima del packaging (0.5.0+).
 *--------------------------------------------------------------------------------------------*/

import { createWriteStream, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
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

// SoX: recorder microfono (registrazione FUORI dal webview, poi Whisper trascrive).
const SOX_URL = process.env.MG_SOX_URL || 'https://downloads.sourceforge.net/project/sox/sox/14.4.2/sox-14.4.2-win32.zip';
const SOX_DIR_IN_ZIP = 'sox-14.4.2';

/** Estrae uno zip: prova `tar`, poi PowerShell Expand-Archive (alcuni zip non piacciono a tar). */
function unzip(zip, dest) {
	try {
		execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'ignore' });
		return;
	} catch {
		execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zip}" -DestinationPath "${dest}" -Force`], { stdio: 'inherit' });
	}
}

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

	// 3) SoX (recorder microfono) in bin/sox/
	const soxDir = join(binDir, 'sox');
	if (!existsSync(join(soxDir, 'sox.exe'))) {
		mkdirSync(soxDir, { recursive: true });
		const zip = join(tmpdir(), 'mg-sox.zip');
		const ex = join(tmpdir(), 'mg-sox-ex');
		await download(SOX_URL, zip);
		rmSync(ex, { recursive: true, force: true });
		mkdirSync(ex, { recursive: true });
		unzip(zip, ex);
		const from = join(ex, SOX_DIR_IN_ZIP);
		for (const f of readdirSync(from)) {
			if (f.endsWith('.exe') && f !== 'sox.exe') { continue; } // scarta wget.exe
			if (f.endsWith('.exe') || f.endsWith('.dll')) {
				copyFileSync(join(from, f), join(soxDir, f));
			}
		}
		console.log('[fetch-stt] SoX estratto in bin/sox.');
	}
	console.log('[fetch-stt] completato.');
}

main().catch(err => { console.error('[fetch-stt] errore:', err); process.exit(1); });
