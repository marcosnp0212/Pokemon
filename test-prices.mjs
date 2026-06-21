import { resolveVariant, tcgdexIdenticalVariants, median } from './update-prices.mjs';
import assert from 'node:assert';

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++; } };

// Datos reales: Furret swsh3-136 (pokemontcg.io en vivo)
const ptcgFurret = { url: 'https://prices.pokemontcg.io/cardmarket/swsh3-136', updatedAt: '2025/11/21',
  prices: { averageSellPrice: 0.11, lowPrice: 0.02, trendPrice: 0.11,
            reverseHoloSell: 0.27, reverseHoloLow: 0.03, reverseHoloTrend: 0.23,
            avg1: 0.03, avg7: 0.07, avg30: 0.1,
            reverseHoloAvg1: 0.25, reverseHoloAvg7: 0.17, reverseHoloAvg30: 0.21 } };
// TCGdex (esquema oficial): standard ~ trend 0.08, holo trend-holo 0.21
const tcgdexFurret = { unit: 'EUR', updated: '2025-08-05T00:42:15.000Z',
  avg: 0.08, low: 0.02, trend: 0.10, avg1: 0.03, avg7: 0.08, avg30: 0.08,
  'avg-holo': 0.27, 'low-holo': 0.03, 'trend-holo': 0.21, 'avg7-holo': 0.19, 'avg30-holo': 0.26 };

check('normal: dos fuentes que concuerdan -> high', () => {
  // ptcg trend 0.11 vs tcgdex trend 0.10 -> diff 0.01 <= 0.50 abs => high
  const r = resolveVariant('normal', tcgdexFurret, ptcgFurret);
  assert.equal(r.confidence, 'high', 'conf=' + r.confidence);
  assert.ok(r.sources.ptcg && r.sources.tcgdex, 'faltan fuentes');
  assert.equal(r.eur, 0.11); // mediana de [0.10,0.11] = 0.105 -> 0.11
});

check('reverse: solo ptcg es fiable (tcgdex no) -> medium, single_source', () => {
  const r = resolveVariant('reverse', tcgdexFurret, ptcgFurret);
  assert.equal(r.confidence, 'medium', 'conf=' + r.confidence);
  assert.ok(r.flags.includes('single_source'));
  assert.equal(r.eur, 0.23); // reverseHoloTrend
  // tcgdex aparece como fuente pero NO fiable -> no debe contar
  assert.equal(r.sources.tcgdex?.reliable, false);
});

check('divergencia real entre fuentes -> low + sources_diverge', () => {
  const tcg = { unit:'EUR', updated:'x', trend: 50, avg: 50, 'trend-holo': 80 };
  const ptcg = { url:'u', updatedAt:'y', prices: { trendPrice: 10, averageSellPrice: 10 } };
  const r = resolveVariant('normal', tcg, ptcg); // 50 vs 10 -> diverge
  assert.equal(r.confidence, 'low', 'conf=' + r.confidence);
  assert.ok(r.flags.includes('sources_diverge'));
});

check('sin datos -> none + no_data', () => {
  const r = resolveVariant('normal', null, null);
  assert.equal(r.confidence, 'none');
  assert.ok(r.flags.includes('no_data'));
  assert.equal(r.eur, null);
});

check('detección del bug: standard == holo idénticos', () => {
  assert.equal(tcgdexIdenticalVariants({ trend: 5, 'trend-holo': 5 }), true);
  assert.equal(tcgdexIdenticalVariants({ trend: 5, 'trend-holo': 8 }), false);
  assert.equal(tcgdexIdenticalVariants(null), false);
});

check('holo: usa trend-holo, no trend', () => {
  const r = resolveVariant('holo', tcgdexFurret, ptcgFurret);
  // tcgdex holo 0.21, ptcg trendPrice 0.11 -> diff 0.10 <= 0.50 => high
  assert.equal(r.sources.tcgdex.field, 'trend-holo');
  assert.equal(r.sources.tcgdex.value, 0.21);
});

check('median util', () => {
  assert.equal(median([1,2,3]), 2);
  assert.equal(median([1,3]), 2);
});

console.log(`\nResultado: ${pass} OK, ${fail} fallos`);
process.exit(fail ? 1 : 0);
