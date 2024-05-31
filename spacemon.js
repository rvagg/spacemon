import { join as pathJoin } from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { errors as undiciErrors } from 'undici'
import { loadConfig } from './lib/config.js'
import { createApi, MaxResultsError } from './lib/lotus.js'
import { createStore } from './lib/store.js'
import { collectExtraState, allEventTypes } from './lib/builtin-actor-events.js'
import { compileDDOData } from './lib/compile-ddo.js'

/**
 * @typedef {import('./src/store.js').Store} Store
 */

const networkParams = {
  mainnet: {
    epoch0Time: new Date('2020-08-24T22:00Z'),
    nv22Epoch: 3855360
  },
  calibnet: {
    epoch0Time: new Date('2022-11-01T18:13Z'),
    nv22Epoch: 1427974
    // nv22Epoch: 1493854, // the fixed height, nv22 was technically before this but the events weren't complete
  }
}
const finalityEpochs = 900 // don't consider events from epochs newer than this, reverts are hard
const epochsPerDay = 2880
const maxFilterEpochRange = Math.floor(epochsPerDay / 12) // default in lotus is 2880, our API calls will likely fail for larger than this
const loopPauseSeconds = 60 // 60 seconds

yargs(hideBin(process.argv))
  .command('collect [config]', 'collect events from a node', () => {}, cmdCollect)
  .command('compile-ddo [config]', 'compile DDO-related events already collected in a store', () => {}, cmdCompileDDO)
  .option('config', {
    describe: 'config.json file to load',
    default: 'config.json'
  })
  .help()
  .fail(false)
  .strictCommands()
  .parseAsync().catch(e => {
    console.error(e)
    process.exit(1)
  })

async function cmdCollect (argv) {
  const config = await loadConfig(argv.config)
  console.log('Collecting events from', config.network, '...')
  const rpc = await createApi(config)

  // TODO: we need a way to start later, a node is unlikely to have all historical events from nv22
  // unless they are an archive node
  if (networkParams[config.network] == null) {
    throw new Error(`Network parameters not available for ${config.network}`)
  }
  const store = await createStore(config, true)
  const latestEpoch = await store.latestEpoch()
  let startEpoch = config.startEpoch
  if (!startEpoch || startEpoch < 0) {
    startEpoch = networkParams[config.network].nv22Epoch
  }
  if (latestEpoch != null) {
    startEpoch = Math.max(latestEpoch + 1, startEpoch)
  }

  // Collect all builtin-actor events, gotta catch 'em all!
  let eventTypes = config.eventTypes
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    eventTypes = allEventTypes
  }
  console.log('Starting at', startEpoch, 'looking for', eventTypes.join(', '))

  let filterEpochRange = maxFilterEpochRange
  let currentHeight, latestHeight, endEpoch
  while (true) {
    try {
      currentHeight = (await rpc.chainHead()).Height
      latestHeight = currentHeight - finalityEpochs
      endEpoch = Math.min(startEpoch + filterEpochRange, latestHeight)
      if (endEpoch <= startEpoch) {
        await sleep(loopPauseSeconds)
        continue
      }
      const saved = await collectRange(store, rpc, startEpoch, endEpoch, eventTypes)
      console.log(`Saved ${saved} events from ${startEpoch} to ${endEpoch} (current=${currentHeight}, finality=${latestHeight})`)
      startEpoch = endEpoch + 1
    } catch (e) {
      if ((e instanceof undiciErrors.UndiciError) || ['ECONNRESET', 'ECONNREFUSED'].includes(e.code)) {
        // If we get a network error then it should be before we save any events, so we can start
        // again. If it's an another kind of error we should probably restart and rewind.
        console.error(`Error collecting events (start=${startEpoch}), waiting to retry: ${e.message}`)
        await sleep(loopPauseSeconds)
      } else if (e instanceof MaxResultsError) {
        console.error(`Max results reached for GetActorEventsRaw (start=${startEpoch}, end=${endEpoch}), adjusting filter range`)
        if (filterEpochRange === 1) {
          throw new Error('Filter epoch range is too small, exiting')
        }
        filterEpochRange = Math.floor(filterEpochRange / 2)
        if (filterEpochRange <= 0) {
          throw new Error(`Unexpected filter epoch range ${filterEpochRange} is too small, exiting`)
        }
      } else {
        throw e
      }
    }
  }
}

async function cmdCompileDDO (argv) {
  const config = await loadConfig(argv.config)
  console.log('Compiling events from', config.network, '...')
  const store = await createStore(config, false)
  const storePath = pathJoin(config.storePath, config.network)
  const epoch0Time = networkParams[config.network].epoch0Time
  await compileDDOData(store, storePath, epoch0Time)
}

/**
 * @param {{Store}} store
 * @param {number} startEpoch - inclusive
 * @param {number} endEpoch - inclusive
 * @param {string[]} eventTypes
 * @returns {Promise<number>} - number of events saved
 */
async function collectRange (store, rpc, startEpoch, endEpoch, eventTypes) {
  let saved = 0
  for await (const { rawEvent, event } of rpc.builtinActorEvents(startEpoch, endEpoch, eventTypes)) {
    const extra = await collectExtraState(event, rpc)
    if (extra != null) {
      event.extra = extra
    }
    await store.save(rawEvent, event)
    saved++
  }
  return saved
}

async function sleep (seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}
