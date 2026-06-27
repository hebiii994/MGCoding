/*---------------------------------------------------------------------------------------------
 *  MGCoding - risoluzione/migrazione della configurazione di feature
 *  Precedenza di lettura: .mg/ → legacy .kiro/ → default. Scrittura: sempre sotto .mg/.
 *  Riusa util/featurePaths.ts (mgDir, exists).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exists, mgDir } from './featurePaths';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Sottocartella canonica che contiene il file di configurazione di feature. */
const CONFIG_SUB = 'settings';
/** Nome del file di configurazione di feature (sotto .mg/settings o .kiro/settings). */
const CONFIG_FILE = 'feature.json';

/** Mappa chiave→valore della configurazione di feature persistita su file. */
type FeatureConfig = Record<string, unknown>;

/** Configurazione di default iniziale creata sotto .mg/ quando nessuna cartella ha il dato (Req. 11.3). */
const DEFAULT_FEATURE_CONFIG: FeatureConfig = {};

/** Radice del primo workspace folder, o undefined se nessuno è aperto. */
function workspaceRoot(): vscode.Uri | undefined {
	const folders = vscode.workspace.workspaceFolders;
	return folders && folders.length ? folders[0].uri : undefined;
}

/** URI canonico di scrittura: <workspace>/.mg/settings/feature.json. */
function mgConfigUri(): vscode.Uri | undefined {
	const dir = mgDir(CONFIG_SUB);
	return dir ? vscode.Uri.joinPath(dir, CONFIG_FILE) : undefined;
}

/** URI legacy di sola lettura: <workspace>/.kiro/settings/feature.json. */
function legacyConfigUri(): vscode.Uri | undefined {
	const root = workspaceRoot();
	return root ? vscode.Uri.joinPath(root, '.kiro', CONFIG_SUB, CONFIG_FILE) : undefined;
}

/** Legge e deserializza un file di configurazione; ritorna {} se assente o non valido. */
async function readConfigFile(uri: vscode.Uri | undefined): Promise<FeatureConfig> {
	if (!uri) {
		return {};
	}
	try {
		const parsed = JSON.parse(DEC.decode(await vscode.workspace.fs.readFile(uri)));
		// Accetta solo oggetti semplici: scarta array/null/scalari.
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FeatureConfig) : {};
	} catch {
		return {};
	}
}

/**
 * Risolve un valore di configurazione di feature con precedenza .mg/ → .kiro/ → default (Req. 11.2, 11.4).
 * La precedenza è applicata per singola chiave: se .mg/ non contiene il dato si legge il legacy .kiro/.
 */
export async function readFeatureConfig<T>(key: string, def: T): Promise<T> {
	const mgCfg = await readConfigFile(mgConfigUri());
	if (Object.prototype.hasOwnProperty.call(mgCfg, key)) {
		return mgCfg[key] as T;
	}

	// La cartella .mg/ non contiene il dato: ripiega sul legacy .kiro/settings/feature.json.
	const legacyCfg = await readConfigFile(legacyConfigUri());
	if (Object.prototype.hasOwnProperty.call(legacyCfg, key)) {
		return legacyCfg[key] as T;
	}

	return def;
}

/**
 * Scrive un valore di configurazione di feature sempre sotto .mg/ (Req. 11.2).
 * Preserva le altre chiavi già presenti nel file .mg/.
 */
export async function writeFeatureConfig<T>(key: string, value: T): Promise<void> {
	const uri = mgConfigUri();
	if (!uri) {
		return;
	}
	const cfg = await readConfigFile(uri);
	cfg[key] = value as unknown;
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, ENC.encode(JSON.stringify(cfg, null, 2)));
}

/**
 * Garantisce una configurazione iniziale: se né .mg/ né .kiro/ contengono il file di
 * configurazione, crea i default sotto .mg/ (Req. 11.3).
 */
export async function ensureInitialConfig(): Promise<void> {
	const mgUri = mgConfigUri();
	if (!mgUri) {
		return;
	}

	// Se .mg/ contiene già il dato non si fa nulla (scrittura canonica già presente).
	if (await exists(mgUri)) {
		return;
	}

	// Se il legacy .kiro/ contiene il dato lo si preserva: non si crea il default.
	const legacyUri = legacyConfigUri();
	if (legacyUri && await exists(legacyUri)) {
		return;
	}

	// Nessuna cartella contiene il dato: crea i default sotto .mg/.
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(mgUri, '..'));
	await vscode.workspace.fs.writeFile(mgUri, ENC.encode(JSON.stringify(DEFAULT_FEATURE_CONFIG, null, 2)));
}
