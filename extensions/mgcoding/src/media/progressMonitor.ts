/*---------------------------------------------------------------------------------------------
 *  MGCoding - Monitor avanzamento: parsing PURO degli eventi di stato di ComfyUI.
 *  Questa sezione del modulo non ha dipendenze da vscode/fetch/WebSocket: mappa gli eventi
 *  WebSocket di ComfyUI (`progress`/`executing`) in `ProgressUpdate` testabili. L'adapter di
 *  I/O (connessione `/ws`, fallback polling `/history`/`/queue`, annullamento `/interrupt`)
 *  sarà aggiunto in seguito allo stesso file (task 15.1) e riuserà queste funzioni pure.
 *  Vedi design "Monitor_Avanzamento" e Property 18.
 *  _Requirements: 8.1_
 *--------------------------------------------------------------------------------------------*/

/**
 * Aggiornamento di avanzamento normalizzato mostrato all'utente.
 * - `percent`: percentuale di completamento garantita nell'intervallo `[0, 100]`.
 * - `currentNode`: identificatore del nodo correntemente in esecuzione, se noto.
 */
export interface ProgressUpdate {
	percent: number;
	currentNode?: string;
}

/**
 * Evento `progress` come inviato da ComfyUI sul WebSocket: indica il passo corrente (`value`)
 * rispetto al totale (`max`) e, opzionalmente, il nodo che sta avanzando (`node`).
 */
export interface ComfyProgressEvent {
	type: 'progress';
	data: {
		value: number;
		max: number;
		node?: string | null;
	};
}

/**
 * Evento `executing` come inviato da ComfyUI sul WebSocket: indica quale nodo è in esecuzione.
 * Quando `node` è `null`/assente l'esecuzione del prompt è terminata.
 */
export interface ComfyExecutingEvent {
	type: 'executing';
	data: {
		node?: string | null;
	};
}

/** Unione degli eventi WebSocket di ComfyUI rilevanti per l'avanzamento. */
export type ComfyProgressMessage = ComfyProgressEvent | ComfyExecutingEvent;

/** Vincola un numero nell'intervallo chiuso `[min, max]`. I non-finiti diventano `min`. */
function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return value;
}

/** Type guard: l'evento è un `progress` ben formato (con `value`/`max` numerici). */
function isProgressEvent(evt: unknown): evt is ComfyProgressEvent {
	if (typeof evt !== 'object' || evt === null) {
		return false;
	}
	const e = evt as { type?: unknown; data?: unknown };
	if (e.type !== 'progress' || typeof e.data !== 'object' || e.data === null) {
		return false;
	}
	const d = e.data as { value?: unknown; max?: unknown };
	return typeof d.value === 'number' && typeof d.max === 'number';
}

/** Type guard: l'evento è un `executing` ben formato. */
function isExecutingEvent(evt: unknown): evt is ComfyExecutingEvent {
	if (typeof evt !== 'object' || evt === null) {
		return false;
	}
	const e = evt as { type?: unknown; data?: unknown };
	return e.type === 'executing' && typeof e.data === 'object' && e.data !== null;
}

/**
 * Mappa (PURO) un evento WebSocket di ComfyUI in un `ProgressUpdate`.
 * - Eventi `progress`: `percent = clamp((value/max) * 100, 0, 100)`; se `max <= 0` la
 *   percentuale è `0`. `currentNode` è valorizzato col `node` dell'evento se presente.
 * - Eventi `executing`: `currentNode` è il nodo indicato (se presente); `percent` resta `0`
 *   poiché l'evento non porta informazione di completamento.
 * Restituisce `undefined` per eventi non riconosciuti o malformati.
 * _Requirements: 8.1_
 */
