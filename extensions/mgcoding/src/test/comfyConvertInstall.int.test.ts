/*---------------------------------------------------------------------------------------------
 *  MGCoding - test di INTEGRAZIONE (esempi) dell'adapter di conversione, download modelli e
 *  installazione nodi in `media/comfyHelper.ts`.
 *  Eseguibile con: node out/test/comfyConvertInstall.int.test.js
 *
 *  Verifica, con mock deterministici di `vscode`, `fetch` e `child_process`:
 *   - fallback di conversione UI→API: prima locale, poi via ComfyUI `/object_info` (Req 15.3);
 *   - estrazione del workflow da un archivio ZIP "stored" costruito a mano (Req 15.5);
 *   - download dei modelli mancanti con conferma, progresso, annullamento ed errore
 *     (Req 16.3, 16.4, 16.5);
 *   - installazione dei nodi mancanti con conferma e messaggio di riavvio (Req 17.2, 17.4).
 *
 *  NOTA: `comfyHelper` importa `vscode` al caricamento. Importiamo PRIMA `./vscodeStub`
 *  (per coerenza con gli altri test) e poi installiamo un override del module loader più ricco
 *  che restituisce un mock configurabile di `vscode` (e un `child_process` con `exec` finto),
 *  così possiamo esercitare gli adapter senza Extension Host né processi reali.
 *
 *  _Requirements: 15.3, 15.5, 16.3, 16.4, 16.5, 17.2, 17.4_
 *--------------------------------------------------------------------------------------------*/

import './vscodeStub';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');
import * as childProcess from 'child_process';

// ---------------------------------------------------------------------------------------------
// Recorder e stato mutabile condiviso col mock di `vscode`.
// ---------------------------------------------------------------------------------------------
const rec = {
	warnings: [] as string[],
	errors: [] as string[],
	infos: [] as string[],
	inputBoxTitles: [] as string[],
	execCommands: [] as string[],
	fetchedUrls: [] as string[],
};

// Risposte scriptate, riconfigurate da ogni scenario.
let openDialogResult: { fsPath: string }[] | undefined;
let warnResult: unknown = undefined;
let infoResult: unknown = undefined;
let inputResult: string | undefined = undefined;
let currentFetch: (url: string, opts?: unknown) => Promise<unknown> = async () => {
	throw new Error('fetch non configurato per questo scenario');
};

// Store di configurazione (mgcoding.*).
const configStore = new Map<string, unknown>();

// ---------------------------------------------------------------------------------------------
// Mock di `vscode`: solo le API usate da comfyHelper (workspace.fs su disco reale, dialog,
// progress, configurazione). Le operazioni su file usano `fs` reale in una cartella temporanea,
// così le verifiche sui file scritti sono deterministiche.
// ---------------------------------------------------------------------------------------------
type Uri = { fsPath: string; scheme: string };
function uri(p: string): Uri { return { fsPath: p, scheme: 'file' }; }

