# Capacité d'exécution — ce que le chiffre veut dire, et ce qu'il ne dit pas

Document de référence pour l'endpoint `/ultra`. Écrit pour qu'un acheteur puisse
recalculer le chiffre lui-même à partir des carnets publics, sans nous croire.

---

## 1. Le problème que ce chiffre résout

Un écart de financement ne dit pas s'il est exploitable. Deux inconnues restent :

1. **Combien ?** Un écart de 1 800 bps annualisés sur une paire dont le carnet
   Hyperliquid contient 15 000 $ n'est pas la même chose que le même écart sur
   un carnet de 8 millions.
2. **À quel prix ?** Entrer sur les deux jambes coûte l'impact de carnet plus
   les frais. Si ce coût dépasse le rendement, l'écart est théorique.

`capacity_usd` répond à la première question, et fournit de quoi répondre à la
seconde.

## 2. Définition exacte

> La capacité est le plus grand notionnel `N` qu'on puisse exécuter
> **simultanément** sur les deux jambes, au marché, avant que la somme des
> impacts des deux entrées ne dépasse le budget d'impact annoncé.

Le budget par défaut est **10 points de base**. Il est publié dans chaque
réponse (`impact_budget_bps`) et n'est pas caché : un acheteur qui veut
20 bps sait quel chiffre lire, puisque l'impact réel des deux jambes est
également publié.

## 3. Le calcul, ligne par ligne

Pour un notionnel `N` :

```
impact_total(N) = impact_HL(N) + impact_CEX(N)
```

Chaque impact se calcule en consommant le carnet dans l'ordre du meilleur prix :

```
reste = N
pour chaque niveau (prix, taille) du carnet, du meilleur au pire :
    niveau_usd = prix × taille
    pris       = min(reste, niveau_usd)
    quantité  += pris / prix
    dépensé   += pris
    reste     -= pris
```

Puis, selon le côté :

```
vente  : vwap = dépensé / quantité      impact = (meilleur_bid − vwap) / meilleur_bid × 10 000
achat  : vwap = dépensé / quantité      impact = (vwap − meilleur_ask) / meilleur_ask × 10 000
```

Le côté dépend du sens de la divergence :

| Divergence | Jambe Hyperliquid | Jambe benchmark |
|---|---|---|
| HL > CEX | vendre → tape les bids | acheter → lève les asks |
| HL < CEX | acheter → lève les asks | vendre → tape les bids |

`impact_total(N)` est strictement croissante en `N`. La capacité est donc la
plus grande racine de `impact_total(N) = budget`, trouvée par **dichotomie**
(48 itérations), et non par une formule approchée.

## 4. Vérification : le cas résolu à la main

Carnet Hyperliquid à vendre : 100 unités à 100, puis 100 unités à 99.
Carnet benchmark à acheter : profondeur illimitée à 100 (impact nul).
Budget : 10 bps.

Pour `N` entre 10 000 et 19 900, le vwap vaut `N / (100 + (N − 10 000) / 99)`.
L'impact atteint 10 bps quand le vwap tombe à 99,90 :

```
N = 99,90 × (100 + (N − 10 000) / 99)
N = 11 100
```

La solution exacte est **11 100 $**. Le test automatisé l'exige à 5 $ près et
passe. C'est la preuve que le solveur n'approxime pas.

## 5. Ce que le chiffre inclut, et ce qu'il ignore

**Inclus dans la mesure :**

- la profondeur réelle des deux carnets, niveau par niveau ;
- la conversion des contrats OKX en monnaie de base (`ctVal × ctMult`), sans
  laquelle la profondeur serait fausse d'un ordre de grandeur ;
- le côté correct selon le sens de la divergence.

**Explicite dans la réponse, mais non mesurable :**

- **les frais** : supposés à 9,5 bps (4,5 Hyperliquid + 5 CEX, palier de base).
  Surchargeables par `fees_bps`. Un taker VIP paie moins, un maker presque rien.
- **la borne de profondeur** : Hyperliquid publie une vingtaine de niveaux par
  côté, Binance 100, OKX 50. Au-delà, la profondeur existe peut-être mais elle
  est **invisible**, donc jamais extrapolée.
- **le plafond interne** : 50 000 000 $. Quand il mord, `usd_lower_bound: true`
  signale que le chiffre est un plancher, pas une mesure.

**Non inclus, volontairement :**

- le risque de liquidation, les appels de marge, le financement adverse ;
- la stabilité temporelle de l'écart (elle est dans `stability`, champ distinct) ;
- l'exécution réelle : la mesure suppose une exécution immédiate et complète,
  ce qu'aucun carnet ne garantit.

## 6. Le champ `breakeven_days`

```
breakeven_days = (frais + impact_HL + impact_CEX) / rendement_quotidien
rendement_quotidien = |divergence_bps| / 365
```

C'est une **conversion d'unité** : la divergence annualisée ramenée au jour, et
le coût d'entrée divisé par ce rendement. Le résultat dit au bout de combien de
jours de portage le coût d'entrée est remboursé, à taux constants.

Ce n'est ni une prévision, ni une recommandation. Le taux change ; le calcul
suppose qu'il ne change pas.

## 7. Relevé réel (1er novembre 2026, venue de référence Binance)

| Paire | Divergence | Capacité | Impact HL + CEX | Carnet HL | Carnet CEX | Retour |
|---|---|---|---|---|---|---|
| USELESS | −1 885 bps | 6 969 $ | 3,13 + 6,87 bps | 15 399 $ | 155 025 $ | 3,78 j |
| UNI | 1 870 bps | 84 459 $ | 2,67 + 2,30 bps | 84 459 $ | 2 457 600 $ | 2,82 j |
| ETH | 1 216 bps | ≥ 7 951 714 $ | 3,25 + 2,34 bps | 7 951 714 $ | 5 204 684 $ | 4,53 j |
| BNB | 842 bps | 88 333 $ | 2,66 + 0,19 bps | 88 333 $ | 1 489 274 $ | 5,35 j |

Lecture : sur USELESS, l'écart est énorme mais le carnet Hyperliquid ne porte
que 15 000 $ — la capacité réelle est de 7 000 $. Sur ETH, la profondeur dépasse
le plafond de mesure. C'est exactement la distinction que la divergence seule ne
fait pas.

## 8. Pourquoi ce n'est pas un conseil

Le endpoint ne dit jamais quelle taille prendre. Il ne connaît ni le capital de
l'acheteur, ni son mandat, ni son appétit de risque, ni sa tolérance à la
liquidation. Il publie trois faits mesurés — profondeur, impact, coût d'entrée —
et laisse l'acheteur décider.

`capacity_usd` est une propriété du **marché**, pas une instruction pour
l'acheteur. C'est la différence entre « ce pont supporte 40 tonnes » et
« vous devriez traverser avec 40 tonnes ».
