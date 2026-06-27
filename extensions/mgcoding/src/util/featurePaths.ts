/*---------------------------------------------------------------------------------------------
 *  MGCoding - risoluzione cartelle feature con compatibilità Kiro (.kiro)
 *  Lettura: preferisce .mg/<sub>, poi .kiro/<sub>. Scrittura: sempre .mg/<sub> (canonica).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function root(): vscode.Uri | undefined {
	const f = vscode.workspace.workspaceFolders;
	return f && f.length ? f[0].uri : undefined;
}

/** Cartella canonica di scrittura: <workspace>/.mg/<sub>. */
export function mgDir(sub: string): vscode.Uri | undefined {
	const r = root();
	return r ? vscode.Uri.joinPath(r, '.mg', sub) : undefined;
}

/**
 * Cartella di lettura per una feature: .mg/<sub> se esiste, altrimenti .kiro/<sub>.
 * Ritorna undefined se nessuna delle due esiste.
 */
export async function resolveFeatureDir(sub: string): Promise<vscode.Uri | undefined> {
	const r = root();
	if (!r) {
		return undefined;
	}
	const mg = vscode.Uri.joinPath(r, '.mg', sub);
	if (await exists(mg)) {
		return mg;
	}
	const kiro = vscode.Uri.joinPath(r, '.kiro', sub);
	if (await exists(kiro)) {
		return kiro;
	}
	return undefined;
}

/**
 * Tutte le cartelle esistenti per una feature, unendo .mg/<sub> e .kiro/<sub>.
 * (.mg per primo, così in caso di nomi duplicati ha la precedenza.)
 */
export async function resolveFeatureDirs(sub: string): Promise<vscode.Uri[]> {
	const r = root();
	if (!r) {
		return [];
	}
	const out: vscode.Uri[] = [];
	for (const base of ['.mg', '.kiro']) {
		const d = vscode.Uri.joinPath(r, base, sub);
		if (await exists(d)) {
			out.push(d);
		}
	}
	return out;
}

/**
 * Risolve un file di configurazione provando più percorsi (es. mcp.json).
 * Ritorna il primo esistente, o undefined.
 */
export async function resolveFile(...relPaths: string[]): Promise<vscode.Uri | undefined> {
	const r = root();
	if (!r) {
		return undefined;
	}
	for (const rel of relPaths) {
		const uri = vscode.Uri.joinPath(r, ...rel.split('/'));
		if (await exists(uri)) {
			return uri;
		}
	}
	return undefined;
}
