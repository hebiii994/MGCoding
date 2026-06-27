/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test della riduzione della cronologia (`reduceHistory`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/reduceHistory.pbt.test.js
 *
 *  Convenzione dei risultati tool: messaggi `user` il cui contenuto inizia con
 *  "Risultato del tool|comando <nome>" e contiene il marcatore d'esito OK/ERRORE.
 *  Il riassunto sintetizzato è prefissato da SUMMARY_PREFIX = '[Riassunto tool]'.
 *
 *  Proprietà coperte (una sola property-based test per proprietà):
 *   - Property 2: La riduzione rientra nel budget o segnala l'irriducibilità (Validates: 1.5, 4.5)
 *   - Property 5: I risultati tool recenti restano integri durante la riduzione (Validates: 4.3)
 *   - Property 6: Il riassunto conserva identità ed esito del tool (Validates: 4.4)
 *   - Property 7: Senza riassunto si applica solo il troncamento (Validates: 4.6)
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	reduceHistory,
	estimateMessagesTokens,
	SUMMARY_PREFIX,
	TRUNCATE_MAX_CHARS,
	TRUNCATE_NOTICE,
} from '../llm/contextManager';
import type { ChatMessage } from '../llm/types';

const RUNS = 200;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// --- Generatori ----------------------------------------------------------------------------

/** Nomi di tool: identificatori senza spazi (come li estrae `extractToolName`). */
const arbToolName = fc.constantFrom('echo', 'run_command', 'read_file', 'write_file', 'grep', 'list_dir');

/** Esito esplicito del tool: usato come marcatore d'esito nel risultato. */
const arbOutcome = fc.constantFrom<'OK' | 'ERRORE'>('OK', 'ERRORE');

/**
 * Corpo del risultato: solo minuscole/cifre/spazi, così da non introdurre per caso
 * i marcatori maiuscoli "OK"/"ERRORE" né il prefisso di riassunto.
 */
const arbBody = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')), {
	minLength: 0,
	maxLength: 1200,
});

/** Descrittore astratto di un messaggio, risolto in ChatMessage con marcatore univoco. */
type MsgSpec =
	| { kind: 'tool'; tool: string; outcome: 'OK' | 'ERRORE'; body: string }
	| { kind: 'plain'; role: ChatMessage['role']; body: string };

const arbToolSpec: fc.Arbitrary<MsgSpec> = fc.record({
	kind: fc.constant<'tool'>('tool'),
	tool: arbToolName,
	outcome: arbOutcome,
	body: arbBody,
});

const arbPlainSpec: fc.Arbitrary<MsgSpec> = fc.record({
	kind: fc.constant<'plain'>('plain'),
	role: fc.constantFrom<ChatMessage['role']>('user', 'assistant', 'system'),
	body: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')), { maxLength: 200 }),
});

const arbSpec: fc.Arbitrary<MsgSpec> = fc.oneof(arbToolSpec, arbPlainSpec);

/**
 * Trasforma una lista di MsgSpec in ChatMessage[] con contenuto univoco per indice
 * (suffisso "#i"), così da poter confrontare i messaggi per contenuto senza ambiguità.
 * I risultati tool seguono la convenzione "Risultato del tool <nome> <esito>: <corpo> #i".
 */
function buildMessages(specs: MsgSpec[]): ChatMessage[] {
	return specs.map((s, i) => {
		if (s.kind === 'tool') {
			return {
				role: 'user' as const,
				content: `Risultato del tool ${s.tool} ${s.outcome}: ${s.body} #${i}`,
			};
		}
		return { role: s.role, content: `${s.body} #${i}` };
	});
}

/** Vero se il messaggio è un risultato di tool secondo la convenzione. */
function isToolResultMsg(m: ChatMessage): boolean {
	return m.role === 'user' && /^Risultato del (?:tool|comando)\b/.test(m.content);
}

/** Indici dei risultati tool "recenti" protetti (gli ultimi keepRecent risultati). */
function recentToolContents(messages: ChatMessage[], keepRecent: number): string[] {
	const toolContents = messages.filter(isToolResultMsg).map(m => m.content);
	const from = Math.max(0, toolContents.length - keepRecent);
	return toolContents.slice(from);
}

const arbMessages = fc.array(arbSpec, { maxLength: 14 }).map(buildMessages);
const arbKeepRecent = fc.integer({ min: 1, max: 6 });

// --- Property 2: rientro nel budget o irriducibilità segnalata, ultimo utente preservato ----
// **Validates: Requirements 1.5, 4.5**
test('Property 2: la riduzione rientra nel budget oppure segnala stillOverBudget, preservando l\'ultimo utente', () => {
	fc.assert(
		fc.property(
			arbMessages,
			fc.integer({ min: 0, max: 4000 }),
			fc.boolean(),
			arbKeepRecent,
			(messages, historyBudget, summarize, keepRecent) => {
				// Ultimo messaggio utente dell'input (con keepRecent>=1 il suo contenuto è preservato).
				let lastUserContent: string | undefined;
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i].role === 'user') {
						lastUserContent = messages[i].content;
						break;
					}
				}

				const { messages: out, stillOverBudget } = reduceHistory({
					messages,
					historyBudget,
					summarize,
					keepRecent,
				});

				const tokens = estimateMessagesTokens(out);

				// La riduzione rientra nel budget OPPURE segnala l'irriducibilità (Req. 1.5, 4.5).
				assert.ok(
					tokens <= historyBudget || stillOverBudget === true,
					`fuori budget (${tokens} > ${historyBudget}) senza stillOverBudget`
				);

				// stillOverBudget è coerente con la stima finale.
				assert.strictEqual(
					stillOverBudget,
					tokens > historyBudget,
					'stillOverBudget incoerente con la stima dei token'
				);

				// L'ultimo messaggio utente non è mai rimosso (Req. 4.5).
				if (lastUserContent !== undefined) {
					const stillPresent = out.some(m => m.role === 'user' && m.content === lastUserContent);
					assert.ok(stillPresent, 'l\'ultimo messaggio utente non è stato preservato');
				}
			}
		),
		{ numRuns: RUNS }
	);
});