export function parseProgressEvent(evt: ComfyProgressMessage | unknown): ProgressUpdate | undefined {
	if (isProgressEvent(evt)) {
		const { value, max, node } = evt.data;
		const percent = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
		const update: ProgressUpdate = { percent };
		if (typeof node === 'string' && node.length > 0) {
			update.currentNode = node;
		}
		return update;
	}
	if (isExecutingEvent(evt)) {
		const { node } = evt.data;
		const update: ProgressUpdate = { percent: 0 };
		if (typeof node === 'string' && node.length > 0) {
			update.currentNode = node;
		}
		return update;
	}
	return undefined;
}

/*---------------------------------------------------------------------------------------------
 *  Adapter di I/O del Monitor_Avanzamento (task 15.1).
 *  Si connette al WebSocket di ComfyUI (`<endpoint>/ws?clientId=...`), riusa la funzione PURA
 *  `parseProgressEvent` per emettere `ProgressUpdate` ai sottoscrittori e, se la connessione
 *  cade durante un'esecuzione, ripiega sul polling periodico di `/history/{promptId}` e
 *  `/queue` (Req 8.4). L'annullamento invoca `POST <endpoint>/interrupt` entro 5s (Req 8.2) e
 *  riporta lo stato di annullamento (Req 8.3).
 *
 *  Client WebSocket: si usa la `WebSocket` globale del runtime (disponibile come implementazione
 *  undici nel processo Node/Electron dell'estensione e come WebSocket del browser nei webview).
 *  Non viene aggiunta alcuna dipendenza: il pacchetto `ws` non è dichiarato in package.json. Il
 *  costruttore è accessibile in modo strutturale così da supportare sia l'API `addEventListener`
 *  (browser/undici) sia l'API a eventi `on(...)` del pacchetto `ws` se iniettato nei test.
 *  _Requirements: 8.1, 8.2, 8.3, 8.4_
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

/** Stato di annullamento riportato all'utente (Req 8.3). */
export interface CancelState {
	cancelled: boolean;
	/** true se la richiesta `/interrupt` è stata accettata da ComfyUI. */
	interrupted: boolean;
}

/**
 * Interfaccia del Monitor_Avanzamento come da design.
 * - `onUpdate(cb)`: registra un sottoscrittore agli aggiornamenti di avanzamento.
 * - `live`: `true` quando gli aggiornamenti arrivano via WebSocket, `false` quando si è
 *   ripiegato sul polling periodico (fallback).
 */
export interface IProgressMonitor {
	onUpdate(cb: (u: ProgressUpdate) => void): vscode.Disposable;
	readonly live: boolean;
}

/** Evento `message` di un WebSocket in stile browser/undici. */
interface WsMessageEvent {
	data: unknown;
}

/** Evento `close` di un WebSocket in stile browser/undici. */
interface WsCloseEvent {
	code?: number;
	reason?: string;
}

/**
 * Sottoinsieme strutturale di un'istanza WebSocket sufficiente per il monitor.
 * Copre sia l'API DOM/undici (`addEventListener`) sia l'API a eventi del pacchetto `ws` (`on`).
 */
interface MinimalWebSocket {
	close(): void;
	addEventListener?(type: string, listener: (ev: unknown) => void): void;
	on?(event: string, listener: (...args: unknown[]) => void): void;
}

/** Costruttore di un WebSocket strutturalmente compatibile. */
export type WebSocketCtor = new (url: string) => MinimalWebSocket;

/** Opzioni dell'adapter (con punti di iniezione per i test). */
export interface ProgressMonitorOptions {
	/** Identificativo client usato nell'accodamento del job e nella query `/ws`. */
	clientId?: string;
	/** `promptId` del job da monitorare (necessario per il fallback su `/history/{promptId}`). */
	promptId?: string;
	/** Costruttore WebSocket da usare; se assente si usa quello globale del runtime. */
	webSocketCtor?: WebSocketCtor;
	/** Implementazione `fetch` da usare (default: `fetch` globale). */
	fetchImpl?: typeof fetch;
	/** Intervallo del polling di fallback in ms (default 1000). */
	pollIntervalMs?: number;
}

