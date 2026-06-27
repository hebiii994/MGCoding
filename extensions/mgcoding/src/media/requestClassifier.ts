/*---------------------------------------------------------------------------------------------
 *  MGCoding - Orchestratore: classificatore di richieste di generazione.
 *  Logica PURA (nessuna dipendenza da vscode/fetch): determina se una `GenRequest` è
 *  `image` / `t2v` / `i2v` / `ambiguous` in base alla presenza di un'immagine iniziale e ai
 *  marcatori di tipo nel testo del prompt.
 *  Vedi design "Components and Interfaces > Orchestratore" (classify) e Property 1 & 2.
 *  _Requirements: 1.1, 1.6_
 *--------------------------------------------------------------------------------------------*/

import { GenKind, GenRequest } from './genTypes';

/** Risultato della classificazione: un tipo concreto oppure `ambiguous`. */
export type Classification = GenKind | 'ambiguous';

/**
 * Marcatori che indicano un **intento video** nel prompt (parole chiave, formati e workflow
 * video noti della community). Confrontati senza distinzione di maiuscole/minuscole.
 */
const VIDEO_MARKERS: RegExp[] = [
	/\bvideo\b/i,
	/\bvideos\b/i,
	/\bt2v\b/i,
	/\bi2v\b/i,
	/\btext[\s-]?to[\s-]?video\b/i,
	/\bimage[\s-]?to[\s-]?video\b/i,
	/\banima(?:zione|zioni|te|tion|ted)\b/i,
	/\banima\b/i,
	/\bclip\b/i,
	/\bfilmato\b/i,
	/\bfilmati\b/i,
	/\bmovie\b/i,
	/\bgif\b/i,
	/\bwebm\b/i,
	/\bmp4\b/i,
	/\bwan\b/i,
	/\banimatediff\b/i,
	/\bsvd\b/i,
	/\bmotion\b/i,
	/\bframes?\b/i,
	/\bfps\b/i,
];

/**
 * Marcatori che indicano un **intento immagine** nel prompt. Confrontati senza distinzione
 * di maiuscole/minuscole.
 */
const IMAGE_MARKERS: RegExp[] = [
	/\bimmagine\b/i,
	/\bimmagini\b/i,
	/\bimage\b/i,
	/\bimages\b/i,
	/\bfoto\b/i,
	/\bphoto\b/i,
	/\bpicture\b/i,
	/\bpic\b/i,
	/\brender\b/i,
	/\bdisegno\b/i,
	/\bdisegna\b/i,
	/\bdrawing\b/i,
	/\bdraw\b/i,
	/\britratto\b/i,
	/\bportrait\b/i,
	/\bwallpaper\b/i,
	/\btxt2img\b/i,
	/\btext[\s-]?to[\s-]?image\b/i,
	/\bimg2img\b/i,
	/\bpng\b/i,
	/\bjpe?g\b/i,
];

/** Vero se il testo contiene almeno uno dei marcatori dati. */
function hasMarker(text: string, markers: RegExp[]): boolean {
	return markers.some(re => re.test(text));
}

/** Vero se la richiesta fornisce un'immagine iniziale non vuota. */
function hasInitImage(req: GenRequest): boolean {
	return typeof req.initImage === 'string' && req.initImage.length > 0;
}

/**
 * Classifica una richiesta di generazione.
 *
 * Regole (in ordine di precedenza):
 * 1. `forcedKind`, se presente, ha la precedenza assoluta.
 * 2. Intento video + immagine iniziale => `i2v`.
 * 3. Intento video senza immagine iniziale => `t2v`.
 * 4. Immagine iniziale senza intento video (img2img) => `image`.
 * 5. Marcatori immagine nel prompt => `image`.
 * 6. Nessuna immagine e nessun marcatore di tipo => `ambiguous`.
 *
 * Il risultato è sempre uno tra `image`, `t2v`, `i2v`, `ambiguous`.
 */
export function classify(req: GenRequest): Classification {
	// (1) Il tipo forzato dall'utente ha la precedenza.
	if (req.forcedKind) {
		return req.forcedKind;
	}

	const prompt = typeof req.prompt === 'string' ? req.prompt : '';
	const initImage = hasInitImage(req);
	const videoIntent = hasMarker(prompt, VIDEO_MARKERS);

	// (2)/(3) Intento video: I2V se c'è un'immagine iniziale, altrimenti T2V.
	if (videoIntent) {
		return initImage ? 'i2v' : 't2v';
	}

	// (4) Immagine iniziale senza intento video => generazione immagine (img2img).
	if (initImage) {
		return 'image';
	}

	// (5) Marcatori di tipo immagine nel prompt.
	if (hasMarker(prompt, IMAGE_MARKERS)) {
		return 'image';
	}

	// (6) Nessuna immagine e nessun marcatore di tipo: tipo non determinabile.
	return 'ambiguous';
}
