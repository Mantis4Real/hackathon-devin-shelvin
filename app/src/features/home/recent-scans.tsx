import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import type { ScanSummary } from '@/api/types';
import { formatAmount } from '@/features/results/compare';
import { useTheme } from '@/theme';
import { Cell, DashedRule, EmptyState, ErrorBanner, Row, SectionHeader, Skeleton, TableHead, Text } from '@/ui';

import { formatLastScraped } from './format';
import { homeStrings as s } from './strings';
import { useLowestPrices } from './use-lowest-prices';

const COUNT_WIDTH = 34;
const LOW_WIDTH = 72;

interface RecentScansProps {
  scans: ScanSummary[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}

/** RECENT SCANS: a table of Product | listings | lowest price + store code, with a totals line. Rows open Saved listings. */
export function RecentScans({ scans, loading, error, onRetry }: RecentScansProps) {
  const lowest = useLowestPrices(scans);
  const total = scans.reduce((n, scan) => n + scan.listingCount, 0);
  return (
    <View>
      <SectionHeader title={s.recentTitle} right={scans.length > 0 ? String(scans.length).padStart(2, '0') : undefined} />
      {error ? (
        <View style={styles.pad}>
          <ErrorBanner message={`${s.recentError} ${error}`} onRetry={onRetry} />
        </View>
      ) : loading && scans.length === 0 ? (
        <>
          <RecentScanSkeleton />
          <RecentScanSkeleton />
        </>
      ) : scans.length === 0 ? (
        <EmptyState icon="clock.arrow.circlepath" iconFallback="🕘" title={s.recentEmptyTitle} message={s.recentEmptyMessage} />
      ) : (
        <>
          <TableHead
            columns={[
              { label: s.productColumn },
              { label: s.listingsColumn, width: COUNT_WIDTH, align: 'right' },
              { label: s.lowestColumn, width: LOW_WIDTH, align: 'right' },
            ]}
          />
          {scans.map((scan) => (
            <RecentScanRow key={scan.product.id} scan={scan} lowest={lowest[scan.product.id]} />
          ))}
          <View style={styles.totals}>
            <DashedRule />
            <View style={styles.totalsRow}>
              <Text variant="mono" style={styles.totalsText}>
                {s.productsTotal(scans.length)}
              </Text>
              <Text variant="mono" style={styles.totalsText}>
                {s.listingsTotal(total)}
              </Text>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

function RecentScanRow({ scan, lowest }: { scan: ScanSummary; lowest?: { amount: number; store: string; otherSize?: string } | null }) {
  const { product } = scan;
  const name = [product.productName, product.size].filter(Boolean).join(' ');
  const when = scan.lastScrapedAt ? formatLastScraped(scan.lastScrapedAt) : s.neverScraped;
  const meta = [product.brand, when].filter(Boolean).join(' · ');
  return (
    <Row
      accessibilityLabel={`${name}, ${s.listingCount(scan.listingCount)}${lowest ? `, ${s.lowestA11y(formatAmount(lowest.amount), lowest.store)}${lowest?.otherSize ? ` ${lowest.otherSize}` : ''}` : ''}`}
      onPress={() => router.push({ pathname: '/product/[id]', params: { id: product.id } })}>
      <Cell>
        <Text variant="subheading" numberOfLines={2}>
          {name}
        </Text>
        <Text variant="mono" color="secondary" numberOfLines={1} style={styles.meta}>
          {meta}
        </Text>
      </Cell>
      <Cell width={COUNT_WIDTH} align="right">
        <Text variant="mono" style={styles.count}>
          {scan.listingCount}
        </Text>
      </Cell>
      <Cell width={LOW_WIDTH} align="right">
        {lowest ? (
          <>
            <Text variant="number">{formatAmount(lowest.amount)}</Text>
            <Text variant="mono" color="secondary" style={styles.store}>
              {lowest.otherSize ? s.lowestOtherSize(lowest.store, lowest.otherSize) : lowest.store}
            </Text>
          </>
        ) : (
          <Text variant="number" color="secondary">
            {lowest === null ? s.noPrice : ' '}
          </Text>
        )}
      </Cell>
    </Row>
  );
}

function RecentScanSkeleton() {
  const { spacing } = useTheme();
  return (
    <View style={[styles.skeleton, { gap: spacing.md }]}>
      <View style={[styles.flex, { gap: 6 }]}>
        <Skeleton width="65%" height={14} />
        <Skeleton width="40%" height={10} />
      </View>
      <Skeleton width={48} height={16} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { paddingTop: 12 },
  meta: { marginTop: 2 },
  count: { lineHeight: 20 },
  store: { fontSize: 11 },
  totals: { marginTop: -1 },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10 },
  totalsText: { fontWeight: '600', letterSpacing: 0.5 },
  skeleton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
});
