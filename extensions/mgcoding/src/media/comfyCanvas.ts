/*---------------------------------------------------------------------------------------------
 *  MGCoding - Canvas ComfyUI al centro: apre l'editor a nodi di ComfyUI (già in esecuzione)
 *  dentro un pannello editor di MGCoding. Riusa il "Simple Browser" integrato di VS Code, che
 *  gestisce correttamente l'embedding di http://localhost (CSP, sandbox iframe, focus lock):
 *  un iframe fatto a mano in un webview personalizzato risultava spesso vuoto.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Verifica veloce che ComfyUI risponda sull'endpoint (timeout breve). */
async function comfyReachable(endpoint: string): Promise<boolean> {
	try {
		const res = await fetch(`${endpoint}/system_stats`, { signal: AbortSignal.timeout(2500) });
		return res.ok;
	} catch {
		try {
			// Alcune versioni non espongono /system_stats: prova la root.
			const res = await fetch(endpoint, { signal: AbortSignal.timeout(2500) });
			return res.ok;
		} catch {
			return false;
		}
	}
}

/** Apre il canvas a nodi di ComfyUI nel Simple Browser integrato; fallback al browser di sistema. */
export async function openComfyCanvas(): Promise<void> {
	const endpoint = vscode.workspace.getConfiguration('mgcoding')
		.get<string>('image.comfyEndpoint', 'http://127.0.0.1:8188').replace(/\/$/, '');

	if (!(await comfyReachable(endpoint))) {
		const pick = await vscode.window.showWarningMessage(
			`ComfyUI non risponde su ${endpoint}. Avvialo (run_nvidia_gpu.bat) e riprova.`,
			'Riprova', 'Apri nel browser'
		);
		if (pick === 'Riprova') {
			return openComfyCanvas();
		}
		if (pick === 'Apri nel browser') {
			await vscode.env.openExternal(vscode.Uri.parse(endpoint));
		}
		return;
	}

	try {
		// Simple Browser: webview collaudato per http://localhost (iframe + CSP corretti).
		await vscode.commands.executeCommand('simpleBrowser.show', endpoint);
	} catch {
		const pick = await vscode.window.showWarningMessage(
			`Impossibile aprire il canvas integrato per ${endpoint}.`, 'Apri nel browser'
		);
		if (pick === 'Apri nel browser') {
			await vscode.env.openExternal(vscode.Uri.parse(endpoint));
		}
	}
}
