/**
 * Free, FOSS vehicle reliability / trust assessment.
 *
 * There is no free API for reliability scores (RedBook/Glass's Data carry them,
 * paid). Instead we use a small transparent, editable dataset of real-world
 * reputation (YMM), combined with the listing's own live market signals that we
 * already scrape:
 *   - carsales' own price indicator (FAIR/GOOD/GREAT PRICE) is real market data:
 *     a GREAT PRICE badge reflects demand/price health for that make+model+year.
 *   - the odometer-for-age drives a "high use = more wear" adjustment.
 *   - (Optionally a dealer star rating via dealer_info.)
 *
 * The rating is a heuristic to guide a human, never a guarantee. Always verify
 * with a PPI + PPSR before buying.
 */

export interface ReliabilityResult {
  score: number; // 0..100
  band: 'HIGH' | 'MEDIUM' | 'LOW';
  note: string;
  issues: string[];
}

interface ModelRating {
  score: number; // 0..100 baseline
  note: string;
  issues: string[];
}

// Baseline reliability by make (long-term real-world reputation). Tunable.
const MAKE_BASE: Record<string, number> = {
  toyota: 82,
  honda: 80,
  mazda: 75,
  suzuki: 78,
  nissan: 70,
  hyundai: 74,
  kia: 74,
  subaru: 68,
  mitsubishi: 68,
  ford: 60,
  holden: 55,
  volkswagen: 52,
  peugeot: 48,
  citroen: 46,
  fiat: 45,
  rover: 42,
  chinese: 40,
};