const vscodeMock: Record<string, unknown> = {
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	Uri: {
		file: (p: string): Uri => uri(p),
		joinPath: (base: Uri, ...segs: string[]): Uri => uri(path.join(base.fsPath, ...segs)),
	},
	workspace: {
		workspaceFolders: undefined as undefined | { uri: Uri }[],
		getConfiguration: (_section?: string): unknown => ({
			get: (key: string, def?: unknown): unknown => (configStore.has(key) ? configStore.get(key) : def),
			update: async (key: string, value: unknown, _target?: unknown): Promise<void> => {
				configStore.set(key, value);
			},
		}),
		fs: {
			readFile: async (u: Uri): Promise<Uint8Array> => new Uint8Array(fs.readFileSync(u.fsPath)),
			writeFile: async (u: Uri, data: Uint8Array): Promise<void> => {
				fs.mkdirSync(path.dirname(u.fsPath), { recursive: true });
				fs.writeFileSync(u.fsPath, Buffer.from(data));
			},
			createDirectory: async (u: Uri): Promise<void> => { fs.mkdirSync(u.fsPath, { recursive: true }); },
			readDirectory: async (u: Uri): Promise<[string, number][]> =>
				fs.readdirSync(u.fsPath).map(n => [n, fs.statSync(path.join(u.fsPath, n)).isDirectory() ? 2 : 1]),
		},
	},
	window: {
		showOpenDialog: async (..._a: unknown[]): Promise<unknown> => openDialogResult,
		showWarningMessage: async (msg: string, ..._a: unknown[]): Promise<unknown> => {
			rec.warnings.push(String(msg));
			return warnResult;
		},
		showErrorMessage: async (msg: string, ..._a: unknown[]): Promise<unknown> => {
			rec.errors.push(String(msg));
			return undefined;
		},
		showInformationMessage: async (msg: string, ..._a: unknown[]): Promise<unknown> => {
			rec.infos.push(String(msg));
			return infoResult;
		},
		showInputBox: async (opts: { title?: string }, ..._a: unknown[]): Promise<unknown> => {
			rec.inputBoxTitles.push(opts?.title ?? '');
			return inputResult;
		},
		showQuickPick: async (..._a: unknown[]): Promise<unknown> => undefined,
		withProgress: async (_opts: unknown, cb: (p: unknown, t: unknown) => unknown): Promise<unknown> =>
			cb({ report: (_x: unknown): void => { } }, { isCancellationRequested: false, onCancellationRequested: (_f: unknown): void => { } }),
	},
};

// `child_process` con `exec` finto: registra il comando e risponde con successo, così
// l'installazione nodi non lancia git/pip reali ma percorre comunque il ramo di successo.
const cpMock: Record<string, unknown> = {
	...(childProcess as unknown as Record<string, unknown>),
	exec: (cmd: string, opts: unknown, cb?: (err: unknown, res: unknown) => void): unknown => {
		rec.execCommands.push(cmd);
		const callback = (typeof opts === 'function' ? opts : cb) as ((err: unknown, res: unknown) => void) | undefined;
		callback?.(null, { stdout: '', stderr: '' });
		return { on: (): void => { } };
	},
};

// Installa l'override del loader DOPO vscodeStub: la nostra funzione viene interrogata per prima
// e fornisce il mock ricco; per gli altri moduli delega alla catena precedente.
const M = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const prevLoad = M._load;
M._load = function (request: string, ...rest: unknown[]): unknown {
	if (request === 'vscode') {
		return vscodeMock;
	}
	if (request === 'child_process') {
		return cpMock;
	}
	return prevLoad.apply(this, [request, ...rest]);
};

// `fetch` globale instradato al gestore dello scenario corrente.
(globalThis as unknown as { fetch: unknown }).fetch = (url: unknown, opts?: unknown): Promise<unknown> => {
	const u = String(url);
	rec.fetchedUrls.push(u);
	return currentFetch(u, opts);
};

// Caricato DOPO l'installazione dell'override → `require('vscode')` restituisce `vscodeMock`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const helper = require('../media/comfyHelper') as typeof import('../media/comfyHelper');

// ---------------------------------------------------------------------------------------------
// Utility di test.
// ---------------------------------------------------------------------------------------------
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

function resetScenario(): void {
	rec.warnings.length = 0;
	rec.errors.length = 0;
	rec.infos.length = 0;
	rec.inputBoxTitles.length = 0;
	rec.execCommands.length = 0;
	rec.fetchedUrls.length = 0;
	openDialogResult = undefined;
	warnResult = undefined;
	infoResult = undefined;
	inputResult = undefined;
	currentFetch = async () => { throw new Error('fetch non configurato'); };
}

// Risposte HTTP minime compatibili con quanto usa comfyHelper.
function jsonResponse(obj: unknown, ok = true, status = 200): unknown {
	return { ok, status, headers: new Map<string, string>(), json: async (): Promise<unknown> => obj };
}
function streamResponse(bytes: Buffer): unknown {
	const body = new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.enqueue(new Uint8Array(bytes));
			controller.close();
		},
	});
	return { ok: true, status: 200, body, headers: new Map<string, string>([['content-length', String(bytes.length)]]) };
}

