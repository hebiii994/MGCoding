/*---------------------------------------------------------------------------------------------
 *  MGCoding - Test di integrazione della Galleria (Image Studio).
 *  Esercita `ImageStudioProvider` (media/imageStudioView.ts) con un `vscode` simulato (mock):
 *  verifica che la Galleria elenchi sia immagini sia video partizionando il contenuto della
 *  cartella di output (Req 7.1), che gli elementi video siano marcati `kind: 'video'` così che
 *  il webview renderizzi un `<video>` (Req 7.2), che l'eliminazione richieda conferma e poi
 *  rimuova il file e aggiorni l'elenco (Req 7.3), e che l'apertura usi `vscode.env.openExternal`
 *  per aprire il file nel sistema operativo (Req 7.4).
 *
 *  Eseguibile con: node out/test/gallery.int.test.js
 *  _Requirements: 7.2, 7.3, 7.4_
 *--------------------------------------------------------------------------------------------*/

// Lo stub di `vscode` DEVE essere importato PRIMA del modulo sotto test: installa l'hook su
// `require('vscode')` e ci dà il riferimento condiviso `vscodeMock` da popolare per il test.
// Il modulo sotto test viene caricato in modo PIGRO (require) DOPO aver popolato il mock,
// perché la compilazione CommonJS di `import * as vscode` ne fotografa le proprietà al require.
import { vscodeMock } from './vscodeStub';
import * as assert from 'assert';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
	}
}

// ---- Mock minimale di `vscode` ------------------------------------------------------------

const FileTypeFile = 1;
const FileTypeDirectory = 2;
const GALLERY_DIR = 'C:/out/generated';

interface MockUri { fsPath: string; path: string; scheme: string; toString(): string }
function makeUri(fsPath: string): MockUri {
	const norm = fsPath.replace(/\\/g, '/');
	return { fsPath, path: norm, scheme: 'file', toString: () => `file://${norm}` };
}

/** Stato condiviso del mock, ripuntato a ogni `setup()`. */
interface MockState {
	posted: Array<Record<string, unknown>>;
	handler?: (msg: { type: string;[k: string]: unknown }) => unknown | Promise<unknown>;
	dirListing: Array<[string, number]>;
	deleted: string[];
	openedExternal: MockUri[];
	executedCommands: string[];
	warningCalls: Array<{ message: string; options: unknown; items: string[] }>;
	/** Risposta restituita da `showWarningMessage` (la scelta dell'utente). */
	warningResponse: string | undefined;
}

function newState(dirListing: Array<[string, number]>): MockState {
	return { posted: [], dirListing, deleted: [], openedExternal: [], executedCommands: [], warningCalls: [], warningResponse: undefined };
}

// Riferimento mutabile: i closure stabili del mock leggono SEMPRE lo stato corrente.
let current: MockState = newState([]);

/** Popola `vscodeMock` UNA SOLA volta con oggetti stabili che leggono `current`. */
function installMockVscode(): void {
	const config = {
		get: (key: string, def?: unknown) => (key === 'image.galleryFolder' ? GALLERY_DIR : def),
		update: async () => { /* no-op */ }
	};
	Object.assign(vscodeMock, {
		Uri: {
			file: (p: string) => makeUri(p),
			joinPath: (base: MockUri, ...segs: string[]) => makeUri(`${base.fsPath}/${segs.join('/')}`)
		},
		FileType: { File: FileTypeFile, Directory: FileTypeDirectory },
		ConfigurationTarget: { Global: 1 },
		ProgressLocation: { Notification: 15 },
		workspace: {
			// Nessuna cartella di lavoro: `workflowsDir()` resta undefined → listWorkflows() = [].
			workspaceFolders: undefined,
			onDidChangeConfiguration: () => ({ dispose: () => { /* no-op */ } }),
			getConfiguration: () => config,
			fs: {
				readDirectory: async (uri: MockUri) => (uri.fsPath === GALLERY_DIR ? current.dirListing : []),
				delete: async (uri: MockUri) => { current.deleted.push(uri.fsPath); }
			}
		},
		window: {
			showWarningMessage: async (message: string, options: unknown, ...items: string[]) => {
				current.warningCalls.push({ message, options, items });
				return current.warningResponse;
			}
		},
		env: { openExternal: async (uri: MockUri) => { current.openedExternal.push(uri); return true; } },
		commands: { executeCommand: async (command: string) => { current.executedCommands.push(command); } }
	});
}

// Tipo lasco del provider (caricato in modo pigro DOPO aver installato il mock).
type Provider = { resolveWebviewView(view: unknown): void; refresh(): void };
type ProviderCtor = new (extensionUri: unknown) => Provider;
let ImageStudioProvider: ProviderCtor;

