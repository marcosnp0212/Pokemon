#!/usr/bin/env node
// ============================================================================
//  Trabajador de precios multi-fuente  (corre en GitHub Actions, cron diario)
// ----------------------------------------------------------------------------
//  1. Lee data/collection.json
//  2. Para cada cardId único, consulta TCGdex y pokemontcg.io (Cardmarket, EUR)
//  3. Por cada (cardId, variante) extrae el precio de cada fuente fiable
//  4. Cruza las fuentes -> valor de consenso + nivel de confianza + flags
//  5. Detecta el síntoma del bug (precios idénticos entre variantes)
//  6. Escribe data/prices.json (que el frontend lee de forma estática)
//
//  No falla nunca por una carta: registra el problema como flag y sigue.
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VARIANTS, PRICE_MAP, THRESHOLDS, pickField } from './variants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const COLLECTION = join(ROOT, 'collection.json');
const PRICES = join(ROOT, 'prices.json');

const PTCG_KEY = process.env.POKEMONTCG_API_KEY || ''; // opcional, sube el límite
const CONCURRENCY = 4;

// --- utilidades de red -----------------------------------------------------
async function fetchJson(url, headers = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404) return null;          // carta no encontrada en esa fuente
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
  return d?.pricing?.cardmarket || null; // { unit:'EUR', trend, avg, 'trend-holo', ... }
}

async function getPtcg(cardId) {
  const headers = PTCG_KEY ? { 'X-Api-Key': PTCG_KEY } : {};
  const d = await fetchJson(`https://api.pokemontcg.io/v2/cards/${encodeURIComponent(cardId)}`, headers);
  const cm = d?.data?.cardmarket || null;
  return cm ? { prices: cm.prices, url: cm.url, updatedAt: cm.updatedAt } : null;
}

// --- lógica de consenso ----------------------------------------------------
export function resolveVariant(variant, tcgdex, ptcg) {
  const flags = [];
  const sources = {};

  // pokemontcg.io
  const pMap = PRICE_MAP.ptcg[variant];
  const pPick = pickField(ptcg?.prices, pMap.fields);
  if (pPick) sources.ptcg = { ...pPick, reliable: pMap.reliable, updated: ptcg?.updatedAt || null };

  // TCGdex
  const tMap = PRICE_MAP.tcgdex[variant];
  const tPick = pickField(tcgdex, tMap.fields);
  if (tPick) sources.tcgdex = { ...tPick, reliable: tMap.reliable, updated: tcgdex?.updated || null };

  // valores fiables para el consenso
  const reliable = Object.values(sources).filter(s => s.reliable).map(s => s.value);

  let eur = null, confidence = 'none', spread = null;

  if (reliable.length >= 2) {
    const min = Math.min(...reliable), max = Math.max(...reliable);
    spread = +((max - min)).toFixed(2);
    const rel = (max - min) / min;
    const agree = rel <= THRESHOLDS.divergeRel || (max - min) <= THRESHOLDS.divergeAbs;
    eur = +median(reliable).toFixed(2);
    if (agree) {
      confidence = 'high';
    } else {
      confidence = 'low';
      flags.push('sources_diverge');
    }
  } else if (reliable.length === 1) {
    eur = +reliable[0].toFixed(2);
    confidence = 'medium';
    flags.push('single_source');
  } else {
    // ninguna fuente fiable; usar la mejor no fiable solo como pista
    const any = Object.values(sources)[0];
    if (any) { eur = +any.value.toFixed(2); confidence = 'low'; flags.push('no_reliable_source'); }
    else { flags.push('no_data'); }
  }

  return { eur, confidence, spread, flags, sources };
}

export function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Detección del síntoma del bug en TCGdex: standard == holo idénticos.
export function tcgdexIdenticalVariants(tcgdex) {
  if (!tcgdex) return false;
  const a = tcgdex['trend'], b = tcgdex['trend-holo'];
  return typeof a === 'number' && typeof b === 'number' && a > 0 && a === b;
}

// --- pool de concurrencia simple -------------------------------------------
async function mapPool(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

// --- main ------------------------------------------------------------------
async function main() {
  const collection = JSON.parse(await readFile(COLLECTION, 'utf8'));
  const cards = collection.cards || [];

  // cardIds únicos y conjunto de variantes pedidas por carta
  const byCard = new Map();
  for (const c of cards) {
    if (!c.cardId) continue;
    if (!byCard.has(c.cardId)) byCard.set(c.cardId, new Set());
    byCard.get(c.cardId).add(c.variant || 'normal');
  }
  const cardIds = [...byCard.keys()];
  console.log(`Cartas únicas a precificar: ${cardIds.length}`);

  const out = {};
  let ok = 0, withFlags = 0, errors = 0;

  await mapPool(cardIds, CONCURRENCY, async (cardId) => {
    let tcgdex = null, ptcg = null;
    try {
      [tcgdex, ptcg] = await Promise.all([
        getTcgdex(cardId).catch(() => null),
        getPtcg(cardId).catch(() => null),
      ]);
    } catch (e) {
      errors++; console.warn(`! ${cardId}: ${e.message}`);
    }

    const buggy = tcgdexIdenticalVariants(tcgdex);

    for (const variant of byCard.get(cardId)) {
      const r = resolveVariant(variant, tcgdex, ptcg);
      if (buggy && (variant === 'holo' || variant === 'normal')) {
        r.flags.push('tcgdex_identical_variants');
        // si TCGdex estaba arrastrando el consenso, degradamos confianza
        if (r.confidence === 'high') r.confidence = 'medium';
      }
      if (r.eur != null) ok++; else withFlags++;
      if (r.flags.length) withFlags++;

      out[`${cardId}|${variant}`] = {
        eur: r.eur,
        confidence: r.confidence,
        spread: r.spread,
        flags: r.flags,
        cardmarketUrl: ptcg?.url || null,
        sources: r.sources,
      };
    }
  });

  const result = {
    generatedAt: new Date().toISOString(),
    currency: 'EUR',
    stats: { cards: cardIds.length, priced: ok, flagged: withFlags, errors },
    prices: out,
  };
  await writeFile(PRICES, JSON.stringify(result, null, 2) + '\n');
  console.log(`Listo. Precificadas ${ok}, con avisos ${withFlags}, errores ${errors}.`);
}

const isMain = process.argv[1] && process.argv[1].endsWith("update-prices.mjs");
if (isMain) main().catch(e => { console.error("FALLO GLOBAL:", e); process.exit(1); });
