/*---------------------------------------------------------------------------------------------
 *  MGCoding - Capability_Detector (nucleo puro + cache di sessione)
 *
 *  Classifica ogni modello in un Capability_Tier (`native` / `structured` / `textual`)
 *  senza fidarsi della sola capability `tools` dichiarata da /api/show: il tier `native`
 *  è concesso solo dopo il superamento di un test di verifica funzionale del tool-use.
 *
 *  Questo modulo è PURO: nessuna dipendenza da `vscode`, da `fetch` o dal filesystem.
 *  Il guscio I/O (probe funzionale) vive in OllamaProvider e delega qui le decisioni.
 *--------------------------------------------------------------------------------------------*/

/**
 * Classe di capacità assegnata a un modello:
 *  - `native`: tool-use nativo affidabile;
 *  - `structured`: richiede grammatica/JSON vincolato;
 *  - `textual`: richiede il protocollo testuale `mg-tool` con scaffolding.
 */
export type CapabilityTier = 'native' | 'structured' | 'textual';

/** Ordinamento dei tier dal più capace al meno capace. */
const TIER_ORDER: readonly CapabilityTier[] = ['native', 'structured', 'textual'];

export interface TierInputs {
	/** Capability "tools" dichiarata da /api/show. */
	declaresTools: boolean;
	/** Esito del test di verifica funzionale del tool-use (undefined = non eseguito). */
	functionalProbePassed?: boolean;
	/** Override esplicito mgcoding.model.capabilityTier per il modello. */
	configOverride?: CapabilityTier;
}

/**
 * Logica PURA di classificazione (Req. 3.1-3.3, 3.5):
 *  - configOverride, se presente, vince e salta la probe (Req. 3.5);
 *  - 'native' SOLO se functionalProbePassed === true (Req. 3.2);
 *  - se declaresTools ma probe fallita → al massimo 'structured' (Req. 3.3);
 *  - altrimenti 'textual'.
 */
export function classifyTier(inputs: TierInputs): CapabilityTier {
	// L'override di configurazione ha sempre la precedenza e salta la probe (Req. 3.5).
	if (inputs.configOverride !== undefined) {
		return inputs.configOverride;
	}
	// 'native' è concesso solo dopo il superamento della probe funzionale (Req. 3.2).
	if (inputs.functionalProbePassed === true) {
		return 'native';
	}
	// Un modello che dichiara `tools` ma fallisce/salta la probe è al massimo 'structured'
	// (Req. 3.3): mai 'native' senza prova funzionale.
	if (inputs.declaresTools) {
		return 'structured';
	}
	// Nessuna capacità di tool dichiarata né provata: percorso testuale.
	return 'textual';
}

/** Declassa un tier di un livello: native→structured→textual (Req. 9.6). */
export function downgradeTier(tier: CapabilityTier): CapabilityTier {
	const index = TIER_ORDER.indexOf(tier);
	// Non scende mai sotto 'textual' (idempotente al minimo).
	const next = Math.min(index + 1, TIER_ORDER.length - 1);
	return TIER_ORDER[next];
}

/** Cache per-sessione tier↔modello (Req. 3.4). */
export class CapabilityCache {
	private readonly tiers = new Map<string, CapabilityTier>();

	/** Restituisce il tier in cache per il modello, o undefined se assente. */
	get(model: string): CapabilityTier | undefined {
		return this.tiers.get(model);
	}

	/** Memorizza il tier per il modello per la durata della sessione (Req. 3.4). */
	set(model: string, tier: CapabilityTier): void {
		this.tiers.set(model, tier);
	}

	/**
	 * Declassa in cache il tier del modello per la sessione corrente (Req. 9.6).
	 * Se il modello non è ancora in cache, parte da 'native' prima di declassare.
	 * Restituisce il tier risultante.
	 */
	downgrade(model: string): CapabilityTier {
		const current = this.tiers.get(model) ?? 'native';
		const downgraded = downgradeTier(current);
		this.tiers.set(model, downgraded);
		return downgraded;
	}

	/** Svuota la cache (es. a fine sessione). */
	clear(): void {
		this.tiers.clear();
	}
}
