/*---------------------------------------------------------------------------------------------
 *  MGCoding - analytics anonimi (opt-in) verso PostHog
 *  Non invia MAI prompt, codice, percorsi o chiavi: solo eventi d'uso aggregati.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const CONSENT_ASKED = 'mgcoding.analytics.consentAsked';

let instance: Analytics | undefined;

class Analytics {
	private readonly version: string;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
	}

	private cfg(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('mgcoding');
	}

	private enabled(): boolean {
		return this.cfg().get<boolean>('analytics.enabled', false);
	}

	/** Chiede il consenso una sola volta (opt-in, default disattivato). */
	async maybeAskConsent(): Promise<void> {
		// Persistito nelle impostazioni utente (più affidabile del globalState) e nel globalState.
		const askedSetting = this.cfg().get<boolean>('analytics.asked', false);
		if (askedSetting || this.enabled() || this.context.globalState.get<boolean>(CONSENT_ASKED, false)) {
			return;
		}
		await this.context.globalState.update(CONSENT_ASKED, true);
		await this.cfg().update('analytics.asked', true, vscode.ConfigurationTarget.Global);
		const choice = await vscode.window.showInformationMessage(
			'MGCoding può raccogliere statistiche d\'uso anonime per migliorare il prodotto (nessun codice, prompt o chiave viene inviato). Vuoi attivarle?',
			'Attiva',
			'No, grazie'
		);
		if (choice === 'Attiva') {
			await this.cfg().update('analytics.enabled', true, vscode.ConfigurationTarget.Global);
			this.track('analytics_enabled');
		}
	}

	/** Invia un evento anonimo a PostHog (fire-and-forget). */
	track(event: string, properties?: Record<string, string | number | boolean>): void {
		if (!this.enabled()) {
			return;
		}
		const key = this.cfg().get<string>('analytics.key', '').trim();
		if (!key) {
			return;
		}
		const host = this.cfg().get<string>('analytics.host', 'https://eu.i.posthog.com').replace(/\/$/, '');
		const body = {
			api_key: key,
			event,
			distinct_id: vscode.env.machineId,
			properties: {
				...properties,
				app_version: this.version,
				os: process.platform,
				vscode_version: vscode.version,
				$lib: 'mgcoding'
			}
		};
		// fire-and-forget: gli errori non devono mai impattare l'utente
		void fetch(`${host}/capture/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}).catch(() => { /* ignora */ });
	}
}

/** Inizializza il singleton e chiede il consenso (una volta). */
export function initAnalytics(context: vscode.ExtensionContext): void {
	instance = new Analytics(context);
	void instance.maybeAskConsent();
}

/** Traccia un evento anonimo (no-op se non inizializzato o disattivato). */
export function track(event: string, properties?: Record<string, string | number | boolean>): void {
	instance?.track(event, properties);
}

/** Attiva/disattiva le statistiche d'uso dall'apposito comando. */
export async function toggleAnalytics(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('mgcoding');
	const next = !cfg.get<boolean>('analytics.enabled', false);
	await cfg.update('analytics.enabled', next, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`Statistiche d'uso MGCoding ${next ? 'attivate' : 'disattivate'}.`);
}
