/*---------------------------------------------------------------------------------------------
 *  MGCoding - checkpoint/revert delle modifiche dell'agente
 *  Registra il contenuto originale dei file prima che l'agente li modifichi,
 *  così è possibile ripristinare l'ultimo gruppo di modifiche.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const DEC = new TextDecoder();
const ENC = new TextEncoder();

/** path(uri.toString()) -> contenuto originale (null = il file non esisteva). */
const original = new Map<string, string | null>();

/** Inizia un nuovo checkpoint (azzera quello precedente). */
export function beginCheckpoint(): void {
	original.clear();
}

/** Registra il contenuto originale di un file (una sola volta per checkpoint). */
export async function recordOriginal(uri: vscode.Uri): Promise<void> {
	const key = uri.toString();
	if (original.has(key)) {
		return;
	}
	try {
		original.set(key, DEC.decode(await vscode.workspace.fs.readFile(uri)));
	} catch {
		original.set(key, null);
	}
}

export function hasCheckpoint(): boolean {
	return original.size > 0;
}

/** Ripristina tutti i file del checkpoint allo stato originale. Ritorna il numero di file. */
export async function revertCheckpoint(): Promise<number> {
	const n = original.size;
	for (const [key, content] of original) {
		const uri = vscode.Uri.parse(key);
		try {
			if (content === null) {
				await vscode.workspace.fs.delete(uri);
			} else {
				await vscode.workspace.fs.writeFile(uri, ENC.encode(content));
			}
		} catch {
			// ignora
		}
	}
	original.clear();
	return n;
}
