/*---------------------------------------------------------------------------------------------
 *  MGCoding - Bridge Telegram: invia prompt al tuo PC dal telefono e ricevi le risposte.
 *  Usa l'API Bot di Telegram in long-polling (nessun server da esporre).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../llm/registry';
import { runAgent } from '../agent/agentLoop';
import { ProfileStore } from '../profile/profiles';
import { setRemoteMode } from '../agent/tools';
import { ChatMessage } from '../llm/types';
import { splitThink } from '../util/parsing';

const CHAT_ID_KEY = 'mgcoding.telegram.chatId';
const api = (token: string, method: string): string => `https://api.telegram.org/bot${token}/${method}`;
const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface TgUpdate {
	update_id: number;
	message?: { text?: string; chat?: { id: number } };
}

export class TelegramBridge {
	private running = false;
	private offset = 0;
	private token = '';
	private pairCode = '';
	private busy = false;
	private history: ChatMessage[] = [];

	private readonly profiles: ProfileStore;

	constructor(
		private readonly registry: ProviderRegistry,
		private readonly memento: vscode.Memento
	) {
		this.profiles = new ProfileStore(this.memento);
	}

	private chatId(): string | undefined {
		return this.memento.get<string>(CHAT_ID_KEY) || undefined;
	}

	/** Avvia il long-polling con il token dato. Mostra il codice di pairing se non collegato. */
	async start(token: string): Promise<void> {
		if (this.running) {
			this.running = false;
			await delay(200);
		}
		this.token = token;
		this.running = true;
		if (!this.chatId()) {
			this.pairCode = Math.floor(100000 + Math.random() * 900000).toString();
			void vscode.window.showInformationMessage(
				`MGCoding · Telegram: apri il tuo bot sul telefono e invia il messaggio   /pair ${this.pairCode}   per collegarlo.`
			);
		} else {
			void this.send('🟢 MGCoding è online sul tuo PC. Mandami un prompt. (/new per ricominciare)');
		}
		void this.loop();
	}

	stop(): void {
		this.running = false;
	}

	dispose(): void {
		this.stop();
	}

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				const res = await fetch(`${api(this.token, 'getUpdates')}?timeout=30&offset=${this.offset}`);
				if (!res.ok) {
					await delay(4000);
					continue;
				}
				const data = await res.json() as { ok: boolean; result?: TgUpdate[] };
				for (const u of data.result ?? []) {
					this.offset = u.update_id + 1;
					const text = u.message?.text;
					const id = u.message?.chat?.id;
					if (text && id !== undefined) {
						await this.handle(String(id), text.trim());
					}
				}
			} catch {
				await delay(5000);
			}
		}
	}

	private async handle(chatId: string, text: string): Promise<void> {
		// Pairing: accetta solo il codice mostrato sul PC.
		if (!this.chatId()) {
			const m = text.match(/^\/pair\s+(\d{6})/);
			if (m && m[1] === this.pairCode) {
				await this.memento.update(CHAT_ID_KEY, chatId);
				await this.sendTo(chatId, '✅ Collegato! Mandami un prompt e lo eseguo sul tuo PC.\nComandi: /new (nuova conversazione).');
			} else {
				await this.sendTo(chatId, 'Per collegarti: sul PC apri MGCoding (comando “Connetti Telegram”) e invia qui  /pair <codice>.');
			}
			return;
		}
		if (chatId !== this.chatId()) {
			return; // chat non autorizzata
		}
		if (text === '/new') {
			this.history = [];
			await this.send('🆕 Nuova conversazione.');
			return;
		}
		if (text === '/start' || text === '/help') {
			await this.send('Mandami un prompt e lo eseguo sul tuo PC con l’agente MGCoding. /new per ricominciare.');
			return;
		}
		if (this.busy) {
			await this.send('⏳ Sto già lavorando a una richiesta, attendi che finisca…');
			return;
		}
		await this.runPrompt(text);
	}

	private async runPrompt(text: string): Promise<void> {
		this.busy = true;
		await this.send('🤔 Elaboro sul PC…');
		const cfg = vscode.workspace.getConfiguration('mgcoding');
		setRemoteMode(true, cfg.get<boolean>('telegram.autoApprove', false));
		this.history.push({ role: 'user', content: text });
		// Profilo per-persona: ogni chat Telegram ha il proprio profilo (auto-apprendimento).
		const id = this.chatId();
		if (id) {
			await this.profiles.ensure(`tg-${id}`, `Telegram ${id}`);
			await this.profiles.setActive(`tg-${id}`);
		}
		const systemExtra = this.profiles.contextBlock() || undefined;
		let answer = '';
		const tools: string[] = [];
		try {
			await runAgent(this.registry, this.history, {
				onAssistantText: t => { answer += (answer ? '\n' : '') + t; },
				onToolStart: c => { tools.push(c.tool); },
				onToolResult: () => { /* non inoltrato per non intasare */ },
				onRemember: fact => this.profiles.appendFact(this.profiles.activeId(), fact)
			}, undefined, systemExtra);
		} catch (e) {
			await this.send('⚠️ Errore: ' + (e instanceof Error ? e.message : String(e)));
			return;
		} finally {
			setRemoteMode(false, false);
			this.busy = false;
		}
		const clean = (splitThink(answer).answer || answer).trim() || '(nessuna risposta testuale)';
		const toolNote = tools.length ? `\n\n🔧 azioni: ${[...new Set(tools)].join(', ')}` : '';
		await this.send(clean.slice(0, 3900) + toolNote);
	}

	private async send(text: string): Promise<void> {
		const id = this.chatId();
		if (id) {
			await this.sendTo(id, text);
		}
	}

	/**
	 * Rispecchia su Telegram un evento della chat del PC (messaggio utente, risposta o
	 * azione dell'agente), così da seguire da remoto cosa accade. Disattivabile con
	 * l'impostazione mgcoding.telegram.mirror. Non inoltra durante un turno avviato da
	 * Telegram stesso (busy) per evitare doppioni.
	 */
	async mirror(role: 'user' | 'assistant' | 'tool', text: string): Promise<void> {
		const id = this.chatId();
		if (!id || !this.running || this.busy) {
			return;
		}
		if (!vscode.workspace.getConfiguration('mgcoding').get<boolean>('telegram.mirror', true)) {
			return;
		}
		const icon = role === 'user' ? '🧑 PC' : role === 'assistant' ? '🤖' : '🔧';
		await this.sendTo(id, `${icon} ${text}`.slice(0, 3900));
	}

	private async sendTo(chatId: string, text: string): Promise<void> {
		if (!this.token) {
			return;
		}
		try {
			await fetch(api(this.token, 'sendMessage'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ chat_id: chatId, text })
			});
		} catch {
			/* rete non disponibile */
		}
	}
}
