# 🍎 MGCoding — Build per Apple Silicon (per Claude Code sul Mac)

> Sei Claude Code in esecuzione su un Mac (Apple Silicon, M-series). Questo branch
> `mac-arm64` serve a produrre il pacchetto macOS di MGCoding. Segui i passi sotto.

## Cosa fare (in ordine)

1. **Verifica di essere su un Mac arm64**

   ```bash
   uname -sm   # atteso: "Darwin arm64"
   ```

2. **Installa i prerequisiti** (se mancano)

   ```bash
   xcode-select --install                       # Xcode Command Line Tools
   brew install python cmake sox create-dmg     # build nativi + voce + dmg
   # Node.js 24.x:
   brew install fnm && fnm install 24 && fnm use 24
   node -v   # atteso: v24.x
   ```

   - `cmake` → compila il motore vocale whisper.cpp
   - `sox`   → recorder microfono (la voce si disattiva da sola se manca)

3. **Sei già in questo repo, su questo branch.** Assicurati che sia aggiornato:

   ```bash
   git checkout mac-arm64
   git pull origin mac-arm64
   ```

4. **Lancia la build** (con generazione del .dmg per gli aggiornamenti in-app):

   ```bash
   MGCODING_MAKE_DMG=1 bash build/mgcoding/build-mac-arm64.sh
   ```

   Risultato:
   - App: `../VSCode-darwin-arm64/MGCoding.app` (accanto alla cartella del repo)
   - DMG: prodotto se `MGCODING_MAKE_DMG=1` (asset `*arm64*.dmg` per l'updater in-app)

5. **Primo avvio senza notarizzazione**: clic destro sull'app → *Apri* (solo la prima volta).

## ⚠️ Regole importanti per questa sessione

- **NON pubblicare release / NON fare `gh release`** senza che l'utente lo chieda esplicitamente.
- **NON committare binari** (`*.app`, `*.dmg`, `out/`, `.build/` sono già ignorati).
- Se modifichi sorgenti per far compilare su Mac, **committa su questo branch `mac-arm64`**
  con messaggio in italiano e chiudi con:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Tutto ciò che è **codice/identificatori va in inglese**; commenti e prose in italiano.

## Dettagli completi

Vedi `build/mgcoding/MAC-BUILD.md` (prerequisiti, firma/notarizzazione opzionale,
come puntare a Ollama sul PC Windows in LAN, uso di ChatGPT/Gemini/Azure dal Mac).
