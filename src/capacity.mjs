/**
 * Capacite d'execution : combien de notionnel peut passer sur les deux jambes
 * avant que le desequilibre ne coute plus que le budget d'impact choisi.
 *
 * CE QUE CE MODULE EST, ET CE QU'IL N'EST PAS
 * -------------------------------------------
 * C'est une mesure de profondeur de carnet. Il repond a une seule question :
 * « a partir de quelle taille l'execution des deux jambes coute-t-elle plus de
 * X points de base ? ». Il ne dit pas quoi faire, ni quelle taille prendre.
 * Aucune recommandation, aucune allocation : uniquement de l'arithmetique sur
 * des carnets publics.
 *
 * MODELE
 * ------
 * On suppose une execution au marche des deux cotes, simultanement, pour le
 * meme notionnel N. Chaque jambe consomme les niveaux du carnet dans l'ordre
 * du meilleur prix au pire. Le prix moyen obtenu (vwap) est compare au
 * meilleur prix affiche avant execution : l'ecart, en points de base, est
 * l'impact de cette jambe.
 *
 *   impact(N) = impact_HL(N) + impact_CEX(N)
 *
 * impact(N) est croissante en N. La capacite est le plus grand N tel que
 * impact(N) <= seuil. On le trouve par dichotomie, ce qui evite toute
 * supposition sur la forme de la courbe.
 *
 * Les niveaux sont fournis tels que les venues les publient : {px, sz}.
 * Aucune conversion de contrat n'est faite ici, c'est le role de l'appelant,
 * qui seul connait la valeur du contrat (OKX exprime ses tailles en contrats).
 */

const BPS = 10_000;

/** Garde-fou : un carnet malforme ne doit pas produire d'infini. */
const MAX_SANE_LEVELS = 500;

/**
 * Normalise un cote de carnet : nombres finis, prix strictement positifs,
 * tri par prix decroissant pour les bids, croissant pour les asks.
 */
export function normaliseLevels(levels, side) {
  const rows = Array.isArray(levels) ? levels : [];
  const clean = [];
  for (const level of rows.slice(0, MAX_SANE_LEVELS)) {
    const px = Number(level?.px);
    const sz = Number(level?.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    if (px <= 0 || sz <= 0) continue;
    clean.push({ px, sz });
  }
  clean.sort((a, b) => (side === "bid" ? b.px - a.px : a.px - b.px));
  return clean;
}

/** Notionnel total disponible sur un cote, en dollars. */
export function bookDepthUsd(levels) {
  let total = 0;
  for (const { px, sz } of levels) total += px * sz;
  return total;
}

/**
 * Impact d'une execution au marche sur un cote de carnet.
 *
 * side = "bid"  : on vend, on tape dans les bids, le vwap descend sous le
 *                 meilleur bid. L'impact est la perte relative.
 * side = "ask"  : on achete, on leve les asks, le vwap monte au-dessus du
 *                 meilleur ask. L'impact est le surcout relatif.
 *
 * Si le carnet ne contient pas assez de taille, `exhausted` vaut true et le
 * vwap ne porte que sur la partie remplie : l'appelant doit traiter ce cas
 * comme une borne, pas comme une execution complete.
 */
export function sideImpact(levels, side, notionalUsd) {
  const book = levels && levels.length ? levels : [];
  if (book.length === 0 || !(notionalUsd > 0)) {
    return { filledUsd: 0, vwap: null, impactBps: null, exhausted: true, best: null };
  }

  const best = book[0].px;
  let remaining = notionalUsd;
  let filledUsd = 0;
  let filledQty = 0;

  for (const { px, sz } of book) {
    if (remaining <= 0) break;
    const levelUsd = px * sz;
    const take = Math.min(remaining, levelUsd);
    filledUsd += take;
    filledQty += take / px;
    remaining -= take;
  }

  const exhausted = remaining > 1e-6;
  const vwap = filledQty > 0 ? filledUsd / filledQty : null;

  let impactBps = null;
  if (vwap !== null) {
    // Signe toujours positif : c'est un cout, quel que soit le cote.
    impactBps = ((side === "bid" ? best - vwap : vwap - best) / best) * BPS;
    if (!Number.isFinite(impactBps)) impactBps = null;
  }

  return { filledUsd, vwap, impactBps, exhausted, best };
}

/**
 * Plus grande taille telle que l'impact cumule des deux jambes reste sous le
 * seuil. Dichotomie sur [0, profondeur_min].
 *
 * Retourne aussi l'impact de chaque jambe a cette taille, pour que le client
 * puisse verifier le chiffre au lieu de le croire.
 */
export function orderBookCapacity({
  hlLevels,
  cexLevels,
  hlSide,
  cexSide,
  maxImpactBps = 10,
  maxUsd = 50_000_000,
  iterations = 48,
}) {
  const hl = normaliseLevels(hlLevels, hlSide);
  const cex = normaliseLevels(cexLevels, cexSide);

  const hlDepthUsd = bookDepthUsd(hl);
  const cexDepthUsd = bookDepthUsd(cex);
  const ceiling = Math.min(hlDepthUsd, cexDepthUsd, maxUsd);

  const impactAt = (usd) => {
    const a = sideImpact(hl, hlSide, usd);
    const b = sideImpact(cex, cexSide, usd);
    if (a.impactBps === null || b.impactBps === null) return null;
    return { total: a.impactBps + b.impactBps, hl: a.impactBps, cex: b.impactBps, exhausted: a.exhausted || b.exhausted };
  };

  if (!(ceiling > 0)) {
    return {
      usd: 0,
      hlImpactBps: null,
      cexImpactBps: null,
      hlDepthUsd,
      cexDepthUsd,
      reason: hlDepthUsd === 0 ? "empty_hyperliquid_book" : "empty_benchmark_book",
    };
  }

  // Si meme la totalite du carnet tient dans le budget, la profondeur publique
  // est la limite, et non le seuil d'impact.
  const atCeiling = impactAt(ceiling);
  if (atCeiling && atCeiling.total <= maxImpactBps) {
    return {
      usd: ceiling,
      hlImpactBps: atCeiling.hl,
      cexImpactBps: atCeiling.cex,
      hlDepthUsd,
      cexDepthUsd,
      reason: ceiling === maxUsd && ceiling < Math.min(hlDepthUsd, cexDepthUsd) ? "capped_by_request" : "capped_by_visible_depth",
    };
  }

  let lo = 0;
  let hi = ceiling;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (lo + hi) / 2;
    if (mid <= lo || mid >= hi) break;
    const at = impactAt(mid);
    if (!at) break;
    if (at.total <= maxImpactBps) lo = mid;
    else hi = mid;
  }

  const final = impactAt(lo);
  return {
    usd: lo,
    hlImpactBps: final ? final.hl : null,
    cexImpactBps: final ? final.cex : null,
    hlDepthUsd,
    cexDepthUsd,
    reason: lo <= 0 ? "no_size_within_budget" : "impact_budget",
  };
}

export default { normaliseLevels, bookDepthUsd, sideImpact, orderBookCapacity };
