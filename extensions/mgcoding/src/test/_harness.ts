/*---------------------------------------------------------------------------------------------
 *  MGCoding - mini-harness di test condiviso.
 *
 *  I file di test dell'estensione girano con node puro (`node out/test/<nome>.test.js`), senza
 *  un runner esterno. Storicamente ognuno reimplementava il proprio contatore `passed/failed`,
 *  la propria `test()` e l'IIFE finale con `process.exit(1)`. Questo modulo centralizza quel
 *  boilerplate: `test`/`testAsync` registrano i casi (sincroni o asincroni indifferentemente) e
 *  `run` li esegue in ordine, stampa il riepilogo e termina con codice ≠ 0 se qualcosa fallisce.
 *
 *  Uso tipico:
 *  ```ts
 *  import { test, run } from './_harness';
 *  test('somma', () => assert.strictEqual(1 + 1, 2));
 *  test('async', async () => { await Promise.resolve(); assert.ok(true); });
 *  void run();
 *  ```
 *
 *  NB: per i moduli che leggono `vscode` a load-time, importare PRIMA `./vscodeStub` (e usare
 *  `loadAfterMock`) — vedi la trappola documentata in `vscodeStub.ts`.
 *--------------------------------------------------------------------------------------------*/

/** Un caso di test: nome + funzione (sincrona o asincrona, indistintamente). */
interface TestCase {
	name: string;
	fn: () => void | Promise<void>;
}

const cases: TestCase[] = [];

/** Registra un caso di test. La funzione può essere sincrona o restituire una Promise. */
export function test(name: string, fn: () => void | Promise<void>): void {
	cases.push({ name, fn });
}

/** Alias esplicito per i casi asincroni (puramente documentale: `test` li gestisce già). */
export const testAsync = test;

/**
 * Esegue in sequenza tutti i casi registrati, stampando `ok`/`FAIL` per ciascuno e un riepilogo
 * finale. Se almeno un caso fallisce, termina il processo con codice 1 (così l'esito è visibile
 * a chi lancia la suite). Ritorna il conteggio per eventuali usi programmatici.
 */
export async function run(): Promise<{ passed: number; failed: number }> {
	let passed = 0;
	let failed = 0;
	for (const c of cases) {
		try {
			await c.fn();
			passed++;
			console.log(`ok   - ${c.name}`);
		} catch (e) {
			failed++;
			console.error(`FAIL - ${c.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
		}
	}
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
	return { passed, failed };
}
