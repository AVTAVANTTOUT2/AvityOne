# Feuille de route

Fonctions d'AvityOne, regroupées par domaine. Une case cochée désigne une fonction implémentée dans la version
non publiée, avec les limites décrites ci-dessous et dans le [README](README.md). Elle ne certifie ni un déploiement
ni une qualification sur un agent réel ou un appareil. Les évolutions figurent dans le [CHANGELOG](CHANGELOG.md).
Les lignes « Pistes » renvoient aux briques open source relevées dans
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
- **Complément non publié** : orchestration durable, plans éditables et dépendances, fusions contrôlées, outils du
  dépôt, connaissance hybride et versionnée, administration, multimodalité, PWA/dictée et commandes CLI dédiées.

Détail dans le [CHANGELOG](CHANGELOG.md).

## Agents et routage

- [x] Routage intelligent par LLM.
- [x] Sélection des agents selon leurs performances.
- [x] Vérification de l’authentification, de la disponibilité réelle et des quotas.
- [x] Bascule automatique vers un autre agent après échec.
- [x] Installation et connexion des agents depuis l’interface.
- [x] Configuration graphique des règles de routage.
- [x] Catalogue et autocomplétion des commandes natives ACP.
- [x] Gestion des serveurs MCP supplémentaires, dont Serena et Context7.

Pistes : claude-code-router (routage par type de requête), LiteLLM (appels LLM directs), Serena et Context7 (MCP).

Portée : la bascule automatique couvre les échecs de connexion avant envoi du travail ; après envoi, la relance
est explicite. Le classement utilise des évaluations sur un texte attendu et la durée des réponses. Les serveurs
MCP supplémentaires doivent être installés et configurés sur l'hôte.
Le quota provient d'une commande locale configurée pour le fournisseur ; les sources Codex, Claude et Cursor sont
fournies dans le [guide des quotas](docs/quotas.md). OpenCode vérifie son contexte anonyme et précise l'absence de
plafond publié pour les modèles gratuits. Sans mesure fournisseur fiable, le solde reste inconnu.
La disponibilité est vérifiée par initialisation ACP et création de session, sans prompt facturable ; elle ne garantit
pas qu'un fournisseur acceptera une prochaine requête, et l'authentification reste inconnue si le protocole ne la confirme pas.

## Plans et orchestration

- [x] Édition, réorganisation et sélection des étapes d’un plan.
- [x] Gestion des dépendances entre tâches.
- [x] Répartition des tâches selon les fichiers concernés.
- [x] File d’attente persistante des demandes.
- [x] Limitation globale des agents simultanés.
- [x] Reprise des travaux après redémarrage.
- [x] Relance ciblée des sous-tâches échouées.
- [x] Transmission structurée des résultats entre sous-agents.
- [x] Synthèse automatique des travaux parallèles.
- [x] Arrêt automatique des agents inactifs.
- [x] Détection et interruption des agents bloqués.
- [x] Artefacts persistants « spécification → plan → tâches ».

Pistes : vibe-kanban (tâches et tentatives), rivet-dev/agents (processus durables), spec-kit (artefacts spec → plan → tâches).

Portée : les demandes en attente reprennent automatiquement ; les tentatives interrompues par un arrêt nécessitent
une relance explicite. Les fichiers déclarés par les tâches déterminent leur sérialisation. La synthèse rassemble
les résultats et erreurs structurés, sans ajouter une évaluation implicite de leur qualité.

## Git, validation et fusion

- [x] Exécution et suivi des tests, du lint et du build par l’orchestrateur.
- [x] Contrôles bloquants avant fusion.
- [x] Revue croisée obligatoire avant fusion.
- [x] Suivi structuré des remarques et corrections de revue.
- [x] Sélection des fichiers et modifications à intégrer.
- [x] Sélection individuelle des branches à fusionner.
- [x] Résolution assistée des conflits.
- [x] Préparation automatique des dépendances des worktrees.

Portée : npm est détecté via son lockfile et ses scripts ; les autres piles utilisent les commandes configurées.
La fusion est atomique après validations et revues favorables. Une sélection partielle conserve les worktrees.

## Environnement de développement

- [x] Explorateur de fichiers.
- [x] Éditeur de code intégré.
- [x] Terminal interactif.
- [x] Comparaison globale des changements avant fusion.
- [x] Acceptation ou rejet des modifications par fichier ou bloc.
- [x] Génération d’un contexte complet du dépôt pour les revues globales.

Pistes : code-server (édition dans le navigateur), Repomix (pack du dépôt pour les revues globales).

Portée : terminal shell bidirectionnel avec pipes, sans PTY ni applications plein écran. Le contexte du dépôt
contient les fichiers texte suivis, avec limite de taille et exclusions signalées ; `complete` indique si tous les
fichiers ont été inclus. Il ne s'agit pas d'un export des secrets ou de tous les fichiers binaires.

## Mémoire et connaissances

