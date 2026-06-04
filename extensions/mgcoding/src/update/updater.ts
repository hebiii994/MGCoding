/*---------------------------------------------------------------------------------------------
 *  MGCoding - controllo aggiornamenti via GitHub Releases (con download + install in-app)
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const REPO = 'hebiii994/MGCoding';

interface GhRelease {
	tag_name: string;
	html_url: string;
	assets: { name: string; browser_download_url: string }[];
}

function parseVer(v: string): number[] {
	return v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

/** Ritorna >0 se a>b, <0 se a<b, 0 se uguali. */
function cmpVer(a: string, b: string): number {
	const pa = parseVer(a);
	const pb = parseVer(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	return 0;
}

function currentVersion(context: vscode.ExtensionContext): string {
	return (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
}

/** Badge persistente nella status bar (mostrato solo quando c'è un aggiornamento). */
let updateBar: vscode.StatusBarItem | undefined;
let commandRegistered = false;
/** Release attualmente disponibile (memorizzata per il comando del badge). */
let pendingRelease: { tag: string; current: string; downloadUrl?: string; htmlUrl: string } | undefined;

function ensureUpdateUi(context: vscode.ExtensionContext): void {
	if (!updateBar) {
		updateBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100000);
		updateBar.command = 'mgcoding.showUpdate';
		updateBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		context.subscriptions.push(updateBar);
	}
	if (!commandRegistered) {
		commandRegistered = true;
		context.subscriptions.push(
			vscode.commands.registerCommand('mgcoding.showUpdate', () => promptUpdate())
		);
	}
}

/** Mostra il messaggio con le opzioni di aggiornamento (in-app su Windows). */
async function promptUpdate(): Promise<void> {
	if (!pendingRelease) {
		return;
	}
	const canInApp = process.platform === 'win32' && !!pendingRelease.downloadUrl;
	const primary = canInApp ? 'Aggiorna ora' : 'Scarica dal browser';
	const choice = await vscode.window.showInformationMessage(
		`È disponibile MGCoding ${pendingRelease.tag} (hai v${pendingRelease.current}).`,
		primary,
		'Note di rilascio'
	);
	if (choice === 'Aggiorna ora') {
		await downloadAndInstall();
	} else if (choice === 'Scarica dal browser') {
		await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.downloadUrl ?? pendingRelease.htmlUrl));
	} else if (choice === 'Note di rilascio') {
		await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.htmlUrl));
	}
}

/** Scarica l'installer dentro l'app (con avanzamento) e lo avvia, poi chiude MGCoding. */
async function downloadAndInstall(): Promise<void> {
	if (!pendingRelease?.downloadUrl) {
		return;
	}
	const url = pendingRelease.downloadUrl;
	const tag = pendingRelease.tag;
	const dest = path.join(os.tmpdir(), `MGCodingSetup-${tag}.exe`);

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Scaricamento MGCoding ${tag}`, cancellable: false },
			async progress => {
				const res = await fetch(url, { headers: { 'user-agent': 'MGCoding' } });
				if (!res.ok || !res.body) {
					throw new Error(`HTTP ${res.status}`);
				}
				const total = Number(res.headers.get('content-length') ?? 0);
				const reader = res.body.getReader();
				const out = fs.createWriteStream(dest);
				let received = 0;
				let lastPct = 0;
				for (; ;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					out.write(Buffer.from(value));
					received += value.length;
					if (total > 0) {
						const pct = Math.floor((received / total) * 100);
						if (pct > lastPct) {
							progress.report({ increment: pct - lastPct, message: `${pct}%` });
							lastPct = pct;
						}
					}
				}
				await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const fallback = await vscode.window.showErrorMessage(`Download non riuscito (${msg}).`, 'Apri pagina release');
		if (fallback) {
			await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.htmlUrl));
		}
		return;
	}

	const go = await vscode.window.showInformationMessage(
		`MGCoding ${tag} è stato scaricato. Avviare l'installazione ora? Si aprirà l'installer: MGCoding verrà chiusa e riaperta aggiornata automaticamente.`,
		{ modal: true },
		'Installa ora'
	);
	if (go !== 'Installa ora') {
		return;
	}

	// Aggiornamento automatico tramite uno script .bat lanciato in modo DETACHED
	// (processo indipendente: sopravvive alla chiusura di MGCoding). Lo script
	// attende la chiusura dell'app, installa in silenzio e la riapre aggiornata.
	const exePath = process.execPath;
	const exeName = exePath.split(/[\\/]/).pop() ?? 'MGCoding.exe';
	const batPath = path.join(os.tmpdir(), `mgcoding-update-${tag}.bat`);
	const bat = [
		'@echo off',
		'timeout /t 2 /nobreak >NUL',
		':wait',
		`tasklist /FI "IMAGENAME eq ${exeName}" 2>NUL | find /I "${exeName}" >NUL && (timeout /t 1 /nobreak >NUL & goto wait)`,
		`"${dest}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`,
		`start "" "${exePath}"`,
		'del "%~f0"'
	].join('\r\n');

	let launchError = '';
	try {
		fs.writeFileSync(batPath, bat, 'utf8');
		// Lancia il .bat staccato dal processo di MGCoding così continua dopo il quit.
		const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', batPath], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		});
		child.unref();
	} catch (err) {
		launchError = err instanceof Error ? err.message : String(err);
	}

	if (launchError) {
		// Fallback infallibile: mostra il file da eseguire a mano.
		const pick = await vscode.window.showErrorMessage(
			`Aggiornamento automatico non riuscito (${launchError}). Puoi installarlo a mano: clicca "Mostra installer" e fai doppio clic sul file.`,
			'Mostra installer'
		);
		if (pick === 'Mostra installer') {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dest));
		}
		return;
	}

	vscode.window.showInformationMessage(`Aggiornamento a MGCoding ${tag} in corso: l'app si chiuderà e si riaprirà aggiornata tra pochi secondi…`);
	// Chiude MGCoding così l'installer (avviato dal Task Scheduler) può procedere.
	setTimeout(() => void vscode.commands.executeCommand('workbench.action.quit'), 1500);
}

export async function checkForUpdates(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
	ensureUpdateUi(context);

	let release: GhRelease | undefined;
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
			headers: { 'user-agent': 'MGCoding', 'accept': 'application/vnd.github+json' }
		});
		if (res.ok) {
			release = await res.json() as GhRelease;
		}
	} catch {
		// rete non disponibile
	}

	if (!release?.tag_name) {
		if (manual) {
			vscode.window.showWarningMessage('Impossibile verificare gli aggiornamenti MGCoding.');
		}
		return;
	}

	const current = currentVersion(context);
	if (cmpVer(release.tag_name, current) <= 0) {
		// Già aggiornato: nascondi il badge.
		pendingRelease = undefined;
		updateBar?.hide();
		if (manual) {
			vscode.window.showInformationMessage(`MGCoding è aggiornato (v${current}).`);
		}
		return;
	}

	// Aggiornamento disponibile: memorizza, mostra il badge persistente e proponi l'aggiornamento.
	const asset = release.assets.find(a => /Setup.*\.exe$/i.test(a.name)) ?? release.assets[0];
	pendingRelease = { tag: release.tag_name, current, downloadUrl: asset?.browser_download_url, htmlUrl: release.html_url };

	if (updateBar) {
		updateBar.text = `$(cloud-download) MGCoding ${release.tag_name}`;
		updateBar.tooltip = `È disponibile l'aggiornamento ${release.tag_name} (hai v${current}). Clicca per aggiornare.`;
		updateBar.show();
	}

	await promptUpdate();
}
