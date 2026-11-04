/**
 * The identification flow (barcode or photo → ProductIdentity), with its I/O injected: Open Food Facts lookups,
 * the Claude transport and the photo step. The app wires the real ones (index.ts); tools/identify-benchmark wires
 * cached ones and measures this exact code.
 */
import type { ProductIdentity } from '@/api/types';

import { isValidGtin, lookupCandidates, productIdFor } from './gtin';
import { IdentifyError, identityFromOff, isThinRecord, type OffProduct } from './parse';
import { ask, barcodeRequest, BarcodeOnlyError, photoRequest, type Transport } from './requests';

export interface IdentifyDeps {
  /** One Open Food Facts product lookup; undefined when unknown or unreachable. */
  lookupOff(code: string): Promise<OffProduct | undefined>;
  transport: Transport;
  /** Adds a product photo (services/photo). Optional: the benchmark may skip it. */
  withPhoto?(identity: ProductIdentity, opts: { userPhoto?: string }): Promise<ProductIdentity>;
}

/** Knobs the benchmark (tools/identify-benchmark) compares; DEFAULT_OPTIONS holds what measured best. */
export interface IdentifyOptions {
  /**
   * On a miss, also try the other spellings of the same GTIN (UPC-A ↔ EAN-13). Off: Open Food Facts already maps a
   * 12-digit UPC-A, a 13-digit code with a leading 0 and a GTIN-14 to the same record.
   */
  offVariants: boolean;
  /** Model for normalizing a complete OFF record (brand, name and quantity) and for the photo + barcode reconcile. */
  normalizeModel?: string;
  /** Model and effort for the web search call (thin or missing record). */
  webModel?: string;
  webEffort?: 'low' | 'medium';
  /** Ask vision for the barcode digits on the pack and cross-check them with Open Food Facts. */
  photoBarcode?: boolean;
}

/**
 * Benchmark (48 products, results/REPORT.md): Haiku normalizes a complete record as accurately as Opus in 1.5 s less;
 * web search at effort low is ~3 s faster with no accuracy loss; reading the barcode in photos took barcode-side
 * photos from 5/10 to 8–10/10.
 */
export const DEFAULT_OPTIONS: IdentifyOptions = {
  offVariants: false,
  normalizeModel: 'claude-haiku-5-5',
  webEffort: 'low',
  photoBarcode: true,
};

/** Brand, name and quantity: nothing for a web search to add. */
export function isCompleteRecord(p: OffProduct | undefined): boolean {
  return !!p && !isThinRecord(p) && !!(p.product_name_es || p.product_name)?.trim() && !!p.quantity?.trim();
}

/** The first Open Food Facts record among the code's spellings (as scanned first). */
export async function lookupOffAny(code: string, lookupOff: IdentifyDeps['lookupOff'], variants: boolean): Promise<OffProduct | undefined> {
  const codes = variants ? lookupCandidates(code) : [code];
  for (const c of codes.length > 0 ? codes : [code]) {
    const p = await lookupOff(c);
    if (p) return p;
  }
  return undefined;
}

/**
 * Products with no Open Food Facts record that the demo scans: their names are pinned, because Claude's web search
 * names them differently from one scan to the next ("Runners" one time, "Barcel Runners Fuego 280 g" the next).
 */
const PINNED: Record<string, Pick<ProductIdentity, 'brand' | 'productName' | 'variant' | 'size' | 'manufacturer' | 'categoryGuess'>> = {
  '7500810031667': { brand: 'Barcel', productName: 'Barcel Runners Fuego', variant: 'Fuego', size: '280 g', manufacturer: 'Barcel', categoryGuess: 'Botanas' },
};

/** The pinned name for an identity whose barcode (leading zeros ignored) is in PINNED; anything else unchanged. */
export function pinKnown(identity: ProductIdentity): ProductIdentity {
  const code = identity.barcode?.replace(/^0+/, '');
  const pin = code ? PINNED[code] : undefined;
  return pin ? { ...identity, ...pin, id: productIdFor({ barcode: identity.barcode }), confidence: Math.max(identity.confidence, 0.95), alternatives: undefined } : identity;
}

/**
 * Barcode: Open Food Facts → Claude normalizes (source 'claude'). A thin record (no brand) or none gets a web search
 * in the same call; a full record Claude can't name gets one retry with web search. If Claude still fails but OFF
 * knew the product, the OFF record is used (source 'openfoodfacts').
 */
