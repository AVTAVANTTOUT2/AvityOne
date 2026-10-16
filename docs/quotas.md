# Sources de quotas des agents

Les sources livrées interrogent le compte déjà connecté sur le serveur. Elles ne
lancent aucun prompt, n’installent rien et ne changent pas la configuration
d’AvityOne. Node 24 et le CLI correspondant doivent être disponibles pour
l’utilisateur du service.

| Agent | Source | Limite |
|---|---|---|
| Codex | `codex app-server`, méthode officielle `account/rateLimits/read` | Compte ChatGPT connecté au CLI ; une clé API seule ne fournit pas ce quota. |
| Claude Code | GET fixe `https://api.anthropic.com/api/oauth/usage`, utilisé par le CLI natif | Contrat interne, non garanti comme API publique ; nécessite la connexion Claude dans un fichier local. |
| Cursor | Aucune source de quota du compte intégrée | `status` prouve une connexion, pas un solde. Le quota reste inconnu. |
| OpenCode | Aucune source de quota fournisseur intégrée | Les statistiques locales de tokens/coût ne donnent pas le plafond du fournisseur. Le quota reste inconnu. |

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

La sortie valide contient uniquement `remaining`, `limit: 100`, `unit` et, si
fournie, `resetAt`. Le pourcentage restant correspond à la fenêtre la plus
contraignante parmi celles applicables. Ce n’est ni un nombre de tokens ni une
estimation en dollars. Une disponibilité positive ne garantit pas l’accès à
tous les modèles ni l’absence d’autres restrictions du fournisseur.

Les réponses manquantes, périmées, mal formées ou trop grandes, les erreurs
d’authentification/réseau et le délai de 4,2 secondes font échouer la commande.
AvityOne conserve alors le statut **inconnu**, sans inventer de valeur. Le CLI
émet sur stderr un motif borné et fixe, sans réponse brute ni identifiant ; le
runner d’AvityOne affiche son erreur générique de commande. Aucune requête HTTP
Claude n’accepte de redirection. Si le forfait est épuisé mais que le fournisseur
annonce des crédits supplémentaires, le solde global reste également inconnu :
la source ne bloque pas à tort l’utilisation de ces crédits.

Le runner d’AvityOne limite chaque mesure à cinq secondes et invalide les
snapshots après cinq minutes ou à leur remise à zéro. Une vérification manuelle
suffit ; éviter d’interroger le fournisseur en boucle, notamment après un 429.

## Références et qualification

- [Codex App Server : quotas ChatGPT](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- [Claude Code : données officielles de la ligne de statut](https://code.claude.com/docs/en/statusline) ; cette interface documente les pourcentages et remises à zéro, mais ne constitue pas une documentation publique du point d’accès OAuth interne utilisé ici.
- [Commandes du CLI Cursor](https://cursor.com/docs/cli/reference/parameters).
- [Commandes du CLI OpenCode](https://opencode.ai/docs/cli/).

La lecture réelle a été vérifiée en préproduction avec Codex CLI 0.162.1 et
Claude Code 2.1.300. Les tests automatisés utilisent uniquement des réponses
simulées, des fichiers temporaires et un faux processus CLI. Aucun secret ou
identifiant de compte ne figure dans les fixtures.
