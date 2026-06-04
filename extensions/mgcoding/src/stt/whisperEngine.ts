/*---------------------------------------------------------------------------------------------
 *  MGCoding - motore STT Whisper integrato e auto-avviato (0.5.0)
 *  Avvia un server whisper.cpp incluso nel pacchetto (extensions/mgcoding/bin) al primo
 *  uso del microfono ed espone un endpoint locale OpenAI-compatibile per la trascrizione.
 *  NB: i binari/modello vengono scaricati in fase di build da build/mgcoding/fetch-stt.mjs.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
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

	dispose(): void {
		try {
			this.proc?.kill();
		} catch {
			// ignora
		}
		this.proc = undefined;
		this.port = 0;
	}
}
