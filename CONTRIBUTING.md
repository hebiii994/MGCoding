# Contribuire a MGCoding

Grazie per l'interesse verso MGCoding! Questa guida spiega come segnalare problemi e proporre modifiche.

MGCoding è un fork di [Visual Studio Code / Code-OSS](https://github.com/microsoft/vscode) (Microsoft, licenza MIT). Per problemi che riguardano il *core* dell'editor (non specifici di MGCoding) la documentazione e gli issue di VS Code restano un riferimento utile.

## Segnalare un problema

Apri una [issue](https://github.com/hebiii994/MGCoding/issues) includendo, quando possibile:

* Versione di MGCoding (menu Aiuto → Informazioni)
* Sistema operativo
* Provider/modello LLM in uso (Ollama, Claude, ChatGPT, Gemini, Azure…)
* Passi riproducibili (1… 2… 3…)
* Cosa ti aspettavi rispetto a cosa è successo
* Eventuali errori dalla Dev Tools Console (Aiuto → Attiva/disattiva strumenti di sviluppo)

Prima di aprirne una nuova, controlla le [issue esistenti](https://github.com/hebiii994/MGCoding/issues) per evitare duplicati. Una issue per problema.

## Proporre modifiche (Pull Request)

1. Fai un fork del repo e crea un branch dedicato.
2. Compila ed esegui da sorgente (vedi il [README](README.md)).
3. Assicurati che non ci siano errori di compilazione TypeScript e che i test passino.
4. Apri una pull request descrivendo chiaramente la modifica.

Il codice dell'estensione che implementa MGCoding vive in [`extensions/mgcoding`](extensions/mgcoding); seguine le convenzioni di stile esistenti.

## Licenza

Contribuendo accetti che il tuo contributo sia distribuito sotto licenza [MIT](LICENSE.txt), come il resto del progetto.

## Grazie

Ogni contributo, grande o piccolo, aiuta a migliorare il progetto. Grazie!
