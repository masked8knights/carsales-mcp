import { ListingCard } from './browser.js';

export interface ListingDetails extends Partial<ListingCard> {
  id: string;
  url: string;
  description: string | null;
  photos: string[];
  dealer: string | null;
  dealerLocation: string | null;
  features: string[];
}

export function parseDetails(html: string, id: string, url: string): ListingDetails {
  const details: ListingDetails = {
    id,
    url,
    photos: [],
    features: [],
    description: null,
    dealer: null,
    dealerLocation: null,
  };

  const specs = [...html.matchAll(/<title>([^<]+)<\/title>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  for (const s of specs) {
    if (s.startsWith('$')) continue; // price strings handled separately below
    const lower = s.toLowerCase();
    if (/km\b|\skm$/.test(lower) && /\d/.test(s)) details.odometer = Number(s.replace(/[^0-9]/g, ''));
    else if (lower.includes('auto') || lower.includes('manual') || lower.includes('cvt'))
      details.transmission = s;
    else if (/petrol|diesel|hybrid|electric|lpg|fuel/i.test(lower)) details.fuelType = s;
    else if (/(sedan|wagon|suv|hatch|ute|coupe|van|convertible)/.test(lower))
      details.bodyType = s;
    else if (/\d.*(cyl|l\b|cc|electric)/i.test(lower)) details.engine = s;
  }

  // carsales also embeds the key specs as a structured array, e.g.
  // ["petrol","Automatic","625,000 km"]. Pick the array that actually carries a
  // km value (some pages have many small arrays), so odometer/transmission/fuel/
  // body are reliably populated.
  let specArr: RegExpMatchArray | null = null;
  for (const a of html.matchAll(/\[("[^"\]]*"(?:,"[^"\]]*"){0,8})\]/g)) {
    const tokens = (a[1] || '').match(/"([^"]*)"/g)?.map((t) => t.replace(/^"|"$/g, ''));
    if (tokens && tokens.some((t) => /[\d,]{2,}\s?km$/i.test(t))) {
      specArr = tokens as unknown as RegExpMatchArray;
      break;
    }
  }
  if (specArr) {
    const tokens = Array.from(specArr as unknown as string[]);
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (/^[\d,]{2,}\s?km$/.test(lower)) details.odometer = Number(t.replace(/[^0-9]/g, ''));
      else if (/\b(automatic|manual|cvt|semi-automatic)\b/i.test(lower) && !details.transmission)
        details.transmission = t;
      else if (/\b(petrol|diesel|hybrid|electric|plug-in hybrid|lpg)\b/i.test(lower) && !details.fuelType)
        details.fuelType = t;
      else if (/(sedan|wagon|suv|hatch|ute|coupe|van|convertible)/i.test(lower) && !details.bodyType)
        details.bodyType = t;
    }
  }
  // Fallback odometer from any "<digits> km" string on the page.
  if (details.odometer == null) {
    const km = html.match(/"title":"([\d,]{2,})\s?km"/) || html.match(/([\d][\d,]{2,})\s?km\b/i);
    if (km) details.odometer = Number(km[1].replace(/,/g, ''));
  }

  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (h1) details.title = h1[1].trim();

  // Price: prefer the structured numeric price, then the main heading price, then
  // any 4-figure amount. A single cheap `$` beyond this (loan/repayment, e.g. $440)
  // is explicitly filtered out because the asking price is never below $1,000.
  const structured = html.match(/"price":\s*(\d{4,})/);
  if (structured) details.price = Number(structured[1]);
  else {
    const heading = html.match(/"value":"\$([\d,]{4,})","variant":"heading-larg/i);
    const main = html.match(/\$\s?([\d,]{4,})/);
    const cand = heading ? heading[1] : main ? main[1] : null;
    if (cand && Number(cand.replace(/,/g, '')) >= 500) details.price = Number(cand.replace(/,/g, ''));
  }
  const excl = html.match(/\$([\d,]{2,})\s*Excl\./);
  if (excl) details.priceExGovt = Number(excl[1].replace(/,/g, ''));

  const yearM = details.title && details.title.match(/^(\d{4})/);
  if (yearM) details.year = Number(yearM[1]);

  const badge = html.match(/(FAIR PRICE|GOOD PRICE|GREAT PRICE|BAD PRICE)/);
  if (badge) details.priceBadge = badge[1];

  // Photos. Only real seller photos of THIS car, not carsales' stock/editorial
  // library images, promo shots, avatars, trust badges or payment assets. Mixing
  // those in makes vision inspection meaningless (we saw several listings whose
  // "gallery" was mostly a red promo Colt, not the car for sale). Carsales'
  // genuine seller photos come from the private/upload bucket (pxcrush
  // 'carsales/cars/private' or 'cars/private'), not 'editorial.pxcrush'.
  const photos = [
    ...html.matchAll(/<img[^>]+src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi),
  ]
    .map((m) => m[1])
    .filter((u) => /pxcrush\.net\/(?:carsales\/)?cars\/(?:cars\/)?private\//i.test(u))
    .filter((u) => !/editorial\.pxcrush/i.test(u));
  details.photos = [...new Set(photos)].slice(0, 12);

  // Description: the seller's own comments ("Comments from the seller" block),
  // where owners actually say what's wrong with the car (scratches, rust, needed
  // repairs for roadworthy, etc.). This is a truncated 4-line span (-webkit-line
  // clamp) with a "read more". Grab that block, strip the clamp span tags to get
  // the full text. Fall back to the meta description only if no such block exists.
  // The comments block: <div data-id="details:body:comments"> ... <div style="-webkit-line-clamp"> <span>TEXT</span> ...
  // Capture from the line-clamp div up to ~2KB, then strip all tags and entity
  // refs; the longest contiguous text therein is the seller's write-up.
  const cIdx = html.indexOf('data-id="details:body:comments"');
  if (cIdx >= 0) {
    const clampIdx = html.indexOf('-webkit-line-clamp', cIdx);
    if (clampIdx >= 0) {
      const piece = html.slice(clampIdx, clampIdx + 2500);
      const textOnly = piece
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .replace(/-webkit-line-clamp:\s*\d+;?/gi, ' ')
        .trim();
      if (textOnly.length > 15) details.description = textOnly;
    }
  }
  if (!details.description) {
    const metaDesc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    if (metaDesc) details.description = metaDesc[1];
  }

  // Features / specification bullet list (best effort).
  const featSection = html.match(/features?<\/h\d>([\s\S]*?)(?:<h\d|<\/section)/i);
  if (featSection) {
    details.features = [
      ...featSection[1].matchAll(/<li[^>]*>\s*([^<]+)\s*<\/li>/g),
    ]
      .map((m) => m[1].trim())
      .filter(Boolean);
  }

  // Dealer / seller
  const sell = html.match(/data-testid="seller-section"[^>]*>\s*<span[^>]*>([^<]+)</);
  if (sell) {
    details.seller = sell[1].trim();
    const st = sell[1].match(/\b(NSW|VIC|QLD|SA|TAS|WA|ACT|NT)\b/);
    if (st) details.state = st[1];
  }

  // When the full detail page loads (not blocked), carsales embeds a schema.org
  // Vehicle in JSON-LD with richer, reliable fields. Overlay them to fill any
  // gaps left by the HTML heuristics above.
  const ld = extractVehicleLd(html);
  if (ld) {
    if (ld.name && !details.title) details.title = String(ld.name);
    const mileage = ld.mileageFromOdometer?.value;
    if (mileage != null && !details.odometer) details.odometer = Number(mileage);
    // JSON-LD offers are authoritative for price; prefer them over the HTML regex.
    if (ld.offers?.price != null) details.price = Number(ld.offers.price);
    if (ld.offers?.priceSpecification?.priceExclGST != null)
      details.priceExGovt = Number(ld.offers.priceSpecification.priceExclGST);
    if (ld.bodyType && !details.bodyType) details.bodyType = String(ld.bodyType);
    if (ld.vehicleTransmission && !details.transmission)
      details.transmission = String(ld.vehicleTransmission);
    if (ld.fuelType && !details.fuelType)
      details.fuelType = typeof ld.fuelType === 'string' ? ld.fuelType : String(ld.fuelType.name);
    if (ld.seller?.name) details.seller = String(ld.seller.name);
    const ldImgs = Array.isArray(ld.image) ? ld.image : ld.image ? [ld.image] : [];
    const urls = ldImgs.map((i: any) => (typeof i === 'string' ? i : i?.url)).filter(Boolean);
    if (urls.length && !details.photos.length) details.photos = urls.slice(0, 12);
  }

  return details;
}

function extractVehicleLd(html: string): any | null {
  const ms = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)];
  for (const m of ms) {
    try {
      const d = JSON.parse(m[1]);
      const graph = Array.isArray(d['@graph']) ? d['@graph'] : [d];
      for (const x of graph) {
        if (x && (x['@type'] === 'Vehicle' || x['@type'] === 'Car' || x['@type'] === 'Product'))
          return x;
      }
    } catch {
      // not JSON-LD; skip
    }
  }
  return null;
}
