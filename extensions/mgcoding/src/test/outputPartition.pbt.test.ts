/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test (fast-check) per il partizionamento totale in immagini/video.
 *  Eseguibile con: node out/test/outputPartition.pbt.test.js
 *
 *  Design > Correctness Properties
 *  ### Property 17: Partizionamento totale di output ed elenchi in immagini e video
 *  "Per ogni insieme di elementi (output di esecuzione o file di una cartella), il
 *   partizionamento in immagini e video copre tutti gli elementi con estensione/descrittore di
 *   media noto, senza perdite né duplicazioni, e ogni elemento è assegnato alla categoria
 *   coerente con la sua estensione/descrittore."
 *  **Validates: Requirements 6.4, 7.1**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
	OutputDescriptor,
	classifyOutput,
	classifyFile,
	partitionOutputs,
	partitionFiles,
} from '../media/outputClassifier';

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

// Estensioni di immagine note (statiche a livello di solo nome file).
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'];
// Estensioni di per sé video oppure animazioni (gif) a livello di solo nome file.
const VIDEO_EXTS = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'flv', 'gifv', 'gif'];
// Estensioni non multimediali: escluse da entrambe le categorie nel partizionamento file.
const NON_MEDIA_EXTS = ['txt', 'json', 'bin', 'log', 'safetensors', 'gguf'];

// class_type che identificano nodi di output video (riconosciuti da isVideoOutputNode).
const VIDEO_NODE_TYPES = [
	'VHS_VideoCombine', 'VideoCombine', 'SaveVideo', 'CreateVideo',
	'SaveAnimatedWEBP', 'SaveAnimatedPNG', 'SaveWEBM', 'SaveGIF',
];
const NON_VIDEO_NODE_TYPES = [
	'SaveImage', 'PreviewImage', 'KSampler', 'VAEDecode', 'CheckpointLoaderSimple',
];

// Genera uno "stem" non vuoto e privo di separatori/punti, per costruire nomi file prevedibili.
const stemArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);

// A volte applica una variazione di maiuscole all'estensione per coprire la case-insensitivity.
function casing(ext: string): fc.Arbitrary<string> {
	return fc.constantFrom(ext, ext.toUpperCase());
}

const anyExt = fc.oneof(
	fc.constantFrom(...IMAGE_EXTS).chain(casing),
	fc.constantFrom(...VIDEO_EXTS).chain(casing),
	fc.constantFrom(...NON_MEDIA_EXTS).chain(casing),
);

// Nome file: stem + estensione, con prefisso di cartella facoltativo (separatori misti).
const filenameArb: fc.Arbitrary<string> = fc.tuple(
	fc.option(fc.constantFrom('', 'out/', 'a\\b/', 'sub\\'), { nil: '' }),
	stemArb,
	fc.oneof(anyExt, fc.constant('')), // '' = nessuna estensione
).map(([prefix, stem, ext]) => (ext ? `${prefix}${stem}.${ext}` : `${prefix}${stem}`));

// Descrittore di output: nome file + nodo facoltativo + flag animated facoltativo.
const outputDescriptorArb: fc.Arbitrary<OutputDescriptor> = fc.record({
	filename: filenameArb,
	nodeClassType: fc.option(
		fc.constantFrom(...VIDEO_NODE_TYPES, ...NON_VIDEO_NODE_TYPES),
		{ nil: undefined },
	),
	animated: fc.option(fc.boolean(), { nil: undefined }),
});

test('Property 17a: partitionFiles copre i media noti senza perdite né duplicazioni', () => {
	fc.assert(
		fc.property(fc.array(filenameArb, { minLength: 0, maxLength: 20 }), (files) => {
			const { images, videos } = partitionFiles(files);

			// Coerenza di categoria: ogni elemento è nella categoria del suo classifyFile.
			for (const f of images) {
				assert.strictEqual(classifyFile(f), 'image',
					`'${f}' è tra le immagini ma classifyFile non è 'image'`);
			}
			for (const f of videos) {
				assert.strictEqual(classifyFile(f), 'video',
					`'${f}' è tra i video ma classifyFile non è 'video'`);
			}

			// Copertura totale + nessuna perdita + nessuna duplicazione: il risultato (in ordine)
			// coincide esattamente con il filtraggio dell'input per categoria.
			assert.deepStrictEqual(images, files.filter(f => classifyFile(f) === 'image'));
			assert.deepStrictEqual(videos, files.filter(f => classifyFile(f) === 'video'));

			// I file non multimediali sono esclusi: somma categorie = numero di media noti.
			const knownMedia = files.filter(f => classifyFile(f) !== undefined).length;
			assert.strictEqual(images.length + videos.length, knownMedia,
				'la somma delle categorie deve coincidere coi media noti (no perdite/duplicazioni)');
		}),
		{ numRuns: 300 },
	);
});

test('Property 17b: partitionOutputs assegna ogni output a esattamente una categoria', () => {
	fc.assert(
		fc.property(fc.array(outputDescriptorArb, { minLength: 0, maxLength: 20 }), (outputs) => {
			const { images, videos } = partitionOutputs(outputs);

			// Coerenza di categoria con classifyOutput.
			for (const o of images) {
				assert.strictEqual(classifyOutput(o), 'image',
					`output '${o.filename}' è tra le immagini ma classifyOutput non è 'image'`);
			}
			for (const o of videos) {
				assert.strictEqual(classifyOutput(o), 'video',
					`output '${o.filename}' è tra i video ma classifyOutput non è 'video'`);
			}

			// Copertura totale: ogni descrittore ha un descrittore noto (video|image), quindi
			// nessun output è perso e nessuno è duplicato.
			assert.deepStrictEqual(images, outputs.filter(o => classifyOutput(o) === 'image'));
			assert.deepStrictEqual(videos, outputs.filter(o => classifyOutput(o) === 'video'));
			assert.strictEqual(images.length + videos.length, outputs.length,
				'ogni output deve comparire in esattamente una categoria (copertura totale)');
		}),
		{ numRuns: 300 },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