/** Costruisce un webview/view fittizio, risolve la view e attende un giro di stato. */
async function setup(dirListing: Array<[string, number]>): Promise<MockState> {
	current = newState(dirListing);

	const webview = {
		options: {} as unknown,
		cspSource: 'vscode-resource',
		html: '',
		asWebviewUri: (uri: MockUri) => makeUri(uri.fsPath),
		postMessage: async (m: Record<string, unknown>) => { current.posted.push(m); return true; },
		onDidReceiveMessage: (cb: MockState['handler']) => { current.handler = cb; return { dispose: () => { /* no-op */ } }; }
	};
	const view = {
		webview,
		visible: true,
		onDidChangeVisibility: () => ({ dispose: () => { /* no-op */ } })
	};

	const provider = new ImageStudioProvider(makeUri('C:/ext'));
	provider.resolveWebviewView(view);
	// `resolveWebviewView` lancia sendState() senza await: forziamo un giro deterministico.
	await current.handler!({ type: 'refresh' });
	return current;
}

/** Ultimo messaggio di tipo `state` inviato al webview. */
function lastState(state: MockState): Record<string, unknown> {
	const states = state.posted.filter(m => m.type === 'state');
	assert.ok(states.length > 0, 'nessun messaggio "state" inviato al webview');
	return states[states.length - 1];
}

const MIXED_DIR: Array<[string, number]> = [
	['IMG_0002.png', FileTypeFile],
	['VID_0001.mp4', FileTypeFile],
	['readme.txt', FileTypeFile],
	['subdir', FileTypeDirectory]
];

async function main(): Promise<void> {
	// La rete non deve essere toccata: listCheckpoints/listLoras useranno fetch → falliscono → [].
	(globalThis as unknown as { fetch: () => Promise<never> }).fetch = async () => { throw new Error('offline (test)'); };

	// Installa il mock PRIMA di caricare il modulo sotto test, poi caricalo (require pigro).
	installMockVscode();
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	ImageStudioProvider = (require('../media/imageStudioView') as { ImageStudioProvider: ProviderCtor }).ImageStudioProvider;

	// Req 7.1/7.2: la Galleria elenca immagini E video, e i video sono marcati kind 'video'.
	await test('galleria: partiziona la cartella in immagini e video (png + mp4)', async () => {
		const state = await setup(MIXED_DIR);
		const gallery = lastState(state).gallery as Array<{ kind: string; format: string; path: string; src: string }>;
		// Solo i file multimediali: il .txt e la sottocartella sono esclusi.
		assert.strictEqual(gallery.length, 2, 'attesi esattamente 2 elementi multimediali');
		const video = gallery.find(g => g.format === 'mp4');
		const image = gallery.find(g => g.format === 'png');
		assert.ok(video, 'il video .mp4 deve comparire nella galleria');
		assert.ok(image, "l'immagine .png deve comparire nella galleria");
		// Req 7.2: l'elemento video è marcato 'video' → il webview renderizza un <video>.
		assert.strictEqual(video!.kind, 'video', "il file .mp4 deve avere kind 'video'");
		assert.strictEqual(image!.kind, 'image', "il file .png deve avere kind 'image'");
		assert.strictEqual(video!.path, `${GALLERY_DIR}/VID_0001.mp4`);
		assert.strictEqual(image!.path, `${GALLERY_DIR}/IMG_0002.png`);
	});

	// Req 7.3: eliminazione con conferma → rimuove il file e aggiorna l'elenco.
	await test("eliminazione: con conferma rimuove il file e aggiorna l'elenco", async () => {
		const state = await setup(MIXED_DIR);
		state.warningResponse = 'Elimina'; // l'utente conferma
		const target = `${GALLERY_DIR}/VID_0001.mp4`;
		const postedBefore = state.posted.length;
		await state.handler!({ type: 'deleteItem', path: target });
		// Conferma con dialog MODALE prima di eliminare (Req 7.3, 22.4).
		assert.strictEqual(state.warningCalls.length, 1, 'deve chiedere conferma una volta');
		assert.deepStrictEqual(state.warningCalls[0].options, { modal: true }, 'la conferma deve essere modale');
		assert.ok(state.warningCalls[0].items.includes('Elimina'), "deve offrire l'azione 'Elimina'");
		assert.deepStrictEqual(state.deleted, [target], 'il file deve essere eliminato');
		assert.ok(state.posted.length > postedBefore, "deve aggiornare l'elenco (re-invio stato)");
	});

	// Req 7.3 (negativo): senza conferma NON elimina nulla.
	await test('eliminazione: senza conferma non rimuove il file', async () => {
		const state = await setup(MIXED_DIR);
		state.warningResponse = undefined; // l'utente annulla / chiude
		await state.handler!({ type: 'deleteItem', path: `${GALLERY_DIR}/VID_0001.mp4` });
		assert.strictEqual(state.warningCalls.length, 1, 'deve comunque chiedere conferma');
		assert.deepStrictEqual(state.deleted, [], 'senza conferma nessun file deve essere eliminato');
	});

	// Req 7.4: apertura di un elemento → apre il file nel SO via openExternal.
	await test('apertura: openInOS apre il file con vscode.env.openExternal', async () => {
		const state = await setup(MIXED_DIR);
		const target = `${GALLERY_DIR}/VID_0001.mp4`;
		await state.handler!({ type: 'openInOS', path: target });
		assert.strictEqual(state.openedExternal.length, 1, 'deve aprire esattamente un elemento');
		assert.strictEqual(state.openedExternal[0].fsPath, target, 'deve aprire il file richiesto nel SO');
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void main();
