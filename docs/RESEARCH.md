# Recherche open source : briques réutilisables

Relevé via l'API GitHub le **2026-10-14** (étoiles, dernier push, licence). Légende :
**✅ utilisé** dans AvityOne · **🔜 à intégrer** (feuille de route) · **💡 inspiration** (patterns repris, pas de code) · **⛔ écarté**.

## 1. Intégration des agents : le choix structurant

Tous les agents visés parlent désormais **ACP (Agent Client Protocol)** : JSON-RPC sur stdio, avec sessions,
streaming, appels d'outils, plans, modes (dont `plan`), choix du modèle et permissions. C'est ce qu'utilisent Zed
et JetBrains. AvityOne est donc un *client ACP*, au lieu de piloter des terminaux ou d'analyser quatre formats JSON
différents.

| Projet | ★ | Push | Licence | Verdict |
|---|---:|---|---|---|
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | 4.4k | 2026-10-14 | Apache-2.0 | ✅ protocole d'intégration unique (client implémenté dans `src/acp.ts`) |
| [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) | 2.6k | 2026-10-14 | Apache-2.0 | ✅ adaptateur Claude Code (Agent SDK) |
| [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp) | 455 | 2026-10-14 | — | ✅ adaptateur Codex (remplace `zed-industries/codex-acp`, archivé) |
| Cursor CLI `agent acp` ([docs](https://cursor.com/docs/cli/acp)) | — | — | propriétaire | ✅ ACP natif, modes agent/plan/ask |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 213k | 2026-10-14 | MIT | ✅ `opencode acp` natif |
| [openai/codex](https://github.com/openai/codex) | 129k | 2026-10-14 | Apache-2.0 | ✅ CLI sous-jacente |
| [aaif-goose/goose](https://github.com/aaif-goose/goose) | 55k | 2026-10-14 | Apache-2.0 | 🔜 candidat 5ᵉ agent (ACP natif) |
| [coder/agentapi](https://github.com/coder/agentapi) | 1.5k | 2026-09-13 | MIT | ⛔ **archivé**, pilotage par émulation terminal (ACP le remplace) |

## 2. Orchestration multi-agents et UI

| Projet | ★ | Push | Licence | Verdict |
|---|---:|---|---|---|
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28.4k | 2026-09-19 | Apache-2.0 | 💡🔜 référence : tâches kanban, **un worktree git par tentative**, revue de diff, lancement de n'importe quel agent. Modèle pour l'exécution parallèle. |
| [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | 14.1k | 2026-10-12 | AGPL-3.0 | 💡 UI web et mobile pour Claude, Cursor, Codex et OpenCode. AGPL : on reprend l'UX, pas le code. |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8.6k | 2026-08-20 | AGPL-3.0 | 💡 tmux et worktrees par agent |
| [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | 1.4k | 2026-10-14 | Apache-2.0 | 💡 superviseur et workers (handoff, assign, send_message), déjà dans ton outillage (`cao-ops-mcp`) |
| [slopus/happy](https://github.com/slopus/happy) | 24.1k | 2026-10-14 | MIT | 🔜 client mobile pour Claude et Codex : piste pour le pilotage depuis le téléphone |
| [coder/code-server](https://github.com/coder/code-server) | 79.6k | 2026-10-14 | MIT | 🔜 VS Code dans le navigateur, sur la même VM, pour l'édition humaine |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 37.7k | 2026-10-10 | MIT | 💡 routage par type de requête (background, think, long contexte) |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 61k | 2026-10-14 | — | 🔜 si on ajoute des appels LLM directs (routeur LLM, embeddings) |
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 90.9k | 2026-10-14 | MIT | 💡 *condensers* : compression de l'historique d'agent |
| [stravu/crystal](https://github.com/stravu/crystal) (→ Nimbalyst) | 3.1k | 2026-02-26 | MIT | ⛔ peu actif |
| [ruvnet/ruflo](https://github.com/ruvnet/ruflo) (ex claude-flow) | 74.7k | 2026-10-14 | MIT | ⛔ « swarms » lourds et opaques, à l'opposé du contrôle recherché |
| [rivet-dev/agents](https://github.com/rivet-dev/agents) | 1.6k | 2026-10-14 | Apache-2.0 | 💡 un processus durable par agent, mémoire qui survit aux redémarrages |

## 3. Contexte, mémoire, base de connaissance

| Projet | ★ | Push | Licence | Verdict |
|---|---:|---|---|---|
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 100.7k | 2026-10-13 | Apache-2.0 | 💡 même boucle qu'AvityOne (capture → compression → réinjection). Référence pour la compression progressive. |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 67k | 2026-10-14 | Apache-2.0 | 🔜 consolidation de mémoire (ADD, UPDATE, DELETE de faits par LLM). Prochaine étape après la déduplication exacte. |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 31.7k | 2026-10-14 | Apache-2.0 | 🔜 graphe de connaissances **temporel** (faits datés et invalidés) : idéal pour le volet « vie » (personnes, événements) |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | 32.3k | 2026-10-14 | Apache-2.0 | 💡 mémoire graphe et vecteurs, alternative à Graphiti |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 25.1k | 2026-09-10 | Apache-2.0 | 💡 concept *core memory / archival memory* (MemGPT) |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | 4.2k | 2026-10-14 | AGPL-3.0 | 💡 markdown comme source de vérité via MCP. Futur export `.avity/memory/`. |
| [oraios/serena](https://github.com/oraios/serena) | 30.3k | 2026-10-14 | — | ✅ `.serena/memories` indexé dans la base de connaissance. 🔜 à injecter comme MCP dans chaque agent (navigation sémantique par LSP). |
| [upstash/context7](https://github.com/upstash/context7) | 63k | 2026-10-14 | MIT | 🔜 MCP de documentation à jour, à injecter dans chaque agent |
| [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | 12.6k | 2026-07-14 | MIT | 🔜 index sémantique du code (MCP), sinon équivalent maison avec sqlite-vec |
| [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) | 8.2k | 2026-05-18 | Apache-2.0 | 🔜 vecteurs dans le même SQLite : recherche hybride FTS5 + embeddings |
| [yamadashy/repomix](https://github.com/yamadashy/repomix) | 28.8k | 2026-10-11 | MIT | 🔜 pack du dépôt pour les revues globales |
| [mksglu/context-mode](https://github.com/mksglu/context-mode) | 28.9k | 2026-10-14 | — | 💡 sandbox des sorties d'outils, compatible côté agents |
| [coleam00/Archon](https://github.com/coleam00/Archon) | 23.7k | 2026-10-14 | MIT | 💡 workflows déterministes autour des agents de code |
| [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 2k | 2026-10-14 | Apache-2.0 | ⛔ redondant avec notre serveur MCP |

## 4. Planification et qualité

| Projet | ★ | Push | Licence | Verdict |
|---|---:|---|---|---|
| [github/spec-kit](https://github.com/github/spec-kit) | 141k | 2026-10-14 | MIT | 🔜 spec → plan → tâches : le mode Plan d'AvityOne pourra produire des artefacts spec-kit |
| [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer) | 11.7k | 2026-06-19 | — | 💡 « research → plan → implement » pour les grosses bases de code |
| [eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master) | 28.2k | 2026-04-28 | — | 💡 PRD → tâches. Moins actif. |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | 35.8k | 2026-10-14 | — | 🔜 traces et évaluations des sessions |

## Décisions

1. **ACP plutôt que le parsing de CLI ou des surcouches** : un seul client pour les 4 agents, avec les modes plan natifs, les
   permissions et le choix du modèle. Chaque fournisseur maintient son adaptateur ; on suit leurs mises à jour sans rien réécrire.
2. **Mémoire et contexte maison, minimalistes** (SQLite FTS5 dans `node:sqlite`, aucune dépendance). C'est le cœur du
   produit, donc on le possède. Les briques lourdes (mem0, Graphiti, sqlite-vec) se branchent derrière la même interface
   `searchMemory` et `addMemory` quand le besoin est mesuré.
3. **MCP comme bus de mémoire** : le même serveur `avity` est injecté dans chaque agent. Aucun agent n'est privilégié.
4. **Licences** : aucun code AGPL copié (claudecodeui, claude-squad, basic-memory restent des inspirations).
