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

/** Trova ricorsivamente il primo file con uno dei nomi dati. */
function findFile(dir, names) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			const found = findFile(p, names);
			if (found) { return found; }
		} else if (names.includes(e.name)) {
			return p;
		}
	}
	return undefined;
}

/**
 * macOS: whisper.cpp non pubblica binari prebuilt del server, quindi lo compiliamo da
 * sorgente (static, così il binario è autonomo). Servono git e cmake (brew install cmake).
 * Il recorder microfono su macOS usa SoX di sistema (brew install sox), non bundlato.
 */
function buildWhisperMac() {
	const serverOut = join(binDir, 'whisper-server');
	if (existsSync(serverOut)) { console.log('[fetch-stt] whisper-server (mac) già presente.'); return; }
	const src = join(tmpdir(), 'mg-whisper-src');
	const build = join(src, 'build');
	rmSync(src, { recursive: true, force: true });
	console.log('[fetch-stt] clono whisper.cpp…');
	execFileSync('git', ['clone', '--depth', '1', '--branch', WHISPER_VERSION, 'https://github.com/ggml-org/whisper.cpp', src], { stdio: 'inherit' });
	console.log('[fetch-stt] compilo whisper.cpp (cmake)… (qualche minuto)');
	execFileSync('cmake', ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF'], { stdio: 'inherit' });
	execFileSync('cmake', ['--build', build, '--config', 'Release', '-j'], { stdio: 'inherit' });
	const bin = findFile(build, ['whisper-server', 'server']);
	if (!bin) { throw new Error('whisper-server non trovato dopo la build.'); }
	copyFileSync(bin, serverOut);
	execFileSync('chmod', ['+x', serverOut]);
	console.log('[fetch-stt] whisper-server (mac) compilato in bin/.');
}

async function main() {
	mkdirSync(binDir, { recursive: true });

	if (process.platform === 'darwin') {
		// 1) Server whisper.cpp (compilato da sorgente).
		buildWhisperMac();
		// 2) Modello.
		await download(MODEL_URL, join(binDir, MODEL_FILE));
		// 3) Recorder: su macOS si usa SoX di Homebrew (brew install sox) — fallback nel codice.
		console.log('[fetch-stt] completato (macOS). NB: per la voce serve "brew install sox".');
		return;
	}

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