- [x] Recherche hybride lexicale et sémantique.
- [x] Indexation sémantique du code source.
- [x] Consolidation automatique des connaissances.
- [x] Détection des faits contradictoires ou périmés.
- [x] Édition des connaissances existantes.
- [x] Historique et restauration des connaissances.
- [x] Export Markdown versionnable.
- [x] Graphe temporel des personnes, événements et faits.
- [x] Réindexation automatique et incrémentale.
- [x] Import et extraction de documents PDF et bureautiques.
- [x] Ouverture des documents sources complets.
- [x] Sélection et modification du contexte injecté.

Pistes : sqlite-vec (vecteurs à côté de FTS5), claude-context (index sémantique du code), mem0 (consolidation),
Graphiti (graphe temporel), basic-memory (Markdown comme source de vérité).

Portée : LSA locale sur au plus 300 extraits récents et 12 dimensions, combinée à FTS5. La consolidation fusionne
les doublons normalisés ; les contradictions et péremptions concernent les faits structurés et datés. PDF :
`pdftotext` requis ; documents bureautiques : `unzip` requis. Extraction textuelle sans OCR, originaux conservés.

## Projets

- [x] Renommage, archivage et retrait des projets.
- [x] Recherche et filtrage des projets.
- [x] Sélecteur de dossiers.
- [x] Édition du brief et des instructions depuis l’interface.

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
- [x] Navigation précédent/suivant entre sessions, avec raccourcis suspendus pendant les dialogues.

## Fichiers et multimodalité

- [x] Ajout de pièces jointes.
- [x] Envoi d’images aux agents.
- [x] Glisser-déposer de fichiers.
- [x] Affichage natif des réponses multimodales.

## Activité et notifications

- [x] Suivi de l’activité des sessions non sélectionnées.
- [x] Notifications de fin, d’échec et d’autorisation en attente.
- [x] Indicateur de déconnexion et de reconnexion.
- [x] Signalement des erreurs de chargement de la mémoire et du contexte.

## Mobile et dictée

- [x] Application PWA installable.
- [x] Sélection des modèles et options sur mobile.
- [x] Lancement des exécutions parallèles sur mobile.
- [x] Choix de la langue de dictée.
- [x] Dictée sur les navigateurs sans reconnaissance vocale native.
- [x] Priorité au moteur configuré, repli navigateur annoncé, annulation et récupération de l'enregistrement.

Pistes : happy (client mobile pour Claude et Codex).

Portée : PWA sur HTTPS/localhost et navigateur compatible ; aucun travail de session hors ligne. La commande de
transcription configurée est prioritaire ; sans elle, la reconnaissance native est utilisée lorsqu'elle existe,
avec une indication explicite de ce repli. Les erreurs serveur ne déclenchent pas de bascule vers le navigateur.
L'arrêt anticipé à 4 Mio réserve le dernier fragment avant le plafond de 5 Mio ; l'audio reste téléchargeable après
un échec. L'annulation et le changement de session libèrent le micro et écartent les résultats tardifs.
Le [guide local](docs/dictee.md) décrit le moteur CPU multilingue. Les appareils physiques restent à qualifier.

## Administration et exploitation

- [x] Écran de configuration globale.
- [x] Déconnexion volontaire.
- [x] Rotation du jeton et révocation des accès depuis l’interface.
- [x] Configuration intégrée HTTPS et Tailscale.
- [x] Sauvegarde et restauration intégrées.
- [x] Suivi des tokens, coûts, budgets et quotas, avec cartes d'état, dates de mesure et erreurs explicites.
- [x] Traces centralisées des exécutions.
- [x] Évaluation comparative de la qualité des agents.

Pistes : Langfuse (traces et évaluations).

Portée : tokens et coûts proviennent des métriques déclarées par les agents, et une valeur absente reste inconnue.
Les quotas nécessitent un raccordement fournisseur configuré, distinct des tokens/coûts ; une mesure expire après
5 minutes ou à sa remise à zéro. Seul un quota mesuré, encore frais et épuisé bloque les nouveaux prompts.
Les cartes distinguent les quotas disponibles, épuisés, inconnus et expirés ; une valeur absente ou périmée ne
devient pas un faux zéro. La vérification explicite montre son attente et ses erreurs, sans doublon simultané par agent.
Les sauvegardes couvrent SQLite et les pièces jointes, pas les dossiers des projets ni la configuration. La restauration
exige un schéma compatible et un redémarrage après maintenance. HTTPS repose sur un hôte Tailscale déjà connecté.

## Interface en ligne de commande

- [x] Commandes dédiées à l’exécution des plans, au parallélisme, à l’isolation, aux revues et aux fusions.

## Limites de cet inventaire

Les tests automatisés utilisent des agents, dossiers et bases temporaires ; ils ne prouvent pas la disponibilité des
CLI externes, les quotas d'un fournisseur, la qualité d'un modèle, une installation mobile ou l'état d'un serveur réel.
La validation locale, la CI distante, le SHA déployé en preprod et une éventuelle production sont des preuves distinctes.
Cette documentation n'annonce aucune mise en production.
