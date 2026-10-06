# Hoklims Devkit

Le plugin Codex commun prépare les vérifications et associe les observations
AssertLedger au changement exact. `PLANNED` conserve les obligations non prouvées ;
la préparation et le replay n'exécutent aucun test candidat. Le
[contrat de demande et ses limites](docs/workflow.md) décrit ce parcours.

Hoklims Devkit prépare un dépôt Git pour [Semctx](https://github.com/hoklims/semctx), avec [AssertLedger](https://github.com/hoklims/assertledger) et [Latent Compass](https://github.com/hoklims/latent-compass) en option. Il appelle les installateurs propres à chaque projet et conserve leurs données séparées.

**Disponibilité :** vérifier `npm view hoklims-devkit@0.1.2 version` avant d'utiliser les commandes publiques ci-dessous. Une version est prête seulement après vérification de sa release et de son installation depuis npm. Pendant le développement, utiliser `bun bin/hoklims-devkit.js` depuis ce dépôt.

## Prérequis

- Bun 1.4 ou plus récent et Git.
- La CLI Codex, Claude Code, ou les deux dans le `PATH`. `--host auto` sélectionne tous les hôtes détectés.
- Pour AssertLedger : Node 22.15 ou plus récent, npm et le gestionnaire déclaré par le dépôt (npm, pnpm ou Bun avec installation `node_modules`). Les dépôts Yarn peuvent utiliser directement le `setup` natif d'AssertLedger. L'adaptateur prêt à l'emploi vise `node:test` ; d'autres frameworks peuvent demander un adaptateur fourni par l'utilisateur.
- Pour Latent Compass : uv. Son environnement persistant utilise Python 3.13.

Le lanceur n'installe pas Bun, Node ou uv à l'insu de l'utilisateur. Un prérequis manquant est signalé avant toute modification.

## Première utilisation

Pour le workflow Codex commun, lancer depuis ce checkout :

```sh
bun bin/hoklims-devkit.js onboard . --dry-run --json
```

Retirer `--dry-run` pour appliquer. Après publication, l'entrée publique sera
`bunx hoklims-devkit@latest onboard .`. Ce profil fixe Semctx 0.4.2 et
AssertLedger 1.4.0, réutilise leurs installateurs et installe `hoklims-proof`
par les commandes natives de marketplace Codex. Cette installation inscrit
explicitement le plugin dans le profil utilisateur Codex ; le fichier de
configuration AssertLedger du dépôt reste identique. Le plugin commun ne déclare
ni serveur MCP supplémentaire ni hook.

Les fichiers étrangers, les plugins désactivés, les versions incompatibles et
les snapshots modifiés sont signalés avant application. Une relance conserve les
versions et les octets possédés. `onboard --upgrade-plugin` permet explicitement
de mettre à niveau un snapshot possédé encore intact. Ouvrir ensuite une session
Codex neuve et de confiance pour vérifier le chargement ; installation, chargement,
approbation et usage observé restent des états distincts.

Après publication, lancer depuis un dépôt Git :

```sh
bunx hoklims-devkit@latest setup .
```

Cette commande sélectionne Semctx ainsi que les hôtes Codex et Claude détectés. `--dry-run --json` affiche le plan sans modifier le dépôt, la configuration des hôtes ni l'état du lanceur. Bun, npm et uv peuvent toutefois remplir leurs caches de téléchargement. `--with assertledger`, `--with latent-compass` ou les deux activent les parcours facultatifs. `--host codex` et `--host claude` ciblent un seul hôte.

```sh
bunx hoklims-devkit@latest setup . --host codex --with assertledger,latent-compass --dry-run --json
bunx hoklims-devkit@latest doctor . --json
bunx hoklims-devkit@latest upgrade . --dry-run --json
```

Lors de la première installation, `setup` choisit les dernières versions stables compatibles. Il vérifie **tous les composants sélectionnés avant de modifier le dépôt ou la configuration des hôtes**, puis mémorise le plan et chaque installation réussie dans un fichier d'état du profil utilisateur. Une relance conserve ces versions ; seul `upgrade` recherche de nouvelles versions. Si l'installation s'interrompt, relancez la même commande pour reprendre le plan initial. Si le canal stable a changé et empêche la reprise d'une mise à niveau, `upgrade --refresh-pending` recalcule explicitement le plan.

Si un composant est enregistré pour Codex et Claude, utiliser `upgrade --host all` pour changer sa version sans attribuer la nouvelle version à un hôte non modifié.

`doctor --json` distingue le paquet installé, la configuration, le chargement dans la session, l'approbation et l'usage observé. L'installation seule ne prouve ni le chargement ni l'approbation. Ouvrir une nouvelle tâche Codex ou recharger les plugins Claude lorsque le rapport le demande. Examiner le hook Latent Compass dans l'hôte avant de l'approuver.

## Usage courant

Le skill `proof-workflow` prépare la demande sans JSON rédigé par le développeur.
Codex choisit les obligations et chemins utiles, puis appelle par exemple
`workflow . --base origin/main --obligation ID --test PATH --json`.
`--evidence EXPORT_FILE` rejoue un export AssertLedger avec le runtime local fixé,
contrôle son rattachement et conserve sa portée consultative. Les limites
d'authenticité, d'environnement et de couverture restent visibles ; aucune
obligation Semctx n'est clôturée automatiquement.

- Semctx sert à examiner l'impact d'un changement et les obligations associées, par exemple avec `semctx verify diff --base origin/main`.
- AssertLedger sert à vérifier une affirmation précise sur un test de régression. Son installation n'invente ni défaut ni preuve. L'exécution locale non isolée exige toujours `--allow-unsafe-execution` donné par l'opérateur.
- Latent Compass consigne les inconnues d'une décision importante. Ses observations locales restent consultatives et ne donnent aucune autorité d'exécution.

Il n'est pas nécessaire d'utiliser les trois outils à chaque tâche.

## Retrait et développement

Cette version n'a pas de commande de désinstallation commune. `assertledger disconnect . --client codex|claude-code --write` retire uniquement ses fichiers encore identiques. `latent-compass host remove --project-root . --host codex|claude` retire l'inscription du projet sans toucher aux autres. Le plugin Semctx est partagé entre dépôts : ne le retirer de Codex ou Claude que lorsqu'aucun autre dépôt ne l'utilise. Les fichiers métier `.semctx` et les preuves sont conservés.

Pour contribuer, lancer `bun test` puis `bun run check`. npm impose une première publication authentifiée avant de pouvoir configurer un éditeur de confiance ; les versions suivantes utiliseront OIDC. La [procédure de publication](docs/releasing.md) lie les essais aux paquets installés hors checkout. La commande publique ne sera annoncée qu'après vérification sur le registre.
