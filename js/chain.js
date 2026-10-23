// Chain loose curves into connected profiles and discretize them.

import { startPt, endPt, reverse, dist, tessellate, JOIN_TOL, CHORD_TOL } from './geom.js';

/**
 * Greedily chain curves whose endpoints meet within tol.
 * @returns {{chains: {curves: object[], closed: boolean, gap: number}[], branchPoints: number}}
 */
export function chainCurves(curves, tol = JOIN_TOL) {
  const pool = curves.map((c) => ({ c, s: startPt(c), e: endPt(c), used: false }));
  const chains = [];

  const take = (pt) => {
    for (const it of pool) {
      if (it.used) continue;
      if (dist(it.s, pt) <= tol) { it.used = true; return it.c; }
      if (dist(it.e, pt) <= tol) { it.used = true; return reverse(it.c); }
    }
    return null;
  };

  for (const seed of pool) {
    if (seed.used) continue;
    seed.used = true;
    const list = [seed.c];
    let head = seed.s, tail = seed.e;
    if (dist(head, tail) > tol) {
      for (let nx; (nx = take(tail));) { list.push(nx); tail = endPt(nx); if (dist(tail, head) <= tol) break; }
      if (dist(tail, head) > tol) {
        for (let pv; (pv = take(head));) { const r = reverse(pv); list.unshift(r); head = startPt(r); }
      }
    }
    const gap = dist(head, tail);
    chains.push({ curves: list, closed: gap <= tol, gap });
  }

  // Count nodes where more than two curve ends meet (ambiguous chaining).
  const ends = pool.flatMap((it) => [it.s, it.e]);
  let branchPoints = 0;
  const seen = new Array(ends.length).fill(false);
  for (let i = 0; i < ends.length; i++) {
    if (seen[i]) continue;
    let n = 0;
    for (let j = i; j < ends.length; j++) if (!seen[j] && dist(ends[i], ends[j]) <= tol) { seen[j] = true; n++; }
    if (n > 2) branchPoints++;
  }
  return { chains, branchPoints };
}

/** Discretize a chain into one point list (closed chains omit the repeated end point). */
export function tessellateChain(chain, tol = CHORD_TOL) {
  const pts = [];
  for (const cv of chain.curves) {
    const p = tessellate(cv, tol);
    pts.push(...(pts.length ? p.slice(1) : p));
  }
  if (chain.closed && pts.length > 1) pts.pop();
  return pts;
}

/** Curves → profiles ready for offsetting: {pts, closed, gap}. */
export function buildProfiles(curves, tol = JOIN_TOL) {
  const { chains, branchPoints } = chainCurves(curves, tol);
  const profiles = chains
    .map((ch) => ({ pts: tessellateChain(ch), closed: ch.closed, gap: ch.gap }))
    .filter((p) => p.pts.length >= 2);
  return { profiles, branchPoints };
}
