/*---------------------------------------------------------------------------------------------
 *  MGCoding - controllo aggiornamenti via GitHub Releases (con download + install in-app)
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
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

/** Mostra il messaggio con le opzioni di aggiornamento (in-app su Windows e macOS). */
async function promptUpdate(): Promise<void> {
	if (!pendingRelease) {
		return;
	}
	const canInApp = (process.platform === 'win32' || process.platform === 'darwin') && !!pendingRelease.downloadUrl;
	const primary = canInApp ? 'Aggiorna ora' : 'Scarica dal browser';
	const choice = await vscode.window.showInformationMessage(
		`È disponibile MGCoding ${pendingRelease.tag} (hai v${pendingRelease.current}).`,
		primary,
		'Note di rilascio'
	);
	if (choice === 'Aggiorna ora') {
		if (process.platform === 'darwin') {
			await downloadAndInstallMac();
		} else {
			await downloadAndInstall();
		}
	} else if (choice === 'Scarica dal browser') {
		await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.downloadUrl ?? pendingRelease.htmlUrl));
	} else if (choice === 'Note di rilascio') {
		await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.htmlUrl));
	}
}

/** Scarica un file mostrando l'avanzamento. Ritorna true se completato. */
async function downloadWithProgress(url: string, dest: string, tag: string): Promise<boolean> {
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
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const fallback = await vscode.window.showErrorMessage(`Download non riuscito (${msg}).`, 'Apri pagina release');
		if (fallback && pendingRelease) {
			await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.htmlUrl));
		}
		return false;
	}
}

/**
 * Aggiornamento su macOS: scarica il .dmg, lo monta e guida l'utente a trascinare
 * MGCoding.app in Applicazioni. (L'auto-sostituzione mentre l'app gira è inaffidabile
 * su macOS per via di Gatekeeper, quindi si usa il flusso semi-automatico.)
 */
async function downloadAndInstallMac(): Promise<void> {
	if (!pendingRelease?.downloadUrl) {
		return;
	}
	const tag = pendingRelease.tag;
	const dest = path.join(os.tmpdir(), `MGCoding-${tag}.dmg`);
	if (!(await downloadWithProgress(pendingRelease.downloadUrl, dest, tag))) {
		return;
	}
	const go = await vscode.window.showInformationMessage(
		`MGCoding ${tag} è stato scaricato. Apro il disco: trascina MGCoding nella cartella Applicazioni (sostituendo la versione attuale), poi riavvia l'app.`,
		{ modal: true },
		'Apri il disco'
	);
	if (go !== 'Apri il disco') {
		return;
	}
	try {
		execFileSync('open', [dest], { stdio: 'ignore' });
	} catch {
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dest));
	}
}

/** Scarica l'installer dentro l'app (con avanzamento) e lo avvia, poi chiude MGCoding. */
async function downloadAndInstall(): Promise<void> {
	if (!pendingRelease?.downloadUrl) {
		return;
	}
	const tag = pendingRelease.tag;
	const dest = path.join(os.tmpdir(), `MGCodingSetup-${tag}.exe`);

	if (!(await downloadWithProgress(pendingRelease.downloadUrl, dest, tag))) {
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

	// Aggiornamento automatico tramite il Task Scheduler di Windows: lo script .bat
	// gira sotto il SERVIZIO Utilità di pianificazione, quindi è del tutto INDIPENDENTE
	// dal processo di MGCoding (lo spawn "detached" veniva invece ucciso alla chiusura
	// dell'app perché Electron mette i figli in un job). Lo script attende la chiusura,
	// installa in silenzio e riapre l'app aggiornata.
	const exeName = process.execPath.split(/[\\/]/).pop() ?? 'MGCoding.exe';
	const batPath = path.join(os.tmpdir(), `mgcoding-update-${tag}.bat`);
	const taskName = 'MGCodingUpdate';
	// Percorso completo a schtasks (robusto anche se System32 non è nel PATH).
	const schtasks = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
	const logPath = path.join(os.tmpdir(), 'mgcoding-update.log');
	// Script VISIBILE e robusto: mostra lo stato, attende la chiusura (max ~20s),
	// installa con barra di avanzamento (/SILENT), riapre, e scrive un log per diagnosi.
	const bat = [
		'@echo off',
		'title MGCoding - Aggiornamento',
		`echo Aggiornamento di MGCoding ${tag} > "${logPath}"`,
		'echo ============================================',
		'echo  Aggiornamento di MGCoding in corso...',
		'echo  (non chiudere questa finestra)',
		'echo ============================================',
		'echo Attendo la chiusura dell app...',
		'set /a n=0',
		':wait',
		`tasklist /FI "IMAGENAME eq ${exeName}" 2>NUL | find /I "${exeName}" >NUL`,
		'if errorlevel 1 goto install',
		'set /a n+=1',
		'if %n% geq 20 goto install',
		'timeout /t 1 /nobreak >NUL',
		'goto wait',
		':install',
		`echo Installazione in corso... >> "${logPath}"`,
		'echo Installazione in corso, attendere qualche minuto...',
		// NB: in /SILENT l'installer Inno RILANCIA GIÀ l'app da solo (sezione [Run],
		// ShouldRunAfterUpdate=True). NON aggiungere qui un altro avvio, altrimenti si
		// aprono DUE finestre (una vuota + una col workspace).
		`"${dest}" /SILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL >> "${logPath}" 2>&1`,
		`echo Exit code installer: %errorlevel% >> "${logPath}"`,
		`"${schtasks}" /Delete /F /TN ${taskName} >NUL 2>&1`,
		// Auto-eliminazione pulita (evita il messaggio "batch file cannot be found").
		'(goto) 2>nul & del "%~f0"'
	].join('\r\n');

	let launchError = '';
	try {
		fs.writeFileSync(batPath, bat, 'utf8');
		// Crea ed esegue subito un task una-tantum: gira sotto il servizio, fuori dal job di MGCoding.
		execFileSync(schtasks, ['/Create', '/F', '/TN', taskName, '/SC', 'ONCE', '/ST', '00:00', '/TR', `cmd /c "${batPath}"`], { stdio: 'ignore', windowsHide: true });
		execFileSync(schtasks, ['/Run', '/TN', taskName], { stdio: 'ignore', windowsHide: true });
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

	// Aggiornamento disponibile: scegli l'asset adatto alla piattaforma.
	const asset = process.platform === 'darwin'
		? (release.assets.find(a => /arm64.*\.dmg$/i.test(a.name)) ?? release.assets.find(a => /\.dmg$/i.test(a.name)))
		: (release.assets.find(a => /Setup.*\.exe$/i.test(a.name)) ?? release.assets[0]);
	pendingRelease = { tag: release.tag_name, current, downloadUrl: asset?.browser_download_url, htmlUrl: release.html_url };

	if (updateBar) {
		updateBar.text = `$(cloud-download) MGCoding ${release.tag_name}`;
		updateBar.tooltip = `È disponibile l'aggiornamento ${release.tag_name} (hai v${current}). Clicca per aggiornare.`;
		updateBar.show();
	}

	await promptUpdate();
}
