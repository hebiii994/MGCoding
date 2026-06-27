/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test del Router_LLM (logica pura `chooseProvider`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/routerVision.pbt.test.js
 *
 *  Property 6: Con immagini si sceglie un modello vision quando disponibile
 *  Per ogni lista di provider e una richiesta che include immagini (`hasImages = true`),
 *  se almeno un provider disponibile dichiara capacità vision allora il provider selezionato
 *  ha capacità vision.
 *
 *  Per isolare questa proprietà neutralizziamo il filtro che precede il vision nella
 *  precedenza di `chooseProvider` (vedi registry.ts):
 *   - `localFirst = false`  → il passo 2 (local-first) non restringe i candidati prima
 *     del passo 3 (vision), così che il filtro vision agisca sull'intero insieme dei
 *     provider disponibili.
 *  Il passo 4 (auto-route) opera sui soli candidati già filtrati per vision, quindi non
 *  può scegliere un provider privo di vision: la `RouteConfig` resta perciò arbitraria.
 *
 *  **Validates: Requirements 2.3**
 *--------------------------------------------------------------------------------------------*/

// Lo stub di `vscode` DEVE essere importato prima del modulo sotto test (vedi vscodeStub.ts).
import './vscodeStub';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { chooseProvider, ProviderDescriptor, RouteConfig, RouteContext } from '../llm/registry';

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

/** Descrittore di provider con flag di disponibilità/località/vision arbitrari. */
const arbDescriptor: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: fc.string({ minLength: 1, maxLength: 8 }),
	available: fc.boolean(),
	local: fc.boolean(),
	vision: fc.boolean(),
});

/** Insieme di descrittori (anche vuoto): l'ordine e gli id arbitrari sono ammessi. */
const arbDescriptors: fc.Arbitrary<ProviderDescriptor[]> = fc.array(arbDescriptor, { maxLength: 6 });

/**
 * Contesto di instradamento con `hasImages` fissato a true (la richiesta include immagini)
 * e `localFirst` fissato a false per isolare il filtro vision dal local-first.
 * `complexity` e `hint` restano arbitrari.
 */
const arbContext: fc.Arbitrary<RouteContext> = fc.record({
	hint: fc.option(fc.string(), { nil: undefined }),
	hasImages: fc.constant(true),
	complexity: fc.constantFrom<'light' | 'heavy'>('light', 'heavy'),
	localFirst: fc.constant(false),
});

/** Configurazione di auto-route opzionale (può anche essere assente). */
const arbRoute: fc.Arbitrary<RouteConfig | undefined> = fc.option(
	fc.record({
		heavyId: fc.string({ minLength: 1, maxLength: 8 }),
		lightId: fc.string({ minLength: 1, maxLength: 8 }),
		autoRoute: fc.boolean(),
	}),
	{ nil: undefined }
);

// --- Property 6: con immagini, se esiste un disponibile vision la scelta è vision ----------
test('Property 6: con immagini e un provider vision disponibile la scelta ha capacità vision', () => {
	fc.assert(
		fc.property(arbDescriptors, arbContext, arbRoute, (descriptors, ctx, route) => {
			// La nuova firma restituisce un RouteResult: si legge `.provider`.
			const chosen = chooseProvider(descriptors, ctx, route).provider;
			const availableVision = descriptors.filter(d => d.available && d.vision);
			if (availableVision.length > 0) {
				assert.ok(chosen !== undefined, 'con un provider vision disponibile deve restituire un provider');
				assert.ok(chosen.available, 'la scelta deve comunque essere disponibile');
				assert.ok(chosen.vision, 'con immagini e un vision disponibile la scelta deve avere capacità vision');
			}
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
