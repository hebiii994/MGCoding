/*---------------------------------------------------------------------------------------------
 *  MGCoding - stub di `vscode` per eseguire test di logica pura con node puro.
 *
 *  Alcuni moduli sotto test (es. `llm/registry.ts`) fanno `import * as vscode from 'vscode'`
 *  al caricamento. In ambiente di test (node, fuori dall'Extension Host) il modulo `vscode`
 *  non esiste. Questo file, importato PRIMA del modulo sotto test, intercetta la risoluzione
 *  di `require('vscode')` e restituisce SEMPRE LO STESSO oggetto condiviso (`vscodeMock`):
 *  per i test di logica pura resta vuoto (sufficiente perché la funzione pura sotto test non
 *  usa alcuna API di `vscode` al caricamento del modulo); un test di integrazione può invece
 *  POPOLARLO prima di esercitare il modulo sotto test. Poiché i moduli fanno
 *  `import * as vscode from 'vscode'` catturando questo riferimento stabile, le proprietà
 *  aggiunte dopo l'import sono comunque visibili (vedi `gallery.int.test.ts`).
 *--------------------------------------------------------------------------------------------*/

import Module = require('module');

/**
 * Oggetto `vscode` condiviso restituito da ogni `require('vscode')` sotto test. Riferimento
 * STABILE e mutabile: vuoto per i test puri, popolabile dai test di integrazione.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const vscodeMock: any = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = Module as any;
const originalLoad = M._load;
M._load = function (request: string, ...args: unknown[]): unknown {
	if (request === 'vscode') {
		return vscodeMock;
	}
	return originalLoad.apply(this, [request, ...args]);
};

/**
 * ⚠️ TRAPPOLA DA CONOSCERE — snapshot di `vscode` a load-time.
 *
 * I moduli sotto test sono compilati con `esModuleInterop`, quindi un
 * `import * as vscode from 'vscode'` diventa `__importStar(require('vscode'))`. Per uno stub
 * che NON è un modulo ES (come `vscodeMock`), `__importStar` **copia** le proprietà proprie
 * dell'oggetto al momento del `require`: il modulo cattura cioè uno SNAPSHOT dello stub fatto
 * quando viene caricato, non un riferimento vivo. Di conseguenza, se un modulo legge
 * `vscode.window`/`vscode.workspace`/... A LOAD-TIME (es. `llm/registry.ts` nel costruttore, o
 * qualunque accesso in cima al file), un `import` in testa al file di test lo carica PRIMA che
 * il test abbia popolato `vscodeMock`, e quelle proprietà restano `undefined` per sempre — con
 * errori opachi tipo «Cannot read properties of undefined».
 *
 * Due modi sicuri per evitarla:
 *  1. Popolare `vscodeMock` con la superficie necessaria PRIMA di caricare il modulo, poi
 *     caricarlo con `require` (non con un `import` in testa). Vedi `loadAfterMock`.
 *  2. Per le sole funzioni pure (che non toccano `vscode` a load-time) l'`import` in testa va
 *     bene: lo snapshot vuoto è sufficiente.
 */

/**
 * Carica un modulo DOPO aver popolato lo stub `vscode`, evitando lo snapshot vuoto descritto
 * sopra. Usare con un percorso relativo alla cartella `out/test/` (come un normale `require`):
 *
 * ```ts
 * import { vscodeMock, loadAfterMock } from './vscodeStub';
 * Object.assign(vscodeMock, { window: { createStatusBarItem: () => ({ ... }) }, workspace: { ... } });
 * const { ProviderRegistry } = loadAfterMock<typeof import('../llm/registry')>('../llm/registry');
 * ```
 *
 * @param request percorso del modulo, identico a quello che passeresti a `require`.
 * @returns gli export del modulo, tipizzati dal chiamante.
 */
export function loadAfterMock<T>(request: string): T {
	// La risoluzione del percorso relativo deve avvenire rispetto al MODULO CHIAMANTE, non a
	// questo file: si usa quindi il `require` del chiamante. Poiché `vscodeStub` è importato dai
	// file di test (stessa cartella `out/test/`), i percorsi relativi `../llm/...` coincidono.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(request) as T;
}
