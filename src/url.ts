export interface SearchParams {
  make?: string;
  model?: string;
  state?: string;
  bodyStyle?: string;
  transmission?: string;
  fuelType?: string;
  condition?: 'used' | 'new' | 'private' | 'dealer';
  badge?: string;
  colour?: string;
  cylinders?: string;
  doors?: string;
  keyword?: string;
  minPrice?: number;
  maxPrice?: number;
  minYear?: number;
  maxYear?: number;
  maxOdometer?: number;
  postcode?: string;
  radius?: number;
  sort?: string;
  page?: number;
  limit?: number;
  /** Internal: pass a carsales server-side sort token (e.g. "Odometer") into the
   * URL. carsales does not accept a server-side price filter, but it does accept
   * these result-order tokens, and "Odometer" conveniently surfaces old, high-km,
   * cheap cars first, which is how we hunt for sub-$4000 deals. */
  serverSort?: string;
}

const STATE_SLUG: Record<string, string> = {
  nsw: 'new-south-wales-state',
  'new south wales': 'new-south-wales-state',
  vic: 'victoria-state',
  victoria: 'victoria-state',
  qld: 'queensland-state',
  queensland: 'queensland-state',
  sa: 'south-australia-state',
  'south australia': 'south-australia-state',
  tas: 'tasmania-state',
  tasmania: 'tasmania-state',
  wa: 'western-australia-state',
  'western australia': 'western-australia-state',
  act: 'australian-capital-territory-state',
  'australian capital territory': 'australian-capital-territory-state',
  nt: 'northern-territory-state',
  'northern territory': 'northern-territory-state',
};

const BODY_SLUG: Record<string, string> = {
  sedan: 'sedan-bodystyle',
  wagon: 'wagon-bodystyle',
  suv: 'suv-bodystyle',
  hatch: 'hatchback-bodystyle',
  hatchback: 'hatchback-bodystyle',
  ute: 'ute-bodystyle',
  coupe: 'coupe-bodystyle',
  van: 'van-bodystyle',
  convertible: 'convertible-bodystyle',
};

const TRANS_SLUG: Record<string, string> = {
  automatic: 'automatic-transmission',
  auto: 'automatic-transmission',
  manual: 'manual-transmission',
};

const FUEL_SLUG: Record<string, string> = {
  petrol: 'petrol-fueltype',
  diesel: 'diesel-fueltype',
  hybrid: 'hybrid-fueltype',
  electric: 'electric-fueltype',
  'plug-in hybrid': 'plug-in-hybrid-fueltype',
  lpg: 'lpg-fueltype',
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * carsales' internal search predicate DSL. The public facet URLs (bodystyle,
 * transmission) do NOT let us pass a server-side price filter, so to get real
 * filtered results (e.g. "automatic, under $4000, NSW") we build the same
 * `q=` predicate the site's own search uses. Example:
 *   ((And.Price.range(0..4000)._.GenericGearType.Automatic._.State.New South Wales.))
 * The `. _.` token joins And-clauses; `sort=~Price` orders by price.
 *
 * Returns the encoded q= params for the current filters, or '' if none apply.
 */
function predicateClauses(p: SearchParams): string[] {
  const clauses: string[] = [];
  if (p.minPrice != null || p.maxPrice != null) {
    const lo = p.minPrice ?? 0;
    const hi = p.maxPrice ?? 999999999;
    clauses.push(`Price.range(${lo}..${hi})`);
  }
  if (p.transmission) {
    const t = p.transmission.toLowerCase();
    const gear = t === 'manual' ? 'Manual' : 'Automatic';
    clauses.push(`GenericGearType.${gear}`);
  }
  if (p.state) {
    const stateName = STATE_NAMES[p.state.toLowerCase()] || p.state;
    clauses.push(`State.${stateName}`);
  }
  if (p.fuelType) {
    const f = p.fuelType.toLowerCase();
    const map: Record<string, string> = {
      petrol: 'Petrol', diesel: 'Diesel', hybrid: 'Hybrid', electric: 'Electric', lpg: 'LPG',
      'plug-in hybrid': 'PlugInHybrid',
    };
    clauses.push(`FuelType.${map[f] || f}`);
  }
  return clauses;
}

// State names as carsales' DSL spells them (State.New South Wales, etc.).
const STATE_NAMES: Record<string, string> = {
  nsw: 'New South Wales', 'new south wales': 'New South Wales',
  vic: 'Victoria', victoria: 'Victoria',
  qld: 'Queensland', queensland: 'Queensland',
  sa: 'South Australia', 'south australia': 'South Australia',
  tas: 'Tasmania', tasmania: 'Tasmania',
  wa: 'Western Australia', 'western australia': 'Western Australia',
  act: 'Australian Capital Territory', 'australian capital territory': 'Australian Capital Territory',
  nt: 'Northern Territory', 'northern territory': 'Northern Territory',
};

export function buildPredicateUrl(p: SearchParams): string {
  const clauses = predicateClauses(p);
  if (!clauses.length) return '';
  // Top-level And of all clauses; join with '. _.' (the DSL separator).
  const predicate = `((And.${clauses.join('._.')}))`;
  const q = encodeURIComponent(predicate);
  // Price sort: ~Price puts cheapest first (matches the site's low-to-high view).
  const sort = p.sort === 'price_high' ? '~PriceDir' : '~Price';
  return `https://www.carsales.com.au/cars/?q=${q}&sort=${sort}`;
}

export function buildSearchUrl(p: SearchParams): string {
  const segments: string[] = ['cars'];
  if (p.condition === 'used') segments.push('used');
  else if (p.condition === 'new') segments.push('new');
  else if (p.condition === 'private') segments.push('private');
  else if (p.condition === 'dealer') segments.push('dealer');

  // make is optional now: omit it to search ALL makes (brand-agnostic). Only push
  // real segments so the URL stays clean (no empty path part).
  if (p.make) segments.push(slug(p.make));
  if (p.model) segments.push(slug(p.model));

  if (p.state) {
    const s = STATE_SLUG[p.state.toLowerCase()];
    if (s) segments.push(s);
  }
  if (p.bodyStyle) {
    const b = BODY_SLUG[p.bodyStyle.toLowerCase()];
    if (b) segments.push(b);
  }
  if (p.transmission) {
    const t = TRANS_SLUG[p.transmission.toLowerCase()];
    if (t) segments.push(t);
  }
  if (p.fuelType) {
    const f = FUEL_SLUG[p.fuelType.toLowerCase()];
    if (f) segments.push(f);
  }
  if (p.cylinders) segments.push(`${slug(p.cylinders)}-cylinders`);
  if (p.doors) segments.push(`${slug(p.doors)}-doors`);
  if (p.colour) segments.push(`${slug(p.colour)}-colour`);
  if (p.badge) segments.push(`${slug(p.badge)}-badge`);

  let url = 'https://www.carsales.com.au/' + segments.join('/') + '/';

  const params: string[] = [];
  if (p.keyword) params.push(`q=${encodeURIComponent(p.keyword)}`);
  if (p.postcode) params.push(`postcode=${encodeURIComponent(p.postcode)}`);
  if (p.radius != null) params.push(`distance=${encodeURIComponent(String(p.radius))}`);
  if (p.page && p.page > 1) params.push(`page=${p.page}`);
  // Server-side result ordering. carsales honors these tokens (e.g. "Odometer"
  // = highest odometer first, which surfaces old/cheap cars).
  if (p.serverSort) params.push(`sort=${encodeURIComponent(p.serverSort)}`);
  if (params.length) url += '?' + params.join('&');

  return url;
}