/** Restituisce il costruttore `WebSocket` globale del runtime, se disponibile. */
export function resolveGlobalWebSocketCtor(): WebSocketCtor | undefined {
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	return typeof ctor === 'function' ? (ctor as unknown as WebSocketCtor) : undefined;
}

/**
 * Converte un endpoint HTTP(S) di ComfyUI nell'URL WebSocket `/ws?clientId=...`.
 * `http://host:8188` → `ws://host:8188/ws?clientId=...`; `https://` → `wss://`.
 */
export function comfyWsUrl(endpoint: string, clientId: string): string {
	const ep = endpoint.replace(/\/$/, '');
	const ws = ep.replace(/^http/i, 'ws'); // http→ws, https→wss
	return `${ws}/ws?clientId=${encodeURIComponent(clientId)}`;
}

/**
 * Estrae il testo JSON da un messaggio WebSocket eterogeneo (stringa, Buffer, ArrayBuffer).
 * I messaggi binari di anteprima di ComfyUI vengono ignorati restituendo `undefined`.
 */
function messageToText(data: unknown): string | undefined {
	if (typeof data === 'string') {
		return data;
	}
	if (data instanceof Uint8Array) {
		return Buffer.from(data).toString('utf8');
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(new Uint8Array(data)).toString('utf8');
	}
	return undefined;
}

/**
 * Monitor di avanzamento di un'esecuzione ComfyUI con WebSocket e fallback al polling.
 *
 * Ciclo di vita: `start()` apre il WebSocket; gli eventi `progress`/`executing` sono mappati con
 * `parseProgressEvent` ed emessi ai sottoscrittori (`live === true`). Se la connessione cade
 * mentre l'esecuzione non è terminata, si passa al polling periodico (`live === false`, Req 8.4).
 * `cancel()` invoca `/interrupt` entro 5s e segna lo stato di annullamento (Req 8.2, 8.3).
 * `dispose()` libera tutte le risorse.
 */
export class ComfyProgressMonitor implements IProgressMonitor {
	private readonly endpoint: string;
	private readonly clientId: string;
	private readonly promptId: string | undefined;
	private readonly wsCtor: WebSocketCtor | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly pollIntervalMs: number;

	private readonly updateListeners = new Set<(u: ProgressUpdate) => void>();
	private readonly cancelListeners = new Set<(s: CancelState) => void>();

	private socket: MinimalWebSocket | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private _live = false;
	private _cancelled = false;
	private _interrupted = false;
	private finished = false;
	private disposed = false;

	constructor(endpoint: string, options: ProgressMonitorOptions = {}) {
		this.endpoint = endpoint.replace(/\/$/, '');
		this.clientId = options.clientId ?? `mgcoding-${Date.now()}`;
		this.promptId = options.promptId;
		this.wsCtor = options.webSocketCtor ?? resolveGlobalWebSocketCtor();
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.pollIntervalMs = options.pollIntervalMs ?? 1000;
	}

	/** `true` quando gli aggiornamenti arrivano via WebSocket; `false` durante il fallback polling. */
	get live(): boolean {
		return this._live;
	}

	/** Stato di annullamento corrente (Req 8.3). */
	get cancelState(): CancelState {
		return { cancelled: this._cancelled, interrupted: this._interrupted };
	}

	/** Registra un sottoscrittore agli aggiornamenti di avanzamento. */
	onUpdate(cb: (u: ProgressUpdate) => void): vscode.Disposable {
		this.updateListeners.add(cb);
		return { dispose: () => { this.updateListeners.delete(cb); } };
	}

	/** Registra un sottoscrittore alle notifiche di annullamento. */
	onCancel(cb: (s: CancelState) => void): vscode.Disposable {
		this.cancelListeners.add(cb);
		return { dispose: () => { this.cancelListeners.delete(cb); } };
	}

