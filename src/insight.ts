/**
 * Free, FOSS valuation helper. Instead of a paid valuation API (RedBook /
 * CarHistory), we derive a fair-price band from *free* comparable carsales
 * listings (same make/model/year window). Best-effort: depends on how many
 * comparables the scraper returns.
 */

import { ListingCard } from './browser.js';

export interface PriceInsight {
  count: number;
  min: number | null;
  max: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  mean: number | null;
  yearBuckets: { year: number; median: number; count: number }[];
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

export function computePriceInsight(cards: ListingCard[]): PriceInsight {
  const prices = cards
    .map((c) => c.price ?? c.priceExGovt ?? null)
    .filter((p): p is number => p != null && p > 0)
    .sort((a, b) => a - b);
  const mean = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const byYear = new Map<number, number[]>();
  for (const c of cards) {
    const p = c.price ?? c.priceExGovt ?? null;
    if (c.year && p && p > 0) {
      if (!byYear.has(c.year)) byYear.set(c.year, []);
      byYear.get(c.year)!.push(p);
    }
  }
  const yearBuckets = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, ps]) => {
      const s = [...ps].sort((a, b) => a - b);
      return { year, median: quantile(s, 0.5)!, count: ps.length };
    });

  return {
    count: prices.length,
    min: prices[0] ?? null,
    max: prices[prices.length - 1] ?? null,
    median: quantile(prices, 0.5),
    p25: quantile(prices, 0.25),
    p75: quantile(prices, 0.75),
    mean,
    yearBuckets,
  };
}

export function formatInsight(
  insight: PriceInsight,
  make: string,
  model: string | undefined,
  targetPrice: number | null,
): string {
  const aud = (n: number | null) => (n == null ? 'n/a' : '$' + Math.round(n).toLocaleString());
  const lines = [
    `Fair-price band for ${make}${model ? ' ' + model : ''} (from ${insight.count} free comparable listings):`,
    `  median: ${aud(insight.median)}   (25th–75th pct: ${aud(insight.p25)} – ${aud(insight.p75)})`,
    `  range:  ${aud(insight.min)} – ${aud(insight.max)}   mean: ${aud(insight.mean)}`,
  ];
  if (insight.yearBuckets.length) {
    lines.push('  by year:');
    for (const b of insight.yearBuckets.slice(0, 6)) {
      lines.push(`    ${b.year}: median ${aud(b.median)} (n=${b.count})`);
    }
  }
  if (targetPrice != null) {
    if (insight.median != null) {
      const diff = targetPrice - insight.median;
      const pct = Math.round((diff / insight.median) * 100);
      const word = diff <= 0 ? 'BELOW' : 'ABOVE';
      lines.push(
        `  Listing price ${aud(targetPrice)} is ${word} median by ${aud(Math.abs(diff))} (${Math.abs(pct)}%).`,
      );
    } else {
      lines.push(`  Listing price ${aud(targetPrice)} — no comparables to judge against.`);
    }
  }
  return lines.join('\n');
}
