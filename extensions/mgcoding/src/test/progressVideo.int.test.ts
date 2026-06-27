/*---------------------------------------------------------------------------------------------
 *  MGCoding - Test di integrazione (node puro) per il Monitor_Avanzamento e il Motore_Generazione
 *  video, usando i punti di iniezione (`webSocketCtor`, `fetchImpl`) per evitare I/O reale.
 *  Eseguibile con: node out/test/progressVideo.int.test.js
 *
 *  Copre (asserzioni a esempi, niente property-based):
 *   - Avanzamento via WebSocket: `open` → eventi `progress`/`executing` mappati a ProgressUpdate
 *     (percent in [0,100], currentNode), con `live === true` mentre connesso.  (Req 8.1)
 *   - Annullamento: `cancel()` invia `POST <endpoint>/interrupt` (entro 5s) e segnala lo stato
 *     di annullamento.  (Req 8.2, 8.3)
 *   - Fallback al polling: alla caduta del WebSocket si interrogano `/history`/`/queue`.  (Req 8.4)
 *   - Recupero output: `queueAndCollectMedia` partiziona immagini e video scaricati da `/view`.
 *     (Req 6.4)  E `generateVideo` segnala `NoVideoOutputError` se il workflow non produce video.
 *
 *  Nota: `progressMonitor.ts` importa `vscode` solo come type (cancellato a runtime); `videoGen.ts`
 *  non importa `vscode`. Importiamo comunque lo stub PER PRIMO per coerenza con gli altri test e
 *  per robustezza se in futuro venisse aggiunto un import a runtime.
 *  _Requirements: 8.2, 8.3, 8.4, 6.4_
 *--------------------------------------------------------------------------------------------*/

import './vscodeStub';
import * as assert from 'assert';
import {
	ComfyProgressMonitor,
	createProgressMonitor,
	comfyWsUrl,
	type ProgressUpdate,
} from '../media/progressMonitor';
import {
	queueAndCollectMedia,
	generateVideo,
	NoVideoOutputError,
} from '../media/videoGen';
import type { ApiWorkflow } from '../media/workflowGraph';

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => void | Promise<void> }> = [];
/** Registra un test; l'esecuzione è sequenziale e deterministica (vedi `run`). */
function test(name: string, fn: () => void | Promise<void>): void {
	cases.push({ name, fn });
}

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const ENDPOINT = 'http://127.0.0.1:8188';

/**
 * WebSocket fittizio in stile DOM/undici (`addEventListener`). Cattura l'ultima istanza creata
 * tramite `onInstance` così il test può pilotare manualmente gli eventi `open`/`message`/`close`.
 */
class FakeWebSocket {
	static onInstance: ((ws: FakeWebSocket) => void) | undefined;
	readonly url: string;
	closed = false;
	private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.onInstance?.(this);
	}

	addEventListener(type: string, listener: (ev: unknown) => void): void {
		const arr = this.listeners.get(type) ?? [];
		arr.push(listener);
		this.listeners.set(type, arr);
	}

	close(): void {
		this.closed = true;
	}

	/** Recapita un evento ai sottoscrittori registrati. */
	emit(type: string, ev: unknown): void {
		for (const l of this.listeners.get(type) ?? []) {
			l(ev);
		}
	}
}

/** Costruttore tipizzato per l'iniezione (`webSocketCtor`). */
const FakeWsCtor = FakeWebSocket as unknown as new (url: string) => FakeWebSocket;

/** Costruisce una Response-like minimale per un corpo JSON. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		arrayBuffer: async () => new ArrayBuffer(0),
	} as unknown as Response;
}

/** Costruisce una Response-like minimale per un corpo binario (per `/view`). */
function bytesResponse(bytes: Uint8Array): Response {
	return {
		ok: true,
		status: 200,
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	} as unknown as Response;
}

// --------------------------------------------------------------------------------------------
// comfyWsUrl: conversione endpoint HTTP → URL WebSocket /ws
// --------------------------------------------------------------------------------------------
test('comfyWsUrl: http→ws e https→wss con clientId codificato', () => {
	assert.strictEqual(comfyWsUrl('http://127.0.0.1:8188', 'c 1'), 'ws://127.0.0.1:8188/ws?clientId=c%201');
	assert.strictEqual(comfyWsUrl('https://host:8188/', 'abc'), 'wss://host:8188/ws?clientId=abc');
});

