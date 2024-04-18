import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { blake2b256 as hasher } from '@multiformats/blake2/blake2b'

export class TipSetKey {
  /**
   * @param {import('multiformats/cid').CID[]} cids
   */
  constructor (...cids) {
    this.encoded = encodeKey(cids)
  }

  /**
   * @returns {import('multiformats/cid').CID}
   */
  async cid () {
    const block = await Block.encode({ value: this.encoded, hasher, codec })
    return block.cid
  }

  /**
   * @param {boolean}
   */
  isEmpty () {
    return this.encoded.length === 0
  }
}

/**
 * @param {import('multiformats/cid').CID[]} cids
 * @returns {Uint8Array}
 */
function encodeKey (cids) {
  const byteLen = cids.reduce((acc, cid) => acc + cid.byteLength, 0)
  const buf = new Uint8Array(byteLen)
  let offset = 0
  for (const cid of cids) {
    buf.set(cid.bytes, offset)
    offset += cid.byteLength
  }
  return buf
}
