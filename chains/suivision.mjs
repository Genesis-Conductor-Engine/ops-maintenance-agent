/**
 * SuiVision default explorer for Sui (Node / agent tooling).
 * Browser twin: yennefer-quest-deploy/public/js/suivision.js
 *
 * @see https://suivision.xyz
 */

export const SUIVISION_BASE = 'https://suivision.xyz';

function strip(s) {
  return String(s ?? '').trim();
}

export function encodeTypePath(typePath) {
  return encodeURIComponent(strip(typePath));
}

export function accountUrl(address) {
  return `${SUIVISION_BASE}/account/${strip(address)}`;
}

export function txUrl(digest) {
  return `${SUIVISION_BASE}/txblock/${strip(digest)}`;
}

export function coinUrl(coinType) {
  return `${SUIVISION_BASE}/coin/${encodeTypePath(coinType)}`;
}

export function nftCollectionUrl(collectionType) {
  return `${SUIVISION_BASE}/nft/collection/${encodeTypePath(collectionType)}`;
}

export function nftObjectUrl(objectId) {
  return `${SUIVISION_BASE}/nft/object/${strip(objectId)}`;
}

export function objectUrl(objectId) {
  return `${SUIVISION_BASE}/object/${strip(objectId)}`;
}

/**
 * @param {'account'|'tx'|'transaction'|'txblock'|'coin'|'nftCollection'|'nftObject'|'object'} kind
 * @param {string} id
 */
export function explorerUrl(kind, id) {
  switch (String(kind).toLowerCase()) {
    case 'account':
    case 'address':
    case 'wallet':
      return accountUrl(id);
    case 'tx':
    case 'transaction':
    case 'txblock':
    case 'digest':
      return txUrl(id);
    case 'coin':
    case 'cointype':
    case 'token':
      return coinUrl(id);
    case 'nftcollection':
    case 'collection':
      return nftCollectionUrl(id);
    case 'nft':
    case 'nftobject':
      return nftObjectUrl(id);
    case 'object':
      return objectUrl(id);
    default:
      throw new Error(`SuiVision: unknown kind "${kind}"`);
  }
}

export const SuiVision = {
  BASE: SUIVISION_BASE,
  account: accountUrl,
  tx: txUrl,
  transaction: txUrl,
  coin: coinUrl,
  nftCollection: nftCollectionUrl,
  nftObject: nftObjectUrl,
  object: objectUrl,
  url: explorerUrl,
  encodeTypePath,
};

export default SuiVision;
