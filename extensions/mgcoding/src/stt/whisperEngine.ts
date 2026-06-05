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
		// Primo file .bin nella cartella bin (es. ggml-base.bin).
		try {
			const m = fs.readdirSync(this.binDir).find(f => f.endsWith('.bin'));
			return m ? path.join(this.binDir, m) : '';
		} catch {
			return '';
		}
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
		return path.join(this.binDir, 'sox', process.platform === 'win32' ? 'sox.exe' : 'sox');
	}

	/** True se il recorder (SoX) è incluso. */
	canRecord(): boolean {
		return fs.existsSync(this.soxPath());
	}

	/**
	 * Registra dal microfono di default in un WAV 16kHz mono, fermandosi da solo dopo
	 * una pausa (VAD di SoX). Ritorna il percorso del WAV, o undefined se non ha catturato voce.
	 * @param maxSeconds limite di sicurezza (kill).
	 */
	recordToWav(maxSeconds = 60): Promise<string | undefined> {
		return new Promise(resolve => {
			if (!this.canRecord()) {
				resolve(undefined);
				return;
			}
			const out = path.join(os.tmpdir(), `mg-rec-${Date.now()}.wav`);
			// silence 1 0.1 3%  → inizia quando rileva voce; 1 1.5 3% → ferma dopo 1.5s di silenzio.
			const args = ['-t', 'waveaudio', '-d', '-r', '16000', '-c', '1', '-b', '16', out,
				'silence', '1', '0.1', '3%', '1', '1.5', '3%'];
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
			const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } }, maxSeconds * 1000);
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
