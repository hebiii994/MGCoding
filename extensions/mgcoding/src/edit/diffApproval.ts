/*---------------------------------------------------------------------------------------------
 *  MGCoding - anteprima diff + approvazione delle modifiche ai file
 *  Mostra il confronto (contenuto attuale vs proposto) e chiede conferma prima di scrivere.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const SCHEME = 'mgcoding-diff';
/** uri.toString() -> contenuto virtuale da mostrare nel diff */
const CONTENT = new Map<string, string>();
let counter = 0;

class DiffContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		return CONTENT.get(uri.toString()) ?? '';
	}
}

export function registerDiffApproval(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, new DiffContentProvider())
	);
}

/**
 * Apre un editor diff (attuale vs proposto) e chiede all'utente se applicare.
 * Ritorna true se approvato.
 */
export async function confirmWrite(relPath: string, oldContent: string, newContent: string): Promise<boolean> {
	const v = ++counter;
	const oldUri = vscode.Uri.parse(`${SCHEME}:/attuale/${relPath}?v=${v}`);
	const newUri = vscode.Uri.parse(`${SCHEME}:/proposta/${relPath}?v=${v}`);
	CONTENT.set(oldUri.toString(), oldContent);
	CONTENT.set(newUri.toString(), newContent);

	const isNew = oldContent.length === 0;
	const title = `MGCoding · ${relPath} ${isNew ? '(nuovo file)' : '(modifica)'}`;
	await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, { preview: true });

	const choice = await vscode.window.showInformationMessage(
		`Applicare le modifiche a "${relPath}"?`,
		{ modal: true },
		'Applica'
	);

	CONTENT.delete(oldUri.toString());
	CONTENT.delete(newUri.toString());
	return choice === 'Applica';
}
