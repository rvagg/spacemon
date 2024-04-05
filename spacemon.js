import { encode as jsonEncode } from '@ipld/dag-json'
import { loadConfig } from './lib/config.js'
import { LotusApi } from './lib/lotus.js'

// The nv22 "fix" height where to integrate late changes, this only happened on the calibration
// network. Our event schemas won't match all of the events we get before this height.
//  - https://github.com/filecoin-project/FIPs/pull/964
//  - https://github.com/filecoin-project/FIPs/pull/968
const calibnetValidNv22Height = 1493854
const finalityEpochs = 900 // don't consider events from epochs newer than this, reverts are hard
const epochsPerDay = 2880
const maxFilterHeightRange = epochsPerDay // default in lotus is 2880, our API calls will likely fail for larger than this

const config = await loadConfig('./config.json')
const rpc = new LotusApi(config)

const currentHeight = (await rpc.chainHead()).Height
let startHeight = currentHeight - 2880 * 3
if (config.network === 'calibration') {
  startHeight = Math.max(startHeight, calibnetValidNv22Height)
}

// All types: const eventTypes = ['verifier-balance', 'allocation', 'allocation-removed', 'claim',
//  'claim-updated', 'claim-removed', 'deal-published', 'deal-activated', 'deal-terminated',
//  'deal-completed', 'sector-precommitted', 'sector-activated', 'sector-updated',
//  'sector-terminated']
const eventTypes = ['allocation', 'sector-activated', 'sector-updated', 'verifier-balance']

console.log('Starting at', startHeight, 'looking for', eventTypes.join(', '))

for await (const event of rpc.builtinActorEvents(startHeight, -1, eventTypes)) {
  // console.log(dagJsonPretty(event))
  console.log(dagJson(event))
}

function dagJson (obj) {
  return new TextDecoder().decode(jsonEncode(obj))
}

// dagJsonPretty is a minor hack to get the dag-json encoder to round-trip through the standard JSON
// encoder so we can pretty print the output while retaining proper CID and Bytes forms.
function dagJsonPretty (obj) {
  return JSON.stringify(JSON.parse(new TextDecoder().decode(jsonEncode(obj))), null, 2)
}
