/*---------------------------------------------------------------------------------------------
 *  MGCoding - controllo aggiornamenti via GitHub Releases
 *--------------------------------------------------------------------------------------------*/

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
			vscode.commands.registerCommand('mgcoding.showUpdate', () => promptDownload())
		);
	}
}

/** Mostra il messaggio con i pulsanti Scarica / Note di rilascio. */
async function promptDownload(): Promise<void> {
	if (!pendingRelease) {
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		`È disponibile MGCoding ${pendingRelease.tag} (hai v${pendingRelease.current}).`,
		'Scarica installer',
		'Note di rilascio'
	);
	if (choice === 'Scarica installer' && pendingRelease.downloadUrl) {
		await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.downloadUrl));
	} else if (choice === 'Note di rilascio') {
		await vscode.env.openExternal(vscode.Uri.parse(pendingRelease.htmlUrl));
	}
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

	// Aggiornamento disponibile: memorizza, mostra il badge persistente e (se manuale) il prompt.
	const asset = release.assets.find(a => /Setup.*\.exe$/i.test(a.name)) ?? release.assets[0];
	pendingRelease = { tag: release.tag_name, current, downloadUrl: asset?.browser_download_url, htmlUrl: release.html_url };

	if (updateBar) {
		updateBar.text = `$(cloud-download) MGCoding ${release.tag_name}`;
		updateBar.tooltip = `È disponibile l'aggiornamento ${release.tag_name} (hai v${current}). Clicca per scaricarlo.`;
		updateBar.show();
	}

	if (manual) {
		await promptDownload();
	} else {
		// Avviso non invasivo all'avvio (il badge resta comunque visibile).
		const choice = await vscode.window.showInformationMessage(
			`È disponibile MGCoding ${release.tag_name} (hai v${current}).`,
			'Scarica installer',
			'Note di rilascio'
		);
		if (choice === 'Scarica installer' && asset) {
			await vscode.env.openExternal(vscode.Uri.parse(asset.browser_download_url));
		} else if (choice === 'Note di rilascio') {
			await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
		}
	}
}
