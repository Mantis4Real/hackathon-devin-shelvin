// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comparePrices, groupByProduct, isOutOfStock, mainCurrency, formatAmount, formatDelta, listingNetSize, parseNetSize, pricePer100, ratingText, shownPrice, stockText, storeAbbreviation } from './compare';

test('parseNetSize: grams, kilos, millilitres, litres', () => {
  assert.deepEqual(parseNetSize('62 g'), { amount: 62, unit: 'g' });
  assert.deepEqual(parseNetSize('70g'), { amount: 70, unit: 'g' });
  assert.deepEqual(parseNetSize('145 gr'), { amount: 145, unit: 'g' });
  assert.deepEqual(parseNetSize('1 kg'), { amount: 1000, unit: 'g' });
  assert.deepEqual(parseNetSize('1.5 kg'), { amount: 1500, unit: 'g' });
  assert.deepEqual(parseNetSize('600 ml'), { amount: 600, unit: 'ml' });
  assert.deepEqual(parseNetSize('600 mL'), { amount: 600, unit: 'ml' });
  assert.deepEqual(parseNetSize('1 L'), { amount: 1000, unit: 'ml' });
  assert.deepEqual(parseNetSize('1,5 l'), { amount: 1500, unit: 'ml' });
  assert.deepEqual(parseNetSize('Bolsa de 2 litros'), { amount: 2000, unit: 'ml' });
});

test('parseNetSize: unknown sizes are skipped', () => {
  for (const v of ['', '12 oz', '6 piezas', 'grande', '0 g', undefined, null, 62, true]) assert.equal(parseNetSize(v as never), undefined, String(v));
});

test('listingNetSize: own field first, then the product size, times the pack count', () => {
  assert.deepEqual(listingNetSize({ fields: { net_weight: '62 g' } }, '90 g'), { amount: 62, unit: 'g' });
  assert.deepEqual(listingNetSize({ fields: {} }, '90 g'), { amount: 90, unit: 'g' });
  assert.deepEqual(listingNetSize({ fields: { pack_size: 6 } }, '62 g'), { amount: 372, unit: 'g' });
  assert.deepEqual(listingNetSize({ fields: { pack_size: 1 } }, '62 g'), { amount: 62, unit: 'g' });
  assert.equal(listingNetSize({ fields: {} }), undefined);
});

test('pricePer100: price over size, rounded to cents', () => {
  assert.deepEqual(pricePer100({ fields: {}, price: { amount: 24.9, currency: 'MXN' } }, '70 g'), { amount: 35.57, unit: 'g' });
  assert.deepEqual(pricePer100({ fields: { size: '600 ml' }, price: { amount: 18, currency: 'MXN' } }), { amount: 3, unit: 'ml' });
  assert.deepEqual(pricePer100({ fields: { net_weight: '1 kg' }, price: { amount: 120, currency: 'MXN' } }), { amount: 12, unit: 'g' });
  assert.equal(pricePer100({ fields: {}, price: { amount: 24.9, currency: 'MXN' } }), undefined, 'no size');
  assert.equal(pricePer100({ fields: { net_weight: '62 g' } }), undefined, 'no price');
  assert.equal(pricePer100({ fields: { net_weight: '62 g' }, price: { amount: 0, currency: 'MXN' } }), undefined, 'zero price');
});

test('comparePrices: lowest and deltas', () => {
  const r = comparePrices([
    { id: 'a', price: { amount: 25.5, currency: 'MXN' } },
    { id: 'b', price: { amount: 24.9, currency: 'MXN' } },
    { id: 'c', price: { amount: 26, currency: 'MXN' } },
    { id: 'd' },
  ]);
  assert.equal(r.lowestId, 'b');
  assert.equal(r.lowest, 24.9);
  assert.deepEqual(r.deltas, { a: 0.6, b: 0, c: 1.1 });
});

