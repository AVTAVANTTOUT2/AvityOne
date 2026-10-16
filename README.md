# AvityOne

Plateforme personnelle d'IA de code (et de vie) auto-hébergée. **Claude Code, Codex, Cursor et OpenCode** tournent en CLI
sur ton serveur. AvityOne les pilote et gère ce qui fait la différence sur les projets complexes : **routage,
mode plan, exécution, revue croisée, contexte inter-sessions, mémoire et base de connaissance par projet.**

Principe : AvityOne ne réimplémente pas la boucle d'agent, qui fait la qualité de Claude Code et de Codex. Il les
pilote par le protocole standard qu'ils parlent tous, l'[Agent Client Protocol](https://agentclientprotocol.com)
(ACP, celui de Zed et JetBrains), et garde la main sur le contexte.

```
  Navigateur (UI 3 panneaux) ──HTTP+SSE──┐          avity (CLI) ──┐
                                         ▼                        ▼
            ┌──────────────── AvityOne server (Node 24, 0 dépendance) ────────────────┐
            │ Routeur ──▶ Hub : sessions, plan → exécution → revue croisée, permissions │
            │ Moteur de contexte : brief, état git, mémoire FTS5, docs indexés,         │
            │   résumés de sessions, reprise (handoff) quand on change d'agent          │
            │ SQLite : projects · sessions · items · memory (FTS5) · kb (FTS5)          │
            └─────┬───────────────┬────────────────┬────────────────┬─────────────────┘
              ACP stdio       ACP stdio        ACP stdio        ACP stdio
           claude-agent-acp   codex-acp        agent acp       opencode acp
            (Claude Code)      (Codex)         (Cursor)         (OpenCode)
                  └───────── serveur MCP « avity » : mémoire partagée par tous ─────────┘
```

## Fonctions disponibles (version non publiée)

| Fonction | Détail |
|---|---|
| **Agents** | Claude Code, Codex, Cursor et OpenCode via ACP. Installation, connexion, contrôle de disponibilité et catalogue des commandes dans Administration ; autocomplétion des commandes `/…`. Les serveurs MCP stdio supplémentaires se configurent dans la même interface. |
| **Routage** | Mentions `@agent`, choix manuel, continuité de session, règles éditables, classement selon des évaluations enregistrées ou choix par un agent LLM. La bascule automatique intervient après un échec de connexion, avant tout envoi de travail. |
| **Plans** | `/plan` ou le bouton Plan ; édition de la spécification et des étapes, ordre, sélection, agent, fichiers concernés et dépendances dans Outils → Plan et tâches. Les cycles et dépendances manquantes sont refusés. |
| **Revue croisée** | Verdict structuré d'un autre agent (ou de l'auteur lui-même s'il est le seul installé), remarques ouvertes et explication des corrections. La fusion exige une revue favorable de chaque auteur et des contrôles réussis sur le résultat exact ; seule une revue défavorable laisse des remarques à justifier. |
| **Worktree isolé** | Case « worktree » par session : au premier tour en mode agent, l'agent est relancé dans `.avity/worktrees/<session>` sur la branche `avity/<session>`. Tout `.avity/` (worktrees, documents importés, brief non suivi) est exclu du `git status` du projet. Projets non git : inchangé. |
| **Orchestration durable** | Une tâche par sous-session isolée, dépendances explicites et sérialisation des fichiers communs. File SQLite persistante, limites de parallélisme, résultats structurés, synthèse et artefacts spécification/plan/tâches. Relance ciblée, arrêt des connexions inactives et interruption des agents bloqués. |
| **Fusion contrôlée** | Comparaison et sélection des branches, fichiers ou blocs. Le résultat est préparé dans un worktree temporaire, validé puis relu avant intégration atomique. Un conflit conserve tous les worktrees ; une sélection partielle conserve le travail restant. |
| **Contexte inter-sessions** | Brief, instructions, état git, recherche hybride dans les mémoires et sources, résumés des sessions récentes. Le panneau Contexte permet d'éditer le complément et de choisir les connaissances et sources à injecter à la prochaine connexion. |
| **Reprise multi-agents** | Changer d'agent en cours de route (`@codex continue`) transmet le transcript au nouvel agent. |
| **Résumés + mémoire** | Toutes les 4 réponses, à l'ouverture d'une nouvelle session, ou sur « Résumer » : un modèle léger (Haiku) résume la session et extrait décisions, conventions, pièges, faits et todos. Le tout est dédupliqué. |
| **Mémoire partagée MCP** | Chaque agent reçoit le serveur MCP `avity` (`avity_memory_search`, `avity_memory_add`, `avity_recent_sessions`). Ce que Codex apprend, Claude le sait. |
| **Connaissances** | Indexation incrémentale du code et des documents, recherche FTS5 + LSA locale, consolidation, faits structurés contradictoires ou périmés, édition, historique/restauration, export Markdown et graphe temporel. Import PDF/bureautique et ouverture des sources originales. |
| **Espace de travail** | Explorateur et éditeur de fichiers, terminal avec entrée/sortie, diffs avant/après staging, sélection ou annulation par fichier/bloc et export du contexte du dépôt pour revue. Les chemins restent dans l'espace du projet ou de son worktree. |
| **Projets** | Recherche, renommage, archivage, retrait sans effacer les fichiers, sélecteur de dossiers du serveur, édition du brief et de `AGENTS.md`. |
| **Fichiers et médias** | Pièces jointes par sélection ou glisser-déposer, blocs ACP image/audio/ressource et rendu des réponses multimédias. Les pièces suivent la modification, la régénération et la bifurcation des conversations. |
| **Mobile et dictée** | PWA installable, options d'agent et exécution parallèle sur mobile, six langues de dictée. En l'absence de reconnaissance native, l'enregistrement est transmis au moteur configuré sur le serveur. |
| **Administration** | Configuration, déconnexion, rotation du jeton, accès HTTPS via Tailscale, sauvegarde/restauration, métriques rapportées par les agents, budgets locaux, quotas issus d'une source configurée, traces et évaluations comparatives. |
| **UI premium** | React + [libraries.dev](https://libraries.dev) (thème et effets, voir ci-dessous) : projets et sessions, flux en streaming (messages, réflexions, outils animés, diffs, plans, permissions), sélecteurs modèle/effort exposés par chaque agent, dictée vocale, panneau mémoire et aperçu du contexte injecté. Utilisable sur mobile. |
| **Sessions** | Renommer, épingler, dupliquer, archiver, supprimer (menu « ⋯ » de l'en-tête). Bifurquer depuis n'importe quelle réponse, modifier et renvoyer un message, régénérer la dernière réponse (même agent ou un autre), copier un message, une réponse ou un bloc de code. Recherche plein texte dans toutes les conversations du projet, avec saut au message trouvé. Export Markdown. Un brouillon par session, conservé sur le serveur. Alt+↑ / Alt+↓ et l'historique du navigateur pour passer d'une session à l'autre. |
| **Activité et notifications** | Pastilles d'activité par session et par projet (en cours, validation requise, terminé ou échoué sans avoir été vu), compteur dans le titre de l'onglet, toasts et notifications système (cloche de l'en-tête, HTTPS ou localhost) de fin, d'échec et d'autorisation en attente. Bandeau de déconnexion avec reconnexion et resynchronisation automatiques. Les erreurs de chargement du contexte et de la mémoire sont signalées dans la session et les panneaux. |
| **Permissions** | Auto-approbation configurable. La validation de plan et les éditions en mode plan te reviennent toujours. |

## Installation (Debian 13)

```bash
git clone https://github.com/AVTAVANTTOUT2/AvityOne.git ~/avityone && cd ~/avityone
bash deploy/provision.sh   # Node 24, git, ripgrep, poppler-utils/unzip, CLIs + adaptateurs ACP
bash deploy/install.sh     # service systemd « avityone » sur :7710 + commande `avity`
```

Connecte ensuite chaque agent **une fois** sur le serveur, avec tes abonnements :

```bash
claude            # puis /login
codex login --device-auth
agent login       # Cursor
opencode auth login
```

Le token d'accès à l'UI se lit avec `jq -r .token ~/.avityone/config.json`.

## Déploiement continu : preprod → prod

| Branche | Serveur | Mise à jour |
|---|---|---|
| `preprod` (branche par défaut) | VM `avityone-preprod` · https://avityone-preprod.tail5feb4c.ts.net | à chaque merge |
| `main` | VM `avityone` · https://avityone.tail5feb4c.ts.net | à chaque merge de la PR `preprod` → `main` |

1. Toute PR vise `preprod`. La CI (`.github/workflows/ci.yml` : types, tests, build) doit passer pour merger.
2. Au merge, la VM preprod se met à jour en moins d'une minute : `npm ci`, build, redémarrage du service.
3. Pour livrer en prod : PR `preprod` → `main`, mergée en **merge commit** (pas de squash, sinon les deux branches
   divergent). La CI refuse toute autre source pour `main`, la prod est donc exactement ce qui a tourné en preprod.

Chaque VM interroge GitHub chaque minute (`avityone-deploy.timer` → `deploy/autodeploy.sh <branche>`) : pas de
secret, pas de port ouvert. Activation sur une VM : `bash deploy/autodeploy.sh preprod` (ou `main`).
Suivi : `journalctl -u avityone-deploy -f`. Redéployer le même commit : `rm ~/.avityone/deployed`.

## Utilisation

- **UI** : `http://<serveur>:7710`. Crée un projet (dossier existant, URL git à cloner ou dossier vide pour un projet « vie »), ouvre une session et écris.
- **CLI** : `avity ask -p monprojet "/plan migrer l'auth vers des sessions"`, `avity memory monprojet auth`, `avity sessions monprojet`,
  `avity search monprojet "migration auth"`, `avity export <session> > session.md`.
- **Brief projet** : écris `.avity/brief.md` dans le projet (objectifs, stack, contraintes). Il est injecté en tête de chaque session.

### Plans, file et fusion

Dans **Outils → Plan et tâches**, enregistre les étapes avant de lancer la sélection. Chaque tâche possède un
identifiant, un contenu, des dépendances, des chemins relatifs et un agent facultatif. Les tâches qui déclarent les mêmes
fichiers s'exécutent dans l'ordre des dépendances ; les résultats et branches des prérequis sont transmis à leurs successeurs.
Les artefacts et la synthèse restent consultables après la fermeture du navigateur.

Après un redémarrage, les demandes encore en file reprennent automatiquement. Une demande en cours au moment de
l'arrêt devient **interrompue** : **Relancer** est explicite, car une action externe peut avoir déjà eu lieu.
La même prudence s'applique à un échec après l'envoi du travail : aucune bascule automatique ne répète cette action.

**Outils → Changements** affiche les branches, les blocs sélectionnables, les validations et les remarques de revue.
La fusion vérifie que le dépôt cible est propre et que les commits n'ont pas changé pendant les contrôles. Un échec,
un conflit ou une remarque ouverte bloque l'intégration. Pour un conflit, ouvre la sous-session concernée et demande
la résolution assistée, puis relance les contrôles et la fusion.

La CLI expose les mêmes opérations ; `plan.json` contient `specification`, `revision` et `tasks` :

```bash
avity plan <session>                         # lire le plan JSON
avity plan <session> --file plan.json         # remplacer le plan avec sa révision
avity execute <session> -a codex
avity parallel <session>
avity queue <session> "demande suivante"
avity jobs <session>
avity retry <job>
avity artifacts <session>
avity isolate <session>
avity preview <session>                      # branches, blocs et empreinte
avity validate <session>
avity review <session> -a codex
avity conflicts <sous-session>
avity merge <session> --branches <id,id> --files <chemin,chemin>
avity merge <session> --hunks <id,id> --fingerprint <empreinte>
```

`AVITY_URL` et `AVITY_TOKEN` permettent à la CLI de joindre un serveur distant. Une demande en file, une validation
et une fusion ont des états distincts ; le retour d'une mise en file ne signifie pas que le travail est terminé.

### Mémoire, sources et dictée

La recherche hybride combine FTS5 avec une analyse sémantique latente (LSA) locale, sans modèle d'embeddings externe.
La partie LSA utilise au plus **300 extraits récents**, **4 096 termes** et **12 dimensions** : elle complète la recherche
lexicale, sans garantir la pertinence d'un modèle sémantique général. L'indexation traite au plus 2 000 fichiers par projet,
300 000 octets par fichier texte et 10 000 000 octets par document PDF/bureautique ; les limites et échecs sont signalés.
Les doublons normalisés sont consolidés après les résumés. Les contradictions comparent les champs sujet/relation/valeur,
et les faits périmés utilisent leur date de validité : un texte libre sans ces informations ne reçoit pas une vérification factuelle universelle.

L'import prend en charge PDF, DOCX, ODT, PPTX et XLSX, ainsi que Markdown et texte. Installe **Poppler (`pdftotext`)**
pour les PDF et **`unzip`** pour les formats bureautiques. L'extraction fournit du texte, sans OCR ni restitution de mise
en page ; les sources originales restent téléchargeables. Les fichiers importés sont conservés dans `.avity/imports/`.

Les pièces jointes de conversation sont limitées à **8 fichiers de 5 Mio maximum** par demande. Les images PNG/JPEG/WebP/GIF,
l'audio et les ressources sont envoyés dans leur format ACP ; leur exploitation dépend des capacités de l'agent choisi.
Lors d'une reprise avec un agent neuf, au plus huit blocs multimédias historiques récents accompagnent le transcript.

La dictée propose français, anglais, espagnol, allemand, italien et portugais. Le navigateur utilise sa reconnaissance
native si elle existe. Sinon, configure `transcription.command` et `transcription.args` : `{file}` est remplacé par le chemin
de l'enregistrement temporaire, `{language}` par la langue choisie. La commande doit écrire uniquement le texte reconnu
sur sa sortie standard ; elle dispose de 120 secondes. Aucun moteur STT ni service payant n'est choisi automatiquement.
Le [guide de dictée locale](docs/dictee.md) fournit une installation CPU de faster-whisper, isolée du serveur Node,
avec modèle multilingue et configuration de la commande.

### Exploitation et limites

- Le terminal lance `/bin/sh -i` avec des pipes et `TERM=dumb`, **sans PTY** : les applications plein écran et les
  commandes exigeant un terminal natif ne sont pas prises en charge. Quatre terminaux peuvent être ouverts simultanément.
- L'export de contexte inclut les fichiers texte suivis par Git, dans une limite de 2 000 000 de caractères. Les secrets
  identifiables par leur nom, les fichiers binaires et les fichiers trop volumineux sont exclus ; `skipped` et `complete`
  rendent ces exclusions explicites.
- La PWA nécessite HTTPS ou localhost et un navigateur compatible. Elle fournit un écran de déconnexion hors ligne ;
  les conversations, jetons et fichiers ne sont pas mis en cache pour travailler sans serveur.
- Les évaluations comparent la présence d'un texte attendu dans les réponses et leur durée. Elles servent au classement
  des agents, sans constituer une mesure générale de qualité. Tokens et coûts manquants restent **inconnus**.
- Une sauvegarde couvre **SQLite et les pièces jointes**, avec empreintes et contrôle d'intégrité. Elle exclut les dossiers
  des projets, les worktrees et la configuration contenant les accès. Leur sauvegarde reste séparée. La restauration
  exige l'arrêt des sessions, crée une copie de sécurité, ferme connexions et terminaux, puis laisse le service en
  maintenance jusqu'à son redémarrage. Elle exige un schéma compatible ; ce n'est pas une migration entre versions.
- L'activation HTTPS pilote `tailscale serve` sur un hôte où Tailscale est installé, authentifié et autorisé. Elle
  n'installe pas Tailscale et n'inscrit pas automatiquement la machine dans un tailnet.

Ces fonctions et les tests simulés décrivent le code disponible. Ils ne constituent pas une qualification des CLI réels,
des appareils mobiles, du serveur preprod ou de la production ; ces vérifications doivent être rapportées séparément.

## Interface : libraries.dev à plein régime

Les 7 bibliothèques de [libraries.dev](https://libraries.dev) (MIT) sont utilisées, chacune pour un rôle précis :

| Bibliothèque | Où |
|---|---|
| **Bot avatars** (`bot-avatars`) | Une identité 3D par agent : Claude = chat à lunettes rondes, Codex = goutte au casque, Cursor = cube à lunettes noires, OpenCode = rond au bonnet, AvityOne = droïde à nœud papillon. Ils travaillent, attendent ou dorment selon l'état réel. |
| **Thinking orbs** (`thinking-orbs`) | Un état d'orbe par action en cours : lecture/recherche → *searching*, édition → *shaping*, commande → *working*, réflexion → *solving*, plan → *weaving*, rédaction → *composing*, attente de validation → *breathing*. |
| **Border beam** (`border-beam`) | Halo pulsé sur les autorisations (*sunset*) et la validation de plan (*ocean*), lueur autour de la barre « Plan prêt », trait sous la session active, pilule de statut, champ de connexion. |
| **Liquid metal** (`metal-fx`) | Bouton d'envoi (chromatique, reflets sur les puces voisines, déformation au survol), « Exécuter le plan » en or, logo en `MetalText`, badge `MetalBadge`. |
| **Gooey** (`liquid-gooey`) | Sélecteur de mode à goutte qui glisse (*move*), menu « + » qui s'éclate en gouttes (*morph*), avatars des sous-sessions parallèles qui se séparent puis refusionnent au merge. |
| **Voice** (`voice-glow`) | Dictée avec langue sélectionnable et lueur réactive au micro ; reconnaissance du navigateur ou transcription serveur configurée. Le balayage *Processing* est reconstruit sur l'API publique `motion` pendant que l'agent travaille. |
| **Image generation** (`img-fx`) | Couverture générative de chaque projet révélée par le shader (connexion, nouvelle session), chargée à la demande. |

Assets construits pour compléter, dans le même thème : jeu d'icônes, logo, couvertures procédurales (SVG rastérisé pour le shader), visionneuse de diff, styles markdown, menus et dialogues.

Sans WebGL matériel (GPU absent ou désactivé, rendu logiciel), l'interface reste entièrement utilisable. Les couvertures `img-fx` s'affichent en image statique et les
éléments `metal-fx` en version simple. Les autres effets dessinent en canvas 2D et ne changent pas.

## Configuration

`~/.avityone/config.json` (ou `$AVITY_HOME/config.json`) surcharge les valeurs de [`src/config.ts`](src/config.ts).
Le jeton aléatoire est créé au premier lancement. **Administration → Configuration** permet de modifier les options
validées ; les valeurs sensibles sont masquées. Un changement d'adresse ou de port nécessite un redémarrage.

| Option | Défaut et effet |
|---|---|
| `host`, `port` | `0.0.0.0`, `7710` : écoute HTTP. |
| `projectsDir` | `~/projects` : dossiers créés et point de départ du sélecteur. |
| `agents` | Catalogue Claude, Codex, Cursor, OpenCode : `name`, `cmd`, `args`, `strengths`, avec `env`, `authMethod` et `quota` facultatifs. |
| `agents.<id>.quota` | Absent par défaut. `{ "cmd": "/chemin/vers/lecteur-quota", "args": [], "env": {} }` : commande locale donnant le quota réel du fournisseur, exécutée sans shell depuis `AVITY_HOME`. `timeoutMs` facultatif : 5 000 ms par défaut, de 1 000 à 30 000 ms. |
| `defaultAgent`, `routes` | `claude` ; règles regex ordonnées définies dans le fichier source. |
| `routing` | `{ "strategy": "rules", "agent": "", "model": "", "fallback": true }`. Stratégies `rules`, `performance`, `llm` ; classifieur par défaut = agent du résumeur. |
| `reviewer` | Claude → Codex, Codex → Claude, Cursor → Codex, OpenCode → Claude. Le relecteur doit différer de l'auteur. |
| `summarizer`, `summarizeEvery` | `{ "agent": "claude", "model": "haiku" }`, `4` réponses. |
| `autoApprove` | `true` ; les actions risquées en mode plan et la sortie du mode plan restent soumises à autorisation. |
| `parallel`, `globalConcurrency` | `4` tâches par plan ; `3` requêtes ACP simultanées au total, y compris revues, résumés et routage LLM. |
| `idleTimeoutMs` | `300000` : fermeture d'une connexion d'agent inactive. |
| `stallTimeoutMs` | `600000` : interruption d'un agent sans activité ; l'attente d'une autorisation utilisateur est distincte. |
| `agentTimeoutMs` | `120000` : délai des échanges ACP hors prompt, dont l'initialisation. |
| `validationTimeoutMs` | `300000` : délai d'une commande de préparation ou de validation. |
| `prepareCommand` | `""` : avec `package-lock.json` et sans `node_modules`, exécute `npm ci --ignore-scripts`. Une commande explicite permet de préparer une autre pile. |
| `validationCommands` | `[]` : `git diff --check`, puis les scripts npm existants `check`, `lint`, `test`, `build`. Une liste explicite remplace cette détection. |
| `mcpServers` | `[]` : serveurs stdio supplémentaires, chacun avec `name`, `command`, `args`, `env`, `enabled`. Serena et Context7 doivent être installés/configurés par l'opérateur. |
| `budgets` | `{ "dailyTokens": 0, "dailyCostUsd": 0, "requireUsage": false }`. Zéro désactive le plafond ; seules les métriques rapportées sont comptées. `requireUsage` bloque les exécutions suivantes si un plafond configuré ne peut plus être vérifié. |
| `transcription` | `{ "command": "", "args": [] }` : moteur STT serveur désactivé tant qu'aucune commande n'est configurée. |

Un worktree est un checkout neuf : les fichiers ignorés (`.env`, secrets, caches…) ne sont pas copiés. La préparation
automatique installe les dépendances npm sans scripts d'installation ; configure une commande adaptée si le projet en
exige. Les autres piles nécessitent des commandes de préparation et de validation explicites.

La vérification d'un agent lance aussi sa commande de quota, si elle est configurée. Elle doit écrire sur stdout un
objet JSON `{ "remaining": 100, "limit": 200, "unit": "requêtes", "resetAt": "2026-11-01T00:00:00Z" }` ;
`resetAt` est facultatif, les nombres doivent être finis et positifs ou nuls, et `limit` doit être supérieur ou égal
à `remaining`. La commande est limitée à 5 secondes par défaut (`timeoutMs` configurable) et 64 Kio de sortie. La mesure expire après 5 minutes, à la date
de remise à zéro ou après modification de la source. Un quota frais épuisé bloque les nouveaux prompts ; absence de
source, erreur ou mesure expirée donnent **inconnu**. Le raccordement et l'exactitude de cette commande dépendent du
fournisseur : AvityOne ne déduit pas son quota des tokens facturés. Les [sources fournies](docs/quotas.md) raccordent
Codex, Claude et Cursor à leurs mesures de compte. Cursor détaille ses différentes réserves. Pour OpenCode,
la source vérifie le modèle global et explique l'absence de plafond publié lorsque l'accès est anonyme gratuit.
Les réponses peuvent fournir `details`, ou `status: "unknown"` avec `remaining` et `limit` nuls et une `reason` explicite.

## Développement

```bash
npm ci             # dépendances de dev et UI verrouillées ; aucune dépendance runtime serveur
npm test           # tests de bout en bout contre un agent ACP simulé (test/fake-agent.mjs)
npm run check      # tsc strict
npm run build      # compile l'UI dans web/dist (fait aussi par deploy/install.sh)
npm run dev        # serveur avec rechargement
npm run dev:web    # UI Vite avec rechargement à chaud (proxy /api vers :7710)
```

Node 24 exécute le TypeScript du serveur directement (type stripping) : pas de build, pas de dépendance runtime. Seule l'UI se compile.
La suite utilise des `AVITY_HOME` et dépôts temporaires, des agents ACP simulés et un transcripteur simulé. Elle couvre
notamment la persistance/reprise, les garde-fous de fusion, les frontières de fichiers, la mémoire, les médias et
l'administration. Avant un commit : `npm run check && npm test && npm run build`.

| Fichier | Rôle |
|---|---|
| [`src/acp.ts`](src/acp.ts) | Client ACP, modes/options/commandes, délais et annulation, limite globale des prompts, métriques |
| [`src/hub.ts`](src/hub.ts) | Connexions, permissions, file durable, plans, résultats, validations et revues avant fusion |
| [`src/orchestration.ts`](src/orchestration.ts) | Schéma des plans/jobs/artefacts/remarques, validation du graphe de dépendances et ordre par fichiers |
| [`src/context.ts`](src/context.ts) | Context pack sélectionnable, état git, transcript, résumés et consolidation mémoire |
| [`src/knowledge.ts`](src/knowledge.ts) | Indexation incrémentale, extraction documentaire, historique, faits et graphe temporel |
| [`src/projects.ts`](src/projects.ts) | Cycle de vie des projets, chemins sûrs, dossiers, brief et instructions |
| [`src/worktree.ts`](src/worktree.ts) | Worktrees, préparation, commandes annulables, diffs et blocs de fusion |
| [`src/workspace.ts`](src/workspace.ts) | Explorateur/éditeur, staging et rejet des changements, contexte du dépôt, terminaux |
| [`src/router.ts`](src/router.ts) | Routage par règles, performances ou LLM et candidats de bascule |
| [`src/agents.ts`](src/agents.ts) | Catalogue, installation/connexion, disponibilité, lecture des quotas, commandes natives et évaluations |
| [`src/admin.ts`](src/admin.ts) | Usage/budgets/quotas/traces, sauvegarde/restauration et accès Tailscale |
| [`src/attachments.ts`](src/attachments.ts) | Téléversement, stockage et conversion des pièces en blocs ACP |
| [`src/speech.ts`](src/speech.ts) | Adaptateur de transcription serveur avec fichier temporaire et délai |
| [`src/config.ts`](src/config.ts) | Défauts, validation/persistance des options et rotation du jeton |
| [`src/cli.ts`](src/cli.ts) | Client terminal : demandes, plans, file, validation, revue, sélection et fusion |
| [`src/mcp.ts`](src/mcp.ts) | Serveur MCP mémoire injecté dans chaque agent |
| [`src/store.ts`](src/store.ts) | SQLite/FTS5, recherche hybride avec projection LSA et métadonnées des connaissances |
| [`src/server.ts`](src/server.ts) | API HTTP, SSE, UI statique, auth |
| [`web/src/`](web/src/) | UI React : `App`, `Feed`, `Composer`, `Sidebar`, `SessionMenu`, `Panel`, `Workbench` (outils), `Administration`, `Media`, `uploads`, `brand`, `icons`, `ui` |
| [`web/public/`](web/public/) | Manifest PWA, service worker et écran hors ligne sans cache de données privées |

## Feuille de route et versions

| Document | Contenu |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Fonctions prévues par domaine : agents et routage, plans et orchestration, git et fusion, environnement de développement, mémoire, projets, sessions, multimodalité, notifications, mobile, administration, CLI. |
| [CHANGELOG.md](CHANGELOG.md) | Ce qui a été livré, version par version. |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Recherche GitHub et choix des briques open source. |
