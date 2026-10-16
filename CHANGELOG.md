# Changelog

Toutes les évolutions notables d'AvityOne. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon [SemVer](https://semver.org/lang/fr/). Les fonctions à venir sont dans la [feuille de route](ROADMAP.md).

## [Non publié]

### Ajouté

- Quotas Cursor issus des compteurs natifs, avec réserves distinctes et prise en compte des crédits et restrictions.
- Vérification du contexte anonyme OpenCode : modèle global et tarif catalogue nul vérifiés, plafond non publié signalé explicitement.
- Détails fournisseur persistés et délai configurable par source de quota, de 1 à 30 secondes.
- Sources de quotas réels pour Codex et Claude, sans convertir les statistiques locales en solde fournisseur.
- Installation isolée d'une dictée CPU avec faster-whisper et modèle multilingue, sans dépendance runtime Node.
- **Administration des agents** : installation et connexion de Claude Code, Codex, Cursor et OpenCode depuis le
  catalogue, vérification ACP de disponibilité, affichage des erreurs d'authentification, commandes natives et
  autocomplétion. Les résultats absents ou non exposés restent inconnus.
- **Routage configurable** : éditeur graphique des règles et de leur ordre, sélection par évaluations mesurées ou
  par un agent LLM, bascule après échec de connexion avant l'envoi du travail. Configuration des serveurs MCP stdio
  supplémentaires, dont Serena et Context7 lorsqu'ils sont installés sur l'hôte.
- **Plans et orchestration durables** : édition de la spécification et des étapes, sélection/réorganisation,
  dépendances validées, fichiers concernés et agent par tâche. File SQLite persistante, limitation du parallélisme
  global, reprise des demandes en attente, relance explicite des tentatives interrompues ou échouées, résultats
  structurés transmis aux successeurs, synthèse et artefacts persistants. Fermeture des connexions inactives,
  interruption des agents bloqués et annulation des commandes de préparation.
- **Validation et fusion** : préparation des dépendances des worktrees, exécution suivie des tests/lint/build,
  revue croisée obligatoire avant fusion et suivi des remarques avec justification des corrections. Comparaison
  et sélection de branches, fichiers ou blocs ; préparation du résultat dans un worktree temporaire et
  intégration atomique après contrôle. Les conflits disposent d'une résolution assistée dans la sous-session.
- **Outils du dépôt** : explorateur, éditeur avec contrôle de révision, terminal `/bin/sh` avec pipes, comparaison
  globale, staging ou annulation par fichier/bloc et export du contexte textuel du dépôt avec exclusions explicites.
- **Mémoire et documents** : recherche hybride FTS5/LSA locale bornée, indexation du code et des documents par
  empreintes, consolidation automatique des doublons, édition et historique restaurable, export Markdown,
  métadonnées de personnes/événements/faits et graphe temporel. Les valeurs structurées contradictoires et les
  dates de validité dépassées sont signalées. Import PDF/DOCX/ODT/PPTX/XLSX, lecture du texte complet et
  téléchargement de la source originale ; extraction avec `pdftotext` ou `unzip` selon le format.
- **Contexte sélectionnable** : choix des connaissances et sources, édition du complément injecté à la prochaine
  connexion d'agent ; les résumés et sources continuent de signaler leurs échecs de chargement.
- **Gestion des projets** : recherche, renommage, archivage, retrait conservant les dossiers, sélecteur de dossiers
  du serveur et édition du brief ainsi que des instructions `AGENTS.md`.
- **Pièces jointes et multimodalité** : sélection ou glisser-déposer, jusqu'à huit fichiers de 5 Mio par demande,
  images/audio/ressources ACP et affichage natif des réponses prises en charge. Conservation des pièces lors de
  la modification, de la régénération et de la bifurcation ; contexte multimédia récent lors d'un changement d'agent.
- **PWA et dictée** : manifest et service worker sans cache des données privées, interface mobile pour les options
  et plans parallèles, six langues de dictée. Enregistrement et transcription par commande serveur configurée
  lorsque le navigateur n'offre pas de reconnaissance native.
- **Exploitation intégrée** : configuration globale validée, déconnexion, rotation du jeton et révocation des
  accès, pilotage HTTPS Tailscale, sauvegarde SQLite et pièces jointes avec empreintes. Restauration contrôlée avec
  copie de sécurité et maintenance jusqu'au redémarrage ; fichiers des projets et configuration exclus.
  Traces d'exécution, tokens/coûts rapportés, budgets locaux et évaluations comparatives sur réponse attendue.
- Quotas par agent via une commande fournisseur configurée et un JSON validé, avec délai, expiration et état
  inconnu explicite. Un quota frais épuisé bloque les nouveaux prompts ; aucun quota n'est inventé sans source.
