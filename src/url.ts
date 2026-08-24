export interface SearchParams {
  make: string;
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

export function buildSearchUrl(p: SearchParams): string {
  const segments: string[] = ['cars'];
  if (p.condition === 'used') segments.push('used');
  else if (p.condition === 'new') segments.push('new');
  else if (p.condition === 'private') segments.push('private');
  else if (p.condition === 'dealer') segments.push('dealer');

  segments.push(slug(p.make));
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
  if (params.length) url += '?' + params.join('&');

  return url;
}