// Known model-specific caveats (real, commonly reported problems).
const MODEL_NOTES: Record<string, ModelRating> = {
  corolla: { score: 86, note: 'One of the most reliable small cars; cheap parts and huge repair network.', issues: [] },
  yaris: { score: 84, note: 'Very reliable, light and cheap to run.', issues: [] },
  camry: { score: 84, note: 'V6/2.4 are bulletproof; ideal cheap daily if body is straight.', issues: ['check oil leaks on 2.4L'] },
  civic: { score: 83, note: 'Reliable and economical.', issues: [] },
  accord: { score: 80, note: 'Reliable, comfortable.', issues: ['older V6 autos can need attention'] },
  swift: { score: 80, note: 'Cheap to buy and run, very reliable for the money.', issues: [] },
  alto: { score: 78, note: 'Tiny, cheap, economical and dependable; parts are inexpensive.', issues: ['very slow on highways; no ABS on some years'] },
  getz: { score: 74, note: 'Cheap, simple and robust small hatch.', issues: [] },
  i30: { score: 76, note: 'Solid, common, easy to service; excellent budget value.', issues: [] },
  rio: { score: 72, note: 'Reasonable budget car.', issues: [] },
  pulsar: { score: 72, note: 'Reliable runabout.', issues: ['check timing chain on some motors'] },
  focus: { score: 60, note: 'Older Focus can be good value but have known electrics/PowerShift (auto) issues.', issues: ['PowerShift auto shudder', 'dampener/engine mounts'] },
  falcon: { score: 66, note: 'Big Australian sedan/ute, cheap parts, thirsty but durable.', issues: ['transmission service history', 'paint/rust on older ones'] },
  commodore: { score: 64, note: 'Capable and cheap to keep; some engines have notable weaknesses.', issues: ['timing chain (V6 ~2011-13)', 'sticking valve springs on some'] },
  cruze: { score: 48, note: 'Common and cheap, but known reliability concerns.', issues: ['turbo/ignition coils', 'transmission and cooling concerns'] },
  barina: { score: 52, note: 'Budget hatch; build quality is average.', issues: [] },
  '3': { score: 80, note: 'One of the best-value budget small cars; reliable and cheap to run.', issues: ['check wheel-arch / boot rust on older ones'] },
  '6': { score: 76, note: 'Reliable, comfortable mid-sizer.', issues: [] },
  micra: { score: 76, note: 'Simple and dependable.', issues: [] },
  lancer: { score: 72, note: 'Dependable and easy to maintain.', issues: [] },
  outlander: { score: 70, note: 'Reliable family SUV.', issues: [] },
  triton: { score: 72, note: 'Trusted, simple ute; good value.', issues: ['rust on older ones', 'check 4WD system'] },
  ranger: { score: 68, note: 'Capable and popular.', issues: ['check coolant/turbo on earlier diesels'] },
  navara: { score: 62, note: 'Strong ute; earlier D40 wheels/rust and torque-converter were issues.', issues: ['D40 rear axle/rust', 'torque converter shudder'] },
  hilux: { score: 80, note: 'Legendary durability; holds its value.', issues: ['older ones often high-km work utes'] },
  cruiser: { score: 78, note: 'Heavy-duty 4WD, very durable.', issues: ['valuable; many are ex-work with high km'] },
  prado: { score: 77, note: 'Robust, comfortable 4WD.', issues: [] },
  forester: { score: 66, note: 'Great AWD value but boxer engine needs care.', issues: ['head gasket (pre-2011)', 'check service history'] },
  impreza: { score: 68, note: 'Fun, capable; boxer quirks.', issues: ['head gasket if neglected'] },
  liberty: { score: 66, note: 'Comfortable AWD; same boxer care.', issues: ['head gasket/pre-2011'] },
  golf: { score: 56, note: 'Nice to drive but parts/services are pricey; older ones have electrics issues.', issues: ['DSG/electrics', 'expensive parts'] },
  passat: { score: 52, note: 'Comfortable but costly to maintain when it ages.', issues: ['DSG', 'oil-burn on TDI'] },
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export function assessReliability(make: string | null | undefined, model: string | null | undefined): ReliabilityResult {
  const makeK = (make || '').trim().toLowerCase();
  const modelK = (model || '').trim().toLowerCase();

  const base = MAKE_BASE[makeK] ?? (makeK === '' ? 60 : 58); // unknown make gets a cautious mid rating
  const modelNote = MODEL_NOTES[modelK];
  let score = base;
  let note = modelNote?.note ?? `${makeK ? makeK[0].toUpperCase() + makeK.slice(1) : 'This'} car: a usable, affordable daily.`;
  const issues = [...(modelNote?.issues ?? [])];
  if (modelNote && modelNote.score) score = (score + modelNote.score) / 2;

  let band: ReliabilityResult['band'] = 'MEDIUM';
  if (score >= 78) band = 'HIGH';
  else if (score < 58) band = 'LOW';

  return { score: clamp(score), band, note, issues };
}

/** Blend the static reliability rating with the listing's own live market signals. */
export function assessListingReliability(input: {
  make?: string | null;
  model?: string | null;
  year?: number | null;
  odometer?: number | null;
  priceBadge?: string | null;
}): ReliabilityResult {
  const r = assessReliability(input.make, input.model);
  let score = r.score;

  // Odometer-for-age: very high use is a genuine wear flag, regardless of make.
  const age = input.year ? new Date().getFullYear() - input.year : null;
  if (age != null && age > 0 && input.odometer != null) {
    const kmPerYear = input.odometer / age;
    if (kmPerYear > 25000) {
      score -= 12;
      r.issues.push(`very high use (~${Math.round(kmPerYear).toLocaleString()} km/yr)`);
    } else if (kmPerYear > 18000) {
      score -= 6;
      r.issues.push(`high use (~${Math.round(kmPerYear).toLocaleString()} km/yr)`);
    }
  }

  // carsales' own price indicator is a market signal for that exact make/model/year.
  const badge = (input.priceBadge || '').toUpperCase();
  if (badge === 'GREAT PRICE') score += 4;
  else if (badge === 'BAD PRICE') score -= 5;

  score = clamp(score);
  let band: ReliabilityResult['band'] = 'MEDIUM';
  if (score >= 78) band = 'HIGH';
  else if (score < 58) band = 'LOW';

  return { ...r, score, band };
}
