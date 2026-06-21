#!/usr/bin/env node
// Trabajador de precios multi-fuente (GitHub Actions). Autónomo, sin imports externos.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PRICE_MAP = {
  ptcg: {
    normal:       { fields: ['trendPrice', 'averageSellPrice', 'avg7'], reliable: true },
    holo:         { fields: ['trendPrice', 'averageSellPrice', 'avg7'], reliable: true },
    reverse:      { fields: ['reverseHoloTrend', 'reverseHoloSell', 'reverseHoloAvg7'], reliable: true },
    firstEdition: { fields: ['trendPrice', 'averageSellPrice', 'avg7'], reliable: false },
    promo:        { fields: ['trendPrice', 'averageSellPrice', 'avg7'], reliable: true },
  },
  tcgdex: {
    normal:       { fields: ['trend', 'avg', 'avg7'], reliable: true },
    holo:         { fields: ['trend-holo', 'avg-holo', 'avg7-holo'], reliable: true },
    reverse:      { fields: ['trend-holo', 'avg-holo', 'trend', 'avg'], reliable: false },
    firstEdition: { fields: ['trend', 'avg'], reliable: false },
    promo:        { fields: ['trend', 'avg'], reliable: false },
  },
};
const THRESHOLDS = { divergeRel: 0.20, divergeAbs: 0.50 };

function pickField(priceObj, fields) {
  if (!priceObj) return null;
  for (const f of fields) {
    const v = priceObj[f];
    if (typeof v === 'number' && v > 0) return { value: v, field: f };
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const COLLECTION = join(ROOT, 'collection.json');
const PRICES = join(ROOT, 'prices.json');
const PTCG_KEY = process.env.POKEMONTCG_API_KEY || '';
const CONCURRENCY = 4;

async function fetchJson(url, headers = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}
async function getTcgdex(cardId) {
  const d = await fetchJson(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(cardId)}`);
  return d?.pricing?.cardmarket || null;
}
async function getPtcg(cardId) {
  const headers = PTCG_KEY ? { 'X-Api-Key': PTCG_KEY } : {};
  const d = await fetchJson(`https://api.pokemontcg.io/v2/cards/${encodeURIComponent(cardId)}`, headers);
  const cm = d?.data?.cardmarket || null;
  return cm ? { prices: cm.prices, url: cm.url, updatedAt: cm.updatedAt } : null;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function tcgdexIdenticalVariants(t) {
  if (!t) return false;
  const a = t['trend'], b = t['trend-holo'];
  return typeof a === 'number' && typeof b === 'number' && a > 0 && a === b;
}
function resolveVariant(variant, tcgdex, ptcg) {
  const flags = [], sources = {};
  const pPick = pickField(ptcg?.prices, PRICE_MAP.ptcg[variant].fields);
  if (pPick) sources.ptcg = { ...pPick, reliable: PRICE_MAP.ptcg[variant].reliable };
  const tPick = pickField(tcgdex, PRICE_MAP.tcgdex[variant].fields);
  if (tPick) sources.tcgdex = { ...tPick, reliable: PRICE_MAP.tcgdex[variant].reliable };
  const reliable = Object.values(sources).filter(s => s.reliable).map(s => s.value);
  let eur = null, confidence = 'none', spread = null;
  if (reliable.length >= 2) {
    const min = Math.min(...reliable), max = Math.max(...reliable);
    spread = +((max - min)).toFixed(2);
    const agree = (max - min) / min <= THRESHOLDS.divergeRel || (max - min) <= THRESHOLDS.divergeAbs;
    eur = +median(reliable).toFixed(2);
    if (agree) confidence = 'high'; else { confidence = 'low'; flags.push('sources_diverge'); }
  } else if (reliable.length === 1) {
    eur = +reliable[0].toFixed(2); confidence = 'medium'; flags.push('single_source');
  } else {
    const any = Object.values(sources)[0];
    if (any) { eur = +any.value.toFixed(2); confidence = 'low'; flags.push('no_reliable_source'); }
    else flags.push('no_data');
  }
  return { eur, confidence, spread, flags, sources };
}

async function mapPool(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function main() {
  let collection = { cards: [] };
  try { collection = JSON.parse(await readFile(COLLECTION, 'utf8')); }
  catch { console.log('No hay collection.json todavía.'); }
  const cards = collection.cards || [];
  const byCard = new Map();
  for (const c of cards) {
    if (!c.cardId) continue;
    if (!byCard.has(c.cardId)) byCard.set(c.cardId, new Set());
    byCard.get(c.cardId).add(c.variant || 'normal');
  }
  const cardIds = [...byCard.keys()];
  console.log(`Cartas únicas: ${cardIds.length}`);
  const out = {}; let ok = 0, withFlags = 0;
  await mapPool(cardIds, CONCURRENCY, async (cardId) => {
    const [tcgdex, ptcg] = await Promise.all([
      getTcgdex(cardId).catch(() => null),
      getPtcg(cardId).catch(() => null),
    ]);
    const buggy = tcgdexIdenticalVariants(tcgdex);
    for (const variant of byCard.get(cardId)) {
      const r = resolveVariant(variant, tcgdex, ptcg);
      if (buggy && (variant === 'holo' || variant === 'normal')) {
        r.flags.push('tcgdex_identical_variants');
        if (r.confidence === 'high') r.confidence = 'medium';
      }
      if (r.eur != null) ok++;
      if (r.flags.length) withFlags++;
      out[`${cardId}|${variant}`] = {
        eur: r.eur, confidence: r.confidence, spread: r.spread,
        flags: r.flags, cardmarketUrl: ptcg?.url || null, sources: r.sources,
      };
    }
  });
  await writeFile(PRICES, JSON.stringify({
    generatedAt: new Date().toISOString(), currency: 'EUR',
    stats: { cards: cardIds.length, priced: ok, flagged: withFlags }, prices: out,
  }, null, 2) + '\n');
  console.log(`Listo. Precificadas ${ok}, avisos ${withFlags}.`);
}
main().catch(e => { console.error('FALLO GLOBAL:', e); process.exit(1); });
