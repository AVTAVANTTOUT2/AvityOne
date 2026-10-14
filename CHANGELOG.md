# Changelog

Toutes les évolutions notables d'AvityOne. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon [SemVer](https://semver.org/lang/fr/). Les fonctions à venir sont dans la [feuille de route](ROADMAP.md).

## [Non publié]

### Ajouté

- `ROADMAP.md` : feuille de route par domaine (agents et routage, plans, git et fusion, environnement de développement,
  mémoire, projets, sessions, multimodalité, notifications, mobile, administration, CLI).
- `CHANGELOG.md`.

### Modifié

- README : la feuille de route renvoie vers `ROADMAP.md` et `CHANGELOG.md` ; le tableau des fonctions est daté v0.2.
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