// --------------------------------------------------------------------------------------------
// 1) Avanzamento via WebSocket: open → progress/executing; live === true mentre connesso (Req 8.1)
// --------------------------------------------------------------------------------------------
test('WebSocket: emette ProgressUpdate validi e live===true mentre connesso', () => {
	let ws: FakeWebSocket | undefined;
	FakeWebSocket.onInstance = (w) => { ws = w; };
	try {
		const monitor = new ComfyProgressMonitor(ENDPOINT, {
			clientId: 'client-1',
			promptId: 'prompt-1',
			webSocketCtor: FakeWsCtor,
			fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
		});

		const updates: ProgressUpdate[] = [];
		monitor.onUpdate(u => updates.push(u));
		monitor.start();

		assert.ok(ws, 'il monitor deve costruire il WebSocket iniettato');
		assert.strictEqual(ws!.url, 'ws://127.0.0.1:8188/ws?clientId=client-1', 'URL /ws atteso');
		assert.strictEqual(monitor.live, false, 'prima di open non è ancora live');

		// open → connesso
		ws!.emit('open', {});
		assert.strictEqual(monitor.live, true, 'dopo open la sorgente è il WebSocket (live)');

		// progress 5/10 sul nodo '7' → percent 50, currentNode '7'
		ws!.emit('message', { data: JSON.stringify({ type: 'progress', data: { value: 5, max: 10, node: '7' } }) });
		const last = updates[updates.length - 1];
		assert.ok(last, 'un evento progress deve produrre un update');
		assert.ok(last.percent >= 0 && last.percent <= 100, `percent in [0,100], era ${last.percent}`);
		assert.strictEqual(last.percent, 50, 'percent atteso 50');
		assert.strictEqual(last.currentNode, '7', 'currentNode atteso 7');

		// executing sul nodo '9' → currentNode '9'
		ws!.emit('message', { data: JSON.stringify({ type: 'executing', data: { node: '9' } }) });
		const exec = updates[updates.length - 1];
		assert.strictEqual(exec.currentNode, '9', 'currentNode atteso 9 dopo executing');

		assert.strictEqual(monitor.live, true, 'resta live finché la connessione è attiva');
		monitor.dispose();
	} finally {
		FakeWebSocket.onInstance = undefined;
	}
});

// --------------------------------------------------------------------------------------------
// 2) Annullamento: cancel() → POST /interrupt entro 5s e stato annullato (Req 8.2, 8.3)
// --------------------------------------------------------------------------------------------
test('cancel(): invia POST /interrupt e riporta lo stato di annullamento entro 5s', async () => {
	const calls: Array<{ url: string; method?: string }> = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method });
		if (url.endsWith('/interrupt')) {
			return jsonResponse({}, true, 200);
		}
		return jsonResponse({}, false, 404);
	}) as unknown as typeof fetch;

	const monitor = new ComfyProgressMonitor(ENDPOINT, {
		webSocketCtor: FakeWsCtor,
		fetchImpl,
	});

	const started = Date.now();
	const state = await monitor.cancel();
	const elapsed = Date.now() - started;

	assert.ok(elapsed < 5000, `cancel deve completare entro 5s, ha impiegato ${elapsed}ms`);
	assert.strictEqual(state.cancelled, true, 'lo stato deve risultare cancelled');
	assert.strictEqual(state.interrupted, true, 'interrupt accettato → interrupted true');

	const interruptCall = calls.find(c => c.url === `${ENDPOINT}/interrupt`);
	assert.ok(interruptCall, 'deve invocare <endpoint>/interrupt');
	assert.strictEqual(interruptCall!.method, 'POST', 'la chiamata a /interrupt deve essere POST');

	monitor.dispose();
});

