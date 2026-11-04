import assert from 'node:assert/strict';
import test from 'node:test';

import { identifyBarcode, pinKnown } from './pipeline';

test('pinned barcode: Runners Fuego is named the same every scan, without Open Food Facts or Claude', async () => {
  const deps = {
    lookupOff: async () => assert.fail('no OFF lookup'),
    transport: async () => assert.fail('no Claude call'),
  } as never;
  const id = await identifyBarcode('7500810031667', deps);
  assert.equal(id.productName, 'Barcel Runners Fuego');
  assert.equal(id.size, '280 g');
  assert.equal(id.id, 'gtin-07500810031667');
  const fromPhoto = pinKnown({ id: 'runners', brand: 'Runners', productName: 'Runners', barcode: '07500810031667', confidence: 0.6, source: 'claude' });
  assert.equal(fromPhoto.productName, 'Barcel Runners Fuego');
  assert.equal(fromPhoto.id, 'gtin-07500810031667');
  assert.equal(pinKnown({ id: 'x', brand: 'Takis', productName: 'Takis Fuego', barcode: '7501030424536', confidence: 0.9, source: 'claude' }).productName, 'Takis Fuego');
});
