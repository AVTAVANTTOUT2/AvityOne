# AvityOne pour macOS

Application native SwiftUI (macOS 14 ou plus récent, Apple Silicon). Les agents (Claude Code, Codex, Cursor,
OpenCode) travaillent **directement sur le Mac**, dans tes dossiers, comme dans l'app Codex. L'orchestration reste
celle des serveurs : routage, mode plan, worktrees, revue croisée, fusion contrôlée, mémoire partagée et contexte.

```
 AvityOne.app (SwiftUI) ──HTTP + SSE, 127.0.0.1──▶ moteur embarqué (Node 24 + src/, le même que sur les VM)
        │                                              │ ACP stdio
        │ PTY (terminal, connexion des agents)         ▼
        └────────────────────────────────▶ claude-agent-acp · codex-acp · agent acp · opencode acp
```

L'app embarque Node 24 (version épinglée et vérifiée par SHA-256) et le moteur `src/`. Elle le lance au démarrage,
sur la boucle locale uniquement, et l'arrête en quittant. Le moteur reçoit `AVITY_EMBEDDED=1` et s'arrête avec ses
agents dès que l'app disparaît, même après un plantage. Rien n'est exposé sur le réseau, sauf si tu actives
l'accès Tailscale.

## Installation

### Depuis la CI

1. Ouvre l'onglet **Actions** du dépôt, puis le dernier passage réussi du workflow **macOS**.
2. Télécharge l'artefact `AvityOne-macOS`, décompresse-le, ouvre `AvityOne.dmg`.
3. Glisse **AvityOne** dans **Applications**.

L'app est signée **ad hoc** (pas de compte Apple Developer) : Gatekeeper la bloque au premier lancement.

- macOS 14 : clic droit sur l'app → **Ouvrir** → **Ouvrir**.
- macOS 15 et suivants : lance l'app une fois, puis **Réglages Système → Confidentialité et sécurité** → **Ouvrir
  quand même**.
- En ligne de commande : `xattr -dr com.apple.quarantine /Applications/AvityOne.app`.

### Construire soi-même

Xcode 16 ou plus récent (ou les Command Line Tools avec Swift 6), puis :

```bash
cd macos
swift build && swift test                 # bibliothèque AvityKit et ses tests
AVITY_ENGINE_TEST=1 swift test            # + intégration avec le vrai moteur (Node 24 dans le PATH)
bash scripts/build-app.sh                 # build/AvityOne.app et build/AvityOne.dmg
open build/AvityOne.app
```

## Premier lancement

Le démarrage guidé enchaîne quatre étapes, toutes modifiables ensuite dans les Réglages :

1. **Autorisations** : notifications, micro et reconnaissance vocale, enregistrement de l'écran, accès complet au
   disque. Tout est facultatif.
2. **Agents** :
   - **Outils de développement Apple** : git est fourni par les Command Line Tools. Le bouton lance
     `xcode-select --install`.
   - **Tout installer** : installe les quatre CLI et leurs adaptateurs ACP.
   - **Connecter** : ouvre un vrai terminal qui lance la commande de connexion de l'agent (`claude auth login`,
     `codex login --device-auth`, `agent login`, `opencode auth login`). Les pages de connexion du navigateur, les
     codes d'appareil et les menus interactifs fonctionnent.
   - **Vérifier** : contrôle l'initialisation ACP et le quota quand une source est configurée.
3. **Premier projet** : choisis le dossier d'un dépôt. Les autres options (clone, dossier vide) sont dans
   **Nouveau projet**.

## Utilisation

