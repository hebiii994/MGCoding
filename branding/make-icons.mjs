/*
 * Genera gli asset icona di MGCoding da branding/mgcoding-icon.png
 * Output:
 *   resources/win32/code.ico          (icona app/eseguibile, multi-size)
 *   resources/win32/code_150x150.png  (tile installer)
 *   resources/win32/code_70x70.png    (tile installer)
 *   resources/linux/code.png          (512x512)
 *   extensions/mgcoding/media/icon.png (icona estensione, colore)
 *
 * Uso:  cd branding && npm install && node make-icons.mjs
 */
import { Jimp } from 'jimp';
import pngToIco from 'png-to-ico';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(here, 'mgcoding-icon.png');

if (!existsSync(src)) {
	console.error(`ERRORE: manca ${src}. Salva qui il PNG quadrato (>=512px).`);
	process.exit(1);
}

async function resizedPngBuffer(size) {
	const img = await Jimp.read(src);
	img.resize({ w: size, h: size });
	return await img.getBuffer('image/png');
}

async function writeResized(size, outPath) {
	const buf = await resizedPngBuffer(size);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, buf);
	console.log(`  scritto ${outPath} (${size}x${size})`);
}

async function main() {
	console.log('Genero asset icona MGCoding...');

	// .ico multi-size per Windows
	const icoSizes = [16, 24, 32, 48, 64, 128, 256];
	const buffers = [];
	for (const s of icoSizes) {
		buffers.push(await resizedPngBuffer(s));
	}
	const ico = await pngToIco(buffers);
	const icoPath = join(root, 'resources/win32/code.ico');
	writeFileSync(icoPath, ico);
	console.log(`  scritto ${icoPath} (.ico ${icoSizes.join(',')})`);

	// tile installer Windows
	await writeResized(150, join(root, 'resources/win32/code_150x150.png'));
	await writeResized(70, join(root, 'resources/win32/code_70x70.png'));

	// icona Linux + icona estensione
	await writeResized(512, join(root, 'resources/linux/code.png'));
	await writeResized(256, join(root, 'extensions/mgcoding/media/icon.png'));

	console.log('Fatto.');
}

main().catch(err => { console.error(err); process.exit(1); });
