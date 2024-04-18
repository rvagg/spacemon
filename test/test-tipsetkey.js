/* eslint-env mocha */

import { CID } from 'multiformats/cid'
import * as codec from '@ipld/dag-cbor'
import { blake2b256 as hasher } from '@multiformats/blake2/blake2b'
import { assert } from 'chai'
import { TipSetKey } from '../lib/tipsetkey.js'

async function mkCid (str) {
  // fake a Filecoin type CID from a string through multihash only, no codec
  const hash = await hasher.digest(new TextEncoder().encode(str))
  return CID.create(1, codec.code, hash)
}

it('should create a TipSetKey', async () => {
  const c1 = await mkCid('a')
  assert.equal('bafy2bzacecesrkxghscnq7vatble2hqdvwat6ed23vdu4vvo3uuggsoaya7ki', c1.toString()) // sanity check
  const c2 = await mkCid('b')
  const c3 = await mkCid('c')

  const tskCid1 = await new TipSetKey().cid()
  assert.equal(tskCid1.toString(), 'bafy2bzacea456askyutsf7uk4ta2q5aojrlcji4mhaqokbfalgvoq4ueeh4l2')
  const tskCid2 = await new TipSetKey(c1).cid()
  assert.equal(tskCid2.toString(), 'bafy2bzacealem6larzxhf7aggj3cozcefqez3jlksx2tuxehwdil27otcmy4q')
  const tskCid3 = await new TipSetKey(c1, c2, c3).cid()
  assert.equal(tskCid3.toString(), 'bafy2bzacecbnwngwfvxuciumcfudiaoqozisp3hus5im5lg4urrwlxbueissu')
})
