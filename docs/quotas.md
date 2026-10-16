# Sources de quotas des agents

Les sources livrées interrogent le compte connecté ou le contexte anonyme vérifiable sur le serveur. Elles ne
lancent aucun prompt et ne changent pas la configuration
d’AvityOne. Node 24 et le CLI correspondant doivent être disponibles pour
l’utilisateur du service.

| Agent | Source | Limite |
|---|---|---|
| Codex | `codex app-server`, méthode officielle `account/rateLimits/read` | Compte ChatGPT connecté au CLI ; une clé API seule ne fournit pas ce quota. |
| Claude Code | GET fixe `https://api.anthropic.com/api/oauth/usage`, utilisé par le CLI natif | Contrat interne, non garanti comme API publique ; nécessite la connexion Claude dans un fichier local. |
| Cursor | Méthodes natives du tableau de bord Cursor avec la connexion du CLI | Contrat interne vérifié ; total natif et réserves distinctes, restrictions et crédits supplémentaires. Un total positif ne rend pas tous les modèles disponibles. |
| OpenCode | Modèle global résolu par le CLI dans un contexte temporaire, catalogue fournisseur public | L'accès anonyme gratuit peut être vérifié ; aucun plafond restant n'est publié pour Big Pickle. Le quota reste inconnu avec une explication précise. |

## Configuration

Ajouter la propriété `quota` à la **définition complète existante** de l’agent
depuis l’administration d’AvityOne. Conserver ses autres propriétés, notamment
`name`, `cmd`, `args` et `strengths` : remplacer une définition par ce seul
fragment la rend invalide. Adapter les chemins absolus au déploiement. Ne jamais
placer un token dans les arguments, la configuration AvityOne ou la ligne de
commande.

Valeur de `agents.codex.quota` :

```json
{
  "cmd": "/usr/bin/node",
  "args": ["/chemin/avityone/src/quota-source.ts", "codex"]
}
```

Valeur de `agents.claude.quota` :

```json
{
  "cmd": "/usr/bin/node",
  "args": ["/chemin/avityone/src/quota-source.ts", "claude"]
}
```

Pour Cursor et OpenCode, conserver également leur définition complète et utiliser
respectivement ces valeurs pour leur propriété `quota` :

```json
{ "cmd": "/usr/bin/node", "args": ["/chemin/avityone/src/cursor-quota.ts"] }
```

```json
{ "cmd": "/usr/bin/node", "args": ["/chemin/avityone/src/opencode-quota.ts"], "timeoutMs": 20000 }
```

Cursor lit les identifiants existants du CLI sans les modifier ni les afficher.
Les appels vont uniquement vers les services Cursor attendus, sans suivre de
redirection. Les réserves de modèles sont indiquées séparément dans `details`.
L'épuisement d'une seule réserve ne bloque pas tout l'agent : l'épuisement global
exige un blocage fournisseur explicite et l'absence vérifiée de capacité de
secours, de crédits ou de paiement à l'usage. La source ne modifie aucun plafond
et n'active aucun paiement supplémentaire.

OpenCode n'a pas de quota commun à tous ses fournisseurs. La source vérifie le
contexte global anonyme qu'elle sait résoudre ; une configuration ambiguë ou un
autre fournisseur reste inconnu. Les paramètres propres aux projets et aux
sessions ne sont pas couverts par cette mesure globale. Les statistiques locales
de tokens ne sont jamais transformées en solde. Big Pickle est gratuit
temporairement, avec des limitations possibles : cela ne signifie pas illimité.
Le serveur CLI auxiliaire utilise un HOME et des répertoires XDG temporaires,
supprimés après la mesure ; ses fichiers de fonctionnement restent dans cet espace.

Codex utilise son authentification native, notamment `CODEX_HOME` si défini.
Son CLI doit être présent dans le `PATH` du service. Le processus auxiliaire et
ses descendants sont arrêtés après la mesure ; aucune conversation n’est créée.
Le CLI peut entretenir lui-même sa connexion et ses fichiers de fonctionnement.
Un troisième argument permet de choisir un identifiant de quota Codex différent
de `codex` lorsqu’il est effectivement retourné par le fournisseur.

