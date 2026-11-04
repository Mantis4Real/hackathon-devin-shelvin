import { StyleSheet, View } from 'react-native';

import type { Listing, ProductIdentity, SimilarProduct, SourcePage } from '@/api/types';
import { useTheme } from '@/theme';
import { Cell, EmptyState, RetailerLogo, Row, SectionHeader, TableHead, Text } from '@/ui';

import { comparePrices, formatAmount, formatDelta, groupByProduct, pricePer100, shownPrice, stockText, type BaseUnit } from './compare';
import { useRetailerLabel } from './retailer-header';
import { strings } from './strings';

const PER_WIDTH = 64;
const PRICE_WIDTH = 78;

/**
 * Listings as a store table: Store + stock | per 100 g | price, with "▼ LOW" under the cheapest and "+0.60" under the others.
 * Tapping a row opens the listing.
 */
export function StoreTable({
  listings,
  productSize,
  compare = true,
  onOpen,
}: {
  listings: Listing[];
  productSize?: string;
  /** False when the listings may be different products: no ▼ LOW or deltas then. */
  compare?: boolean;
  onOpen: (listing: Listing) => void;
}) {
  const comparison = compare ? comparePrices(listings) : { deltas: {} as Record<string, number>, lowestId: undefined };
  const per = new Map(listings.map((l) => [l.id, pricePer100(l, productSize)]));
  const units = new Set([...per.values()].filter(Boolean).map((p) => p!.unit));
  const unit: BaseUnit | undefined = units.size === 1 ? [...units][0] : undefined;
  const pricedCount = Object.keys(comparison.deltas).length;
  const currency = listings.find((l) => l.price)?.price?.currency ?? 'MXN';

  return (
    <View>
      <TableHead
        columns={[
          { label: strings.storeColumn },
          { label: unit ? strings.per100Column(unit) : strings.per100Mixed, width: PER_WIDTH, align: 'right' },
          { label: currency, width: PRICE_WIDTH, align: 'right' },
        ]}
      />
      {listings.map((listing) => (
        <StoreRow
          key={listing.id}
          listing={listing}
          per={per.get(listing.id)}
          showUnit={!unit}
          // Ties with the lowest are marked too.
          lowest={pricedCount > 1 && comparison.deltas[listing.id] === 0}
          delta={pricedCount > 1 ? comparison.deltas[listing.id] : undefined}
          onPress={() => onOpen(listing)}
        />
      ))}
    </View>
  );
}

/**
 * A product's listings split by product, one table each: the scanned product first ("LISTINGS"), then each similar product,
 * then anything the app can't place. Prices are compared only inside a table.
 */
export function ListingTables({
  listings,
  product,
  pages,
  similar,
  empty,
  onOpen,
}: {
  listings: Listing[];
  product: Pick<ProductIdentity, 'productName' | 'size'>;
  pages?: SourcePage[];
  similar?: SimilarProduct[];
  empty: { title: string; message: string };
  onOpen: (listing: Listing) => void;
}) {
  const groups = groupByProduct(listings, product.productName, pages, similar, product.size);
  if (groups.length === 0) {
    return (
      <View>
        <SectionHeader title={strings.listingsTitle} right={strings.listingsCount(0)} />
        <EmptyState icon="doc.text.magnifyingglass" iconFallback="?" title={empty.title} message={empty.message} />
      </View>
    );
  }
  return (
    <>
      {groups.map((g) => (
        <View key={g.key}>
          <SectionHeader
            title={g.key === 'same' ? strings.listingsTitle : g.key === 'other' ? strings.otherProducts : strings.similarListings(g.title ?? g.key)}
            right={strings.listingsCount(g.listings.length)}
          />
          <StoreTable listings={g.listings} productSize={g.key === 'same' ? product.size : undefined} compare={g.comparable} onOpen={onOpen} />
        </View>
      ))}
    </>
  );
}

function StoreRow({
  listing,
  per,
  showUnit,
  lowest,
  delta,
  onPress,
}: {
  listing: Listing;
  per?: { amount: number; unit: BaseUnit };
  showUnit: boolean;
  lowest: boolean;
  delta?: number;
  onPress: () => void;
}) {
  const { spacing } = useTheme();
  const { name, official } = useRetailerLabel(listing);
  const stock = stockText(listing.fields);
  const shown = shownPrice(listing);
  const price = shown ? formatAmount(shown.amount) : strings.empty;
  const note = lowest ? strings.lowMark : delta !== undefined && delta > 0 ? formatDelta(delta) : undefined;
  return (
    <Row onPress={onPress} accessibilityLabel={`${strings.viewDetails}: ${name}, ${price}${lowest ? `, ${strings.lowestA11y}` : ''}`}>
      <Cell>
        <View style={[styles.store, { gap: spacing.sm }]}>
          <RetailerLogo domain={listing.domain} name={name} size={20} />
          <Text variant="subheading" numberOfLines={1} style={styles.shrink}>
            {name}
          </Text>
          {official ? (
            <Text variant="label" color="secondary">
              {strings.official.toUpperCase()}
            </Text>
          ) : null}
        </View>
        <Text variant="mono" color="secondary" numberOfLines={1} style={styles.sub}>
          {stock ? stock.toLowerCase() : listing.domain}
        </Text>
      </Cell>
      <Cell width={PER_WIDTH} align="right">
        <Text variant="mono" style={styles.perText}>
          {per ? `${formatAmount(per.amount)}${showUnit ? ` ${per.unit}` : ''}` : strings.empty}
        </Text>
      </Cell>
      <Cell width={PRICE_WIDTH} align="right">
        <Text variant="number">{price}</Text>
        {note ? (
          <Text variant="mono" color={lowest ? 'accent' : 'secondary'} style={[styles.note, lowest && styles.bold]}>
            {note}
          </Text>
        ) : null}
      </Cell>
    </Row>
  );
}

const styles = StyleSheet.create({
  store: { flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
  sub: { marginTop: 2, marginLeft: 28 },
  perText: { lineHeight: 20 },
  note: { fontSize: 11 },
  bold: { fontWeight: '700' },
});
