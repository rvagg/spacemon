// import { encode as jsonEncode } from '@ipld/dag-json'
import { loadConfig } from './lib/config.js'
import { createApi } from './lib/lotus.js'
import { createStore } from './lib/store.js'
import { collectExtraState } from './lib/builtin-actor-events.js'

/**
 * @typedef {import('./src/store.js').Store} Store
 */

const nv22Epoch = {
  // calibnet: 1493854, // the fixed height, nv22 was technically before this but the events weren't complete
  calibnet: 1427974, // the original nv22 height on calibnet, before fix
  mainnet: 3855360
}
const finalityEpochs = 900 // don't consider events from epochs newer than this, reverts are hard
const epochsPerDay = 2880
const maxFilterEpochRange = Math.floor(epochsPerDay / 2) // default in lotus is 2880, our API calls will likely fail for larger than this
const loopPauseTime = 1000 * 10 // 10 seconds

const config = await loadConfig('./config.json')
const rpc = await createApi(config)

// TODO: probably need to be able to start later, a node is unlikely to have all historical events
// unless they are an archive node
if (nv22Epoch[config.network] == null) {
  throw new Error(`No nv22 epoch defined for network ${config.network}`)
}
const { store, latestEpoch } = await createStore(config)
let startEpoch = nv22Epoch[config.network]
if (latestEpoch != null) {
  startEpoch = Math.max(latestEpoch + 1, startEpoch)
}

// All types:
const eventTypes = ['verifier-balance', 'allocation', 'allocation-removed', 'claim',
  'claim-updated', 'claim-removed', 'deal-published', 'deal-activated', 'deal-terminated',
  'deal-completed', 'sector-precommitted', 'sector-activated', 'sector-updated',
  'sector-terminated']
// const eventTypes = ['allocation', 'sector-activated', 'sector-updated', 'verifier-balance']

console.log('Starting at', startEpoch, 'looking for', eventTypes.join(', '))

while (true) {
  const currentHeight = (await rpc.chainHead()).Height
  const latestHeight = currentHeight - finalityEpochs
  const endEpoch = Math.min(startEpoch + maxFilterEpochRange, latestHeight)
  if (endEpoch === startEpoch) {
    await new Promise(resolve => setTimeout(resolve, loopPauseTime))
    continue
  }
  try {
    await collectRange(store, startEpoch, endEpoch, eventTypes)
  } catch (e) {
    console.error('Error collecting range, waiting to retry ...', startEpoch, endEpoch, e.message)
    console.error(e.stack)
    await new Promise(resolve => setTimeout(resolve, loopPauseTime))
  }
  startEpoch = endEpoch
}

/**
 * @param {{Store}} store
 * @param {number} startEpoch
 * @param {number} endEpoch
 * @param {string[]} eventTypes
 */
async function collectRange (store, startEpoch, endEpoch, eventTypes) {
  let saveCount = 0
  for await (const { rawEvent, event } of rpc.builtinActorEvents(startEpoch, endEpoch, eventTypes)) {
    const extra = await collectExtraState(event, rpc)
    if (extra != null) {
      event.extra = extra
    }
    /*
    if (typeof event.event.sector === 'number') {
      // Don't use event.tipsetKey because many Lotus APIs load state from the parent of a tipset
      // when you request a specific tipset, so let's move ahead by 1 epoch and use that tipset.
      const tipset = (await rpc.chainGetTipSetByHeight(event.height + 1)).Cids
      const addr = typeof event.event.provider === 'string' ?
        event.event.provider :
        typeof event.event.provider === 'number' ?
          `${config.network === 'calibnet' ? 't' : 'f'}0${event.event.provider}` :
          event.emitter
      // console.log(event)
      const sectorInfo = await rpc.stateSectorGetInfo(addr, event.event.sector, tipset)
      if (sectorInfo != null) {
        console.log(sectorInfo)
      }
    }
    */
    await store.save(rawEvent, event)
    if (++saveCount % 100 === 0) {
      console.log('Saved', saveCount, 'events')
    }
    // console.log(dagJsonPretty(event))
    // console.log(dagJson(event))
  }
}

/*
function dagJson (obj) {
  return new TextDecoder().decode(jsonEncode(obj))
}

// dagJsonPretty is a minor hack to get the dag-json encoder to round-trip through the standard JSON
// encoder so we can pretty print the output while retaining proper CID and Bytes forms.
function dagJsonPretty (obj) {
  return JSON.stringify(JSON.parse(new TextDecoder().decode(jsonEncode(obj))), null, 2)
}
*/
