# AGENTS.md — règles pour les agents de code

À lire en entier avant toute modification. Si une règle bloque la tâche, arrête-toi et demande : ne la contourne pas.
Le repo est **public** : jamais de secret, token, clé, IP ou donnée personnelle dans un commit, une PR ou un log.

## Le projet en 30 secondes

AvityOne orchestre des agents de code (Claude Code, Codex, Cursor, OpenCode) via ACP, avec contexte et mémoire partagés.

- **Serveur** : `src/`, Node 24 exécute le TypeScript directement (type stripping). Pas de build, **zéro dépendance
  runtime** : uniquement la bibliothèque standard Node (`node:…`). Données : SQLite + FTS5 dans `~/.avityone/`.
- **UI** : `web/src/`, React + Vite, compilée dans `web/dist/` (ignoré par git, construit au déploiement).
- **Tests** : `test/avity.test.ts`, de bout en bout contre un agent ACP simulé (`test/fake-agent.mjs`).
- **App macOS** : `macos/`, SwiftUI (Swift Package, macOS 14+). Elle embarque Node 24 et `src/`, et pilote ce moteur
  par la même API HTTP+SSE. Guide : [docs/macos.md](docs/macos.md).
- Rôle de chaque fichier : tableau « Développement » du [README](README.md).

## Commandes

```bash
npm ci             # dépendances de dev (TypeScript, Vite, React, libs UI)
npm run check      # tsc strict, serveur + UI
npm test           # tests de bout en bout
npm run build      # UI → web/dist
npm run dev        # serveur avec rechargement (:7710)
npm run dev:web    # UI avec rechargement à chaud (proxy /api vers :7710)
```

App macOS (sur un Mac, Xcode 16+) :

```bash
cd macos
swift build && swift test                 # AVITY_ENGINE_TEST=1 ajoute l'intégration avec le vrai moteur
bash scripts/build-app.sh                 # build/AvityOne.app + AvityOne.dmg (signature ad hoc)
```

Le conteneur Linux des agents ne compile pas SwiftUI : le workflow `macos` (job `app`) est la preuve de compilation.

**Avant chaque commit : `npm run check && npm test && npm run build` doit passer.** C'est exactement ce que fait la CI.

## Règles de code

- **Serveur sans dépendance** : n'ajoute jamais de paquet utilisé par `src/`. Un paquet n'est accepté que s'il ne sert
  qu'à l'UI ou aux outils de dev, et il va dans `devDependencies`. Commite `package-lock.json` avec `package.json`.
- **Swift** : les dépendances SwiftPM ne servent qu'à l'interface (SwiftTerm, MarkdownUI), versions exactes dans
  `macos/Package.swift`. Les modèles du contrat d'API vivent dans `AvityKit` et se testent dans
  `macos/Tests/AvityKitTests/`. Toute route ou tout événement modifié dans `src/` se répercute dans `AvityKit`.
- **TypeScript effaçable uniquement** (`erasableSyntaxOnly`) : pas d'`enum`, de `namespace`, de propriétés de
  paramètres de constructeur ni de décorateurs. Utilise des unions de chaînes et des objets `as const`.
- **Imports** : chemins relatifs avec l'extension `.ts` (`import { config } from './config.ts'`), modules natifs avec
  le préfixe `node:`, types importés avec `type` (`import { route, type Mode } from './router.ts'`).
- **Style** : imite le code autour. Fonctions courtes, peu d'abstractions, commentaires de code en anglais et seulement
  quand le « pourquoi » n'est pas évident. Textes de l'UI, docs, commits et PR **en français**.
- Pas de code « pour plus tard », pas de fichier de config pour une valeur fixe, pas de refactor hors du sujet de la tâche.
- Configuration utilisateur : `~/.avityone/config.json` surcharge les valeurs par défaut de `src/config.ts`. Une
  nouvelle option a une valeur par défaut dans `DEFAULTS` et se documente dans la section « Configuration » du README.

## Tests

- Toute correction de bug ou nouvelle fonction ajoute ou adapte un test dans `test/avity.test.ts`.
- Les tests tournent dans un `AVITY_HOME` temporaire avec les agents simulés `fake` et `fake2`. Ne lance jamais un
  test contre le vrai `~/.avityone` ni contre un vrai CLI d'agent.
- Les tests git passent l'identité en ligne (`-c user.name=… -c user.email=…`) : ne dépends pas d'un `git config` global.

## Workflow git (obligatoire)

```
branche de travail ──PR──▶ preprod ──PR (merge commit)──▶ main
                     CI       │ déploiement auto            │ déploiement auto
                              ▼                             ▼
                         VM preprod                      VM prod
```

1. **Pars toujours de `preprod`**, la branche par défaut :
   `git fetch origin && git switch -c <type>/<sujet-court> origin/preprod`.