Claude lit uniquement `~/.claude/.credentials.json`, ou
`$CLAUDE_CONFIG_DIR/.credentials.json`. Il n’écrit ni ne renouvelle les
identifiants : une connexion expirée demande une reconnexion du CLI. Activer
cette source seulement lorsque l’agent utilise ce même abonnement Claude, et non
une clé API, un proxy, Bedrock ou Vertex. Une connexion stockée seulement dans le
trousseau du système n’est pas prise en charge. Un troisième argument `sonnet` ou
`opus` inclut la fenêtre spécifique à cette famille, si le fournisseur la renvoie.
Sans cet argument, seules les fenêtres générales de cinq heures et sept jours
sont prises en compte.

## Interprétation et erreurs

La sortie chiffrée contient `remaining`, `limit`, `unit` et, si fournie,
`resetAt`, ainsi qu'un texte `details` facultatif (1 000 caractères maximum).
Pour Codex et Claude, le pourcentage restant correspond à la fenêtre la plus
contraignante parmi celles applicables. Ce n'est ni un nombre de tokens ni une
estimation en dollars. Une disponibilité positive ne garantit pas l’accès à
tous les modèles ni l’absence d’autres restrictions du fournisseur.

Une source sans quota chiffré peut retourner `status: "unknown"`, `remaining: null`,
`limit: null`, un `reason` explicite (500 caractères maximum) et `details`.
Ces informations sont conservées sans inventer de nombre ni bloquer les prompts.
Un accès gratuit n'est pas une capacité illimitée.

Les réponses manquantes, périmées, mal formées ou trop grandes, les erreurs
d’authentification/réseau et le dépassement du délai donnent le statut **inconnu**.
Cursor et OpenCode retournent un motif JSON expurgé ; les sources Codex et Claude
échouent avec un motif fixe sur stderr, affiché comme erreur générique de commande
par le runner. Aucune réponse brute ni identifiant n'est conservé. Aucune requête HTTP
Claude n’accepte de redirection. Si le forfait est épuisé mais que le fournisseur
annonce des crédits supplémentaires, le solde global reste également inconnu :
la source ne bloque pas à tort l’utilisation de ces crédits.

Le runner d’AvityOne limite chaque mesure à cinq secondes par défaut ;
`quota.timeoutMs` accepte un entier de 1 000 à 30 000 ms. OpenCode utilise ici
20 secondes pour laisser son CLI résoudre le modèle dans un environnement temporaire.
Le runner transmet son délai via `AVITY_QUOTA_TIMEOUT_MS` ; OpenCode réserve
500 ms à son nettoyage et termine au plus tard après 18 secondes de travail.
Les autres adaptateurs ont une limite interne de 4,2 secondes. Le serveur invalide les
snapshots après cinq minutes ou à leur remise à zéro. Une vérification manuelle
suffit ; éviter d’interroger le fournisseur en boucle, notamment après un 429.

## Références et qualification

- [Codex App Server : quotas ChatGPT](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- [Claude Code : données officielles de la ligne de statut](https://code.claude.com/docs/en/statusline) ; cette interface documente les pourcentages et remises à zéro, mais ne constitue pas une documentation publique du point d’accès OAuth interne utilisé ici.
- [Commandes du CLI Cursor](https://cursor.com/docs/cli/reference/parameters).
- [Cursor : réserves d'usage et limites](https://cursor.com/help/models-and-usage/usage-limits).
- [Commandes du CLI OpenCode](https://opencode.ai/docs/cli/).
- [OpenCode Zen : modèles gratuits et facturation](https://docs.opencode.ai/docs/zen/).

La lecture réelle a été vérifiée en préproduction avec Codex CLI 0.162.1,
Claude Code 2.1.300, Cursor 2026.10.14-0f9edde et OpenCode 1.19.0. Cursor expose
les deux réserves mensuelles sur ce compte ; le format hebdomadaire est couvert
par les fixtures. OpenCode a confirmé le modèle global anonyme Big Pickle et
son tarif catalogue nul, sans quota chiffré publié.
Les tests automatisés utilisent uniquement des réponses
simulées, des fichiers temporaires et un faux processus CLI. Aucun secret ou
identifiant de compte ne figure dans les fixtures.

Le stockage ajoute une colonne nullable `details` sans modifier les anciennes mesures.
Les sauvegardes restent soumises au contrôle de schéma : restaurer une sauvegarde
antérieure avec la version qui l'a créée avant de mettre à jour l'application.
