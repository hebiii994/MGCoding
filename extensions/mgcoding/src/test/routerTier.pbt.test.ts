/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test del routing esteso (`chooseProvider` con RouteResult).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/routerTier.pbt.test.js
 *
 *  Copre le proprietà di correttezza 22-27 del design (Provider_Router con consapevolezza
 *  di tier di capacità, GLM/cloud heavy e costo). Ogni proprietà è verificata da UN solo
 *  property-based test con >= 200 iterazioni.
 *--------------------------------------------------------------------------------------------*/

// Lo stub di `vscode` DEVE essere importato prima del modulo sotto test (vedi vscodeStub.ts).
import './vscodeStub';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { chooseProvider, ProviderDescriptor, RouteConfig, RouteContext } from '../llm/registry';
import { CapabilityTier } from '../llm/types';

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

// --- Utility condivise dai generatori e dalle asserzioni ------------------------------------

/** Identificatore di provider arbitrario non vuoto. */
const arbId: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 6 });

/** Tier di capacità arbitrario. */
const arbTier: fc.Arbitrary<CapabilityTier> = fc.constantFrom<CapabilityTier>('textual', 'structured', 'native');

/** Rango ordinale del tier (replica della logica pura, per le asserzioni). */
const tierRank = (t?: CapabilityTier): number => (t === 'native' ? 2 : t === 'structured' ? 1 : 0);
/** Tier effettivo: locali senza dichiarazione → textual, cloud senza dichiarazione → native. */
const effectiveTier = (d: ProviderDescriptor): CapabilityTier => d.maxTier ?? (d.local ? 'textual' : 'native');
/** Miglior candidato per capacità: il primo con tier effettivo massimo (deterministico). */
const bestByTier = (list: readonly ProviderDescriptor[]): ProviderDescriptor =>
	list.reduce((best, d) => (tierRank(effectiveTier(d)) > tierRank(effectiveTier(best)) ? d : best));

// =============================================================================================
//  Property 22: Local-first restringe ai provider locali
//  Per ogni insieme di descrittori in cui esiste almeno un provider locale disponibile, con
//  `localFirst` attivo il provider scelto è locale.
//  **Validates: Requirements 10.1**
// =============================================================================================

/** Descrittore arbitrario completo (tutti i flag liberi). */
const arbDescriptor: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: arbId,
	available: fc.boolean(),
	local: fc.boolean(),
	vision: fc.boolean(),
	maxTier: fc.option(arbTier, { nil: undefined }),
	paid: fc.boolean(),
	free: fc.boolean(),
});
const arbDescriptors: fc.Arbitrary<ProviderDescriptor[]> = fc.array(arbDescriptor, { maxLength: 6 });

test('Property 22: con localFirst e un locale disponibile la scelta è locale (Req. 10.1)', () => {
	fc.assert(
		fc.property(arbDescriptors, fc.constantFrom<'light' | 'heavy'>('light', 'heavy'), (descriptors, complexity) => {
			// hasImages false: il filtro vision è ortogonale e qui non deve restringere l'insieme.
			const ctx: RouteContext = { hasImages: false, complexity, localFirst: true };
			const chosen = chooseProvider(descriptors, ctx).provider;
			const availableLocals = descriptors.filter(d => d.available && d.local);
			if (availableLocals.length > 0) {
				assert.ok(chosen !== undefined, 'con un locale disponibile deve restituire un provider');
				assert.ok(chosen.local, 'con localFirst e un locale disponibile la scelta deve essere locale');
				assert.ok(chosen.available, 'la scelta locale deve comunque essere disponibile');
			}
		}),
		{ numRuns: RUNS }
	);
});

// =============================================================================================
//  Property 23: Catena di ripiego per le richieste heavy senza locale adeguato
//  Senza alcun locale che raggiunge `requiredTier` per una richiesta `heavy`: se esiste un
//  cloud gratuito adeguato viene scelto quello; altrimenti, se è disponibile un cloud
//  heavy/GLM viene scelto quello con `fallbackReason` valorizzato; altrimenti viene scelto il
//  miglior locale con `degradedLocal === true`.
//  **Validates: Requirements 8.6, 8.7, 10.2**
// =============================================================================================

