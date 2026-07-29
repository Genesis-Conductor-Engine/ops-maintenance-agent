import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountUrl,
  txUrl,
  coinUrl,
  nftCollectionUrl,
  nftObjectUrl,
  objectUrl,
  encodeTypePath,
  explorerUrl,
} from './suivision.mjs';

const EXAMPLE_ACCOUNT =
  '0x75aadc57666f6ac6db4fdc7773a83d5648816d7693ae6193623e69fa266b3162';
const EXAMPLE_TX = 'EiceKotDYdCbrsbbqDhXPYvAhDs5noXHUVt4w4Ay898';
const EXAMPLE_COIN =
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';
const EXAMPLE_COLLECTION =
  '0xac176715abe5bcdaae627c5048958bbe320a8474f524674f3278e31af3c8b86b::fuddies::Fuddies';
const EXAMPLE_OBJECT =
  '0x3de85553c50761ae8b6a9df1858b62205e956480c3eeabebafce1e70fc660313';

test('account URL', () => {
  assert.equal(
    accountUrl(EXAMPLE_ACCOUNT),
    `https://suivision.xyz/account/${EXAMPLE_ACCOUNT}`,
  );
});

test('txblock URL', () => {
  assert.equal(txUrl(EXAMPLE_TX), `https://suivision.xyz/txblock/${EXAMPLE_TX}`);
});

test('coin URL encodes ::', () => {
  const u = coinUrl(EXAMPLE_COIN);
  assert.ok(u.startsWith('https://suivision.xyz/coin/'));
  assert.ok(u.includes('%3A%3A'));
  assert.equal(u, `https://suivision.xyz/coin/${encodeTypePath(EXAMPLE_COIN)}`);
});

test('nft collection URL encodes type path', () => {
  const u = nftCollectionUrl(EXAMPLE_COLLECTION);
  assert.ok(u.includes('/nft/collection/'));
  assert.ok(u.includes('%3A%3A'));
});

test('nft object + object URLs', () => {
  assert.equal(
    nftObjectUrl(EXAMPLE_OBJECT),
    `https://suivision.xyz/nft/object/${EXAMPLE_OBJECT}`,
  );
  assert.equal(
    objectUrl(EXAMPLE_OBJECT),
    `https://suivision.xyz/object/${EXAMPLE_OBJECT}`,
  );
});

test('explorerUrl dispatcher', () => {
  assert.equal(explorerUrl('account', EXAMPLE_ACCOUNT), accountUrl(EXAMPLE_ACCOUNT));
  assert.equal(explorerUrl('txblock', EXAMPLE_TX), txUrl(EXAMPLE_TX));
  assert.equal(explorerUrl('coin', EXAMPLE_COIN), coinUrl(EXAMPLE_COIN));
});