// --------------------------------------------------------------------------------------------
// 3) Fallback al polling: alla caduta del WebSocket si interrogano /history e /queue (Req 8.4)
// --------------------------------------------------------------------------------------------
test('fallback polling: alla chiusura del WS interroga /history e /queue fino al completamento', async () => {
	let ws: FakeWebSocket | undefined;
	FakeWebSocket.onInstance = (w) => { ws = w; };
	try {
		let historyCalls = 0;
		let queueCalls = 0;
		const fetchImpl = (async (url: string) => {
			if (url.includes('/history/')) {
				historyCalls++;
				// Primo giro: nessun output (job ancora in esecuzione) → forza il polling di /queue.
				if (historyCalls === 1) {
					return jsonResponse({ 'prompt-1': { outputs: {} } });
				}
				// Giri successivi: output presente → job completato.
				return jsonResponse({ 'prompt-1': { outputs: { '9': { images: [{ filename: 'a.png' }] } } } });
			}
			if (url.endsWith('/queue')) {
				queueCalls++;
				// Il job monitorato è nella coda in esecuzione.
				return jsonResponse({ queue_running: [[0, 'prompt-1', {}]], queue_pending: [] });
			}
			return jsonResponse({}, false, 404);
		}) as unknown as typeof fetch;

		const monitor = new ComfyProgressMonitor(ENDPOINT, {
			clientId: 'client-1',
			promptId: 'prompt-1',
			webSocketCtor: FakeWsCtor,
			fetchImpl,
			pollIntervalMs: 10,
		});

		const updates: ProgressUpdate[] = [];
		monitor.onUpdate(u => updates.push(u));
		monitor.start();

		ws!.emit('open', {});
		assert.strictEqual(monitor.live, true, 'connesso via WS');

		// Caduta della connessione → fallback al polling.
		ws!.emit('close', { code: 1006 });
		assert.strictEqual(monitor.live, false, 'dopo la caduta non è più live (polling)');

		// Attendi alcuni cicli di polling.
		await delay(120);

		assert.ok(historyCalls >= 1, `deve interrogare /history (chiamate: ${historyCalls})`);
		assert.ok(queueCalls >= 1, `deve interrogare /queue quando il job è ancora in esecuzione (chiamate: ${queueCalls})`);

		const finalUpdate = updates[updates.length - 1];
		assert.ok(finalUpdate, 'il polling deve produrre almeno un update');
		assert.strictEqual(finalUpdate.percent, 100, 'al completamento il polling emette percent 100');
		assert.strictEqual(monitor.live, false, 'il fallback resta non-live');

		monitor.dispose();
	} finally {
		FakeWebSocket.onInstance = undefined;
	}
});

// --------------------------------------------------------------------------------------------
// 3b) createProgressMonitor senza WebSocket disponibile → parte direttamente in polling
// --------------------------------------------------------------------------------------------
test('createProgressMonitor: senza webSocketCtor ripiega sul polling e completa', async () => {
	let historyCalls = 0;
	const fetchImpl = (async (url: string) => {
		if (url.includes('/history/')) {
			historyCalls++;
			return jsonResponse({ 'p-x': { outputs: { '1': { images: [{ filename: 'z.png' }] } } } });
		}
		if (url.endsWith('/queue')) {
			return jsonResponse({ queue_running: [], queue_pending: [] });
		}
		return jsonResponse({}, false, 404);
	}) as unknown as typeof fetch;

	// In Node/Electron `globalThis.WebSocket` può esistere (undici): in tal caso il fallback
	// `?? resolveGlobalWebSocketCtor()` userebbe il WS globale invece del polling. Per testare
	// in modo DETERMINISTICO il ramo di polling, rimuoviamo temporaneamente il WS globale.
	const savedWs = (globalThis as { WebSocket?: unknown }).WebSocket;
	delete (globalThis as { WebSocket?: unknown }).WebSocket;
	const updates: ProgressUpdate[] = [];
	let monitor: ComfyProgressMonitor | undefined;
	try {
		monitor = createProgressMonitor(ENDPOINT, {
			promptId: 'p-x',
			webSocketCtor: undefined, // nessun ctor esplicito + nessun WS globale → polling immediato
			fetchImpl,
			pollIntervalMs: 10,
		});
		monitor.onUpdate(u => updates.push(u));

		await delay(60);
		assert.ok(historyCalls >= 1, 'deve interrogare /history in modalità polling');
		assert.strictEqual(monitor.live, false, 'in polling non è live');
		assert.ok(updates.some(u => u.percent === 100), 'deve completare con percent 100');
	} finally {
		monitor?.dispose();
		if (savedWs !== undefined) {
			(globalThis as { WebSocket?: unknown }).WebSocket = savedWs;
		}
	}
});