// Locale sempre inadeguato per requiredTier = 'native' (tier < native), disponibile.
const arbInadequateLocal: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: arbId,
	available: fc.constant(true),
	local: fc.constant(true),
	vision: fc.constant(false),
	maxTier: fc.constantFrom<CapabilityTier>('textual', 'structured'),
	paid: fc.constant(false),
	free: fc.constant(false),
});
// Cloud sempre adeguato (maxTier undefined ⇒ tier effettivo 'native'), disponibile.
const arbAdequateCloud: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: arbId,
	available: fc.constant(true),
	local: fc.constant(false),
	vision: fc.boolean(),
	maxTier: fc.constant<CapabilityTier | undefined>(undefined),
	paid: fc.boolean(),
	free: fc.boolean(),
});

test('Property 23: ripiego heavy senza locale adeguato → free cloud / heavy cloud motivato / locale degradato (Req. 8.6, 8.7, 10.2)', () => {
	fc.assert(
		fc.property(
			fc.array(arbInadequateLocal, { maxLength: 4 }),
			fc.array(arbAdequateCloud, { maxLength: 4 }),
			(locals, clouds) => {
				const all = [...locals, ...clouds];
				// Senza alcun provider disponibile la proprietà non si applica (vedi Property 27).
				fc.pre(all.length > 0);
				// localFirst false ⇒ niente local-first vincolante (verificato in Property 22).
				const ctx: RouteContext = { hasImages: false, complexity: 'heavy', localFirst: false, requiredTier: 'native' };
				const res = chooseProvider(all, ctx);
				// Nessun locale raggiunge 'native' per costruzione: vale la catena di ripiego.
				const freeAdequate = all.find(d => !d.local && d.free === true); // i cloud sono tutti adeguati
				if (freeAdequate) {
					assert.strictEqual(res.provider, freeAdequate, 'deve scegliere il primo cloud gratuito adeguato');
				} else if (all.some(d => !d.local)) {
					assert.ok(res.provider !== undefined && !res.provider.local, 'deve ripiegare su un cloud heavy');
					assert.ok(!!res.fallbackReason && res.fallbackReason.length > 0, 'il ripiego cloud heavy deve essere motivato');
				} else {
					// Solo locali inadeguati: si sceglie il miglior locale, segnalando il degrado.
					assert.ok(res.provider !== undefined && res.provider.local, 'senza cloud deve scegliere un locale');
					assert.strictEqual(res.degradedLocal, true, 'il locale insufficiente deve essere marcato degradedLocal');
					assert.strictEqual(res.provider, bestByTier(locals), 'deve scegliere il miglior locale per capacità');
				}
			}
		),
		{ numRuns: RUNS }
	);
});

// =============================================================================================
//  Property 24: Instradamento heavy verso GLM designato
//  Con `autoRoute` attivo, GLM disponibile e designato come provider heavy, una richiesta
//  `heavy` (senza local-first vincolante) seleziona GLM.
//  **Validates: Requirements 8.5**
// =============================================================================================

// Descrittore "altro" che NON è mai un cloud gratuito (per non scavalcare GLM) né l'id 'glm'.
const arbNonGlm: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: arbId.filter(s => s !== 'glm'),
	available: fc.boolean(),
	local: fc.boolean(),
	vision: fc.boolean(),
	maxTier: fc.option(arbTier, { nil: undefined }),
	paid: fc.boolean(),
	free: fc.constant(false),
});
const arbGlm: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: fc.constant('glm'),
	available: fc.constant(true),
	local: fc.constant(false),
	vision: fc.constant(true),
	maxTier: fc.constant<CapabilityTier | undefined>(undefined),
	paid: fc.constant(true),
	free: fc.constant(false),
});

test('Property 24: una richiesta heavy con autoRoute e GLM designato heavy seleziona GLM (Req. 8.5)', () => {
	fc.assert(
		fc.property(
			arbGlm,
			fc.array(arbNonGlm, { maxLength: 5 }),
			fc.option(arbTier, { nil: undefined }),
			arbId,
			(glm, others, requiredTier, lightId) => {
				const all = [glm, ...others];
				const route: RouteConfig = { heavyId: 'glm', lightId, autoRoute: true };
				// localFirst false: nessun cloud gratuito presente ⇒ GLM non viene scavalcato.
				const ctx: RouteContext = { hasImages: false, complexity: 'heavy', localFirst: false, requiredTier };
				const chosen = chooseProvider(all, ctx, route).provider;
				assert.ok(chosen !== undefined, 'deve restituire un provider');
				assert.strictEqual(chosen.id, 'glm', 'la richiesta heavy deve essere instradata su GLM');
			}
		),
		{ numRuns: RUNS }
	);
});

