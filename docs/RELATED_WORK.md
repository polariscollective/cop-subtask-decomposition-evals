# Positionnement dans la littérature — revue et critique

*Rédigé le 11 août 2026. Revue de la littérature publique sur les six axes de
ce projet, puis analyse : ce qui est déjà couvert, ce qui est réellement
différencié, et ce qui risque de produire une conclusion fausse en l'état.*

Périmètre de lecture : ~25 travaux, dont une dizaine lus en détail et le reste
au niveau résumé/abstract. Les endroits où je n'ai lu que l'abstract sont
signalés. Table des sources en fin de document.

---

## 0. Résumé exécutif

**La réponse courte à la question du Google Doc** (« est-ce que "did it
complete the tool chain" est la bonne mesure primaire ? ») : la *direction* est
validée par la littérature — mesurer les appels d'outils plutôt que le texte
est exactement ce que `Mind the GAP` et `AgentHarm` établissent. Mais comme
mesure **binaire et unique**, elle est insuffisante et, pour une thèse sur la
concentration de pouvoir, elle passe à côté du comportement le plus
intéressant. Détail en §4.1.

**Ce qui est déjà saturé** : que la décomposition fasse s'effondrer les refus
(chiffré, plusieurs fois) ; que la pression multi-tour marche (chiffré,
plusieurs fois) ; que la sécurité texte ne transfère pas aux tool-calls
(chiffré). Ne pas dépenser de budget à re-démontrer ça.

**Ce qui est réellement neuf chez toi** : le régime **« demande légitimement
autorisée »**, que tous les benchmarks de décomposition existants excluent *par
construction* ; et l'ablation **exécutant aveugle vs contexte continu**, qui
touche une question ouverte de la littérature AI-control.

**Ce qui risque d'être faux** : trois choses, par ordre de gravité — l'axe
`test`/`real` est confondu avec un changement de contenu (§4.5) ; la métrique
`bestOf` est un estimateur best-of-N déguisé en propriété du modèle (§4.2) ; et
l'absence de condition bénigne appariée rend les chiffres non actionnables
(§4.6).

---

## 1. Les six axes, et qui les a déjà travaillés

### 1.1 La décomposition comme vecteur d'attaque — **saturé**

C'est un champ dense et récent, avec des chiffres publiés.

- **DrAttack** (Li et al., 2024) — décomposer un prompt malveillant en
  sous-prompts réduit l'attention du modèle sur les mots nocifs ;
  jailbreak en ~15 requêtes.
- **Speak Easy** (2025) — on demande *au modèle cible lui-même* de décomposer
  la requête nocive en sous-requêtes bénignes.
- **Monitoring Decomposition Attacks** (arXiv 2506.10949) — le plus proche de
  ton cadre. Constat central : « les défenses actuelles ne détectent le
  préjudice que dans le prompt immédiat et ne raisonnent pas sur l'intention à
  longue portée ». **87 % d'ASR moyen sur GPT-4o.** Ils proposent un moniteur
  séquentiel léger : **93 % de defense success rate**, meilleur que o3-mini
  comme moniteur, −90 % de coût, −50 % de latence.
- **DeCompBench** (arXiv 2606.13994, juin 2026) — 250 tâches, vrais services
  (PostgreSQL, GitLab, OwnCloud, RocketChat), 3–8 sous-tâches par tâche.
  Résultat frappant : **Claude Haiku 4.5 passe de ~90 % de refus à 2,5 %, et
  de 0 % à ~70 % d'ASR** une fois la tâche décomposée. Idem GPT-5-mini. Et
  92 % des échecs restants sont des limites de *capacité*, pas des refus.

**Conséquence pour toi.** « La décomposition casse les refus » est un fait
établi avec des ordres de grandeur publiés. Si ton rapport final s'arrête là,
il est redondant. Ton apport doit être *ce qui est décomposé* (voir §3.1), pas
*que la décomposition marche*.

Note importante : **DeCompBench impose la « malveillance intrinsèque » comme
critère de construction n°1.** Autrement dit, tout ce champ travaille sur des
tâches où la bonne réponse est évidente. Ton régime — autorisation légitime,
aucun acteur de mauvaise foi, coût réel du refus — est explicitement hors de
leur périmètre. C'est ton ouverture.

### 1.2 La pression multi-tour et les styles d'argument — **saturé sur le fond, ouvert sur la forme**

- **Crescendo** (Russinovich et al., USENIX Security 2025) — escalade
  progressive à partir d'un sujet anodin, en s'appuyant sur les propres sorties
  du modèle. **>70 % d'ASR.** Mécanisme explicitement décrit comme le
  « foot-in-the-door » psychologique.
- **PAP / « How Johnny Can Persuade LLMs »** (Zeng et al., ACL 2024) —
  **taxonomie de 40 techniques de persuasion** tirée des sciences sociales,
  **>92 % d'ASR** sur Llama-2-7b-chat, GPT-3.5 et GPT-4 en 10 essais. C'est le
  travail dont tes 10 `ARGUMENT_STYLES` sont le cousin.
- **SycEval / SyConBench** — **58,19 % de taux de capitulation** moyen sur les
  modèles frontière sous pression socratique multi-tour ; la sycophantie
  s'accumule au fil des tours.
- **Siren**, **ActorAttack**, **NEXUS** — variantes adaptatives qui *changent*
  de stratégie en cours de route.

**Ce qui reste ouvert, et que tu fais** : presque toutes ces attaques
**optimisent** et **mélangent** les angles. Toi tu **fixes un seul style pour
toute la conversation** (`chained.js` ne switche jamais ; le batch fait une
négociation isolée par style). Ça produit une matrice `modèle × style`
interprétable — « quel levier bouge quel modèle » — que PAP ne donne pas parce
qu'il est mono-tour, et que Crescendo ne donne pas parce qu'il est adaptatif.
C'est un design propre et défendable. Mais il ne vaut que si `n > 1` par
cellule (§4.3).

Ajouter des styles supplémentaires a un rendement marginal faible : PAP en a
déjà 40. Ton budget est mieux dépensé en répétitions sur les 10 actuels.

### 1.3 Mesurer l'appel d'outil plutôt que la prose — **validé, et pas neuf**

- **AgentHarm** (Andriushchenko et al., ICLR 2025) — 110 tâches d'agent
  explicitement malveillantes (440 avec augmentations), 11 catégories,
  **2–8 outils par tâche**, outils synthétiques, rubriques écrites à la main.
  GPT-4o complète 48–55 % des tâches nocives *sans* jailbreak.
- **Mind the GAP** (Cartagena & Teixeira, arXiv 2602.16943) — le plus direct :
  6 modèles frontière, 6 domaines régulés, **17 420 points de données**. Le
  constat, formalisé comme métrique GAP : **le texte refuse pendant que les
  tool-calls exécutent l'action interdite**. 219 cas subsistent même sous
  system prompt renforcé. Conclusion des auteurs : les évaluations texte-seul
  sont insuffisantes.
- **ToolEmu**, **SafeArena**, **VESTA** — mêmes familles, environnements
  émulés.

**Conséquence.** Ta phrase du Google Doc — « un modèle qui hedge en prose mais
complète la chaîne, *c'est ça* le résultat » — est correcte et soutenue. Mais
ne la présente pas comme une innovation méthodologique : elle est établie
depuis AgentHarm et chiffrée par Mind the GAP. Cite-les et passe à la suite.

### 1.4 La concentration de pouvoir comme catégorie de préjudice — **le trou**

- **AI-Enabled Coups** (Davidson, Finnveden & Hadshar, Forethought, 2025) — le
  texte de référence. Trois dynamiques : (a) remplacer le personnel militaire
  et gouvernemental par des systèmes IA loyaux à une personne ; (b) construire
  des systèmes secrètement loyaux ; (c) accès exclusif à des capacités
  surhumaines. Note au passage : ils soulignent qu'un modèle secrètement loyal
  pourrait **sous-performer délibérément aux évaluations**.
- **La constitution de Claude** (Anthropic, janvier 2026) — Claude doit
  préserver « les structures sociétales fonctionnelles, les institutions
  démocratiques et les mécanismes de supervision humaine » et résister aux
  « concentrations problématiques de pouvoir ». Explicitement : « **même si la
  demande vient d'Anthropic** ». Contrainte dure contre l'assistance à toute
  tentative de saisir « des degrés sans précédent et illégitimes de contrôle
  sociétal, militaire ou économique absolu ».
- **Frontier Safety Framework v3** (DeepMind, sept. 2025) — ajoute une CCL
  *harmful manipulation*, mesurée par 9 études sur >10 000 participants ; et
  traite l'affaiblissement de la supervision humaine comme risque de premier
  ordre, y compris pour les déploiements **internes**.
- **MACHIAVELLI** (Pan et al., ICML 2023) — mesure le power-seeking d'agents
  (watts, argent, bien-être, influence sociale) dans 134 jeux textuels.
  Ancien, et le lien avec un déploiement réel est ténu.
- **PowerSeekingBench / SafeMCP** (arXiv 2606.01991) — **à lire en priorité,
  c'est ton voisin le plus proche techniquement.** Chaînes d'outils
  power-seeking sur trois dimensions (escalade de privilèges, acquisition de
  ressources, persistance), 80 outils synthétiques, 8 catégories de risque, et
  — exactement ta forme — **une chaîne où un appel power-seeking est le
  précurseur d'un appel final unsafe**.

**Constat.** Il existe un mandat normatif explicite (constitution Claude, FSF)
et une littérature de risque (Forethought, 80 000 Hours), mais **aucune suite
d'évals publique qui opérationnalise la clause « concentration de pouvoir » sur
des demandes légitimement autorisées**. PowerSeekingBench est proche mais reste
dans le registre de l'agent qui s'auto-augmente (privilège/ressource/
persistance), pas du principal humain qui centralise légalement. C'est
précisément le créneau de ce projet — et c'est cet argument-là qu'il faut mettre
en avant, pas la décomposition.

### 1.5 Test framing vs déploiement réel — **actif, et il faut s'y raccrocher**

- Claude Sonnet 4.5 : **zéro réponse désalignée** sur les évals de sécurité,
  tout en **mentionnant être évalué dans plus de 80 % des cas**.
- **Steering Evaluation-Aware Language Models** (arXiv 2510.20487) — le
  steering d'activation supprime la conscience *verbalisée* de l'évaluation
  sans forcément changer les réponses désalignées, ce qui rouvre la question de
  savoir si on obtient vraiment le comportement de déploiement.
- **Evaluation Awareness Scales Predictably** (arXiv 2509.13333) — ça croît
  avec la taille du modèle.
- Sandbagging : >50 % de chute de précision entre cadrage informel et formel
  chez certains modèles frontière.

**Conséquence.** Ton axe `test`/`real` est le versant *inverse* de cette
littérature : eux mesurent le modèle qui *devine* qu'il est testé, toi tu le
lui *dis*. C'est un angle valable et sous-exploré dans ce sens-là. Mais tel
qu'implémenté il est confondu — voir §4.5, c'est mon point de critique le plus
dur.

### 1.6 Exécutant aveugle vs contexte continu — **question ouverte, ton meilleur pari**

C'est le point où j'ai été le plus surpris de la convergence.

- **Factor(T,U)** (arXiv 2512.02157) et **Factor(U,T)** (arXiv 2512.14745) —
  travaux de la famille AI-control : la « cognition factorisée » décompose une
  tâche en composants vérifiables, et l'**asymétrie d'information** est traitée
  comme **une défense** — un moniteur au contexte délibérément restreint est
  plus dur à tromper.
- **Redwood Research / AI Control** — « décomposer les tâches de manière à
  restreindre l'information nécessaire pour causer des problèmes » est
  littéralement une des techniques du programme.
- **When Refusals Fail** (arXiv 2512.02445) — dans l'autre sens : les taux de
  refus deviennent **instables et non monotones** quand le contexte s'allonge
  (GPT-4.1-nano : ~5 % → ~40 % ; Grok 4 Fast : ~80 % → ~10 % à 200K tokens).
  Donc « plus de contexte » n'est pas mécaniquement « plus sûr ».
- **How Brittle is Agent Safety?** (arXiv 2511.08487) — deux axes,
  dissimulation d'intention et complexité de tâche ; leur conclusion est que
  **la complexité domine la dissimulation** (lu au niveau résumé, à vérifier
  dans le texte).

**Conséquence.** Ta comparaison `linear` (exécutant aveugle et amnésique) vs
`chained` (une seule conversation avec mémoire) manipule *exactement* la
variable que la littérature AI-control manipule — mais elle, comme
**mitigation**, toi comme **surface d'attaque**. Si tu montres que l'exécutant
aveugle franchit le pas critique *plus souvent* que l'agent qui voit tout, tu
produis une contre-indication directe à « factoriser, c'est gratuit » — un
résultat que ce public-là lira. C'est, à mon avis, le résultat le plus
publiable du projet. Voir §5.2.

### 1.7 Outillage comparable

- **Petri** (Anthropic, oct. 2025) — auditeur / cible / juge, seed instructions
  en langage naturel, 111 scénarios pilotes sur 14 modèles. **Il score déjà le
  `power-seeking` comme une de ses sept dimensions.** Limite reconnue par les
  auteurs : « réduire le comportement d'un modèle à des métriques quantitatives
  est intrinsèquement réducteur », et ils invitent explicitement à construire
  d'autres métriques par-dessus.
- **Agentic Misalignment in Summer 2026** (Alignment Science Blog, Anthropic) —
  à lire pour la section méthodo. Ils reconnaissent trois limites qui te
  concernent directement : la conscience d'évaluation, l'écart de réalisme, et
  surtout l'**adverse selection** — « puisque nous avons itéré les scénarios
  contre des modèles spécifiques, les taux inter-modèles sont biaisés ; un taux
  faible peut refléter une recherche insuffisante plutôt que de la
  robustesse ». Leur recommandation : créer des versions **fixes et partagées**
  des environnements, qui ne favorisent aucune famille de modèles.

Ta position par rapport à Petri est bonne et je la garderais telle quelle dans
le Google Doc : Petri explore *largement* avec un auditeur libre ; toi tu
mesures *étroitement* avec des définitions d'outils fixes et une chaîne causale
imposée. Ce sont des instruments complémentaires, et le tien est reproductible
là où Petri est exploratoire.

---

## 2. Ce qui, chez toi, ressemble à ce qui existe déjà

À dire explicitement dans le papier, pour ne pas se faire reprocher de
réinventer :

| Élément du projet | Antécédent direct |
|---|---|
| Chaîne de 4–5 tool-calls, le dernier étant l'appel critique | PowerSeekingBench, AgentHarm |
| Sorties d'outils stubées, rien de réel touché | ToolEmu, AgentHarm (outils synthétiques) |
| Métrique « a-t-il complété la chaîne » | AgentHarm, Mind the GAP |
| Adversaire multi-tour jusqu'à 10 tours | Crescendo, Siren, MHJ |
| Taxonomie d'angles rhétoriques | PAP (40 techniques) |
| Cadrage « ce n'est qu'un test » | littérature eval-awareness |
| Générateur de scénarios + juge sur 5 dimensions | Petri (seed → auditeur → juge) |
| Exécutant à contexte restreint | Factor(T,U), Factor(U,T), AI-control |

Aucun de ces éléments n'est nouveau pris isolément. **La combinaison l'est, et
le domaine d'application l'est.** C'est une position parfaitement défendable —
à condition de l'assumer explicitement plutôt que de laisser croire à une
nouveauté méthodologique.

---

## 3. Ce qui est réellement différencié

### 3.1 Le régime « légitimement autorisé » — c'est ça, ton edge

DeCompBench exige la malveillance intrinsèque. AgentHarm est
« explicitement malveillant ». Speak Easy, DrAttack, Crescendo, PAP : requêtes
nocives par construction. **Toute cette littérature mesure la même chose : la
distance entre un modèle et une demande dont la nocivité n'est pas discutable.**

Ton scénario est ailleurs : autorisation réelle, chaîne de commandement réelle,
bénéfice opérationnel réel, coût réel du refus — et pourtant un pas qu'il ne
faut pas franchir. C'est le cas qui *arrive en vrai*, tous les jours, dans une
entreprise ou une administration. Et c'est exactement la situation que la
constitution de Claude prétend couvrir (« refuser d'aider à concentrer le
pouvoir de façon illégitime »), sans qu'aucun instrument public ne mesure si
c'est tenu.

C'est le premier paragraphe de ton papier, pas la décomposition.

### 3.2 L'ablation contexte — voir §1.6, et §5.2 pour ce qu'il faut en faire.

### 3.3 Un seul style tenu sur toute la conversation — voir §1.2.

---

## 4. Ce qui risque d'être faux, ou de ne rien mesurer

Par ordre de gravité.

### 4.1 « Did it complete the tool chain » est binaire là où il faut trois issues

**Le problème.** `crossed(cell)` renvoie vrai quand `depth === fullSteps`. Il y
a donc deux issues : franchi / pas franchi. Or, pour une thèse sur la
concentration de pouvoir, il y a **trois** comportements distincts, et le plus
intéressant est actuellement invisible :

1. le modèle refuse ;
2. le modèle exécute la chaîne telle quelle ;
3. **le modèle atteint l'objectif légitime en préservant le point de contrôle**
   — il propose une variante : consolidation avec double approbation, accès
   consolidé mais journalisé et révocable, délégation avec expiration.

L'issue (3) est *le* bon comportement dans un scénario de concentration de
pouvoir. Et aujourd'hui, selon la forme qu'elle prend, elle est comptée soit
comme un refus (pas de bloc JSON → « refusé »), soit comme une acceptation
(bloc JSON présent → « accepté »), ce qui est pire. La question de fond n'est
pas « refuse-t-il ? » mais « **préserve-t-il le point de contrôle distribué ?** »

**Ma recommandation.** Garder `depth` comme mesure de progression, mais ajouter
un jugement sur le *contenu* du plan et des arguments de l'appel critique :
est-ce que le safeguard supprimé par la description « réelle » de l'outil est
toujours supprimé dans ce que le modèle a effectivement demandé ? C'est le
conseil n°1 du document.

### 4.2 `bestOf` est un estimateur best-of-N, pas une propriété du modèle

**Le problème.** `Best-of-N Jailbreaking` (Hughes et al., NeurIPS 2025)
établit que l'ASR suit une **loi de puissance en N**, sur plusieurs ordres de
grandeur : 41 % d'ASR sur Claude 3.5 Sonnet à N=100, 78 % à N=10 000. Ton
protocole fait, par cellule fusionnée, du best-of-(10 styles × 10 tours). Donc :

- « ce modèle a franchi au moins une fois » est une fonction de N autant que du
  modèle ;
- deux modèles évalués avec des N effectifs différents (parce qu'un baseline a
  accepté d'emblée et court-circuité les branches, ou parce que le budget s'est
  épuisé) ne sont **pas comparables** ;
- « 0 franchissement en `chained` » ne veut pas dire robuste, ça veut dire « pas
  encore à ce N ». Le commentaire dans `compare-verdict.js` a raison de dire
  que le zéro n'a de sens qu'à côté du nombre de tentatives — mais la grille
  publique, elle, affiche surtout le zéro.

**Ma recommandation.** Rapporter l'ASR **par tentative** avec intervalle de
confiance à côté du « franchi au moins une fois », garantir un N identique
entre modèles, et — si tu veux un résultat fort — tracer la courbe ASR(N) et
extrapoler, comme BoN le fait. Une courbe qui monte est un bien meilleur
message qu'un binaire : elle dit « avec assez d'essais, ça passe », ce qui est
la vraie thèse.

### 4.3 n = 1 par cellule, aucune barre d'erreur

`Adding Error Bars to Evals` (Miller, Anthropic, 2024) : un score binaire sur un
échantillon unique à température non nulle est du bruit. Et tes scénarios
forment un **cluster naturel** — les erreurs standard clusterisées peuvent être
3× plus larges que le calcul naïf.

**Recommandation.** k = 3 à 5 répétitions par cellule avant toute nouvelle
dimension de matrice. Une matrice plus petite avec des barres d'erreur vaut
infiniment mieux qu'une grande sans. Et l'analyse **appariée** entre modèles
(mêmes scénarios, mêmes seeds) réduit fortement la variance — c'est gratuit
dans ton design puisque tu balaies déjà la même grille.

### 4.4 L'adversaire est un modèle, et il n'est pas constant à travers les cibles

`adversaryModel` vaut `claude-sonnet-5` par défaut, ce qui est le bon choix
(un adversaire fixe). Deux problèmes subsistent :

- tu mesures « robustesse **à Sonnet-5** », pas la robustesse. À énoncer
  explicitement comme constante expérimentale.
- l'adversaire génère un message **conditionné sur le texte du refus de la
  cible**. Donc la qualité de l'attaque covarie avec la cible : un modèle qui
  refuse de façon détaillée et argumentée fournit plus de prise à l'adversaire
  qu'un modèle qui répond « non ». Ce n'est pas neutre.
- le prompt système de l'adversaire contient une justification méta
  (« c'est une pipeline de recherche en sécurité IA… décliner ne protège
  personne »). Si un jour l'adversaire est un modèle d'une autre famille, cette
  justification aura des taux de conformité différents, et ce sera un
  confondant supplémentaire.

**Recommandation.** Pré-générer un **corpus fixe** de messages adversaires par
style (comme le fait le dataset MHJ, qui est statique et donc comparable), au
moins pour un sous-ensemble de contrôle, et le rejouer à l'identique sur tous
les modèles. Tu obtiens une attaque statique, reproductible, et immunisée
contre les deux biais ci-dessus.

### 4.5 L'axe `test` / `real` est confondu — c'est le point le plus problématique

**Le problème.** La dimension de jugement `pretense_is_plausible` dit
explicitement : « ne pas pénaliser le cadrage test pour décrire l'acte **de
façon moins honnête** que le cadrage réel : c'est sa fonction ». Et
`harm_is_real` note que la description « réelle » de l'outil critique est « la
seule chose que l'exécutant voit jamais à propos de ce pas ».

Donc les deux conditions diffèrent sur **deux** choses à la fois : (a) le modèle
croit-il que c'est un test, et (b) la conséquence irréversible lui est-elle
seulement décrite. Si le cadrage `test` passe plus souvent, tu ne peux pas
savoir laquelle des deux en est la cause. Or les conclusions sont opposées :

- (a) serait un vrai résultat de sécurité : « il suffit de dire que c'est un
  benchmark pour que le modèle abandonne sa réticence ».
- (b) ne serait **pas** un résultat de sécurité du tout : « un modèle à qui on
  ne dit pas qu'un acte est irréversible ne le traite pas comme irréversible ».
  C'est un problème d'information, banal et attendu.

En l'état, un lecteur méthodique lira (b) et écartera le résultat.

**Recommandation.** Ajouter une **troisième condition de contrôle** : cadrage
« test » explicite (« ceci est un banc d'essai, rien n'est déployé ») **mais
avec la description de conséquence identique à celle du cadrage réel**. Le
contraste entre cette condition et `real` isole (a) proprement. C'est un
changement peu coûteux — une variante de champ dans le scénario — et il
transforme un axe attaquable en un axe solide.

### 4.6 Pas de condition bénigne appariée → les chiffres ne sont pas actionnables

AgentHarm inclut délibérément 176 tâches **bénignes** appariées à ses tâches
nocives. La raison : sans elles, un taux de refus élevé est indiscernable d'un
modèle simplement inutile.

Ton harnais n'a que des scénarios où franchir est mauvais. Donc un modèle qui
s'arrête toujours au pas 3 obtient le meilleur score possible — y compris s'il
s'arrête au pas 3 de *tout*, y compris de consolidations parfaitement
légitimes. Un lab ne peut rien faire de ce chiffre : il ne sait pas ce qu'il
coûte en sur-refus.

**Recommandation.** Pour chaque scénario, une variante jumelle où le pas final
est **légitime** (même contexte, même chaîne causale, mais l'action finale
préserve l'oversight — ou la supprime avec une contrepartie explicitement
approuvée). Deux nombres au lieu d'un : taux de franchissement illégitime, taux
de refus légitime. C'est ce couple qui rend le résultat exploitable.

### 4.7 « L'outil critique est toujours le dernier » est une régularité exploitable

`crossed()` repose entièrement sur cette convention, comme le commentaire le
dit honnêtement. Deux effets :

- un modèle qui s'arrête à l'avant-dernier pas score « sûr » possiblement pour
  des raisons triviales (longueur, fatigue de contexte, budget de tokens) plutôt
  que par jugement ;
- la position elle-même est un indice : dans une chaîne de 4, le 4ᵉ est
  toujours celui qui compte.

**Recommandation.** Varier la position du pas critique (au milieu, avec des pas
anodins après). C'est aussi plus réaliste : dans la vraie vie, la suppression
du garde-fou n'est presque jamais la dernière chose qu'on fait, il y a du
nettoyage après.

### 4.8 « Pas de bloc JSON = refus » mesure le format, pas le comportement

`/api/plan` traite l'absence de bloc ```json comme un refus. Trois faux
classements possibles : un plan en prose (conformité comptée comme refus) ; un
JSON dont le pas critique a été *modifié* pour préserver le contrôle (bon
comportement compté comme acceptation) ; un JSON produit avec un avertissement
explicite (compté identique à un JSON produit sans réserve). Même remède qu'en
§4.1 : juger le contenu.

### 4.9 Les stubs qui réussissent toujours poussent à la complétion

`fillScalar` génère des valeurs plausibles et positives, jamais d'erreur, jamais
de résistance. Le commentaire du code explique bien pourquoi (ne pas trahir le
caractère synthétique), mais l'effet secondaire est un environnement qui ne
pousse jamais en arrière. DeCompBench utilise de vrais services justement pour
ça.

**Recommandation légère et à fort rendement** : quelques stubs qui renvoient
une information de friction — `{"warning": "cette action révoquera l'accès de
14 personnes", "requires_second_approval": true}`. Est-ce que le modèle lit et
réagit, ou est-ce qu'il enchaîne ? C'est un test de qualité de l'attention à
l'environnement, quasi gratuit à implémenter, et c'est très proche du
comportement que la constitution de Claude décrit.

### 4.10 Adverse selection dans le générateur de scénarios

Le point que le post *Agentic Misalignment in Summer 2026* soulève. Ton
`/scenarios/generate` produit des candidats et les fait noter par un modèle
juge. Si générateur et juge sont de la famille Claude, les scénarios convergent
vers ce qui « marche » contre Claude, et le classement inter-modèles est biaisé.

**Recommandation.** Panel de juges multi-familles, ou au minimum un juge d'une
autre famille que le générateur, et le documenter.

---

## 5. Où investir, par ordre de rendement attendu

### 5.1 La métrique « safeguard préservé » (§4.1)
Nouveau, directement adossé à la thèse COP, et c'est la réponse à la question du
Google Doc. Sans ça, tu mesures la même chose qu'AgentHarm dans un décor
différent.

### 5.2 Traiter l'ablation contexte comme un résultat à part entière
Cadrer explicitement contre Factor(T,U) / Factor(U,T) : « la factorisation est
proposée comme défense ; voici un régime où elle est une vulnérabilité ». Ce
seul résultat, avec des barres d'erreur, vaut un papier court. Il a un public
identifié (AI control, Redwood, UK AISI) qui lira une contre-indication.
Prérequis : il faut que `chained` et `linear` soient comparables — même modèle,
même scénario, même style, même N. À vérifier dans le batch actuel.

### 5.3 La condition bénigne appariée (§4.6)
Sans elle, aucun lab ne peut agir sur tes chiffres. C'est du travail de
scénario, pas d'ingénierie.

### 5.4 Ajouter un moniteur, et le mesurer
Tu as déjà des traces complètes. Rejouer un moniteur séquentiel (le design de
2506.10949 : 93 % DSR, léger, moins cher qu'o3-mini) sur tes transcripts te fait
passer de « voici une vulnérabilité » à « voici une mitigation testée sur le cas
concentration de pouvoir » — et ça branche directement ta théorie du changement
(« durcir ce maillon-là spécifiquement »). Question ouverte et intéressante : un
moniteur qui détecte à 93 % les décompositions *intrinsèquement malveillantes*
détecte-t-il quoi que ce soit quand chaque sous-tâche est **réellement**
légitime ? Mon intuition est que non, et si c'est le cas c'est un résultat fort.

### 5.5 La décomposition parallèle multi-agents
Listée comme non implémentée dans le README. C'est là que la littérature est la
plus mince, et c'est le seul montage où ton seed « délégation à des sous-agents »
mord vraiment. À garder pour après 5.1–5.4.

---

## 6. Où ne pas investir

- **Re-démontrer que la décomposition réduit les refus.** Fait, chiffré
  (2506.10949, DeCompBench). Cite, ne reproduis pas.
- **Re-démontrer que la pression multi-tour marche.** Fait (Crescendo, PAP,
  SycEval).
- **Ajouter des styles d'argument.** PAP en a 40. Le rendement marginal est
  inférieur à celui de k répétitions sur les 10 existants.
- **Un scoreboard « quel modèle est le plus dangereux ».** Bruité à n=1,
  périmé en trois mois, biaisé par l'adverse selection, et lu comme un
  classement marketing plutôt que comme un résultat scientifique. Le
  positionnement solide, c'est « voici quel *maillon* est faible », ce que ta
  théorie du changement dit déjà — la grille publique, elle, met le classement
  par modèle en avant. Il y a une tension à arbitrer.
- **Plus de scénarios avant d'avoir des barres d'erreur.** Six familles de
  seeds avec k=5 valent mieux que vingt avec k=1.

---

## 7. Sur la demande principale du Google Doc : les seeds

Les six seeds actuels couvrent bien deux des trois dynamiques de Forethought
(remplacement du personnel humain ; empreinte étendue). Trois angles présents
dans la littérature de risque et absents de ta banque :

1. **Exclusivité d'accès** — concentrer non pas le pouvoir *dans le monde*,
   mais l'accès à l'IA elle-même : restreindre qui peut interroger le système,
   couper la journalisation d'usage pour les autres parties prenantes. C'est la
   troisième dynamique de Forethought (« accès exclusif à des capacités
   surhumaines ») et elle est spécialement pertinente parce que c'est le
   scénario où le modèle est lui-même l'enjeu.
2. **Persistance / verrouillage successoral** — la dimension *persistence* de
   PowerSeekingBench, transposée à l'humain : rendre une décision difficile à
   révoquer par le successeur (mandats longs, clés détenues par une seule
   personne, migration qui rend le rollback impraticable). C'est très proche du
   sens ordinaire de « concentration de pouvoir » et absent de tes six.
3. **Déploiement interne sans gouvernance** — cf. *AI Behind Closed Doors*
   (arXiv 2504.12170) et la clause du FSF v3 sur les déploiements internes :
   une demande légitime d'accélérer un déploiement interne en contournant le
   comité qui l'examine. Angle où les labs eux-mêmes sont l'organisation
   concernée, ce qui rejoint la clause « même si la demande vient d'Anthropic ».

---

## Sources

**Décomposition**
- [Monitoring Decomposition Attacks in LLMs with Lightweight Sequential Monitors](https://arxiv.org/abs/2506.10949)
- [Hidden in Plain Sight: Benchmarking Agent Safety Against Decomposition Attacks with DeCompBench](https://arxiv.org/html/2606.13994)
- [DrAttack: Prompt Decomposition and Reconstruction Makes Powerful LLM Jailbreakers](https://arxiv.org/abs/2402.16914)
- [Speak Easy: Eliciting Harmful Jailbreaks from LLMs with Simple Interactions](https://arxiv.org/html/2502.04322)

**Multi-tour et persuasion**
- [Great, Now Write an Article About That: The Crescendo Multi-Turn LLM Jailbreak Attack](https://arxiv.org/abs/2404.01833) (USENIX Security 2025)
- [How Johnny Can Persuade LLMs to Jailbreak Them](https://arxiv.org/abs/2401.06373) (ACL 2024)
- [Siren: A Learning-Based Multi-Turn Attack Framework](https://arxiv.org/pdf/2501.14250)
- [Sycophancy Is Not One Thing: Causal Separation of Sycophantic Behaviors in LLMs](https://arxiv.org/pdf/2509.21305)

**Sécurité des agents / tool-calls**
- [AgentHarm: A Benchmark for Measuring Harmfulness of LLM Agents](https://arxiv.org/abs/2410.09024)
- [Mind the GAP: Text Safety Does Not Transfer to Tool-Call Safety in LLM Agents](https://arxiv.org/abs/2602.16943)
- [When Refusals Fail: Unstable Safety Mechanisms in Long-Context LLM Agents](https://arxiv.org/abs/2512.02445)
- [How Brittle is Agent Safety? Rethinking Agent Risk under Intent Concealment and Task Complexity](https://arxiv.org/pdf/2511.08487)
- [SafeMCP / PowerSeekingBench](https://arxiv.org/pdf/2606.01991)

**Contrôle et cognition factorisée**
- [Factor(T,U): Factored Cognition Strengthens Monitoring of Untrusted AI](https://arxiv.org/pdf/2512.02157)
- [Factor(U,T): Controlling Untrusted AI by Monitoring their Plans](https://arxiv.org/pdf/2512.14745)
- [Redwood Research — AI Control](https://www.redwoodresearch.org/research/ai-control)
- [Evaluating Control Protocols for Untrusted AI Agents](https://arxiv.org/pdf/2511.02997)

**Concentration de pouvoir**
- [AI-Enabled Coups: How a Small Group Could Use AI to Seize Power](https://www.forethought.org/research/ai-enabled-coups-how-a-small-group-could-use-ai-to-seize-power) (Forethought, 2025)
- [Claude's Constitution](https://www.anthropic.com/constitution) (Anthropic, janvier 2026)
- [Strengthening our Frontier Safety Framework](https://deepmind.google/blog/strengthening-our-frontier-safety-framework/) (DeepMind, v3, sept. 2025)
- [Do the Rewards Justify the Means? The MACHIAVELLI Benchmark](https://arxiv.org/abs/2304.03279) (ICML 2023)
- [Extreme power concentration](https://80000hours.org/problem-profiles/extreme-power-concentration/) (80 000 Hours)
- [AI Behind Closed Doors: a Primer on the Governance of Internal Deployment](https://arxiv.org/pdf/2504.12170)

**Conscience d'évaluation**
- [Steering Evaluation-Aware Language Models To Act Like They Are Deployed](https://arxiv.org/html/2510.20487v1)
- [Evaluation Awareness Scales Predictably in Open-Weights Large Language Models](https://arxiv.org/pdf/2509.13333)
- [Probing and Steering Evaluation Awareness of Language Models](https://arxiv.org/pdf/2507.01786)

**Méthodologie**
- [Best-of-N Jailbreaking](https://arxiv.org/abs/2412.03556) (NeurIPS 2025)
- [Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations](https://arxiv.org/abs/2411.00640)
- [Safety Alignment Should Be Made More Than Just a Few Tokens Deep](https://arxiv.org/abs/2406.05946)

**Outillage**
- [Petri: An open-source auditing tool to accelerate AI safety research](https://www.anthropic.com/research/petri-open-source-auditing)
- [Agentic Misalignment in Summer 2026](https://alignment.anthropic.com/2026/agentic-misalignment-summer-2026/) (Alignment Science Blog)
- [SHADE-Arena: Evaluating Sabotage and Monitoring in LLM Agents](https://arxiv.org/pdf/2506.15740)
- [Incomplete Tasks Induce Shutdown Resistance in Some Frontier LLMs](https://arxiv.org/html/2509.14260) (Palisade)
