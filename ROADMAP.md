# Feuille de route

Fonctions prévues pour AvityOne, regroupées par domaine. Quand une fonction est livrée, coche sa case et ajoute-la au
[CHANGELOG](CHANGELOG.md). Les lignes « Pistes » renvoient aux briques open source relevées dans
[docs/RESEARCH.md](docs/RESEARCH.md).

## Déjà livré

- **v0.1** : orchestrateur ACP pour 4 agents (Claude Code, Codex, Cursor, OpenCode), routage par règles et mentions,
  mode plan, revue croisée, context pack, mémoire partagée MCP, base de connaissance FTS5, CLI `avity`.
- **v0.2** : worktrees git par session, exécution parallèle d'un plan, merge avec revue du diff combiné, interface
  React + libraries.dev.
- **Non publié** : gestion des sessions (renommage, épinglage, archivage, suppression, duplication), recherche dans
  l'historique des conversations, export Markdown, brouillons propres à chaque session, bifurcation, modification et
  renvoi des messages, régénération, copie des réponses et des blocs de code, navigation entre sessions ; activité
  des sessions en arrière-plan, notifications, état de la connexion, signalement des erreurs de mémoire et de contexte.

Détail dans le [CHANGELOG](CHANGELOG.md).

## Agents et routage

- [ ] Routage intelligent par LLM.
- [ ] Sélection des agents selon leurs performances.
- [ ] Vérification de l’authentification, de la disponibilité réelle et des quotas.
- [ ] Bascule automatique vers un autre agent après échec.
- [ ] Installation et connexion des agents depuis l’interface.
- [ ] Configuration graphique des règles de routage.
- [ ] Catalogue et autocomplétion des commandes natives ACP.
- [ ] Gestion des serveurs MCP supplémentaires, dont Serena et Context7.

Pistes : claude-code-router (routage par type de requête), LiteLLM (appels LLM directs), Serena et Context7 (MCP).

## Plans et orchestration

- [ ] Édition, réorganisation et sélection des étapes d’un plan.
- [ ] Gestion des dépendances entre tâches.
- [ ] Répartition des tâches selon les fichiers concernés.
- [ ] File d’attente persistante des demandes.
- [ ] Limitation globale des agents simultanés.
- [ ] Reprise des travaux après redémarrage.
- [ ] Relance ciblée des sous-tâches échouées.
- [ ] Transmission structurée des résultats entre sous-agents.
- [ ] Synthèse automatique des travaux parallèles.
- [ ] Arrêt automatique des agents inactifs.
- [ ] Détection et interruption des agents bloqués.
- [ ] Artefacts persistants « spécification → plan → tâches ».

Pistes : vibe-kanban (tâches et tentatives), rivet-dev/agents (processus durables), spec-kit (artefacts spec → plan → tâches).

## Git, validation et fusion

- [ ] Exécution et suivi des tests, du lint et du build par l’orchestrateur.
- [ ] Contrôles bloquants avant fusion.
- [ ] Revue croisée obligatoire avant fusion.
- [ ] Suivi structuré des remarques et corrections de revue.
- [ ] Sélection des fichiers et modifications à intégrer.
- [ ] Sélection individuelle des branches à fusionner.
- [ ] Résolution assistée des conflits.
- [ ] Préparation automatique des dépendances des worktrees.

## Environnement de développement

- [ ] Explorateur de fichiers.
- [ ] Éditeur de code intégré.
- [ ] Terminal interactif.
- [ ] Comparaison globale des changements avant fusion.
- [ ] Acceptation ou rejet des modifications par fichier ou bloc.
- [ ] Génération d’un contexte complet du dépôt pour les revues globales.

Pistes : code-server (édition dans le navigateur), Repomix (pack du dépôt pour les revues globales).

## Mémoire et connaissances

- [ ] Recherche hybride lexicale et sémantique.
- [ ] Indexation sémantique du code source.
- [ ] Consolidation automatique des connaissances.
- [ ] Détection des faits contradictoires ou périmés.
- [ ] Édition des connaissances existantes.
- [ ] Historique et restauration des connaissances.
- [ ] Export Markdown versionnable.
- [ ] Graphe temporel des personnes, événements et faits.
- [ ] Réindexation automatique et incrémentale.
- [ ] Import et extraction de documents PDF et bureautiques.
- [ ] Ouverture des documents sources complets.
- [ ] Sélection et modification du contexte injecté.

Pistes : sqlite-vec (vecteurs à côté de FTS5), claude-context (index sémantique du code), mem0 (consolidation),
Graphiti (graphe temporel), basic-memory (Markdown comme source de vérité).

## Projets

- [ ] Renommage, archivage et retrait des projets.
- [ ] Recherche et filtrage des projets.
- [ ] Sélecteur de dossiers.
- [ ] Édition du brief et des instructions depuis l’interface.

## Sessions et conversations

- [x] Renommage, archivage et suppression des sessions.
- [x] Épinglage des sessions.
- [x] Recherche dans l’historique des conversations.
- [x] Duplication et bifurcation des conversations.
- [x] Export des conversations.
- [x] Brouillons persistants propres à chaque session.
- [x] Modification et renvoi des messages.
- [x] Régénération des réponses.
- [x] Copie dédiée des réponses et blocs de code.
- [x] Navigation précédent/suivant entre sessions.

## Fichiers et multimodalité

- [ ] Ajout de pièces jointes.
- [ ] Envoi d’images aux agents.
- [ ] Glisser-déposer de fichiers.
- [ ] Affichage natif des réponses multimodales.

## Activité et notifications

- [x] Suivi de l’activité des sessions non sélectionnées.
- [x] Notifications de fin, d’échec et d’autorisation en attente.
- [x] Indicateur de déconnexion et de reconnexion.
- [x] Signalement des erreurs de chargement de la mémoire et du contexte.

## Mobile et dictée

- [ ] Application PWA installable.
- [ ] Sélection des modèles et options sur mobile.
- [ ] Lancement des exécutions parallèles sur mobile.
- [ ] Choix de la langue de dictée.
- [ ] Dictée sur les navigateurs sans reconnaissance vocale native.

Pistes : happy (client mobile pour Claude et Codex).

## Administration et exploitation

- [ ] Écran de configuration globale.
- [ ] Déconnexion volontaire.
- [ ] Rotation du jeton et révocation des accès depuis l’interface.
- [ ] Configuration intégrée HTTPS et Tailscale.
- [ ] Sauvegarde et restauration intégrées.
- [ ] Suivi des tokens, coûts, budgets et quotas.
- [ ] Traces centralisées des exécutions.
- [ ] Évaluation comparative de la qualité des agents.

Pistes : Langfuse (traces et évaluations).

## Interface en ligne de commande

- [ ] Commandes dédiées à l’exécution des plans, au parallélisme, à l’isolation, aux revues et aux fusions.

## Limites de cet inventaire

Non vérifié : tests, agents réels et serveur déployé ; intégrations externes potentiellement déjà configurées.
