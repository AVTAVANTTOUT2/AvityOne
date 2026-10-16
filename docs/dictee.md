# Dictée locale sur CPU

Le moteur optionnel `faster-whisper` transcrit les enregistrements du navigateur sans
clé API, abonnement ni envoi de l'audio à un fournisseur. L'installation télécharge
des paquets Python et un modèle public ; les transcriptions suivantes utilisent
uniquement les fichiers locaux. Le serveur Node conserve zéro dépendance runtime.

## Installer

Sur Linux x86-64 avec SSE 4.1 minimum, Python 3.10 ou plus et environ 1,5 Gio de disque
libre, depuis le dépôt :

```bash
python3 deploy/install-transcription.py
```

Le script installe tout dans `~/.local/share/avityone-transcription`, sans `sudo`,
sans modifier le Python système, la configuration AvityOne ou le service. Il crée
une venv même si le paquet système `python3-pip` ou `ensurepip` manque. Le paquet
d'amorçage pip possède une URL et une empreinte SHA-256 fixes. Pour un autre dossier :

```bash
python3 deploy/install-transcription.py --directory /chemin/dictee
```

Le script affiche l'objet `transcription` à reporter dans Administration. Les
chemins sont absolus : `~` et `$HOME` ne sont pas développés dans ces champs.
La commande est le Python de la venv et les arguments sont :

```text
/chemin/dictee/transcribe.py
--file
{file}
--language
{language}
--threads
4
```

Le modèle par défaut se trouve à côté du script, dans `model/`. `--model` permet de
choisir un autre dossier local compatible. `--threads` accepte 1 à 16 threads ;
quatre conviennent à la VM de qualification. Les langues régionales du navigateur,
par exemple `fr-FR`, sont transmises au modèle sous leur code de base (`fr`).

## Versions et fonctionnement

- faster-whisper **1.2.1**, CTranslate2 **4.8.3**, PyAV **16.1.0**, pip **26.2.1**.
- Modèle multilingue `Systran/faster-whisper-base`, révision
  `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66`, environ 145 Mo.
- Calcul CPU `int8`, décodage glouton, sans téléchargement automatique à l'exécution.
- PyAV inclut son décodeur : aucun binaire FFmpeg système n'est nécessaire.
- Une seule transcription charge le modèle à la fois. Le verrou de fichier est
  libéré automatiquement à la fin ou à l'arrêt du processus ; les autres attendent.
- La liste complète des versions installées est conservée dans
  `requirements-installed.txt`, et la révision du modèle dans `model-version.json`.
- Installation mesurée : environ 612 Mio sur disque, modèle et environnement inclus.

**Ne pas mettre PyAV à jour séparément** : PyAV 19.0.1 supprime l'argument
`metadata_errors` utilisé par cette version de faster-whisper. Cette incompatibilité
a été reproduite sur un véritable fichier WebM ; le pin 16.1.0 la corrige.

Le serveur accepte WAV, WebM, Ogg et MP4, avec une taille maximale de 5 Mio. Son délai
de 120 secondes comprend l'attente du verrou, le chargement du modèle et le décodage.
Privilégier les dictées courtes ; un fichier compressé de 5 Mio peut dépasser ce délai.
Un modèle plus gros nécessite une nouvelle mesure de latence et de mémoire.

## Qualification française

Le 16 octobre 2026, sur Debian 13, Python 3.13.5, Node 24.22.0, 4 vCPU sans AVX et
8 Gio de RAM :

- Échantillon : `dictee-fr-thomas.webm`, 27 105 octets, 6,565 secondes, voix de synthèse
  française Thomas de macOS. Aucun microphone ni enregistrement personnel.
- Texte demandé : « Bonjour, je voudrais ajouter une tâche pour demain matin. Merci
  de vérifier la configuration du serveur. »
- Texte obtenu : « Bonjour, je voudrais ajouter une tâche pour demain matin, merci
  de vérifier la configuration du serveur. » Tous les mots sont conservés ; la
  ponctuation diffère.
- Exécution directe : 6,443 secondes, pic mémoire du processus 585,5 Mio.
- `POST /api/transcribe` : HTTP 200 en 4,725 à 5,442 secondes sur deux essais, WebM Opus, langue `fr-FR`.
  Serveur du commit `14a6b12`, port local éphémère et `AVITY_HOME` temporaire.

Ces mesures qualifient ce court échantillon et ce matériel, pas tous les accents,
bruits, longues dictées ou navigateurs. La qualité doit rester vérifiée avant
d'envoyer la transcription comme message.

Pour régénérer cet échantillon sur macOS avec FFmpeg installé :

```bash
say -v Thomas -r 155 -o dictee-fr-thomas.aiff \
  "Bonjour, je voudrais ajouter une tâche pour demain matin. Merci de vérifier la configuration du serveur."
ffmpeg -i dictee-fr-thomas.aiff -ar 16000 -ac 1 -c:a libopus -b:a 32k dictee-fr-thomas.webm
```

Les tests Node exécutent aussi le véritable script Python avec un modèle simulé,
sans téléchargement : langue régionale, CPU hors ligne, sortie texte, fichier de
modèle absent et sérialisation des demandes. Ce test seul est ignoré si Python 3
n'est pas installé ; il ne remplace pas la qualification avec le vrai modèle.

## Sources officielles

- [faster-whisper : installation et exemples CPU](https://github.com/SYSTRAN/faster-whisper)
- [CTranslate2 : matériel CPU pris en charge](https://opennmt.net/CTranslate2/hardware_support.html)
- [Modèle base multilingue et révision utilisée](https://huggingface.co/Systran/faster-whisper-base/tree/ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66)
- [PyAV 16.1.0](https://pypi.org/project/av/16.1.0/)
