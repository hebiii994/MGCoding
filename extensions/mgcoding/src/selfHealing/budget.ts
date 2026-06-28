/*---------------------------------------------------------------------------------------------
 *  MGCoding - Self_Healing: budget dei tentativi (nucleo puro).
 *  Ferma i cicli inutili: esaurimento del budget o assenza di progresso (Req. 8).
 *--------------------------------------------------------------------------------------------*/

import { AttemptDecision, AttemptState } from './types';

/**
 * Decide se continuare a tentare su una Issue (Req. 8.1, 8.2):
 *  - `stop-budget` se i tentativi hanno raggiunto il massimo (priorità sul progresso);
 *  - altrimenti `stop-no-progress` se gli errori non sono diminuiti (`errorsAfter >= errorsBefore`);
 *  - altrimenti `continue`.
 */
export function decideAttempt(state: AttemptState): AttemptDecision {
	if (state.attempts >= state.maxAttempts) {
		return 'stop-budget';
	}
	if (state.errorsAfter >= state.errorsBefore) {
		return 'stop-no-progress';
	}
	return 'continue';
}
