/*---------------------------------------------------------------------------------------------
 *  MGCoding - migrazione deterministica da Kiro (.kiro) a .mg
 *  Copia specs e steering (.md), converte gli hook (.kiro.hook -> .json) e l'mcp.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exists } from '../util/paths';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

async function copyTree(src: vscode.Uri, dst: vscode.Uri): Promise<number> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(src);
	} catch {
		return 0;
	}
	await vscode.workspace.fs.createDirectory(dst);
	let count = 0;
	for (const [name, type] of entries) {
		const s = vscode.Uri.joinPath(src, name);
		const d = vscode.Uri.joinPath(dst, name);
		if (type === vscode.FileType.Directory) {
			count += await copyTree(s, d);
		} else {
			await vscode.workspace.fs.writeFile(d, await vscode.workspace.fs.readFile(s));
			count++;
		}
	}
	return count;
}

function kiroHookToOurs(raw: any): object | undefined {
	if (!raw?.name) {
		return undefined;
	}
	const whenType = raw.when?.type ?? '';
	const event =
		whenType === 'fileCreated' ? 'onCreate' :
			whenType === 'fileDeleted' ? 'onDelete' :
				whenType === 'userTriggered' || whenType === 'manual' ? 'manual' :
					'onSave';
	const action = raw.then?.type === 'runCommand' ? 'command' : 'ask';
	return {
		name: raw.name,
		description: raw.description,
		event,
		filePattern: (raw.when?.patterns ?? [])[0],
		action,
		prompt: raw.then?.prompt,
		command: raw.then?.command,
		enabled: raw.enabled !== false
	};
}

async function importHooks(kiroHooks: vscode.Uri, mgHooks: vscode.Uri): Promise<number> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(kiroHooks);
	} catch {
		return 0;
	}
	await vscode.workspace.fs.createDirectory(mgHooks);
	let count = 0;
	for (const [name, type] of entries) {
		if (type !== vscode.FileType.File || (!name.endsWith('.kiro.hook') && !name.endsWith('.json'))) {
			continue;
		}
		try {
			const raw = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(kiroHooks, name))));
			const converted = (raw?.when || raw?.then) ? kiroHookToOurs(raw) : raw;
			if (!converted) {
				continue;
			}
			const base = name.replace(/\.kiro\.hook$/, '').replace(/\.json$/, '');
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(mgHooks, `${base}.json`),
				ENC.encode(JSON.stringify(converted, null, 2))
			);
			count++;
		} catch {
			// ignora file non validi
		}
	}
	return count;
}

export async function importFromKiro(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showWarningMessage('Apri una cartella per importare da Kiro.');
		return;
	}
	const root = folders[0].uri;
	const kiro = vscode.Uri.joinPath(root, '.kiro');
	if (!(await exists(kiro))) {
		vscode.window.showWarningMessage('Nessuna cartella .kiro trovata nel workspace.');
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'Importo specs, steering, hooks e MCP da .kiro a .mg? (i file .kiro restano intatti)',
		{ modal: true }, 'Importa'
	);
	if (choice !== 'Importa') {
		return;
	}

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'MGCoding: importo da Kiro…' },
		async () => {
			const specs = await copyTree(vscode.Uri.joinPath(kiro, 'specs'), vscode.Uri.joinPath(root, '.mg', 'specs'));
			const steering = await copyTree(vscode.Uri.joinPath(kiro, 'steering'), vscode.Uri.joinPath(root, '.mg', 'steering'));
			const hooks = await importHooks(vscode.Uri.joinPath(kiro, 'hooks'), vscode.Uri.joinPath(root, '.mg', 'hooks'));
			let mcp = 0;
			const kiroMcp = vscode.Uri.joinPath(kiro, 'settings', 'mcp.json');
			if (await exists(kiroMcp)) {
				await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, '.mg', 'mcp.json'), await vscode.workspace.fs.readFile(kiroMcp));
				mcp = 1;
			}
			return { specs, steering, hooks, mcp };
		}
	);

	await vscode.commands.executeCommand('mgcoding.refreshSpecs');
	await vscode.commands.executeCommand('mgcoding.refreshSteering');
	await vscode.commands.executeCommand('mgcoding.refreshHooks');
	await vscode.commands.executeCommand('mgcoding.refreshMcp');

	vscode.window.showInformationMessage(
		`Import da Kiro completato: ${result.specs} file specs, ${result.steering} steering, ${result.hooks} hook, ${result.mcp ? 'mcp.json' : 'nessun mcp'}.`
	);
}