// Costruisce un archivio ZIP "stored" (metodo 0, nessuna compressione) in memoria,
// con central directory ed EOCD validi, leggibile da `extractWorkflowFromArchive`.
function buildStoredZip(files: { name: string; content: string }[]): Buffer {
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const f of files) {
		const nameBuf = Buffer.from(f.name, 'utf8');
		const data = Buffer.from(f.content, 'utf8');
		const lfh = Buffer.alloc(30);
		lfh.writeUInt32LE(0x04034b50, 0);
		lfh.writeUInt16LE(20, 4);
		lfh.writeUInt16LE(0, 6);
		lfh.writeUInt16LE(0, 8); // metodo 0 (stored)
		lfh.writeUInt16LE(0, 10);
		lfh.writeUInt16LE(0, 12);
		lfh.writeUInt32LE(0, 14); // crc (non verificato dal lettore)
		lfh.writeUInt32LE(data.length, 18);
		lfh.writeUInt32LE(data.length, 22);
		lfh.writeUInt16LE(nameBuf.length, 26);
		lfh.writeUInt16LE(0, 28);
		const localOffset = offset;
		chunks.push(lfh, nameBuf, data);
		offset += lfh.length + nameBuf.length + data.length;

		const cdh = Buffer.alloc(46);
		cdh.writeUInt32LE(0x02014b50, 0);
		cdh.writeUInt16LE(20, 4);
		cdh.writeUInt16LE(20, 6);
		cdh.writeUInt16LE(0, 8);
		cdh.writeUInt16LE(0, 10); // metodo 0
		cdh.writeUInt16LE(0, 12);
		cdh.writeUInt16LE(0, 14);
		cdh.writeUInt32LE(0, 16);
		cdh.writeUInt32LE(data.length, 20);
		cdh.writeUInt32LE(data.length, 24);
		cdh.writeUInt16LE(nameBuf.length, 28);
		cdh.writeUInt16LE(0, 30);
		cdh.writeUInt16LE(0, 32);
		cdh.writeUInt16LE(0, 34);
		cdh.writeUInt16LE(0, 36);
		cdh.writeUInt32LE(0, 38);
		cdh.writeUInt32LE(localOffset, 42);
		central.push(Buffer.concat([cdh, nameBuf]));
	}
	const cd = Buffer.concat(central);
	const cdOffset = offset;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(cdOffset, 16);
	eocd.writeUInt16LE(0, 20);
	return Buffer.concat([...chunks, cd, eocd]);
}

// ---------------------------------------------------------------------------------------------
// Setup ambiente: cartella di lavoro temporanea + finta cartella ComfyUI con models/ e
// custom_nodes/. La configurazione punta a questi percorsi reali su disco.
// ---------------------------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-comfy-int-'));
const wsDir = path.join(tmpRoot, 'workspace');
const comfyRoot = path.join(tmpRoot, 'comfy');
const workflowsDir = path.join(wsDir, '.mg', 'workflows');
fs.mkdirSync(workflowsDir, { recursive: true });
fs.mkdirSync(path.join(comfyRoot, 'models'), { recursive: true });
fs.mkdirSync(path.join(comfyRoot, 'custom_nodes'), { recursive: true });

(vscodeMock.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: uri(wsDir) }];
configStore.set('image.comfyRoot', comfyRoot);
configStore.set('image.comfyEndpoint', 'http://127.0.0.1:8188');
configStore.set('image.galleryFolder', '');
configStore.set('image.workflow', '');

const ENDPOINT = 'http://127.0.0.1:8188';

function writeWorkflow(name: string, wf: unknown): void {
	fs.writeFileSync(path.join(workflowsDir, name), JSON.stringify(wf, null, 2));
}

