/*---------------------------------------------------------------------------------------------
 *  MGCoding - estrazione di testo da documenti per l'indice semantico (RAG).
 *  - OOXML (.docx/.pptx/.xlsx) sono archivi ZIP: leggiamo le parti XML e ne togliamo i tag,
 *    SENZA dipendenze esterne (mini-lettore ZIP + zlib.inflateRaw integrato in Node).
 *  - PDF: usa `pdftotext` (poppler) se presente nel PATH; altrimenti il PDF viene saltato.
 *--------------------------------------------------------------------------------------------*/

import * as zlib from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

/** Estensioni documento gestite (oltre a codice/testo). */
export const DOC_EXT = new Set(['docx', 'pptx', 'xlsx', 'pdf']);

/** Legge dall'archivio ZIP le entry il cui nome soddisfa `match`, restituendo {nome, dati}. */
function readZipEntries(buf: Buffer, match: (name: string) => boolean): { name: string; data: Buffer }[] {
	const out: { name: string; data: Buffer }[] = [];
	// End Of Central Directory: cerca la firma 0x06054b50 dal fondo.
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) {
		return out;
	}
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16); // offset central directory
	for (let n = 0; n < count && p + 46 <= buf.length; n++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) {
			break;
		}
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOff = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		if (match(name) && buf.readUInt32LE(localOff) === 0x04034b50) {
			const lNameLen = buf.readUInt16LE(localOff + 26);
			const lExtraLen = buf.readUInt16LE(localOff + 28);
			const dataStart = localOff + 30 + lNameLen + lExtraLen;
			const comp = buf.subarray(dataStart, dataStart + compSize);
			try {
				const data = method === 0 ? comp : zlib.inflateRawSync(comp);
				out.push({ name, data });
			} catch {
				// entry illeggibile: salta
			}
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

/** Rimuove i tag XML e normalizza gli spazi, inserendo a capo sui paragrafi/righe. */
function xmlToText(xml: string): string {
	return xml
		.replace(/<\/(w:p|a:p|text:p)>/g, '\n')
		.replace(/<w:tab\/>|<a:tab\/>/g, '\t')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Estrae il testo da un OOXML (docx/pptx/xlsx) leggendo le parti XML rilevanti. */
function extractOoxml(buf: Buffer, ext: string): string {
	const match = ext === 'docx'
		? (n: string) => n === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(n)
		: ext === 'pptx'
			? (n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)
			: (n: string) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n);
	const parts = readZipEntries(buf, match);
	return parts.map(pt => xmlToText(pt.data.toString('utf8'))).filter(Boolean).join('\n\n');
}

/** Estrae il testo da un PDF usando `pdftotext` (poppler), se disponibile nel PATH. */
async function extractPdf(buf: Buffer): Promise<string> {
	const tmpIn = path.join(os.tmpdir(), `mg-pdf-${Date.now()}.pdf`);
	const tmpOut = `${tmpIn}.txt`;
	try {
		fs.writeFileSync(tmpIn, buf);
		await execFileAsync('pdftotext', ['-q', '-enc', 'UTF-8', tmpIn, tmpOut], { timeout: 60000 });
		return fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
	} catch {
		// pdftotext non installato o errore: PDF non indicizzabile per ora.
		return '';
	} finally {
		try { fs.unlinkSync(tmpIn); } catch { /* */ }
		try { fs.unlinkSync(tmpOut); } catch { /* */ }
	}
}

/** Estrae il testo da un documento binario supportato; '' se non estraibile. */
export async function extractDocText(ext: string, buf: Buffer): Promise<string> {
	try {
		if (ext === 'pdf') {
			return await extractPdf(buf);
		}
		if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') {
			return extractOoxml(buf, ext);
		}
	} catch {
		// estrazione fallita
	}
	return '';
}