// --------------------------------------------------------------------------------------------
// 4) Recupero output: queueAndCollectMedia partiziona immagini + video da /view (Req 6.4)
// --------------------------------------------------------------------------------------------
test('queueAndCollectMedia: recupera e partiziona immagini e video', async () => {
	const workflow: ApiWorkflow = {
		'10': { class_type: 'SaveImage', inputs: {} },
		'11': { class_type: 'VHS_VideoCombine', inputs: {} },
	};

	let promptPosted = false;
	const viewed: string[] = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		if (url.endsWith('/prompt')) {
			promptPosted = init?.method === 'POST';
			return jsonResponse({ prompt_id: 'pp' });
		}
		if (url.includes('/history/')) {
			return jsonResponse({
				pp: {
					outputs: {
						'10': { images: [{ filename: 'img.png', subfolder: '', type: 'output' }] },
						'11': { gifs: [{ filename: 'clip.mp4', subfolder: '', type: 'output', format: 'video/h264-mp4' }] },
					},
				},
			});
		}
		if (url.includes('/view')) {
			viewed.push(url);
			return bytesResponse(new Uint8Array([1, 2, 3, 4]));
		}
		return jsonResponse({}, false, 404);
	}) as unknown as typeof fetch;

	const media = await queueAndCollectMedia(ENDPOINT, workflow, {
		fetchImpl,
		pollIntervalMs: 1,
		maxPolls: 20,
		clientId: 'client-1',
	});

	assert.ok(promptPosted, 'deve accodare il job con POST /prompt');
	assert.strictEqual(media.images.length, 1, 'deve recuperare 1 immagine');
	assert.strictEqual(media.videos.length, 1, 'deve recuperare 1 video');

	assert.strictEqual(media.images[0].filename, 'img.png');
	assert.strictEqual(media.images[0].kind, 'image');
	assert.strictEqual(media.images[0].format, 'png', 'preserva il formato png');
	assert.ok(media.images[0].data.length > 0, 'i dati immagine sono scaricati (base64 non vuoto)');

	assert.strictEqual(media.videos[0].filename, 'clip.mp4');
	assert.strictEqual(media.videos[0].kind, 'video');
	assert.strictEqual(media.videos[0].format, 'mp4', 'preserva il formato mp4');
	assert.ok(media.videos[0].data.length > 0, 'i dati video sono scaricati (base64 non vuoto)');

	assert.strictEqual(viewed.length, 2, 'scarica entrambi i file da /view');
});

// --------------------------------------------------------------------------------------------
// 4b) generateVideo: workflow senza nodo di output video → NoVideoOutputError (Req 5.5)
// --------------------------------------------------------------------------------------------
test('generateVideo: senza nodo output video solleva NoVideoOutputError', async () => {
	const imageOnlyWorkflow: ApiWorkflow = {
		'1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
		'2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
	};
	const fetchImpl = (async () => jsonResponse({}, false, 404)) as unknown as typeof fetch;

	await assert.rejects(
		() => generateVideo(ENDPOINT, imageOnlyWorkflow, { prompt: 'ciao' }, { fetchImpl }),
		(err: unknown) => err instanceof NoVideoOutputError,
		'deve sollevare NoVideoOutputError quando il workflow non produce video',
	);
});

// --------------------------------------------------------------------------------------------
// Runner sequenziale
// --------------------------------------------------------------------------------------------
async function run(): Promise<void> {
	for (const { name, fn } of cases) {
		try {
			await fn();
			passed++;
			console.log(`ok   - ${name}`);
		} catch (e) {
			failed++;
			console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void run();
