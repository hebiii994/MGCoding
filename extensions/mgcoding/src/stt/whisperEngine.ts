/*---------------------------------------------------------------------------------------------
 *  MGCoding - motore STT Whisper integrato e auto-avviato (0.5.0)
 *  Avvia un server whisper.cpp incluso nel pacchetto (extensions/mgcoding/bin) al primo
 *  uso del microfono ed espone un endpoint locale OpenAI-compatibile per la trascrizione.
 *  NB: i binari/modello vengono scaricati in fase di build da build/mgcoding/fetch-stt.mjs.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** Trova una porta TCP libera. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

/** Attende che la porta accetti connessioni (server pronto). */
function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise(resolve => {
		const tryOnce = (): void => {
			const sock = net.connect(port, '127.0.0.1');
			sock.on('connect', () => { sock.destroy(); resolve(true); });
			sock.on('error', () => {
				sock.destroy();
				if (Date.now() > deadline) {
					resolve(false);
				} else {
					setTimeout(tryOnce, 300);
				}
			});
		};
		tryOnce();
	});
}

/** Gestisce il server whisper.cpp incluso: lo avvia su richiesta e fornisce l'endpoint. */
export class WhisperEngine {
	private proc?: ChildProcess;
	private port = 0;
	private starting?: Promise<string | undefined>;

	/** @param binDir cartella che contiene whisper-server.exe e il modello (.../bin) */
	constructor(private readonly binDir: string) { }

