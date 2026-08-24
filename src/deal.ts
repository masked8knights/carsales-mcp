/**
 * "Good deal" scoring for carsales listings.
 *
 * The primary signal is carsales' own price badge (FAIR/GOOD/GREAT/BAD PRICE),
 * which is computed by carsales from real market data, the most reliable
 * indicator we have. We then add small, transparent adjustments from the
 * listing's own numbers (odometer-for-age, price-per-year) so the AI can
 * proactively flag bargains even when the badge is missing.
 */

export interface Deal {
  /** -100..100. Higher is a better deal. */
  score: number;
  label: 'great' | 'good' | 'fair' | 'poor' | 'unknown';
  isGoodDeal: boolean;
  reason: string;
}

export interface DealInput {
  price?: number | null;
  priceExGovt?: number | null;
  year?: number | null;
  odometer?: number | null;
  priceBadge?: string | null;
}

const BADGE_SCORE: Record<string, number> = {
  'GREAT PRICE': 45,
  'GOOD PRICE': 25,
  'FAIR PRICE': 0,
  'BAD PRICE': -35,
};

export function computeDeal(input: DealInput): Deal {
  const badge = (input.priceBadge || '').toUpperCase();
  let score = BADGE_SCORE[badge] ?? 0;
  const reasons: string[] = [];

  if (badge) {
    reasons.push(`carsales badge: ${badge}`);
  } else {
    reasons.push('no price badge from carsales');
  }

  const now = new Date().getFullYear();
  const age = input.year ? now - input.year : null;

  // Odometer-for-age: a lower km/year than typical (~15,000) suggests a
  // gently-used car and a relatively better deal.
  if (age != null && age > 0 && input.odometer != null) {
    const kmPerYear = input.odometer / age;
    if (kmPerYear < 8000) {
      score += 15;
      reasons.push(`very low use (${Math.round(kmPerYear).toLocaleString()} km/yr)`);
    } else if (kmPerYear < 12000) {
      score += 8;
      reasons.push(`low use (${Math.round(kmPerYear).toLocaleString()} km/yr)`);
    } else if (kmPerYear > 25000) {
      score -= 8;
      reasons.push(`high use (${Math.round(kmPerYear).toLocaleString()} km/yr)`);
    }
  }

  // Price-per-year sanity: an unusually low $/year for the age (when we have a
  // price) is a mild positive; we only nudge, we don't pretend to know market.
  const price = input.price ?? input.priceExGovt ?? null;
  if (price != null && age != null && age > 0) {
    const perYear = price / age;
    if (perYear < 2500) {
      score += 10;
      reasons.push(`low price-per-year ($${Math.round(perYear).toLocaleString()}/yr)`);
    } else if (perYear > 12000) {
      score -= 10;
      reasons.push(`high price-per-year ($${Math.round(perYear).toLocaleString()}/yr)`);
    }
  }

  score = Math.max(-100, Math.min(100, Math.round(score)));

  let label: Deal['label'];
  if (badge === 'GREAT PRICE' || score >= 45) label = 'great';
  else if (badge === 'GOOD PRICE' || score >= 20) label = 'good';
  else if (badge === 'BAD PRICE' || score <= -20) label = 'poor';
  else if (badge === 'FAIR PRICE') label = 'fair';
  else label = 'unknown';

  const isGoodDeal = label === 'great' || label === 'good';

  return { score, label, isGoodDeal, reason: reasons.join('; ') };
}
