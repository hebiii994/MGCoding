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
