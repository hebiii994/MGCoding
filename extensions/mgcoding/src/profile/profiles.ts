/*---------------------------------------------------------------------------------------------
 *  MGCoding - profili utente con auto-apprendimento (multi-persona).
 *  Ogni profilo raccoglie preferenze durature su una persona (nome, lingua, framework,
 *  stile di codice, istruzioni ricorrenti). Il profilo ATTIVO viene iniettato nel system
 *  prompt ad ogni turno; si aggiorna sia col tool `remember` sia con un consolidamento
 *  automatico periodico. Tutto resta locale (globalState).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface Profile {
	id: string;
	name: string;
	/** Fatti/preferenze in markdown (una per riga, prefissate da "- "). */
	facts: string;
}

const KEY_PROFILES = 'mgcoding.profiles';
const KEY_ACTIVE = 'mgcoding.activeProfile';

/** Store dei profili persistito in globalState. */
export class ProfileStore {
	constructor(private readonly memento: vscode.Memento) { }

	private all(): Profile[] {
		return this.memento.get<Profile[]>(KEY_PROFILES, []);
	}

	private save(profiles: Profile[]): Thenable<void> {
		return this.memento.update(KEY_PROFILES, profiles);
	}

	list(): Profile[] {
		return this.all();
	}

	activeId(): string {
		return this.memento.get<string>(KEY_ACTIVE, '');
	}

	setActive(id: string): Thenable<void> {
		return this.memento.update(KEY_ACTIVE, id);
	}

	get(id: string): Profile | undefined {
		return this.all().find(p => p.id === id);
	}

	active(): Profile | undefined {
		return this.get(this.activeId());
	}

	/** Crea un profilo (e lo rende attivo se non ce n'è uno). Ritorna il profilo creato. */
	async create(name: string): Promise<Profile> {
		const profiles = this.all();
		const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'utente';
		let id = base;
		let n = 1;
		while (profiles.some(p => p.id === id)) {
			id = `${base}-${++n}`;
		}
		const profile: Profile = { id, name: name.trim() || 'Utente', facts: '' };
		profiles.push(profile);
		await this.save(profiles);
		if (!this.activeId()) {
			await this.setActive(id);
		}
		return profile;
	}

	/** Garantisce l'esistenza di un profilo con un dato id/nome (usato da Telegram per chatId). */
	async ensure(id: string, name: string): Promise<Profile> {
		const existing = this.get(id);
		if (existing) {
			return existing;
		}
		const profiles = this.all();
		const profile: Profile = { id, name: name.trim() || id, facts: '' };
		profiles.push(profile);
		await this.save(profiles);
		if (!this.activeId()) {
			await this.setActive(id);
		}
		return profile;
	}

	/** Aggiunge un fatto al profilo, evitando duplicati banali. */
	async appendFact(id: string, fact: string): Promise<void> {
		const clean = fact.trim().replace(/^[-*]\s*/, '');
		if (!clean) {
			return;
		}
		const profiles = this.all();
		const p = profiles.find(x => x.id === id);
		if (!p) {
			return;
		}
		const lines = p.facts.split('\n').map(l => l.trim()).filter(Boolean);
		if (lines.some(l => l.replace(/^[-*]\s*/, '').toLowerCase() === clean.toLowerCase())) {
			return;
		}
		lines.push(`- ${clean}`);
		p.facts = lines.join('\n');
		await this.save(profiles);
	}

	/** Sostituisce i fatti del profilo (usato dal consolidamento). */
	async setFacts(id: string, facts: string): Promise<void> {
		const profiles = this.all();
		const p = profiles.find(x => x.id === id);
		if (!p) {
			return;
		}
		p.facts = facts.trim();
		await this.save(profiles);
	}

	async rename(id: string, name: string): Promise<void> {
		const profiles = this.all();
		const p = profiles.find(x => x.id === id);
		if (p) {
			p.name = name.trim() || p.name;
			await this.save(profiles);
		}
	}

	/** Blocco markdown del profilo attivo da iniettare nel system prompt, o '' se vuoto. */
	contextBlock(): string {
		const p = this.active();
		if (!p || !p.facts.trim()) {
			return '';
		}
		return `## Profilo utente: ${p.name}\nPreferenze apprese su questa persona — tienine conto e adatta le risposte:\n${p.facts.trim()}`;
	}
}