2. Commits au format `type(portée): description en français`, avec les types `feat`, `fix`, `docs`, `refactor`,
   `test` et `chore`. Par exemple `fix(web): l'interface reste utilisable sans WebGL`.
3. **PR vers `preprod`**, jamais vers `main`. La CI (`ci`) doit être verte pour merger.
4. **Interdit** : pousser directement sur `preprod` ou `main`, faire un `--force` sur ces branches, contourner la CI,
   merger une PR que l'utilisateur n'a pas demandé de merger.
5. **Mise en prod** : uniquement par une PR `preprod` → `main`, mergée en **merge commit** (jamais en squash ni en
   rebase, sinon les branches divergent). La CI rejette toute autre source pour `main`. Seul l'utilisateur décide
   d'une mise en prod.
6. Mets à jour la doc dans la même PR :
   - `CHANGELOG.md`, section `[Non publié]`, sous `Ajouté`, `Corrigé`, `Modifié` ou `Supprimé` ;
   - `README.md` si une commande, une option ou un comportement visible change ;
   - `ROADMAP.md` : coche ce qui est livré.

## Environnements et déploiement

| Env | Branche | VM (Proxmox) | Accès |
|---|---|---|---|
| Preprod | `preprod` | 217 `avityone-preprod` | https://avityone-preprod.tail5feb4c.ts.net · `ssh avityone-preprod` |
| Prod | `main` | 216 `avityone` | https://avityone.tail5feb4c.ts.net · `ssh avityone` |

Les URL ne répondent que sur le tailnet. Sur chaque VM, l'application vit dans `~/avityone`, avec l'utilisateur
`elias`, le service systemd `avityone` et le port 7710 servi par `tailscale serve`.

**Déploiement continu (pull)** : `avityone-deploy.timer` lance `deploy/autodeploy.sh <branche>` chaque minute. Si
`origin/<branche>` a bougé, le script lance `git checkout -f`, puis `deploy/install.sh` (`npm ci`, build, redémarrage).
Le dernier SHA déployé est dans `~/.avityone/deployed`, et un échec est retenté à la minute suivante.

| Besoin | Commande (sur la VM) |
|---|---|
| Suivre un déploiement | `journalctl -u avityone-deploy -f` |
| Version déployée | `cat ~/.avityone/deployed` |
| État du serveur | `systemctl status avityone` · `journalctl -u avityone -n 50` |
| Forcer un redéploiement | `rm ~/.avityone/deployed` (le timer redéploie dans la minute) |
| Activer le CD sur une nouvelle VM | `git fetch origin <b> && git checkout -qf -B <b> FETCH_HEAD && bash deploy/autodeploy.sh <b>` |

**Ne jamais faire sur les VM :**
- **Modifier du code dans `~/avityone`** : le prochain déploiement l'écrase (`checkout -f`). Toute correction passe
  par une PR.
- **Lancer `install.sh` ou redémarrer `avityone` à la main sur la prod** : un redémarrage coupe les sessions d'agents
  en cours.
- **Toucher à `~/.avityone/`** (base `avity.db`, `config.json`, token) ni à `~/projects/` : ce sont les données réelles.
- **Désactiver le timer** (`avityone-deploy.timer`) sans le dire à l'utilisateur.

**Rollback** : `git revert -m 1 <commit de merge>` sur une branche partie de `preprod`, puis PR vers `preprod` et
promotion vers `main` par le flux normal. Même en urgence, le flux reste le même : la prod ne reçoit que ce qui est
passé par la preprod.

## Pièges connus

- **Données copiées dans la preprod** : c'est un clone de la prod, avec les mêmes connexions d'agents et des copies
  des projets. Un agent qui pousse depuis la preprod pousse sur les **vrais** dépôts GitHub.
- **Worktrees** : `.avity/worktrees/<session>` est un checkout neuf. Les fichiers ignorés (`node_modules`, `.env`) n'y
  sont pas.
- **`web/dist/`** n'est pas versionné. Après un changement d'UI, `npm run build` sert à vérifier : ne commite pas
  `dist`.
- **Cloner une VM** : démarre-la réseau coupé (`link_down=1`), vide `/var/lib/tailscale/*` (sinon elle reprend
  l'identité et les certificats Tailscale de l'original) et régénère `/etc/machine-id`. Lance ensuite
  `tailscale up --hostname=…`, puis `tailscale serve --bg 7710`.
- **Node 24 minimum** (`engines`). La CI tourne en Node 24 : évite les API plus récentes.

## Checklist avant d'ouvrir une PR

- [ ] Branche partie de `origin/preprod`, PR vers `preprod`.
- [ ] `npm run check && npm test && npm run build` passent en local.
- [ ] Un test couvre le changement.
- [ ] Aucune nouvelle dépendance runtime, aucun secret ni donnée personnelle.
- [ ] `CHANGELOG.md`, et si besoin `README.md` et `ROADMAP.md`, sont à jour.
- [ ] Message de commit `type(portée): …` en français, diff limité au sujet.
