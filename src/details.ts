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
    const lower = s.toLowerCase();
    if (/km\b|\skm$/.test(lower) && /\d/.test(s)) details.odometer = Number(s.replace(/[^0-9]/g, ''));
    else if (lower.includes('auto') || lower.includes('manual') || lower.includes('cvt'))
      details.transmission = s;
    else if (/petrol|diesel|hybrid|electric|lpg|fuel/i.test(lower)) details.fuelType = s;
    else if (/(sedan|wagon|suv|hatch|ute|coupe|van|convertible)/.test(lower))
      details.bodyType = s;
    else if (/\d.*(cyl|l\b|cc|electric)/i.test(lower)) details.engine = s;
  }

  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (h1) details.title = h1[1].trim();

  const main = html.match(/\$([\d,]{2,})/);
  if (main) details.price = Number(main[1].replace(/,/g, ''));
  const excl = html.match(/\$([\d,]{2,})\s*Excl\./);
  if (excl) details.priceExGovt = Number(excl[1].replace(/,/g, ''));

  const yearM = details.title && details.title.match(/^(\d{4})/);
  if (yearM) details.year = Number(yearM[1]);

  const badge = html.match(/(FAIR PRICE|GOOD PRICE|GREAT PRICE|BAD PRICE)/);
  if (badge) details.priceBadge = badge[1];

  // Photos
  const photos = [
    ...html.matchAll(/<img[^>]+src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi),
  ].map((m) => m[1]);
  details.photos = [...new Set(photos)].slice(0, 12);

  // Description: look for a meta description or the first long paragraph.
  const metaDesc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
  if (metaDesc) details.description = metaDesc[1];
  else {
    const p = html.match(/<p[^>]*>([^<]{80,})<\/p>/);
    if (p) details.description = p[1].trim();
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

  return details;
}