	/**
	 * Avvia il monitoraggio: tenta la connessione WebSocket; se il costruttore non è disponibile
	 * o la connessione fallisce, ripiega immediatamente sul polling (Req 8.4).
	 */
	start(): void {
		if (this.disposed || this.finished) {
			return;
		}
		if (!this.wsCtor) {
			this.startPolling();
			return;
		}
		try {
			this.connectWebSocket();
		} catch {
			// Apertura fallita: fallback immediato al polling.
			this.startPolling();
		}
	}

	/** Apre il WebSocket e collega i gestori degli eventi (entrambe le API: DOM/undici e `ws`). */
	private connectWebSocket(): void {
		const url = comfyWsUrl(this.endpoint, this.clientId);
		const Ctor = this.wsCtor!;
		const sock = new Ctor(url);
		this.socket = sock;

		const onOpen = (): void => { this._live = true; };
		const onMessage = (ev: unknown): void => {
			const data = (ev as WsMessageEvent | undefined)?.data ?? ev;
			this.handleRawMessage(data);
		};
		const onClose = (ev: unknown): void => {
			void (ev as WsCloseEvent | undefined);
			this.handleConnectionLost();
		};
		const onError = (): void => { this.handleConnectionLost(); };

		if (typeof sock.addEventListener === 'function') {
			sock.addEventListener('open', () => onOpen());
			sock.addEventListener('message', (e) => onMessage(e));
			sock.addEventListener('close', (e) => onClose(e));
			sock.addEventListener('error', () => onError());
		} else if (typeof sock.on === 'function') {
			// API del pacchetto `ws`: il payload del messaggio è il primo argomento.
			sock.on('open', () => onOpen());
			sock.on('message', (...args: unknown[]) => this.handleRawMessage(args[0]));
			sock.on('close', () => onClose(undefined));
			sock.on('error', () => onError());
		} else {
			// Nessuna API di sottoscrizione nota: ripiega sul polling.
			this.startPolling();
		}
	}