	private exePath(): string {
		return path.join(this.binDir, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
	}

	private modelPath(): string {
		// Sceglie il modello .bin PIÙ GRANDE presente (small/medium > base) per la migliore
		// accuratezza; così basta scaricare un modello più capace per usarlo in automatico.
		try {
			const bins = fs.readdirSync(this.binDir).filter(f => f.endsWith('.bin'));
			if (!bins.length) {
				return '';
			}
			const largest = bins
				.map(f => ({ f, size: fs.statSync(path.join(this.binDir, f)).size }))
				.sort((a, b) => b.size - a.size)[0].f;
			return path.join(this.binDir, largest);
		} catch {
			return '';
		}
	}

	/** Ferma il server (verrà riavviato al prossimo uso con il modello attuale/aggiornato). */
	private restart(): void {
		try { this.proc?.kill(); } catch { /* */ }
		this.proc = undefined;
		this.port = 0;
	}

	/**
	 * Scarica un modello Whisper migliore (ggml-<name>.bin) da HuggingFace in bin/ e riavvia
	 * il server così da usarlo. name es. 'small', 'medium', 'large-v3-turbo'.
	 */
	async downloadModel(name: string, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<void> {
		const file = `ggml-${name}.bin`;
		const dest = path.join(this.binDir, file);
		const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
		const res = await fetch(url, { redirect: 'follow', signal });
		if (!res.ok || !res.body) {
			throw new Error(`Download non riuscito (HTTP ${res.status}) per ${file}.`);
		}
		const total = Number(res.headers.get('content-length') ?? 0);
		const tmp = `${dest}.part`;
		const out = fs.createWriteStream(tmp);
		const reader = res.body.getReader();
		let received = 0;
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			out.write(Buffer.from(value));
			received += value.length;
			if (total > 0) {
				onProgress(Math.floor((received / total) * 100));
			}
		}
		await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
		fs.renameSync(tmp, dest);
		this.restart();
	}

	/** True se il motore è incluso nel pacchetto (binario + modello presenti). */
	isAvailable(): boolean {
		return fs.existsSync(this.exePath()) && !!this.modelPath();
	}

	/** Avvia (se serve) il server e ritorna l'endpoint OpenAI-compatibile, o undefined. */
	async ensureRunning(): Promise<string | undefined> {
		if (this.proc && this.port) {
			return this.endpoint();
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = this.start().finally(() => { this.starting = undefined; });
		return this.starting;
	}

	private async start(): Promise<string | undefined> {
		if (!this.isAvailable()) {
			return undefined;
		}
		this.port = await freePort();
		this.proc = spawn(this.exePath(), ['-m', this.modelPath(), '--host', '127.0.0.1', '--port', String(this.port)], { stdio: 'ignore' });
		this.proc.on('exit', () => { this.proc = undefined; this.port = 0; });
		const ok = await waitForPort(this.port, 20000);
		return ok ? this.endpoint() : undefined;
	}

	private endpoint(): string {
		// whisper.cpp server: endpoint di trascrizione (multipart 'file', response_format json).
		return `http://127.0.0.1:${this.port}/inference`;
	}

	// ---- Registrazione microfono (via SoX, FUORI dal webview) ----

	private recProc?: ChildProcess;

	private soxPath(): string {
		const bundled = path.join(this.binDir, 'sox', process.platform === 'win32' ? 'sox.exe' : 'sox');
		if (fs.existsSync(bundled)) {
			return bundled;
		}
		// macOS/Linux: usa SoX di sistema (es. Homebrew) se non è bundlato.
		if (process.platform !== 'win32') {
			for (const p of ['/opt/homebrew/bin/sox', '/usr/local/bin/sox', '/usr/bin/sox']) {
				if (fs.existsSync(p)) {
					return p;
				}
			}
		}
		return bundled;
	}

	/** True se il recorder (SoX) è incluso. */
	canRecord(): boolean {
		return fs.existsSync(this.soxPath());
	}

	/**
	 * Registra dal microfono in un WAV 16kHz mono. Di default si ferma da solo dopo una
	 * pausa (VAD di SoX). Con `fixedSeconds` registra una durata fissa (utile per test).
	 * Ritorna il percorso del WAV, o undefined se non ha catturato nulla.
	 */
	recordToWav(opts?: { device?: string; maxSeconds?: number; thresholdPct?: number; fixedSeconds?: number }): Promise<string | undefined> {
		const maxSeconds = opts?.maxSeconds ?? 15;
		const device = (opts?.device || '').trim();
		const thr = `${opts?.thresholdPct ?? 2}%`;
		return new Promise(resolve => {
			if (!this.canRecord()) {
				resolve(undefined);
				return;
			}
			const out = path.join(os.tmpdir(), `mg-rec-${Date.now()}.wav`);
			// Driver audio per piattaforma: Windows=waveaudio, macOS=coreaudio, Linux=alsa.
			const driver = process.platform === 'win32' ? 'waveaudio' : process.platform === 'darwin' ? 'coreaudio' : 'alsa';
			// Sorgente: device specifico se indicato, altrimenti il default di sistema (-d).
			const src = device ? ['-t', driver, device] : ['-t', driver, '-d'];
			// Ricetta robusta (VAD):
			//  - start gate a `thr`: ATTENDE la voce prima di registrare (così non cattura il
			//    silenzio iniziale fermandosi subito → niente più [BLANK_AUDIO] in hands-free).
			//  - stop dopo `trail`s sotto soglia (fine voce).
			//  - `trim 0 maxSeconds`: cap pulito → SoX esce e finalizza il WAV da solo (niente
			//    kill a metà che lasciava file corrotti).
			const tail = opts?.fixedSeconds
				? ['trim', '0', String(opts.fixedSeconds)]
				: ['silence', '1', '0.1', thr, '1', '1.5', thr, 'trim', '0', String(maxSeconds)];
			const args = [...src, '-r', '16000', '-c', '1', '-b', '16', out, ...tail];
			let done = false;
			const finish = (val: string | undefined): void => { if (!done) { done = true; resolve(val); } };
			let p: ChildProcess;
			try {
				p = spawn(this.soxPath(), args, { stdio: 'ignore' });
			} catch {
				finish(undefined);
				return;
			}
			this.recProc = p;
			// Solo rete di sicurezza: il cap `trim` dovrebbe far uscire SoX prima di questo.
			const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } }, (maxSeconds + 5) * 1000);
			p.on('error', () => { clearTimeout(timer); this.recProc = undefined; finish(undefined); });
			p.on('exit', () => {
				clearTimeout(timer);
				this.recProc = undefined;
				try {
					finish(fs.statSync(out).size > 1500 ? out : undefined);
				} catch {
					finish(undefined);
				}
			});
		});
	}

	/** Ferma una registrazione in corso (SoX finalizza il file alla chiusura). */
	stopRecording(): void {
		try { this.recProc?.kill(); } catch { /* */ }
	}

	dispose(): void {
		try {
			this.proc?.kill();
		} catch {
			// ignora
		}
		this.stopRecording();
		this.proc = undefined;
		this.port = 0;
	}
}