// ---------------------------------------------------------------------------------------------
// Esecuzione dei test.
// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {

	// ===========================================================================================
	// extractWorkflowFromArchive (Req 15.5)
	// ===========================================================================================
	await test('extractWorkflowFromArchive: estrae il primo .json da uno ZIP stored', () => {
		const wfJson = JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 5 } } });
		const zip = buildStoredZip([
			{ name: 'readme.txt', content: 'non un workflow' },
			{ name: 'my-workflow.json', content: wfJson },
		]);
		const res = helper.extractWorkflowFromArchive(new Uint8Array(zip));
		assert.ok(!('error' in res), `estrazione fallita: ${'error' in res ? res.error : ''}`);
		if ('error' in res) { return; }
		assert.strictEqual(res.name, 'my-workflow.json');
		assert.deepStrictEqual(JSON.parse(res.text), JSON.parse(wfJson));
	});

	await test('extractWorkflowFromArchive: ZIP senza .json restituisce errore', () => {
		const zip = buildStoredZip([{ name: 'note.txt', content: 'niente json qui' }]);
		const res = helper.extractWorkflowFromArchive(new Uint8Array(zip));
		assert.ok('error' in res, 'atteso errore per archivio senza .json');
	});

	await test('extractWorkflowFromArchive: byte non-ZIP restituiscono errore', () => {
		const res = helper.extractWorkflowFromArchive(new Uint8Array(Buffer.from('non sono uno zip')));
		assert.ok('error' in res, 'atteso errore per archivio non valido');
	});

	// ===========================================================================================
	// importWorkflow: conversione e fallback (Req 15.1, 15.2, 15.3, 15.4, 15.5)
	// ===========================================================================================

	await test('importWorkflow: workflow in formato API salvato così com\'è (Req 15.1)', async () => {
		resetScenario();
		const apiWf = { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } } };
		const src = path.join(tmpRoot, 'api-wf.json');
		fs.writeFileSync(src, JSON.stringify(apiWf));
		openDialogResult = [{ fsPath: src }];

		await helper.importWorkflow();

		const dest = path.join(workflowsDir, 'api-wf.json');
		assert.ok(fs.existsSync(dest), 'il workflow API non è stato salvato');
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), apiWf);
		assert.strictEqual(configStore.get('image.workflow'), 'api-wf.json');
		assert.ok(rec.infos.some(m => /importato e attivato/i.test(m)), 'manca il messaggio di conferma');
	});

	await test('importWorkflow: UI→API con fallback a ComfyUI /object_info (Req 15.2, 15.3)', async () => {
		resetScenario();
		// UI con un widget posizionale: la conversione locale (objectInfo vuoto) NON basta,
		// quindi deve interrogare ComfyUI per ordinare i widgets_values.
		const uiWf = { nodes: [{ id: 1, type: 'KSampler', widgets_values: [42], inputs: [] }], links: [] };
		const src = path.join(tmpRoot, 'ui-wf.json');
		fs.writeFileSync(src, JSON.stringify(uiWf));
		openDialogResult = [{ fsPath: src }];
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) {
				return jsonResponse({ KSampler: { input: { required: { seed: ['INT'] } } } });
			}
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.importWorkflow();

		assert.ok(rec.fetchedUrls.some(u => u.endsWith('/object_info')), 'il fallback non ha interrogato /object_info');
		const dest = path.join(workflowsDir, 'ui-wf.json');
		assert.ok(fs.existsSync(dest), 'il workflow convertito non è stato salvato');
		const saved = JSON.parse(fs.readFileSync(dest, 'utf8'));
		assert.strictEqual(saved['1'].class_type, 'KSampler');
		assert.strictEqual(saved['1'].inputs.seed, 42, 'il widget posizionale non è stato ordinato via /object_info');
	});

	await test('importWorkflow: UI non convertibile se ComfyUI è irraggiungibile (Req 15.3/15.4)', async () => {
		resetScenario();
		const uiWf = { nodes: [{ id: 1, type: 'KSampler', widgets_values: [42], inputs: [] }], links: [] };
		const src = path.join(tmpRoot, 'ui-wf-unreach.json');
		fs.writeFileSync(src, JSON.stringify(uiWf));
		openDialogResult = [{ fsPath: src }];
		currentFetch = async () => { throw new Error('ECONNREFUSED'); };

		await helper.importWorkflow();

		assert.ok(!fs.existsSync(path.join(workflowsDir, 'ui-wf-unreach.json')), 'non doveva salvare un workflow non convertibile');
		assert.ok(rec.warnings.some(m => /non convertibile/i.test(m)), 'manca l\'avviso di workflow non convertibile');
	});

	await test('importWorkflow: estrae da archivio ZIP prima dell\'import (Req 15.5)', async () => {
		resetScenario();
		const apiWf = { '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0] } } };
		const zip = buildStoredZip([{ name: 'inner.json', content: JSON.stringify(apiWf) }]);
		const src = path.join(tmpRoot, 'bundle.zip');
		fs.writeFileSync(src, zip);
		openDialogResult = [{ fsPath: src }];

		await helper.importWorkflow();

		const dest = path.join(workflowsDir, 'inner.json');
		assert.ok(fs.existsSync(dest), 'il workflow estratto dallo ZIP non è stato salvato');
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), apiWf);
	});

	// ===========================================================================================
	// installMissingModelsForWorkflow (Req 16.3, 16.4, 16.5)
	// ===========================================================================================
	const modelWf = { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'mymodel.safetensors' } } };
	const objInfoNoModel = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['other.safetensors']] } } } };

	await test('installMissingModels: conferma + progresso + download riuscito (Req 16.4)', async () => {
		resetScenario();
		writeWorkflow('models-ok.json', modelWf);
		warnResult = 'Scarica'; // conferma del download
		const dlUrl = 'http://models.example/mymodel.safetensors';
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) { return jsonResponse(objInfoNoModel); }
			if (url.includes('model-list.json')) {
				return jsonResponse({ models: [{ filename: 'mymodel.safetensors', url: dlUrl, type: 'checkpoints' }] });
			}
			if (url === dlUrl) { return streamResponse(Buffer.from('PESI-MODELLO')); }
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.installMissingModelsForWorkflow(ENDPOINT, 'models-ok.json');

		const dest = path.join(comfyRoot, 'models', 'checkpoints', 'mymodel.safetensors');
		assert.ok(fs.existsSync(dest), 'il modello non è stato scaricato nella cartella attesa');
		assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'PESI-MODELLO');
		assert.ok(rec.fetchedUrls.includes(dlUrl), 'il download non è stato avviato');
		assert.ok(rec.infos.some(m => /completato/i.test(m)), 'manca il messaggio di completamento');
	});

	await test('installMissingModels: senza conferma non scarica nulla (gating Req 16.4)', async () => {
		resetScenario();
		writeWorkflow('models-decline.json', modelWf);
		warnResult = undefined; // utente NON conferma
		const dlUrl = 'http://models.example/decline.safetensors';
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) { return jsonResponse(objInfoNoModel); }
			if (url.includes('model-list.json')) {
				return jsonResponse({ models: [{ filename: 'mymodel.safetensors', url: dlUrl, type: 'checkpoints' }] });
			}
			if (url === dlUrl) { throw new Error('il download NON doveva partire'); }
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.installMissingModelsForWorkflow(ENDPOINT, 'models-decline.json');

		assert.ok(rec.warnings.some(m => /Scarico/i.test(m)), 'manca la richiesta di conferma');
		assert.ok(!rec.fetchedUrls.includes(dlUrl), 'ha scaricato pur senza conferma');
	});

	await test('installMissingModels: annullamento del download (Req 16.4)', async () => {
		resetScenario();
		writeWorkflow('models-cancel.json', modelWf);
		warnResult = 'Scarica';
		const dlUrl = 'http://models.example/cancel.safetensors';
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) { return jsonResponse(objInfoNoModel); }
			if (url.includes('model-list.json')) {
				return jsonResponse({ models: [{ filename: 'mymodel.safetensors', url: dlUrl, type: 'checkpoints' }] });
			}
			if (url === dlUrl) {
				const err = new Error('The operation was aborted');
				(err as { name: string }).name = 'AbortError';
				throw err;
			}
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.installMissingModelsForWorkflow(ENDPOINT, 'models-cancel.json');

		assert.ok(rec.infos.some(m => /annullat/i.test(m)), 'manca il messaggio di annullamento');
		assert.ok(!fs.existsSync(path.join(comfyRoot, 'models', 'checkpoints', 'cancel.safetensors')), 'non doveva creare il file annullato');
	});

	await test('installMissingModels: errore di download segnalato (Req 16.5)', async () => {
		resetScenario();
		writeWorkflow('models-error.json', modelWf);
		warnResult = 'Scarica';
		const dlUrl = 'http://models.example/error.safetensors';
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) { return jsonResponse(objInfoNoModel); }
			if (url.includes('model-list.json')) {
				return jsonResponse({ models: [{ filename: 'mymodel.safetensors', url: dlUrl, type: 'checkpoints' }] });
			}
			if (url === dlUrl) { return jsonResponse({}, false, 500); }
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.installMissingModelsForWorkflow(ENDPOINT, 'models-error.json');

		assert.ok(rec.warnings.some(m => /fallito/i.test(m)), 'manca la segnalazione dell\'errore di download');
	});

	await test('installMissingModels: modello fuori catalogo chiede l\'URL manuale (Req 16.3)', async () => {
		resetScenario();
		writeWorkflow('models-manual.json', modelWf);
		warnResult = 'Scarica';
		inputResult = undefined; // l'utente non incolla un URL → salta
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) { return jsonResponse(objInfoNoModel); }
			if (url.includes('model-list.json')) { return jsonResponse({ models: [] }); } // nessun modello risolto
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.installMissingModelsForWorkflow(ENDPOINT, 'models-manual.json');

		assert.ok(rec.inputBoxTitles.some(t => /mymodel\.safetensors/.test(t)), 'non ha chiesto l\'URL manuale per il modello non risolto');
	});

	// ===========================================================================================
	// installMissingNodesForWorkflow (Req 17.2, 17.4)
	// ===========================================================================================
	const nodeWf = {
		'1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
		'2': { class_type: 'MyCustomNode', inputs: { value: 1 } },
	};
	const objInfoKnown = { CheckpointLoaderSimple: {}, KSampler: {} }; // MyCustomNode NON noto
	const nodeMap = { 'https://github.com/foo/MyNodes': [['MyCustomNode'], {}] };

	await test('installMissingNodes: conferma → installa e chiede il riavvio (Req 17.2, 17.4)', async () => {
		resetScenario();
		writeWorkflow('nodes-ok.json', nodeWf);
		warnResult = 'Installa'; // conferma clonazione codice di terzi
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) { return jsonResponse(objInfoKnown); }
			if (url.includes('extension-node-map.json')) { return jsonResponse(nodeMap); }
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.installMissingNodesForWorkflow(ENDPOINT, 'nodes-ok.json');

		assert.ok(rec.warnings.some(m => /Installo .* pacchett/i.test(m)), 'manca la richiesta di conferma installazione');
		assert.ok(rec.execCommands.some(c => /git clone/i.test(c)), 'non ha clonato il repo del nodo');
		assert.ok(rec.infos.some(m => /RIAVVIA/i.test(m)), 'manca il messaggio di riavvio di ComfyUI');
	});

	await test('installMissingNodes: senza conferma non installa nulla (gating Req 17.2)', async () => {
		resetScenario();
		writeWorkflow('nodes-decline.json', nodeWf);
		warnResult = undefined; // l'utente NON conferma
		currentFetch = async (url: string) => {
			if (url.endsWith('/object_info')) { return jsonResponse(objInfoKnown); }
			if (url.includes('extension-node-map.json')) { return jsonResponse(nodeMap); }
			throw new Error(`URL inatteso: ${url}`);
		};

		await helper.installMissingNodesForWorkflow(ENDPOINT, 'nodes-decline.json');

		assert.ok(rec.warnings.some(m => /Installo .* pacchett/i.test(m)), 'manca la richiesta di conferma');
		assert.strictEqual(rec.execCommands.length, 0, 'ha eseguito git pur senza conferma');
		assert.ok(!rec.infos.some(m => /RIAVVIA/i.test(m)), 'non doveva chiedere il riavvio senza installazione');
	});

	// ---------------------------------------------------------------------------------------------
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void main();