// =============================================================================================
//  Property 25: Preferenza per il cloud gratuito rispetto a quello a pagamento
//  Quando è disponibile un cloud gratuito con tier adeguato, sia per le richieste `light` sia
//  per le `heavy` il router preferisce il cloud gratuito a quello a pagamento.
//  **Validates: Requirements 10.4, 10.5**
// =============================================================================================

const arbFreeCloud: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: arbId,
	available: fc.constant(true),
	local: fc.constant(false),
	vision: fc.boolean(),
	maxTier: fc.constant<CapabilityTier | undefined>(undefined), // 'native' ⇒ sempre adeguato
	paid: fc.constant(false),
	free: fc.constant(true),
});

test('Property 25: con un cloud gratuito adeguato il router lo preferisce al cloud a pagamento (Req. 10.4, 10.5)', () => {
	fc.assert(
		fc.property(
			arbFreeCloud,
			fc.array(arbDescriptor, { maxLength: 5 }),
			fc.constantFrom<'light' | 'heavy'>('light', 'heavy'),
			(freeCloud, others, complexity) => {
				const all = [...others, freeCloud];
				// requiredTier indefinito ⇒ il cloud gratuito è adeguato; localFirst false per isolare il costo.
				const ctx: RouteContext = { hasImages: false, complexity, localFirst: false };
				const chosen = chooseProvider(all, ctx).provider;
				assert.ok(chosen !== undefined, 'deve restituire un provider');
				assert.ok(!chosen.local, 'la scelta deve essere un provider cloud');
				assert.strictEqual(chosen.free, true, 'deve preferire il cloud gratuito a quello a pagamento');
			}
		),
		{ numRuns: RUNS }
	);
});

// =============================================================================================
//  Property 26: Il ripiego al cloud a pagamento sotto local-first è motivato
//  Per ogni instradamento che, con `localFirst` attivo, seleziona un cloud a pagamento,
//  `RouteResult.fallbackReason` è non vuoto.
//  **Validates: Requirements 10.3**
// =============================================================================================

const arbRoute: fc.Arbitrary<RouteConfig | undefined> = fc.option(
	fc.record({ heavyId: arbId, lightId: arbId, autoRoute: fc.boolean() }),
	{ nil: undefined }
);

test('Property 26: con localFirst, se si sceglie un cloud a pagamento il ripiego è motivato (Req. 10.3)', () => {
	fc.assert(
		fc.property(
			arbDescriptors,
			fc.constantFrom<'light' | 'heavy'>('light', 'heavy'),
			fc.option(arbTier, { nil: undefined }),
			arbRoute,
			(descriptors, complexity, requiredTier, route) => {
				const ctx: RouteContext = { hasImages: false, complexity, localFirst: true, requiredTier };
				const res = chooseProvider(descriptors, ctx, route);
				if (res.provider && !res.provider.local && res.provider.paid === true) {
					assert.ok(!!res.fallbackReason && res.fallbackReason.length > 0, 'il ripiego al cloud a pagamento sotto local-first deve essere motivato');
				}
			}
		),
		{ numRuns: RUNS }
	);
});

// =============================================================================================
//  Property 27: Nessun provider disponibile produce assenza di provider
//  Per ogni insieme di descrittori tutti non disponibili, `chooseProvider` restituisce un
//  `RouteResult` con `provider === undefined` e `fallbackReason` valorizzato.
//  **Validates: Requirements 9.5**
// =============================================================================================

// Descrittore mai disponibile (available fissato a false).
const arbUnavailable: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: arbId,
	available: fc.constant(false),
	local: fc.boolean(),
	vision: fc.boolean(),
	maxTier: fc.option(arbTier, { nil: undefined }),
	paid: fc.boolean(),
	free: fc.boolean(),
});

test('Property 27: senza alcun provider disponibile il risultato è provider undefined con motivo (Req. 9.5)', () => {
	fc.assert(
		fc.property(
			fc.array(arbUnavailable, { maxLength: 6 }),
			fc.constantFrom<'light' | 'heavy'>('light', 'heavy'),
			fc.boolean(),
			(descriptors, complexity, localFirst) => {
				const ctx: RouteContext = { hasImages: false, complexity, localFirst };
				const res = chooseProvider(descriptors, ctx);
				assert.strictEqual(res.provider, undefined, 'senza provider disponibili non deve esserci un provider');
				assert.ok(!!res.fallbackReason && res.fallbackReason.length > 0, 'l\'assenza di provider deve essere motivata');
			}
		),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
