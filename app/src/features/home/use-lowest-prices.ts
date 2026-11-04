import { useEffect, useState } from 'react';

import { getApi } from '@/api/client';
import type { ScanSummary } from '@/api/types';
import { comparePrices, groupByProduct, listingNetSize, parseNetSize, storeAbbreviation } from '@/features/results/compare';
import { retailerLabel } from '@/features/results/retailer';

export interface Lowest {
  amount: number;
  currency: string;
  store: string;
  /** Set when no listing has the scanned size: the size of the bag this price is for, e.g. "245g". */
  otherSize?: string;
}

/**
 * Lowest saved price per product, for the Recent scans table. Reads each product's saved listings (GET /products/:id/listings),
 * again whenever a product's last scrape changes. Products whose listings fail to load just show no price.
 */
export function useLowestPrices(scans: ScanSummary[]) {
  const [lowest, setLowest] = useState<Record<string, Lowest | null>>({});
  const key = scans.map((s) => `${s.product.id}@${s.lastScrapedAt ?? ''}#${s.listingCount}`).join('|');

  useEffect(() => {
    let cancelled = false;
    const wanted = key ? key.split('|').map((k) => k.slice(0, k.lastIndexOf('@'))) : [];
    for (const id of wanted) {
      getApi()
        .getProductListings(id)
        .then(({ product, listings }) => {
          // Only this product's own listings: similar products are saved alongside it.
          const same = groupByProduct(listings, product.productName, [], [], product.size).find((g) => g.key === 'same')?.listings ?? [];
          // No listing of the scanned size: show the cheapest saved one anyway, labelled with its own size.
          let { lowestId, lowest: amount } = comparePrices(same);
          let otherSize: string | undefined;
          if (lowestId === undefined) {
            ({ lowestId, lowest: amount } = comparePrices(listings));
            const other = listings.find((l) => l.id === lowestId);
            const size = other && (listingNetSize(other) ?? parseNetSize(other.title));
            const scanned = parseNetSize(product.size);
            if (size && !(scanned && scanned.unit === size.unit && Math.abs(scanned.amount - size.amount) <= 0.5)) otherSize = `${Math.round(size.amount)}${size.unit}`;
          }
          const listing = listings.find((l) => l.id === lowestId);
          const value = listing && amount !== undefined ? { amount, currency: listing.price!.currency, store: storeAbbreviation(retailerLabel(listing.retailerName).name), otherSize } : null;
          if (!cancelled) setLowest((prev) => ({ ...prev, [id]: value }));
        })
        .catch(() => {
          if (!cancelled) setLowest((prev) => ({ ...prev, [id]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  return lowest;
}