	/** Interpreta un payload grezzo del WebSocket e, se è un evento noto, emette l'aggiornamento. */
	private handleRawMessage(data: unknown): void {
		const text = messageToText(data);
		if (text === undefined) {
			return; // messaggio binario (anteprima): ignorato
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		// Un evento `executing` con `node` nullo segnala la fine dell'esecuzione del prompt.
		if (this.isExecutionEnd(parsed)) {
			this.finished = true;
			this.emitUpdate({ percent: 100 });
			this.cleanupTransports();
			return;
		}
		const update = parseProgressEvent(parsed);
		if (update) {
			this.emitUpdate(update);
		}
	}

	/** Vero quando l'evento `executing` indica `node` assente/nullo (esecuzione terminata). */
	private isExecutionEnd(evt: unknown): boolean {
		if (typeof evt !== 'object' || evt === null) {
			return false;
		}
		const e = evt as { type?: unknown; data?: { node?: unknown } };
		return e.type === 'executing' && (e.data?.node === null || e.data?.node === undefined);
	}

	/** Gestisce la caduta della connessione WebSocket durante un'esecuzione: avvia il polling. */
	private handleConnectionLost(): void {
		if (this.disposed || this.finished || this._cancelled) {
			return;
		}
		this._live = false;
		this.socket = undefined;
		this.startPolling(); // Req 8.4
	}

	/**
	 * Avvia il polling periodico dello stato dell'esecuzione su `/history/{promptId}` e `/queue`.
	 * Non potendo ricavare l'avanzamento fine via REST, emette stati grossolani: "in coda/in
	 * esecuzione" (percent 0 col nodo corrente se disponibile) e "completato" (percent 100).
	 */
	private startPolling(): void {
		if (this.disposed || this.finished || this.pollTimer) {
			return;
		}
		this._live = false;
		const tick = (): void => { void this.pollOnce(); };
		this.pollTimer = setInterval(tick, this.pollIntervalMs);
		tick();
	}

	/** Esegue un singolo giro di polling dello stato dell'esecuzione. */
	private async pollOnce(): Promise<void> {
		if (this.disposed || this.finished) {
			return;
		}
		// 1) Se il job risulta nella history, è completato.
		if (this.promptId) {
			const done = await this.pollHistory(this.promptId);
			if (done) {
				this.finished = true;
				this.emitUpdate({ percent: 100 });
				this.cleanupTransports();
				return;
			}
		}
		// 2) Altrimenti consulta la coda per capire se è in esecuzione/in attesa.
		await this.pollQueue();
	}

	/** Interroga `/history/{promptId}`; restituisce `true` se il job ha prodotto output. */
	private async pollHistory(promptId: string): Promise<boolean> {
		try {
			const res = await this.fetchImpl(`${this.endpoint}/history/${encodeURIComponent(promptId)}`);
			if (!res.ok) {
				return false;
			}
			const hist = await res.json() as Record<string, { outputs?: Record<string, unknown> }>;
			const entry = hist[promptId];
			return !!entry?.outputs && Object.keys(entry.outputs).length > 0;
		} catch {
			return false;
		}
	}

	/** Interroga `/queue` ed emette un aggiornamento se il job è in esecuzione o in attesa. */
	private async pollQueue(): Promise<void> {
		try {
			const res = await this.fetchImpl(`${this.endpoint}/queue`);
			if (!res.ok) {
				return;
			}
			const queue = await res.json() as {
				queue_running?: unknown[];
				queue_pending?: unknown[];
			};
			const running = Array.isArray(queue.queue_running) ? queue.queue_running : [];
			const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
			if (this.jobInList(running) || this.jobInList(pending)) {
				this.emitUpdate({ percent: 0 });
			}
		} catch {
			// Errore transitorio di rete: ignorato, riprovato al tick successivo.
		}
	}

	/** Vero se il `promptId` monitorato compare in una voce della coda ComfyUI. */
	private jobInList(items: unknown[]): boolean {
		if (!this.promptId) {
			return items.length > 0;
		}
		for (const item of items) {
			// Una voce di coda è `[number, promptId, prompt, extra, ...]`.
			if (Array.isArray(item) && item.some(v => v === this.promptId)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Annulla l'esecuzione in corso invocando `POST <endpoint>/interrupt` con un limite di 5s
	 * (Req 8.2) e segnala lo stato di annullamento ai sottoscrittori (Req 8.3).
	 */
	async cancel(): Promise<CancelState> {
		this._cancelled = true;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		try {
			const res = await this.fetchImpl(`${this.endpoint}/interrupt`, {
				method: 'POST',
				signal: controller.signal
			});
			this._interrupted = !!res?.ok;
		} catch {
			this._interrupted = false;
		} finally {
			clearTimeout(timer);
		}
		const state = this.cancelState;
		for (const cb of this.cancelListeners) {
			cb(state);
		}
		this.cleanupTransports();
		return state;
	}

	/** Notifica un aggiornamento a tutti i sottoscrittori. */
	private emitUpdate(update: ProgressUpdate): void {
		for (const cb of this.updateListeners) {
			cb(update);
		}
	}

	/** Chiude WebSocket e timer di polling senza rimuovere i sottoscrittori. */
	private cleanupTransports(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.socket) {
			try {
				this.socket.close();
			} catch {
				// chiusura best-effort
			}
			this.socket = undefined;
		}
		this._live = false;
	}

	/** Libera tutte le risorse e i sottoscrittori. */
	dispose(): void {
		this.disposed = true;
		this.cleanupTransports();
		this.updateListeners.clear();
		this.cancelListeners.clear();
	}
}

/**
 * Crea e avvia un `ComfyProgressMonitor` per un'esecuzione ComfyUI.
 * Restituisce l'istanza già connessa (o in polling se il WebSocket non è disponibile).
 */
export function createProgressMonitor(endpoint: string, options: ProgressMonitorOptions = {}): ComfyProgressMonitor {
	const monitor = new ComfyProgressMonitor(endpoint, options);
	monitor.start();
	return monitor;
}