| Fonction | Où |
|---|---|
| Projets et fils | Barre latérale. ⌘N nouveau fil, ⇧⌘N nouveau projet, ⌥↑ / ⌥↓ fil précédent/suivant, filtre, épingler, renommer, dupliquer, archiver, supprimer. |
| Compositeur | Entrée envoie, Maj+Entrée va à la ligne, Échap arrête l'agent. Agent (Auto ou un agent), mode Auto/Agent/Plan, modèle et effort de l'agent, approbation auto, **Worktree** (copie isolée sur sa branche), pièces jointes (glisser-déposer, presse-papiers, capture d'écran), `/commandes`, mentions `@agent`. Pendant un tour, un message part en file. |
| Fil | Réponses en Markdown (copie des blocs de code), réflexions, outils animés avec commande, sortie et diff, plan, cartes d'autorisation, « Plan prêt » (Exécuter, Paralléliser), revue croisée, sous-sessions parallèles. Modifier et renvoyer, régénérer avec un autre agent, bifurquer. |
| Revue (⌥⌘B) | **Changements** : non indexé, indexé, nouveaux fichiers ; indexer, désindexer ou annuler par fichier ou par bloc ; « + » sur une ligne pour commenter et envoyer la remarque à l'agent ; commit, push, pull request (`gh`). **Fusion** : tests, lint, build, remarques de revue, fusion contrôlée des worktrees. **Plan**, **Fichiers** (éditeur), **Mémoire** (connaissances, sources, documents, brief, AGENTS.md), **Contexte**. |
| Terminal (⌘J) | Vrai terminal (PTY) dans le dossier du fil (son worktree s'il est isolé), avec le PATH des agents et la commande `avity`. Plusieurs onglets. |
| Ouvrir dans | Finder, VS Code, Cursor, Zed, Windsurf, Xcode, IntelliJ, Sublime Text, Terminal, iTerm, Ghostty, Warp (ceux qui sont installés). |
| Palette (⌘K) | Actions, fils, projets et recherche plein texte dans les conversations du projet, avec saut au message. |
| Dictée (maintenir ⌃M) | Reconnaissance **sur l'appareil**, en six langues : l'audio ne quitte pas le Mac. Si le moteur a une commande `transcription` configurée, elle est prioritaire, comme dans l'UI web. |
| Notifications | Fin de tour, échec, autorisation en attente. Une autorisation se valide depuis la notification (« Autoriser une fois », « Refuser »). Badge du Dock pour les fils en attente ou non lus. |
| Barre de menus | Fils en cours ou en attente, avec validation rapide, même fenêtres fermées. |
| Fenêtres | « Ouvrir le fil dans une nouvelle fenêtre » (⇧⌘O), avec l'option « Toujours au premier plan ». |

## Autorisations macOS

| Autorisation | Pourquoi | Sans elle |
|---|---|---|
| Notifications | Savoir qu'un agent a fini ou attend, et répondre depuis la notification. | Toasts dans l'app uniquement. |
| Micro et reconnaissance vocale | Dictée. | Pas de dictée. |
| Enregistrement de l'écran | Joindre une capture d'écran (`screencapture -i`). | Pas de capture. |
| Dossiers protégés (Bureau, Documents, Téléchargements, disques externes) | macOS demande l'accès la première fois qu'un agent y travaille. Les messages s'affichent au nom d'AvityOne. | Les agents ne peuvent pas lire ces dossiers. |
| Accès complet au disque | Facultatif : évite ces demandes. Les agents, le moteur et les terminaux en héritent. | Demandes au cas par cas. |

Les **actions des agents** suivent les règles du moteur :

- Les lectures sont autorisées sans demande.
- L'approbation auto est réglable par défaut et pour chaque fil.
- En mode plan, les modifications, suppressions et commandes, ainsi que la sortie du plan, sont toujours soumises à
  ta validation.

## Emplacements

| Quoi | Où |
|---|---|
| Données du moteur (base, jeton, configuration) | `~/Library/Application Support/AvityOne/` (`config.json` en 0600, dossier en 0700) |
| CLI installés par l'app (npm) | `~/Library/Application Support/AvityOne/tools/bin` : pas de sudo, rien dans l'app signée |
| CLI installés par leurs propres installateurs | `~/.local/bin` (Cursor, installateur natif de Claude), `~/.opencode/bin` |
| Commande `avity` | `~/Library/Application Support/AvityOne/tools/bin/avity`, régénérée à chaque démarrage et pointée vers ce moteur |
| Nouveaux projets (clone, dossier vide) et projet « perso » | `~/AvityOne`, hors des dossiers protégés par macOS (modifiable : `projectsDir`) |

Le moteur reçoit un PATH complet, dans cet ordre :

- les outils de l'app, puis Node embarqué ;
- `~/.local/bin`, `~/.opencode/bin`, `~/.bun/bin` ;
- Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) ;
- le PATH de ton shell de connexion, lu une fois via `$SHELL -ilc` ;
- les chemins système ;
- l'assistant `pdftotext` de l'app (PDFKit, utilisé seulement si Poppler est absent) ;
- le CLI de Tailscale (`/Applications/Tailscale.app/Contents/MacOS`).

Le `node` des agents et des commandes de validation est donc Node 24 embarqué.

## Serveurs distants

**Réglages → Connexions** ajoute un serveur AvityOne (URL et jeton, conservé dans le trousseau). Le sélecteur de la
barre latérale passe de **Ce Mac** à ce serveur. L'interface est identique, mais les agents travaillent alors sur le
serveur, dans ses dossiers :

- le terminal est celui du moteur (pipes, sans PTY) ;
- « Ouvrir dans » est désactivé ;
- la connexion des agents passe par l'opération du moteur, avec un champ de saisie.

## Accès depuis le téléphone

Le moteur du Mac sert aussi l'interface web (PWA). Avec Tailscale installé et connecté, **Réglages → Connexions →
Accès HTTPS depuis le téléphone via Tailscale** lance `tailscale serve`. Tu utilises alors AvityOne depuis ton
téléphone, avec le jeton du Mac (Réglages → Avancé pour le changer).

## Dépannage

| Symptôme | Que faire |
|---|---|
| « Le moteur local n'a pas démarré » | Bouton **Journal du moteur**, puis **Réessayer**. Un `config.json` illisible est signalé tel quel : corrige-le ou retire-le. |
| Agent « introuvable » après installation | **Actualiser** puis **Vérifier** dans Réglages → Agents. Pour un CLI installé ailleurs, vérifie qu'il est dans le PATH de ton shell de connexion. |
| git manquant | Installe les Command Line Tools (Réglages → Agents → Outils de développement Apple). |
| Import PDF | L'assistant PDFKit extrait la couche texte ; installe Poppler (`brew install poppler`) pour sa mise en page. Pas d'OCR. |
| Pull request impossible | Installe GitHub CLI (`brew install gh`) puis `gh auth login` dans le terminal (⌘J). |

## Limites

- Signature ad hoc : ni Developer ID ni notarisation ; mises à jour manuelles (nouveau DMG).
- Apple Silicon uniquement ; macOS 14 minimum.
- Pas d'automatisations planifiées, de skills Codex, de tâches cloud, de navigateur intégré ni de Computer Use.
- ACP ne permet pas d'injecter un message dans un tour en cours (« steer ») : il part en file.
- La CI compile l'app, l'empaquette et lance un test de fumée du bundle. Elle exécute les tests du moteur sur macOS
  et l'intégration de la bibliothèque Swift avec le vrai moteur et des agents simulés. L'interface, les autorisations
  système et les vrais CLI d'agents restent à qualifier sur un Mac.
