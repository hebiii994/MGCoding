/*---------------------------------------------------------------------------------------------
 *  MGCoding - modifica inline del codice selezionato (Ctrl+I)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { complete } from '../agent/agent';
import { ProviderRegistry } from '../llm/registry';

function stripFences(text: string): string {
	const m = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
	return (m ? m[1] : text).replace(/\s+$/, '');
}

export async function inlineEdit(registry: ProviderRegistry, presetInstruction?: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Apri un file ed eventualmente seleziona del codice.');
		return;
	}
	const sel = editor.selection;
	const range = sel.isEmpty ? new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)) : sel;
	const code = editor.document.getText(sel.isEmpty ? undefined : sel);
	if (!code.trim()) {
		vscode.window.showWarningMessage('Niente da modificare.');
		return;
	}
	const instruction = presetInstruction ?? await vscode.window.showInputBox({
		prompt: sel.isEmpty ? 'Modifica MGCoding sul file' : 'Modifica MGCoding sulla selezione',
		placeHolder: 'es. aggiungi gestione errori, rinomina in X, converti in async…',
		ignoreFocusOut: true
	});
	if (!instruction) {
		return;
	}
	const lang = editor.document.languageId;
	const prompt = `Riscrivi il seguente codice ${lang} applicando l'istruzione. Rispondi SOLO con il codice risultante, senza spiegazioni e senza blocchi markdown.

Istruzione: ${instruction}

Codice:
${code}`;

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'MGCoding: modifica in corso…', cancellable: false },
		async () => complete(registry, [{ role: 'user', content: prompt }])
	);
	const newCode = stripFences(result);
	if (!newCode.trim()) {
		vscode.window.showWarningMessage('Nessuna modifica prodotta.');
		return;
	}
	await editor.edit(e => e.replace(range, newCode));
	vscode.window.showInformationMessage('MGCoding: modifica applicata (Ctrl+Z per annullare).');
}