test('comparePrices: an out-of-stock listing never wins the lowest price', () => {
  // Walmart México's row for a product it can't sell: $1.00, available false, schema.org OutOfStock.
  const walmart = { id: 'w', price: { amount: 1, currency: 'MXN' }, fields: { available: false, offers_1_availability: 'https://schema.org/OutOfStock' } };
  const r = comparePrices([walmart, { id: 'c', price: { amount: 17.5, currency: 'MXN' }, fields: { availability: 'In stock' } }]);
  assert.equal(r.lowestId, 'c');
  assert.deepEqual(r.deltas, { c: 0 });
  assert.equal(isOutOfStock({ offers_1_availability: 'https://schema.org/OutOfStock' }), true);
  assert.equal(isOutOfStock({ disponibilidad: 'Agotado' }), true);
  assert.equal(isOutOfStock({ availability: 'In stock' }), false);
  assert.equal(comparePrices([walmart]).lowestId, undefined);
});

test('shownPrice: an out-of-stock listing shows no price and no price per 100 g', () => {
  const walmart = { price: { amount: 1, currency: 'MXN' }, fields: { available: false, net_content: '56 g' } };
  assert.equal(shownPrice(walmart), undefined);
  assert.equal(pricePer100(walmart), undefined);
  const od = { price: { amount: 22, currency: 'MXN' }, fields: { availability: 'In stock', net_content: '56 g' } };
  assert.deepEqual(shownPrice(od), { amount: 22, currency: 'MXN' });
  assert.deepEqual(pricePer100(od), { amount: 39.29, unit: 'g' });
  assert.equal(shownPrice({ fields: { available: true } }), undefined);
});

test('comparePrices: ties keep the first, other currencies get no delta, nothing priced gives nothing', () => {
  const r = comparePrices([
    { id: 'a', price: { amount: 10, currency: 'MXN' } },
    { id: 'b', price: { amount: 10, currency: 'MXN' } },
    { id: 'c', price: { amount: 12, currency: 'USD' } },
  ]);
  assert.equal(r.lowestId, 'a');
  assert.deepEqual(r.deltas, { a: 0, b: 0 });
  assert.deepEqual(comparePrices([{ id: 'x' }]), { deltas: {} });
  assert.deepEqual(comparePrices([]), { deltas: {} });
});

test('formatAmount and formatDelta', () => {
  assert.equal(formatAmount(24.9), '24.90');
  assert.equal(formatAmount(1234.5), '1,234.50');
  assert.equal(formatDelta(0.6), '+0.60');
});

test('storeAbbreviation', () => {
  assert.equal(storeAbbreviation('Soriana'), 'SOR');
  assert.equal(storeAbbreviation('Chedraui'), 'CHE');
  assert.equal(storeAbbreviation('Walmart Súper'), 'WMT');
  assert.equal(storeAbbreviation('Bodega Aurrera Despensa'), 'BA');
  assert.equal(storeAbbreviation('Amazon México'), 'AMZ');
  assert.equal(storeAbbreviation('Mercado Libre'), 'MELI');
  assert.equal(storeAbbreviation('La Comer'), 'LCO');
  assert.equal(storeAbbreviation('Farmacias Guadalajara'), 'FG');
  assert.equal(storeAbbreviation('Takis (official site)'), 'TAK');
  assert.equal(storeAbbreviation('Súper Kompras'), 'KOM');
  assert.equal(storeAbbreviation('El Súper'), 'ELS');
});

test('stockText and ratingText', () => {
  assert.equal(stockText({ availability: 'In stock' }), 'In stock');
  assert.equal(stockText({ in_stock: false }), 'Out of stock');
  assert.equal(stockText({ promo: '3 x 2' }), undefined);
  assert.equal(ratingText({ rating: 4.7, review_count: 312 }), '4.7 (312)');
  assert.equal(ratingText({ rating: 4.4 }), '4.4');
  assert.equal(ratingText({ review_count: 12 }), undefined);
});