- Provisionnement de `poppler-utils` et `unzip` pour les extractions PDF et bureautiques.
- **CLI d'orchestration** : `plan` avec import JSON, `execute`, `parallel`, `queue`, `jobs`, `retry`, `artifacts`,
  `isolate`, `preview`, `validate`, `review`, `conflicts` et `merge` avec sélection des branches/fichiers/blocs.
- **Tests simulés supplémentaires** : reprise après arrêt d'un processus, concurrence et annulation, mutations
  de commits pendant validation, contrôles bloquants, sélection de blocs, fichiers Unicode, métadonnées et
  extractions documentaires, multimédia, administration et transcription. Les tests locaux restent distincts
  des vérifications des agents réels, des appareils, de la CI distante et des environnements déployés.
- **`AGENTS.md`** (importé par `CLAUDE.md`) : règles de code, workflow git, déploiement et pièges, pour tous les agents.
- **CI/CD preprod → prod** : CI GitHub Actions (types, tests, build) sur les PR vers `preprod` et `main` ; chaque merge
  sur `preprod` redéploie la VM preprod, chaque merge `preprod` → `main` redéploie la prod (`deploy/autodeploy.sh`).
- **Gestion des sessions** : menu « ⋯ » dans l'en-tête de la session pour renommer (ou double-clic sur le titre),
  épingler, archiver et supprimer. Les sessions épinglées passent en tête de liste, les archivées sont repliées en bas.
  Un titre choisi n'est plus écrasé par les résumés automatiques ; un titre vidé revient au nommage automatique.
  La suppression emporte les sous-sessions parallèles, et elle est refusée tant qu'un worktree n'est pas mergé.
- **Recherche dans l'historique des conversations** : loupe de la liste des sessions. Messages, réponses et revues
  sont indexés en FTS5 (accents et casse ignorés, tous les mots requis, le dernier en préfixe). Un résultat ouvre la
  session sur le message trouvé. Les conversations existantes sont indexées au premier démarrage.
- **Export Markdown** d'une session (messages, réponses, plans, outils, revues), depuis le menu de la session ou avec
  `avity export <session>`.
- **Brouillons par session**, enregistrés sur le serveur : chaque session garde le sien, d'un appareil à l'autre et
  après rechargement.