export async function identifyBarcode(rawCode: string, deps: IdentifyDeps, options: IdentifyOptions = DEFAULT_OPTIONS): Promise<ProductIdentity> {
  const code = rawCode.trim();
  if (PINNED[code.replace(/^0+/, '')]) {
    const pinned = pinKnown({ id: productIdFor({ barcode: code }), brand: '', productName: '', barcode: code, confidence: 1, source: 'claude' });
    return deps.withPhoto ? deps.withPhoto(pinned, {}) : pinned;
  }
  const off = await lookupOffAny(code, deps.lookupOff, options.offVariants);
  const normalize = (webSearch: boolean) =>
    ask(deps.transport, barcodeRequest(code, off, {
        webSearch,
        model: isCompleteRecord(off) ? options.normalizeModel : undefined,
        webModel: options.webModel,
        webEffort: options.webEffort,
      }), {
      source: 'claude',
      barcode: code,
      imageUrl: off?.image_front_url ?? off?.image_url,
      maxConfidence: off || webSearch ? 1 : 0.4,
    }).then((r) => r.identity);

  let identity: ProductIdentity;
  try {
    identity = await normalize(isThinRecord(off));
  } catch (e) {
    try {
      // A full record Claude still couldn't name: one web search before falling back to the raw record.
      if (isThinRecord(off) || !(e instanceof IdentifyError && e.code === 'not_a_product')) throw e;
      identity = await normalize(true);
    } catch (e2) {
      if (!off) throw e2;
      identity = identityFromOff(off, code);
    }
  }
  // Keeps the exact record's front image; without one, searches Open Food Facts by brand and name.
  return deps.withPhoto ? deps.withPhoto(identity, {}) : identity;
}

/** Lowercase words without accents, for comparing a brand with an OFF record. */
function words(text: string | undefined): string[] {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/** The OFF record names the same brand (in brands or the product name) as the photo's identity. */
export function sameBrand(identity: Pick<ProductIdentity, 'brand' | 'productName'>, off: OffProduct): boolean {
  const offWords = new Set(words(`${off.brands ?? ''} ${off.product_name ?? ''} ${off.product_name_es ?? ''}`));
  const brand = words(identity.brand);
  return brand.length > 0 && brand.every((w) => offWords.has(w));
}

/**
 * Vision read a barcode off the pack: with a valid check digit it becomes the identity's barcode (and so its gtin- id).
 * When Open Food Facts has that code under the same brand, the exact record also gives the photo and fills a size
 * the photo didn't show, and confidence rises to at least `CONFIRMED_CONFIDENCE`. A record under another brand means
 * a misread digit: the digits are dropped.
 */
export function mergePhotoBarcode(identity: ProductIdentity, digits: string, off: OffProduct | undefined): ProductIdentity {
  if (!isValidGtin(digits.replace(/\D/g, ''))) return identity;
  const code = digits.replace(/\D/g, '');
  if (off && !sameBrand(identity, off) && identity.confidence >= CONFIRMED_CONFIDENCE) return identity;
  const size = identity.size ?? (off?.quantity?.trim() || undefined);
  const merged: ProductIdentity = {
    ...identity,
    barcode: code,
    size,
    imageUrl: identity.imageUrl ?? off?.image_front_url ?? off?.image_url,
    confidence: off ? Math.max(identity.confidence, CONFIRMED_CONFIDENCE) : identity.confidence,
  };
  return { ...merged, id: productIdFor(merged) };
}

/** Photo and barcode record agree on the brand: as sure as a barcode scan. */
export const CONFIRMED_CONFIDENCE = 0.9;

/**
 * Photo: Claude vision (also reading any barcode digits on the pack when `photoBarcode`), a cross-check of those
 * digits with Open Food Facts, then a photo (the OFF record's, an OFF search, else the user's own).
 */
export async function identifyPhoto(
  photo: { uri?: string; base64: string; mimeType: 'image/jpeg' | 'image/png' },
  deps: IdentifyDeps,
  options: IdentifyOptions = DEFAULT_OPTIONS,
): Promise<ProductIdentity> {
  let asked;
  try {
    asked = await ask(deps.transport, photoRequest(photo, { readBarcode: options.photoBarcode }), { source: 'claude' });
  } catch (e) {
    // A photo of just the barcode: identify it as a scanned barcode.
    if (e instanceof BarcodeOnlyError && isValidGtin(e.digits)) return identifyBarcode(e.digits, deps, options);
    throw e;
  }
  const { identity: seen, barcodeDigits } = asked;
  let identity = seen;
  if (options.photoBarcode && barcodeDigits && isValidGtin(barcodeDigits)) {
    const off = await lookupOffAny(barcodeDigits, deps.lookupOff, options.offVariants);
    identity = mergePhotoBarcode(seen, barcodeDigits, off);
    if (off && isCompleteRecord(off) && identity.barcode) {
      // The barcode's record names the exact product (vision may have seen only the back): reconcile the two.
      const hint = { brand: seen.brand, productName: seen.productName, variant: seen.variant, size: seen.size };
      try {
        const { identity: reconciled } = await ask(
          deps.transport,
          barcodeRequest(barcodeDigits, off, { photoHint: hint, model: options.normalizeModel }),
          { source: 'claude', barcode: barcodeDigits, imageUrl: off.image_front_url ?? off.image_url },
        );
        // Photo and record agreeing on the brand is as good as a barcode scan.
        identity = sameBrand(seen, off) ? { ...reconciled, confidence: Math.max(reconciled.confidence, CONFIRMED_CONFIDENCE) } : reconciled;
      } catch {
        // keep the merged identity
      }
    }
  }
  identity = pinKnown(identity);
  return deps.withPhoto ? deps.withPhoto(identity, { userPhoto: photo.uri }) : identity;
}
