/*---------------------------------------------------------------------------------------------
 *  MGCoding - azioni rapide dal codice: spiega/genera test sulla selezione e una QuickFix
 *  "Correggi con MGCoding" sugli errori dei language server. Refactor e commenti riusano
 *  l'inline edit (modifica con sostituzione nel file).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { complete } from '../agent/agent';
import { inlineEdit } from './inlineEdit';
import { ProviderRegistry } from '../llm/registry';

/** Selezione corrente (o intero file se vuota) con linguaggio. */
function activeCode(): { code: string; lang: string; file: string } | undefined {
	const ed = vscode.window.activeTextEditor;
	if (!ed) {
		void vscode.window.showWarningMessage('Apri un file e seleziona del codice.');
		return undefined;
	}
	const code = ed.selection.isEmpty ? ed.document.getText() : ed.document.getText(ed.selection);
	if (!code.trim()) {
		return undefined;
	}
	return { code, lang: ed.document.languageId, file: vscode.workspace.asRelativePath(ed.document.uri, false) };
}

/** Spiega il codice selezionato in un documento markdown. */
export async function explainSelection(registry: ProviderRegistry): Promise<void> {
	const ctx = activeCode();
	if (!ctx) {
		return;
	}
	const prompt = `Spiega in italiano, in modo chiaro e conciso, cosa fa questo codice ${ctx.lang}: scopo generale, come funziona passo per passo e eventuali criticità. Usa markdown.\n\n\`\`\`${ctx.lang}\n${ctx.code.slice(0, 12000)}\n\`\`\``;
	const out = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'MGCoding: spiego il codice…' },
		() => complete(registry, [{ role: 'user', content: prompt }])
	);
	if (out.trim()) {
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# Spiegazione — ${ctx.file}\n\n${out.trim()}\n` });
		await vscode.window.showTextDocument(doc, { preview: true });
	}
}

/** Genera test per il codice selezionato in un nuovo documento (da salvare dove preferisci). */
export async function generateTests(registry: ProviderRegistry): Promise<void> {
	const ctx = activeCode();
	if (!ctx) {
		return;
	}
	const prompt = `Scrivi test automatici per questo codice ${ctx.lang} (dal file ${ctx.file}). Usa il framework di test idiomatico per il linguaggio. Copri i casi principali e i bordi. Rispondi SOLO con il codice dei test, senza spiegazioni né blocchi markdown.\n\nCodice:\n${ctx.code.slice(0, 12000)}`;
	const out = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'MGCoding: genero i test…' },
		() => complete(registry, [{ role: 'user', content: prompt }])
	);
	const clean = out.replace(/^\s*```[\w-]*\n?|\n?```\s*$/g, '').trim();
	if (clean) {
		const doc = await vscode.workspace.openTextDocument({ language: ctx.lang, content: clean + '\n' });
		await vscode.window.showTextDocument(doc, { preview: false });
		void vscode.window.showInformationMessage('Test generati in un nuovo file: salvalo nella posizione corretta del progetto.');
	}
}

/** Refactor della selezione (riusa l'inline edit con istruzione preimpostata). */
export function refactorSelection(registry: ProviderRegistry): Promise<void> {
	return inlineEdit(registry, 'Migliora la qualità di questo codice (refactor): leggibilità, nomi, struttura, rimozione duplicazioni. NON cambiare il comportamento osservabile.');
}

/** Aggiunge commenti/docstring alla selezione (riusa l'inline edit). */
export function addComments(registry: ProviderRegistry): Promise<void> {
	return inlineEdit(registry, 'Aggiungi commenti chiari e concisi e, dove utile, docstring/JSDoc, senza modificare la logica del codice.');
}

/** Corregge gli errori segnalati nel range indicato (riusa l'inline edit). */
export async function fixWithAI(registry: ProviderRegistry, _uri?: vscode.Uri, range?: vscode.Range, messages?: string[]): Promise<void> {
	const ed = vscode.window.activeTextEditor;
	if (ed && range) {
		ed.selection = new vscode.Selection(range.start, range.end);
	}
	const errs = (messages ?? []).join('; ');
	const instruction = errs
		? `Correggi questi errori segnalati dagli strumenti di analisi, modificando il minimo necessario: ${errs}`
		: 'Correggi gli errori presenti in questo codice, modificando il minimo necessario.';
	await inlineEdit(registry, instruction);
}

/** Fornisce la QuickFix "Correggi con MGCoding" sugli errori/warning. */
export class MgCodeActionProvider implements vscode.CodeActionProvider {
	static readonly kinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(_document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
		const diags = context.diagnostics.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
		if (!diags.length) {
			return [];
		}
		const action = new vscode.CodeAction('✨ Correggi con MGCoding', vscode.CodeActionKind.QuickFix);
		action.command = {
			command: 'mgcoding.fixWithAI',
			title: 'Correggi con MGCoding',
			arguments: [_document.uri, range, diags.map(d => d.message)]
		};
		action.diagnostics = [...diags];
		return [action];
	}
}