- Interface ([#5](https://github.com/AVTAVANTTOUT2/AvityOne/pull/5)) : bouton « aller au dernier message », copie
  des blocs de code, réglages modèle/effort accessibles sur mobile, premier message possible dans un projet sans
  session (il en ouvre une).
- **Bifurcation et duplication** : « Bifurquer ici » sous chaque réponse ouvre une nouvelle session qui reprend la
  conversation jusqu'à ce point ; « Dupliquer » (menu « ⋯ ») la copie en entier. L'original reste intact. La copie
  repart avec un agent neuf qui reçoit le transcript copié, et sans les fichiers d'un éventuel worktree. Son en-tête
  renvoie à la session d'origine.
- **Modification et renvoi des messages** : crayon au survol d'un message. « Renvoyer » remplace la suite de la
  conversation (l'agent repart avec ce qui précède) ; « Dans une bifurcation » garde la conversation et repart de ce
  message dans une nouvelle session. Les fichiers déjà modifiés par l'agent ne sont pas restaurés.
- **Régénération** de la dernière réponse, avec le même agent ou un autre, et « Réessayer » après un tour en échec.
- **Copie** d'un message ou d'une réponse entière (en plus des blocs de code, déjà copiables depuis #5), y compris en
  HTTP simple.
- **Navigation entre sessions** : boutons ‹ › de l'en-tête et Alt+↑ / Alt+↓ dans l'ordre de la liste ; les boutons
  précédent/suivant du navigateur (et le retour Android) parcourent les sessions visitées.
- **Activité des sessions en arrière-plan** : une pastille par session et par projet signale ce qui attend ta
  validation (ambre), ce qui travaille (pulsation), et ce qui a échoué ou terminé sans que tu l'aies vu (rouge, vert).
  Le titre de l'onglet compte ce qui t'attend, par exemple « (2) AvityOne ». Une session terminée pendant une coupure
  est marquée comme telle au retour.
- **Notifications** de fin, d'échec et d'autorisation en attente, y compris pour les autres projets : un toast avec
  « Ouvrir » quand la page est affichée, une notification système quand l'onglet est en arrière-plan (cloche de
  l'en-tête, HTTPS ou localhost requis).
- **État de la connexion** : un bandeau signale la perte du serveur, puis « Reconnecté » et une resynchronisation
  (liste, session ouverte, activité). Un lien mort sans erreur visible (veille, proxy) est détecté par un battement
  toutes les 25 s, et un flux abandonné par le navigateur est rouvert avec un délai croissant.
- **Erreurs de mémoire et de contexte signalées** : une section du context pack qui ne se charge pas (brief illisible,
  mémoire ou base de connaissance indisponible, dossier introuvable) est annoncée dans la session, et l'agent démarre
  avec le reste. Un résumé automatique qui échoue (donc une mémoire qui n'est plus alimentée) est signalé dans la
  session. Les panneaux Mémoire et Contexte affichent leurs erreurs de chargement, et la réindexation nomme les
  fichiers illisibles.
- CLI : `avity search <projet> <texte>` et `avity export <session>`.
- API : `PATCH` et `DELETE /api/sessions/:id`, `PUT /api/sessions/:id/draft`, `GET /api/sessions/:id/export`,
  `GET /api/projects/:id/search?q=`, `POST /api/sessions/:id/fork` (`before` : id du message où couper),
  `POST /api/sessions/:id/edit` (`itemId`, `text`, `fork`), `POST /api/sessions/:id/regenerate` (`agent`).
  Événement SSE `reset` (`fromId`) quand une conversation est coupée. `GET /api/state` renvoie `activity` (sessions
  occupées ou en attente, tous projets) ; la liste des sessions et l'état d'une session portent `busy` et `waiting` ;
  événement SSE `activity` (`kind` : `done`, `error`, `waiting`) ; `projectId` sur les événements `state` et `item` ;
  `/reindex` et la création de projet renvoient `failed` ; `/context` renvoie `warnings`.
- `ROADMAP.md` : feuille de route par domaine (agents et routage, plans, git et fusion, environnement de développement,
  mémoire, projets, sessions, multimodalité, notifications, mobile, administration, CLI).
- `CHANGELOG.md`.

### Corrigé

- La fusion d'un worktree n'est plus impossible avec un seul agent installé : il relit alors son propre travail.
- Un document importé (`.avity/imports/`) ou un brief édité dans l'atelier ne bloque plus la fusion : tout `.avity/`
  est exclu du `git status` du projet, y compris dans les dépôts préparés par une version précédente.
- Un verdict de revue entouré de texte ou d'un bloc de code est accepté ; seule une revue défavorable bloque la fusion
  et laisse des remarques à justifier, les remarques mineures restent lisibles dans la revue.
- L'évaluation comparative lance chaque agent dans un dossier temporaire vide, et non plus dans `~/.avityone`
  (jeton, conversations).
- L'actualisation des agents remplace le résultat affiché au lieu de conserver un ancien quota en cache local.
- Les explications de quota masquent également les secrets placés dans les arguments de commande.
- L'attente d'une autorisation humaine suspend les délais d'inactivité ACP ; la reprise repart avec un délai complet.
- Un agent arrêté après expiration peut être reconnecté au tour suivant au lieu de conserver une connexion morte.
- Une fusion échouée ne laisse plus une sélection de branches partiellement intégrée : le résultat est préparé
  isolément et les worktrees restent disponibles en cas de conflit, de contrôle échoué ou de revue défavorable.
- Une commande de validation ou une revue ne peut plus changer silencieusement le commit validé puis faire
  supprimer le travail source : les fichiers et SHA sont contrôlés avant l'intégration.
- L'annulation pendant la préparation d'un worktree ou l'initialisation ACP arrête également les processus concernés.
- Les noms accentués, les espaces et les caractères échappés sont reconnus dans la sélection des modifications Git.
- Les pièces multimédias restent transmises après modification, régénération et bifurcation d'une conversation.
- Un document illisible (droits, dossier nommé `*.md`…) faisait échouer toute l'indexation, et donc la création du
  projet : il est maintenant ignoré et signalé.
- Les petits boutons icône (« + » des projets et des sessions, « Oublier » de la mémoire) n'affichaient qu'un point :
  la marge de `.chip.sm` écrasait l'icône.
- Sans WebGL (GPU désactivé ou en liste noire, navigateur verrouillé, VM), l'interface restait blanche dès l'écran de
  connexion : le shader `img-fx` levait une erreur non rattrapée. La couverture statique le remplace désormais, aussi
  en rendu WebGL logiciel (SwiftShader, llvmpipe), où les shaders figeaient la page. Une error boundary contient les
  échecs tardifs du renderer. `metal-fx` n'est plus monté sans WebGL matériel : son repli laissait un contour
  « AvityOne » en haut à gauche de la page ([#5](https://github.com/AVTAVANTTOUT2/AvityOne/pull/5),
  [#7](https://github.com/AVTAVANTTOUT2/AvityOne/pull/7)).
- Interface ([#5](https://github.com/AVTAVANTTOUT2/AvityOne/pull/5)) : menu de choix de l'agent rogné par le
  composer, chemin de projet mal affiché, chronomètre aberrant au premier tour, outils restés « en cours » après un
  arrêt, double envoi des autorisations, ouvertures de session concurrentes. Sur mobile : menu latéral refermable,
  zoom iOS sur les champs, zone de l'indicateur d'accueil (safe area), débordements horizontaux.

### Modifié

- Le battement du flux SSE est un événement nommé `ping` (au lieu d'un commentaire), pour que la page puisse le voir.
- README : fonctions de la version non publiée, commandes CLI, options par défaut, modules et limites opérationnelles.
- La revue croisée est exécutée **avant** la fusion ; les validations et l'identité du résultat sont bloquantes.
- La préparation npm des worktrees utilise `npm ci --ignore-scripts` lorsqu'un lockfile existe et que les dépendances
  sont absentes ; les autres piles disposent de commandes configurables.
- `docs/RESEARCH.md` : la légende 🔜 renvoie vers `ROADMAP.md`.

## [0.2.0] - 2026-10-14

### Ajouté

- **Worktrees git par session** ([#2](https://github.com/AVTAVANTTOUT2/AvityOne/pull/2)) : avec l'option « worktree »,
  au premier tour en mode agent, l'agent est relancé dans `.avity/worktrees/<session>` sur la branche
  `avity/<session>`, exclue du `git status` du projet. L'état git, le diff et le context pack suivent le worktree.
  Projets non git : comportement inchangé.
- **Exécution parallèle** ([#2](https://github.com/AVTAVANTTOUT2/AvityOne/pull/2)) : « Exécuter en parallèle » répartit
  le dernier plan (entrées du plan de l'agent, sinon liste numérotée) en sous-sessions isolées, au plus `parallel` (4).
  L'agent de chaque tâche est choisi par le routeur, avec le plan global et sa tâche en contexte. L'état des
  sous-sessions s'affiche dans la session parente.
- **Merge** ([#2](https://github.com/AVTAVANTTOUT2/AvityOne/pull/2)) : commit du travail de chaque worktree, merge dans
  la branche courante, conflits signalés (merge annulé, worktree conservé), nettoyage des worktrees mergés, puis revue
  croisée du diff combiné.
- **Interface premium** ([#3](https://github.com/AVTAVANTTOUT2/AvityOne/pull/3)) avec les 7 bibliothèques
  libraries.dev : `bot-avatars` (identité 3D par agent), `thinking-orbs` (état par action), `border-beam`
  (autorisations, plan prêt, statut), `metal-fx` (envoi, « Exécuter le plan », logo), `liquid-gooey` (mode, menu +,
  sous-sessions parallèles), `voice-glow` (dictée, balayage « Processing »), `img-fx` (couvertures génératives).
- Assets dans le thème : icônes, logo, couvertures procédurales, visionneuse de diff, menus.
- Garde-fou `metal-fx` : rendu normal si le premier frame WebGL n'arrive pas.
- Tests sur un dépôt git temporaire avec l'agent simulé : isolation, parallèle, conflit, revue.

### Modifié

- UI réécrite en React + Vite (`web/src`), servie depuis `web/dist`. Le serveur reste sans dépendance runtime.
- `deploy/install.sh` compile l'UI ; les assets hashés sont servis en cache immuable.
- La configuration de test n'utilise plus jamais un vrai agent installé.

### Supprimé

- Ancienne UI sans framework (`web/app.js`, `web/style.css`).

## [0.1.0] - 2026-10-14

Prototype initial ([#1](https://github.com/AVTAVANTTOUT2/AvityOne/pull/1)).

### Ajouté

- Client ACP (JSON-RPC sur stdio) pour Claude Code, Codex, Cursor et OpenCode.
- Routeur : mentions `@agent`, `/plan`, règles regex, continuité de session.
- Hub : sessions vivantes, streaming d'items, permissions, plan → exécution → revue croisée.
- Moteur de contexte : brief, état git, mémoire FTS5, base de connaissance des docs, résumés de sessions et extraction
  de mémoire, reprise inter-agents.
- Serveur MCP `avity` injecté dans chaque agent (mémoire partagée).
- API HTTP + SSE, UI web 3 panneaux, CLI `avity`.
- Provisioning Debian 13 et service systemd.
- Tests de bout en bout contre un agent ACP simulé.
- `docs/RESEARCH.md` : relevé des briques open source réutilisables.

