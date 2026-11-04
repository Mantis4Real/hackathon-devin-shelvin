// Display helpers for comparing listings: price per 100 g / 100 ml, lowest price and deltas, store abbreviations.
import type { Listing, SimilarProduct, SourcePage } from '@/api/types';

const LOCALE = 'es-MX';

export type BaseUnit = 'g' | 'ml';

/**
 * "62 g" → 62 g, "1.5 kg" → 1500 g, "600 ml" → 600 ml, "1 L" / "1,5 l" → 1000 / 1500 ml, "1,000 g" → 1000 g.
 * A comma followed by exactly three digits groups thousands; any other comma is a decimal point. Undefined when unknown.
 */
export function parseNetSize(text: string | number | boolean | null | undefined): { amount: number; unit: BaseUnit } | undefined {
  if (typeof text !== 'string') return undefined;
  const match = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(kg|kilos?|g|gr|grs|gramos?|ml|mL|l|lt|lts|litros?)\b/i.exec(text);
  if (!match) return undefined;
  const number = /,\d{3}(?!\d)/.test(match[1]) ? match[1].replace(/,/g, '') : match[1].replace(',', '.');
  const value = parseFloat(number);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2].toLowerCase();
  if (unit.startsWith('k')) return { amount: value * 1000, unit: 'g' };
  if (unit.startsWith('g')) return { amount: value, unit: 'g' };
  if (unit === 'ml') return { amount: value, unit: 'ml' };
  return { amount: value * 1000, unit: 'ml' };
}

const SIZE_KEYS = ['net_weight', 'netWeight', 'net_content', 'netContent', 'size', 'weight', 'contenido', 'peso'];
const PACK_KEYS = ['pack_size', 'packSize', 'pack_count', 'packCount', 'units'];