// --- Property 5: i keepRecent risultati tool più recenti restano integri byte-a-byte ---------
// **Validates: Requirements 4.3**
test('Property 5: i risultati tool recenti (keepRecent) restano integri durante la riduzione', () => {
	fc.assert(
		fc.property(
			arbMessages,
			fc.integer({ min: 0, max: 4000 }),
			fc.boolean(),
			arbKeepRecent,
			(messages, historyBudget, summarize, keepRecent) => {
				const expectedRecent = recentToolContents(messages, keepRecent);

				const { messages: out } = reduceHistory({ messages, historyBudget, summarize, keepRecent });

				// Ognuno dei risultati recenti deve comparire intatto nell'output.
				const outContents = out.map(m => m.content);
				for (const content of expectedRecent) {
					assert.ok(
						outContents.includes(content),
						`risultato tool recente alterato o rimosso: ${content.slice(0, 40)}…`
					);
				}
			}
		),
		{ numRuns: RUNS }
	);
});

// --- Property 6: il riassunto conserva identità (nome tool) ed esito (OK/ERRORE) ------------
// **Validates: Requirements 4.4**
test('Property 6: il riassunto dei risultati tool più vecchi conserva nome ed esito', () => {
	fc.assert(
		fc.property(arbMessages, arbKeepRecent, (messages, keepRecent) => {
			// Budget enorme: nessuna rimozione in fase 2, ma la fase 1 riassume comunque
			// i risultati tool non protetti, così possiamo ispezionarli per indice.
			const hugeBudget = 10_000_000;
			const { messages: out } = reduceHistory({
				messages,
				historyBudget: hugeBudget,
				summarize: true,
				keepRecent,
			});

			// Senza rimozioni l'output ha la stessa lunghezza e gli indici coincidono.
			assert.strictEqual(out.length, messages.length, 'la fase 2 non dovrebbe rimuovere con budget enorme');

			// Indici dei risultati tool e quelli protetti (gli ultimi keepRecent).
			const toolIdx = messages.map((m, i) => (isToolResultMsg(m) ? i : -1)).filter(i => i >= 0);
			const protectedFrom = Math.max(0, toolIdx.length - keepRecent);
			const protectedIdx = new Set(toolIdx.slice(protectedFrom));

			for (const i of toolIdx) {
				if (protectedIdx.has(i)) {
					continue; // i recenti restano integri (verificato dalla Property 5)
				}
				const original = messages[i].content;
				const summarized = out[i].content;
				// È un riassunto sintetizzato.
				assert.ok(summarized.startsWith(SUMMARY_PREFIX), `manca il prefisso di riassunto: ${summarized}`);
				// Conserva il nome del tool (token dopo l'intestazione).
				const tool = /^Risultato del tool (\S+)/.exec(original)![1];
				assert.ok(summarized.includes(tool), `il riassunto non contiene il nome del tool ${tool}`);
				// Conserva l'esito OK/ERRORE.
				const outcome = /Risultato del tool \S+ (OK|ERRORE)/.exec(original)![1];
				assert.ok(
					new RegExp(`\\b${outcome}\\b`).test(summarized),
					`il riassunto non contiene l'esito ${outcome}: ${summarized}`
				);
			}
		}),
		{ numRuns: RUNS }
	);
});

// --- Property 7: con summarize=false si applica solo il troncamento (niente riassunti) -------
// **Validates: Requirements 4.6**
test('Property 7: senza riassunto i risultati più vecchi sono solo troncati, mai sintetizzati', () => {
	fc.assert(
		fc.property(arbMessages, arbKeepRecent, (messages, keepRecent) => {
			const hugeBudget = 10_000_000;
			const { messages: out } = reduceHistory({
				messages,
				historyBudget: hugeBudget,
				summarize: false,
				keepRecent,
			});

			assert.strictEqual(out.length, messages.length, 'la fase 2 non dovrebbe rimuovere con budget enorme');

			// Nessun marcatore di riassunto sintetizzato viene mai aggiunto (Req. 4.6).
			for (const m of out) {
				assert.ok(!m.content.includes(SUMMARY_PREFIX), `marcatore di riassunto inatteso: ${m.content}`);
			}

			// I risultati tool non protetti più lunghi della soglia risultano troncati.
			const toolIdx = messages.map((m, i) => (isToolResultMsg(m) ? i : -1)).filter(i => i >= 0);
			const protectedFrom = Math.max(0, toolIdx.length - keepRecent);
			const protectedIdx = new Set(toolIdx.slice(protectedFrom));

			for (const i of toolIdx) {
				if (protectedIdx.has(i)) {
					continue;
				}
				const original = messages[i].content;
				const result = out[i].content;
				if (original.length > TRUNCATE_MAX_CHARS) {
					assert.ok(result.endsWith(TRUNCATE_NOTICE), `troncamento mancante: ${result.slice(-40)}`);
					assert.ok(
						result.length <= TRUNCATE_MAX_CHARS + TRUNCATE_NOTICE.length,
						'il risultato troncato supera la lunghezza attesa'
					);
				} else {
					assert.strictEqual(result, original, 'un risultato corto non dovrebbe cambiare');
				}
			}
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
