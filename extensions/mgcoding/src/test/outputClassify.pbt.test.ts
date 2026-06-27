/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per la classificazione degli output in
 *  video/immagine. Eseguibile con: node out/test/outputClassify.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 15: Classificazione degli output in video/immagine
 *  "Per ogni descrittore di output di esecuzione, l'output è classificato come video se e solo
 *   se proviene da un nodo di combinazione video o è un formato animato (WEBP/GIF animato,
 *   mp4, ecc.); altrimenti è classificato come immagine."
 *  **Validates: Requirements 6.1, 6.2**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { classifyOutput, OutputDescriptor, isVideoOutputNode } from '../media/outputClassifier';

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

// --- Insiemi di estensioni allineati a outputClassifier.ts -----------------------------------
// Estensioni che sono di per sé formati video (PURE_VIDEO_EXTENSIONS).
const PURE_VIDEO_EXTS = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'flv', 'gifv'];
// Estensioni sempre animate => video (ANIMATION_EXTENSIONS).
const ANIMATION_EXTS = ['gif'];
// Estensioni animabili: video SOLO se marcate `animated` (ANIMATABLE_IMAGE_EXTENSIONS).
const ANIMATABLE_IMAGE_EXTS = ['webp', 'png'];
// Estensioni di immagine statica NON animabili (sottoinsieme di IMAGE_EXTENSIONS \ animabili).
const STATIC_IMAGE_EXTS = ['jpg', 'jpeg', 'bmp', 'tif', 'tiff'];
// Estensioni non multimediali / assenza di estensione (devono risultare immagine, salvo nodo video).
const NON_MEDIA_EXTS = ['txt', 'json', 'bin', 'log', ''];

// --- class_type allineati a VIDEO_OUTPUT_NODE_PATTERNS di outputClassifier.ts ----------------
const VIDEO_OUTPUT_CLASS_TYPES = [
	'VHS_VideoCombine', 'VideoCombine', 'SaveVideo', 'CreateVideo',
	'SaveAnimatedWEBP', 'SaveAnimatedPNG', 'SaveWEBM', 'SaveGIF',
];
const NON_VIDEO_CLASS_TYPES = [
	'CheckpointLoaderSimple', 'KSampler', 'CLIPTextEncode',
	'VAEDecode', 'SaveImage', 'PreviewImage', 'LoadImage', 'EmptyLatentImage',
];

// Etichetta del nodo: undefined, oppure un class_type video, oppure uno non video.
const nodeArb = fc.oneof(
	fc.constant<{ classType: string | undefined; isVideoNode: boolean }>({ classType: undefined, isVideoNode: false }),
	fc.constantFrom(...VIDEO_OUTPUT_CLASS_TYPES).map(ct => ({ classType: ct, isVideoNode: true })),
	fc.constantFrom(...NON_VIDEO_CLASS_TYPES).map(ct => ({ classType: ct, isVideoNode: false })),
);

// Categoria dell'estensione, con l'estensione canonica (lowercase) usata per il calcolo atteso.
type ExtCategory = 'pureVideo' | 'animation' | 'animatable' | 'staticImage' | 'nonMedia';
const extArb: fc.Arbitrary<{ ext: string; category: ExtCategory }> = fc.oneof(
	fc.constantFrom(...PURE_VIDEO_EXTS).map(ext => ({ ext, category: 'pureVideo' as ExtCategory })),
	fc.constantFrom(...ANIMATION_EXTS).map(ext => ({ ext, category: 'animation' as ExtCategory })),
	fc.constantFrom(...ANIMATABLE_IMAGE_EXTS).map(ext => ({ ext, category: 'animatable' as ExtCategory })),
	fc.constantFrom(...STATIC_IMAGE_EXTS).map(ext => ({ ext, category: 'staticImage' as ExtCategory })),
	fc.constantFrom(...NON_MEDIA_EXTS).map(ext => ({ ext, category: 'nonMedia' as ExtCategory })),
);

// Base name senza punti né separatori di percorso, così l'estensione resta prevedibile.
const baseNameArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);

// Casing della stringa estensione nel filename (il classificatore normalizza in minuscolo).
function applyCasing(ext: string, upper: boolean): string {
	return upper ? ext.toUpperCase() : ext;
}

const descriptorArb: fc.Arbitrary<{ desc: OutputDescriptor; expected: 'video' | 'image' }> = fc
	.record({
		base: baseNameArb,
		extInfo: extArb,
		node: nodeArb,
		animated: fc.boolean(),
		upperExt: fc.boolean(),
		includeAnimated: fc.boolean(),
	})
	.map(({ base, extInfo, node, animated, upperExt, includeAnimated }) => {
		const { ext, category } = extInfo;
		const filename = ext.length > 0 ? `${base}.${applyCasing(ext, upperExt)}` : base;

		const desc: OutputDescriptor = { filename };
		if (node.classType !== undefined) {
			desc.nodeClassType = node.classType;
		}
		// `animated` viene incluso solo a volte per coprire anche il caso "assente".
		if (includeAnimated) {
			desc.animated = animated;
		}
		const isAnimated = includeAnimated && animated;

		// Calcolo ATTESO indipendente dall'implementazione, derivato dalle etichette:
		// video sse nodo video OPPURE estensione di per sé video/animata OPPURE
		// estensione animabile marcata animated.
		const expectedVideo =
			node.isVideoNode ||
			category === 'pureVideo' ||
			category === 'animation' ||
			(category === 'animatable' && isAnimated);

		return { desc, expected: expectedVideo ? 'video' : 'image' as 'video' | 'image' };
	});

test('Property 15: classifyOutput è video sse nodo video o formato animato/video, altrimenti image', () => {
	fc.assert(
		fc.property(descriptorArb, ({ desc, expected }) => {
			const result = classifyOutput(desc);

			// Bicondizionale rispetto all'etichetta usata per costruire il descrittore.
			assert.strictEqual(result, expected,
				`classifyOutput deve restituire ${expected} per ${JSON.stringify(desc)}`);

			// Coerenza: ogni output è classificato esattamente come video oppure image.
			assert.ok(result === 'video' || result === 'image',
				`risultato inatteso: ${result}`);

			// Se proviene da un nodo di output video, è sempre video (Req 6.1).
			if (isVideoOutputNode(desc.nodeClassType)) {
				assert.strictEqual(result, 'video',
					'un output da nodo di output video deve essere classificato come video');
			}
		}),
		{ numRuns: 300 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