test('groupByProduct: pages decide, similar products keep their order, unknown pages go last', () => {
  const l = (id: string, pageId: string, title?: string) => ({ id, pageId, url: '', domain: '', retailerName: '', title, fields: {}, scrapedAt: '' });
  const pages = [
    { id: 'p1', matchType: 'exact' as const },
    { id: 'p2', matchType: 'similar' as const, similarProductId: 'b' },
    { id: 'p3', matchType: 'similar' as const, similarProductId: 'a' },
  ];
  const groups = groupByProduct([l('1', 'p1'), l('2', 'p2'), l('3', 'p3'), l('4', 'p9', 'Something else')], 'Doritos Incógnita', pages, [
    { id: 'a', productName: 'Takis Fuego' },
    { id: 'b', productName: 'Doritos Nacho' },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.title, g.listings.map((x) => x.id), g.comparable]),
    [
      ['same', undefined, ['1'], true],
      ['a', 'Takis Fuego', ['3'], true],
      ['b', 'Doritos Nacho', ['2'], true],
      ['other', undefined, ['4'], false],
    ],
  );
});

test('groupByProduct: without pages, the title decides (accents and case ignored)', () => {
  const l = (id: string, title?: string) => ({ id, pageId: id, url: '', domain: '', retailerName: '', title, fields: {}, scrapedAt: '' });
  const groups = groupByProduct([l('1', 'DORITOS INCOGNITA 62 g - Walmart'), l('2', "Doritos Flamin' Hot 62 g - Soriana"), l('3')], 'Doritos Incógnita');
  assert.deepEqual(
    groups.map((g) => [g.key, g.listings.map((x) => x.id)]),
    [
      ['same', ['1']],
      ['other', ['2', '3']],
    ],
  );
  assert.deepEqual(groupByProduct([], 'X'), []);
});

test('groupByProduct: title words in any order count, another size does not', () => {
  const l = (id: string, title?: string) => ({ id, pageId: id, url: '', domain: '', retailerName: '', title, fields: {}, scrapedAt: '' });
  const nachos = groupByProduct([l('1', 'Nachos De Queso Y Chile Sabritas Doritos 146g'), l('2', 'Doritos Nachos 340 g')], 'Doritos Nachos', [], [], '146 g');
  assert.deepEqual(nachos.map((g) => [g.key, g.listings.map((x) => x.id)]), [['same', ['1']], ['other', ['2']]]);
  const incognita = groupByProduct([l('1', 'Botana Sabritas Doritos ADN Incógnita 245g')], 'Doritos Incógnita', [], [], '56 g');
  assert.deepEqual(incognita.map((g) => g.key), ['other']);
});

test('parseNetSize: a comma before exactly three digits groups thousands, otherwise it is a decimal', () => {
  assert.deepEqual(parseNetSize('1,000 g'), { amount: 1000, unit: 'g' });
  assert.deepEqual(parseNetSize('2,500 ml'), { amount: 2500, unit: 'ml' });
  assert.deepEqual(parseNetSize('1,000.5 g'), { amount: 1000.5, unit: 'g' });
  assert.deepEqual(parseNetSize('1,5 kg'), { amount: 1500, unit: 'g' });
  assert.deepEqual(parseNetSize('0,75 l'), { amount: 750, unit: 'ml' });
  assert.deepEqual(parseNetSize('1,25 kg'), { amount: 1250, unit: 'g' });
});

test('comparePrices: the lowest is picked only in the main currency', () => {
  const r = comparePrices([
    { id: 'usd', price: { amount: 1.5, currency: 'USD' } },
    { id: 'a', price: { amount: 25.5, currency: 'MXN' } },
    { id: 'b', price: { amount: 24.9, currency: 'MXN' } },
  ]);
  assert.equal(r.lowestId, 'b');
  assert.equal(r.lowest, 24.9);
  assert.deepEqual(r.deltas, { a: 0.6, b: 0 });
  assert.equal(comparePrices([{ id: 'usd', price: { amount: 1.5, currency: 'USD' } }]).lowestId, 'usd');
});

test('mainCurrency: majority wins, MXN breaks a tie', () => {
  assert.equal(mainCurrency(['USD', 'USD', 'MXN']), 'USD');
  assert.equal(mainCurrency(['USD', 'MXN']), 'MXN');
  assert.equal(mainCurrency(['EUR', 'USD']), 'EUR');
});
