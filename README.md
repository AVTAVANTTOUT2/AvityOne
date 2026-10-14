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

## Ce que fait le prototype (v0.1)

| Fonction | Détail |
|---|---|
| **4 agents en CLI** | Claude Code, Codex, Cursor, OpenCode, via ACP. Ajouter un agent ACP (Gemini, Goose…) = 3 lignes de config. |
| **Routage** | `@claude` / `@codex` / `@cursor` / `@opencode` pour forcer, sinon règles regex éditables (plan/archi → Claude, bug/tests → Codex, UI → Cursor, questions → OpenCode). La continuité de session prime. |
| **Mode Plan** | `/plan` ou le bouton Plan : l'agent passe dans son mode lecture seule natif (`plan`, `read-only`…). Les éditions demandent ton accord. Puis **Exécuter le plan**, avec le même agent ou un autre. |
| **Revue croisée** | Le `git diff` est relu par un *autre* modèle (Claude écrit → Codex relit, et inversement), puis « Appliquer les corrections ». |
| **Worktree isolé** | Case « worktree » par session : au premier tour en mode agent, l'agent est relancé dans `.avity/worktrees/<session>` sur la branche `avity/<session>` (exclue du `git status` du projet). Projets non git : inchangé. |
| **Exécution parallèle** | « Exécuter en parallèle » découpe le dernier plan (entrées du plan de l'agent, sinon liste numérotée) en sous-sessions, au plus `parallel` (4), chacune dans son worktree avec l'agent choisi par le routeur, le plan global et sa tâche en contexte. Leur état s'affiche dans la session parente. |
| **Merge** | « Merger » commite le travail de chaque worktree, merge les branches dans la branche courante du projet, signale les conflits (merge annulé, worktree conservé), nettoie les worktrees mergés, puis lance une revue croisée du diff combiné. |
| **Contexte inter-sessions** | À chaque nouvelle session d'agent, un *context pack* est injecté : brief `.avity/brief.md`, état git, mémoires pertinentes (FTS5), extraits de docs, résumés des 3 dernières sessions. |
| **Reprise multi-agents** | Changer d'agent en cours de route (`@codex continue`) transmet le transcript au nouvel agent. |
| **Résumés + mémoire** | Toutes les 4 réponses, à l'ouverture d'une nouvelle session, ou sur « Résumer » : un modèle léger (Haiku) résume la session et extrait décisions, conventions, pièges, faits et todos. Le tout est dédupliqué. |
| **Mémoire partagée MCP** | Chaque agent reçoit le serveur MCP `avity` (`avity_memory_search`, `avity_memory_add`, `avity_recent_sessions`). Ce que Codex apprend, Claude le sait. |
| **Base de connaissance** | Indexation des `.md/.txt` du projet (README, docs/, AGENTS.md, `.serena/memories`…) en FTS5, plus recherche dans l'UI. |
| **UI type Cursor** | Projets et sessions, flux en streaming (messages, réflexions, outils, diffs, plans, permissions), sélecteur de modèle et d'effort exposé par chaque agent, panneau mémoire et aperçu du contexte injecté. Utilisable sur mobile. |
| **Permissions** | Auto-approbation configurable. La validation de plan et les éditions en mode plan te reviennent toujours. |

## Installation (Debian 13)

```bash
git clone https://github.com/AVTAVANTTOUT2/AvityOne.git ~/avityone && cd ~/avityone
bash deploy/provision.sh   # Node 24, git, ripgrep, CLIs d'agents + adaptateurs ACP
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

## Utilisation

- **UI** : `http://<serveur>:7710`. Crée un projet (dossier existant, URL git à cloner ou dossier vide pour un projet « vie »), ouvre une session et écris.
- **CLI** : `avity ask -p monprojet "/plan migrer l'auth vers des sessions"`, `avity memory monprojet auth`, `avity sessions monprojet`.
- **Brief projet** : écris `.avity/brief.md` dans le projet (objectifs, stack, contraintes). Il est injecté en tête de chaque session.

## Configuration

`~/.avityone/config.json` (créé au premier lancement avec un token aléatoire) surcharge les valeurs par défaut de
[`src/config.ts`](src/config.ts) : `port`, `agents`, `routes`, `defaultAgent`, `reviewer`, `summarizer`,
`summarizeEvery`, `autoApprove`, `parallel`.

Un worktree est un checkout neuf : les fichiers ignorés par git (`node_modules`, `.env`…) n'y sont pas, l'agent doit
installer les dépendances lui-même.

## Développement

```bash
npm install        # seulement typescript + @types/node (dev)
npm test           # tests de bout en bout contre un agent ACP simulé (test/fake-agent.mjs)
npm run check      # tsc strict
npm run dev        # serveur avec rechargement
```

Node 24 exécute le TypeScript directement (type stripping) : pas de build, pas de dépendance runtime.

| Fichier | Rôle |
|---|---|
| [`src/acp.ts`](src/acp.ts) | Client ACP (JSON-RPC stdio), sessions, modes, options, one-shot |
| [`src/hub.ts`](src/hub.ts) | Orchestrateur : connexions vivantes, items, permissions, plan/exécution/revue |
| [`src/context.ts`](src/context.ts) | Indexation docs, état git, context pack, transcript, résumés + extraction de mémoire |
| [`src/worktree.ts`](src/worktree.ts) | Worktrees git par session : création, commit, merge, nettoyage |
| [`src/router.ts`](src/router.ts) | Choix agent + mode |
| [`src/mcp.ts`](src/mcp.ts) | Serveur MCP mémoire injecté dans chaque agent |
| [`src/store.ts`](src/store.ts) | SQLite + FTS5 |
| [`src/server.ts`](src/server.ts) | API HTTP, SSE, UI statique, auth |
| [`web/`](web/) | UI (vanilla JS, aucun build) |

## Feuille de route

Recherche GitHub et choix de briques : [docs/RESEARCH.md](docs/RESEARCH.md).

1. ✅ **Worktrees git par session** et exécution parallèle (un plan découpé en tâches réparties sur plusieurs agents, puis merge et revue). Inspiré de vibe-kanban et claude-squad. Suite possible : regrouper les tâches par fichiers touchés plutôt que par ordre, résolution de conflits assistée par un agent.
2. **Recherche hybride** : embeddings via `sqlite-vec` à côté de FTS5, plus un index sémantique du code.
3. **Consolidation de la mémoire** façon mem0 (mise à jour et suppression des faits contradictoires), export markdown versionnable.
4. **Routeur LLM**, en plus des règles, avec retour d'expérience (quel agent réussit quel type de tâche).
5. **code-server** à côté pour l'édition manuelle, HTTPS et Tailscale, PWA mobile, traces Langfuse.
6. Arrêt des processus d'agents inactifs, pièces jointes et images, slash-commands ACP.
