#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  MGCoding - build per macOS Apple Silicon (arm64)
#  Da eseguire SU UN MAC con Apple Silicon (M1/M2/M3/M4).
#  Produce l'app .app e (opzionale) un .dmg distribuibile.
# ---------------------------------------------------------------------------
set -euo pipefail

# --- Prerequisiti -----------------------------------------------------------
#   * Xcode Command Line Tools:   xcode-select --install
#   * Node.js (stessa major usata su Windows, v24.x):  https://nodejs.org o fnm/nvm
#   * Python 3 (per node-gyp):     brew install python
#   * git
#
# Verifica rapida:
command -v node >/dev/null || { echo "ERRORE: Node.js non trovato. Installa Node 24.x."; exit 1; }
command -v python3 >/dev/null || { echo "ERRORE: python3 non trovato. brew install python"; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "ERRORE: Xcode CLT mancanti. Esegui: xcode-select --install"; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
echo "==> Repo: $ROOT"
echo "==> Node:  $(node -v)"
echo "==> arch:  $(uname -m)  (atteso: arm64)"

# --- Dipendenze -------------------------------------------------------------
echo "==> Installazione dipendenze (npm ci)…"
npm ci

# --- Compilazione estensione mgcoding --------------------------------------
echo "==> Compilo l'estensione mgcoding…"
npx gulp compile-extension:mgcoding

# --- Build dell'app Darwin arm64 -------------------------------------------
echo "==> Build VS Code (darwin-arm64)… (alcuni minuti)"
npx gulp vscode-darwin-arm64

# L'output è una cartella .app accanto al repo:
APP_DIR="$ROOT/../VSCode-darwin-arm64"
echo "==> App generata in: $APP_DIR"

# --- (Opzionale) creazione DMG ---------------------------------------------
# Richiede 'create-dmg' (brew install create-dmg). Disattivato di default.
if [[ "${MGCODING_MAKE_DMG:-0}" == "1" ]]; then
	command -v create-dmg >/dev/null || { echo "create-dmg mancante: brew install create-dmg"; exit 1; }
	APP_NAME="$(ls "$APP_DIR" | grep '\.app$' | head -n1)"
	echo "==> Creo DMG da $APP_NAME…"
	rm -f "$ROOT/MGCoding-arm64.dmg"
	create-dmg --overwrite "$APP_DIR/$APP_NAME" "$ROOT" || true
	echo "==> DMG creato in $ROOT"
fi

# --- (Opzionale) firma + notarizzazione ------------------------------------
# Richiede un Apple Developer ID. Esempio (decommenta e personalizza):
#   APP_PATH="$APP_DIR/$(ls "$APP_DIR" | grep '\.app$' | head -n1)"
#   codesign --deep --force --options runtime \
#     --sign "Developer ID Application: TUO NOME (TEAMID)" "$APP_PATH"
#   xcrun notarytool submit "MGCoding-arm64.dmg" \
#     --apple-id "tua@apple.id" --team-id "TEAMID" --password "APP-SPECIFIC-PWD" --wait
#   xcrun stapler staple "MGCoding-arm64.dmg"

echo "==> Fatto. Per avviare senza notarizzazione: clic destro sull'app -> Apri (solo la prima volta)."
