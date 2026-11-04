import { useEffect, useState } from 'react';

import { getApi } from '@/api/client';
import type { ScanSummary } from '@/api/types';
import { comparePrices, groupByProduct, storeAbbreviation } from '@/features/results/compare';
import { retailerLabel } from '@/features/results/retailer';

export interface Lowest {
  amount: number;
  currency: string;
  store: string;
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
          const { lowestId, lowest: amount } = comparePrices(same);
          const listing = listings.find((l) => l.id === lowestId);
          const value = listing && amount !== undefined ? { amount, currency: listing.price!.currency, store: storeAbbreviation(retailerLabel(listing.retailerName).name) } : null;
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