/** Net size of what the listing sells: its own size field (times the pack count), else `fallbackSize` (the product's). */
export function listingNetSize(listing: Pick<Listing, 'fields'>, fallbackSize?: string): { amount: number; unit: BaseUnit } | undefined {
  const fields = listing.fields ?? {};
  const own = SIZE_KEYS.map((k) => parseNetSize(fields[k])).find(Boolean);
  const size = own ?? parseNetSize(fallbackSize);
  if (!size) return undefined;
  const pack = PACK_KEYS.map((k) => fields[k]).find((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 1);
  return pack ? { amount: size.amount * pack, unit: size.unit } : size;
}

/**
 * The price to show and compare: none for an out-of-stock listing, whose price is often a placeholder (Walmart México
 * shows $1.00 for a product it can't sell). The stock line says why the price is missing.
 */
export function shownPrice(listing: Pick<Listing, 'price'> & { fields?: Listing['fields'] }) {
  return listing.price && !isOutOfStock(listing.fields) ? listing.price : undefined;
}

/** Price per 100 g (or 100 ml), rounded to cents. Undefined when the price (see shownPrice) or the size is unknown. */
export function pricePer100(listing: Pick<Listing, 'fields' | 'price'>, fallbackSize?: string): { amount: number; unit: BaseUnit } | undefined {
  const price = shownPrice(listing);
  if (!price || !(price.amount > 0)) return undefined;
  const size = listingNetSize(listing, fallbackSize);
  if (!size) return undefined;
  return { amount: Math.round((price.amount / size.amount) * 100 * 100) / 100, unit: size.unit };
}

export interface PriceComparison {
  /** Id of the cheapest listing (first one on ties); undefined when no listing has a price. */
  lowestId?: string;
  lowest?: number;
  /** Price minus the lowest, per listing id; only listings priced in the lowest's currency. */
  deltas: Record<string, number>;
}

/**
 * Lowest price among the listings and how much more each other one costs. Only listings in the most common currency
 * (MXN on a tie) are compared, so a cheaper-looking USD number never wins, and an out-of-stock listing is left out
 * (shownPrice).
 */
export function comparePrices(listings: readonly (Pick<Listing, 'id' | 'price'> & { fields?: Listing['fields'] })[]): PriceComparison {
  const priced = listings.filter((l) => { const p = shownPrice(l); return p !== undefined && Number.isFinite(p.amount); });
  if (priced.length === 0) return { deltas: {} };
  const currency = mainCurrency(priced.map((l) => l.price!.currency));
  const cheapest = priced.filter((l) => l.price!.currency === currency).reduce((min, l) => (l.price!.amount < min.price!.amount ? l : min));
  const lowest = cheapest.price!.amount;
  const deltas: Record<string, number> = {};
  for (const l of priced) {
    if (l.price!.currency === currency) deltas[l.id] = Math.round((l.price!.amount - lowest) * 100) / 100;
  }
  return { lowestId: cheapest.id, lowest, deltas };
}

/** The currency most listings use; MXN wins a tie, then the first one seen. */
export function mainCurrency(currencies: readonly string[]) {
  const counts = new Map<string, number>();
  for (const c of currencies) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = currencies[0];
  for (const [c, n] of counts) {
    const bestCount = counts.get(best) ?? 0;
    if (n > bestCount || (n === bestCount && c === 'MXN')) best = c;
  }
  return best;
}

/** "24.90", "1,234.50": amount for table cells, the currency sits in the column header. */
export function formatAmount(amount: number) {
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

/** "+0.60" for a listing that costs more than the lowest. */
export function formatDelta(delta: number) {
  return `+${formatAmount(delta)}`;
}

/** Codes for well-known Mexican stores where the first letters would be ambiguous or odd. */
const KNOWN_ABBREVIATIONS: [RegExp, string][] = [
  [/^walmart/, 'WMT'],
  [/^bodega aurrera/, 'BA'],
  [/^amazon/, 'AMZ'],
  [/^mercado ?libre/, 'MELI'],
  [/^la comer/, 'LCO'],
  [/^city market/, 'CMK'],
  [/^fresko/, 'FRK'],
  [/^sam'?s/, 'SAMS'],
  [/^7-?eleven/, '7-11'],
  [/^heb\b|^h-e-b/, 'HEB'],
  [/^oxxo/, 'OXXO'],
];

// Words that don't tell stores apart.
const FILLER = new Set(['la', 'el', 'los', 'las', 'de', 'del', 'y', 'super', 'supermercado', 'mexico', 'mx', 'tienda', 'online', 'despensa', 'official', 'site', 'sitio', 'oficial']);

/** Short store code for tight columns: "Soriana" → "SOR", "Walmart Súper" → "WMT", "Farmacias Guadalajara" → "FG". */
export function storeAbbreviation(name: string) {
  const plain = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .trim();
  for (const [pattern, code] of KNOWN_ABBREVIATIONS) if (pattern.test(plain)) return code;
  const words = plain.split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w));
  if (words.length === 0) return plain.replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

const OUT_OF_STOCK = /out\s*-?\s*of\s*-?\s*stock|sold\s*out|agotado|sin\s+existencia|no\s+disponible/i;

/** The scraped fields say the site can't sell it now (a false stock flag, or a schema.org OutOfStock-style value). */
export function isOutOfStock(fields: Listing['fields'] | undefined) {
  const f = fields ?? {};
  if (['in_stock', 'inStock', 'available'].some((k) => f[k] === false)) return true;
  return Object.entries(f).some(([k, v]) => /availability|stock|disponibilidad/i.test(k) && typeof v === 'string' && OUT_OF_STOCK.test(v));
}

/** Stock text from the scraped fields ("In stock", "Low stock"), or undefined. */
export function stockText(fields: Listing['fields'] | undefined) {
  const f = fields ?? {};
  for (const key of ['availability', 'stock', 'stock_status', 'disponibilidad']) {
    const v = f[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const key of ['in_stock', 'inStock', 'available']) {
    const v = f[key];
    if (typeof v === 'boolean') return v ? 'In stock' : 'Out of stock';
  }
  return undefined;
}

/** "4.7 (312)" from rating + review count fields, or undefined. */
export function ratingText(fields: Listing['fields'] | undefined) {
  const f = fields ?? {};
  const rating = typeof f.rating === 'number' ? f.rating : undefined;
  if (rating === undefined) return undefined;
  const count = [f.review_count, f.reviewCount, f.reviews].find((v): v is number => typeof v === 'number');
  return count !== undefined ? `${rating} (${count})` : String(rating);
}

export interface ListingGroup {
  /** 'same' for the scanned product, a similar product's id, or 'other' when the app can't tell. */
  key: string;
  /** The similar product's name; undefined for 'same' and 'other'. */
  title?: string;
  listings: Listing[];
  /** Prices compare only within one product; the 'other' group mixes unknown products. */
  comparable: boolean;
}

function plain(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Splits a product's listings so prices are only compared within one product: the scanned product first, then each
 * similar product (in `similar` order), then anything unknown. The search's pages decide when the app has them;
 * otherwise a listing whose title has every word of the product name, in any order, counts as the same product,
 * unless `productSize` is given and the title names another size ("Doritos 146g" is not "Doritos 56 g").
 */
export function groupByProduct(
  listings: readonly Listing[],
  productName: string,
  pages: readonly Pick<SourcePage, 'id' | 'matchType' | 'similarProductId'>[] = [],
  similar: readonly Pick<SimilarProduct, 'id' | 'productName'>[] = [],
  productSize?: string,
): ListingGroup[] {
  const words = plain(productName).split(' ').filter(Boolean);
  const size = parseNetSize(productSize);
  const sameByTitle = (title: string) => {
    const have = new Set(plain(title).split(' '));
    if (!words.length || !words.every((w) => have.has(w))) return false;
    const titled = parseNetSize(title);
    return !(size && titled && (titled.unit !== size.unit || Math.abs(titled.amount - size.amount) > 0.5));
  };
  const same: Listing[] = [];
  const bySimilar = new Map<string, Listing[]>();
  const other: Listing[] = [];
  for (const listing of listings) {
    const page = pages.find((p) => p.id === listing.pageId);
    if (page) {
      if (page.matchType === 'exact') same.push(listing);
      else if (page.similarProductId) bySimilar.set(page.similarProductId, [...(bySimilar.get(page.similarProductId) ?? []), listing]);
      else other.push(listing);
    } else if (sameByTitle(listing.title ?? '')) {
      same.push(listing);
    } else {
      other.push(listing);
    }
  }
  const groups: ListingGroup[] = [];
  if (same.length) groups.push({ key: 'same', listings: same, comparable: true });
  for (const s of similar) {
    const list = bySimilar.get(s.id);
    if (list?.length) groups.push({ key: s.id, title: s.productName, listings: list, comparable: true });
    bySimilar.delete(s.id);
  }
  for (const [key, list] of bySimilar) groups.push({ key, title: key, listings: list, comparable: true });
  if (other.length) groups.push({ key: 'other', listings: other, comparable: false });
  return groups;
}
