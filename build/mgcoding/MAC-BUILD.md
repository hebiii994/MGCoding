# Build MGCoding per macOS Apple Silicon (arm64)

Il pacchetto macOS **deve essere costruito su un Mac** (servono gli strumenti
Apple: Xcode Command Line Tools, `codesign`). Non è possibile produrre un `.app`
valido da Windows.

## Prerequisiti (sul Mac)

```bash
xcode-select --install            # Xcode Command Line Tools
brew install python create-dmg    # python3 per node-gyp; create-dmg opzionale
# Node.js 24.x (consigliato fnm o nvm):
#   brew install fnm && fnm install 24 && fnm use 24
```

## Build

```bash
git clone https://github.com/hebiii994/MGCoding.git
cd MGCoding
bash build/mgcoding/build-mac-arm64.sh
```

L'app risulta in `../VSCode-darwin-arm64/MGCoding.app` (accanto alla cartella del repo).

### Creare anche un .dmg

```bash
MGCODING_MAKE_DMG=1 bash build/mgcoding/build-mac-arm64.sh
```

## Avvio senza notarizzazione

Senza un Apple Developer ID, al primo avvio macOS mostra "app non verificata".
Soluzione: **clic destro sull'app → Apri** (solo la prima volta).

## Firma + notarizzazione (opzionale, per distribuzione pulita)

Richiede un account **Apple Developer** (~99 $/anno). Vedi la sezione commentata
in fondo a `build-mac-arm64.sh` per i comandi `codesign` / `notarytool` / `stapler`.

## Usare i modelli e le API dal Mac

- **LLM locali sul PC Windows**: avvia Ollama su Windows con `OLLAMA_HOST=0.0.0.0:11434`,
  apri la porta 11434 nel firewall, poi sul Mac imposta
  `mgcoding.ollama.endpoint = http://IP-DEL-PC-WINDOWS:11434`. I due dispositivi
  devono essere sulla stessa rete (LAN/VPN) e il PC acceso.
- **ChatGPT / Gemini / Azure**: comando *MGCoding: Cambia modello/provider* →
  scegli il preset. Per Azure inserisci endpoint del deployment e `api-version`.
