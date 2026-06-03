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

/** Numero di file modificati nel checkpoint corrente. */
export function changedCount(): number {
	return original.size;
}

const DIFF_SCHEME = 'mgcoding-checkpoint';

/** Registra il provider che serve il contenuto "originale" per le diff. */
export function registerCheckpointDiff(context: vscode.ExtensionContext): void {
	const provider: vscode.TextDocumentContentProvider = {
		provideTextDocumentContent(uri: vscode.Uri): string {
			const realKey = uri.with({ scheme: 'file' }).toString();
			return original.get(realKey) ?? '';
		}
	};
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider));
}

/** Apre la diff (originale ⟶ attuale) per ogni file modificato dall'agente. */
export async function openCheckpointDiffs(): Promise<void> {
	if (original.size === 0) {
		vscode.window.showInformationMessage('Nessuna modifica dell\'agente da mostrare.');
		return;
	}
	for (const [key, content] of original) {
		const uri = vscode.Uri.parse(key);
		const rel = vscode.workspace.asRelativePath(uri, false);
		if (content === null) {
			// File creato dall'agente: non c'è un "prima", apri il file.
			await vscode.window.showTextDocument(uri, { preview: false });
		} else {
			const left = uri.with({ scheme: DIFF_SCHEME });
			await vscode.commands.executeCommand('vscode.diff', left, uri, `${rel} (modifiche MGCoding)`, { preview: false });
		}
	}
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
