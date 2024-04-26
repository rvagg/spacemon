import { join as pathJoin } from 'node:path'
import fs from 'node:fs/promises'
import { request } from 'undici'
import { encode as cborEncode } from '@ipld/dag-cbor'
import { decode as jsonDecode, encode as jsonEncode } from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import { base64pad } from 'multiformats/bases/base64'
import { TipSetKey } from './tipsetkey.js'

import { init as builtinActorEventInit, transform as builtinActorEventTransform } from './builtin-actor-events.js'

// cache for chainGetTipSetByHeight calls, we're likely to get many repeat calls for the same height
// for grouped events in an epoch
let lastTipsetByHeight = null

const maxActorEventsResults = 10_000

export class MaxResultsError extends Error {
  constructor (message) {
    super(message)
    this.name = 'MaxResultsError'
  }
}

export class LotusApi {
  #lotusHttpRpc
  #apiCachePath

  constructor (lotusHttpRpc, apiCachePath) {
    this.lotusHttpRpc = lotusHttpRpc
    this.apiCachePath = apiCachePath
  }

  /**
   * Get the current chain head
   * @returns {Object} - The chain head object
   */
  async chainHead () {
    const result = await this.#request('Filecoin.ChainHead', [])
    // basic schema check
    if (typeof result.Height !== 'number') {
      throw new Error('Unexpected result data')
    }
    return result
  }

  /**
  * Get the current chain head
  * @returns {Object} - The chain head object
  */
  async chainGetTipSetByHeight (height, tipset = []) {
    if (typeof height !== 'number') {
      throw new TypeError('height must be a number')
    }
    if (!Array.isArray(tipset)) {
      throw new TypeError('tipset must be an array')
    }
    if (tipset.length === 0 && lastTipsetByHeight !== null && lastTipsetByHeight.height === height) {
      return lastTipsetByHeight.result
    }
    const result = await this.#request('Filecoin.ChainGetTipSetByHeight', [height, tipset])
    // basic schema check
    if (!Array.isArray(result.Cids)) {
      throw new Error('Unexpected result data')
    }
    lastTipsetByHeight = { height, result }
    return result
  }

  /**
   * @param {CID[]} tipset
   * @param {CID} msgCid
   * @param {number} limit
   * @param {boolean} allowReplaced
   * @returns {Object}
   */
  async stateSearchMsg (tipsetKeyCids, msgCid, limit, allowReplaced) {
    if (!Array.isArray(tipsetKeyCids)) {
      throw new TypeError('tipsetKeyCids must be an array')
    }
    if (typeof limit !== 'number') {
      throw new TypeError('limit must be a number')
    }
    if (typeof allowReplaced !== 'boolean') {
      throw new TypeError('allowReplaced must be a boolean')
    }
    if (typeof CID.asCID !== 'function') {
      throw new TypeError('msgCid must be a CID')
    }
    let cacheFile
    if (tipsetKeyCids.length > 0) {
      const tskCid = await new TipSetKey(...tipsetKeyCids).cid()
      cacheFile = pathJoin(this.apiCachePath, `stateSearchMsg-${msgCid.toString()}-${limit}-${allowReplaced}-${tskCid.toString()}.json`)
      try {
        await fs.access(cacheFile)
        const cacheData = await fs.readFile(cacheFile)
        return jsonDecode(cacheData)
      } catch (err) {}
    }
    const tsk = tipsetKeyCids.map((c) => ({ '/': c.toString() }))
    const params = [tsk, msgCid, limit, allowReplaced]
    const result = await this.#request('Filecoin.StateSearchMsg', params)
    if (tipsetKeyCids.length > 0) {
      await fs.writeFile(cacheFile, jsonEncode(result))
    }
    return result
  }

  /**
   * @param {CID} msgCid
   * @returns {Object}
   */
  async chainGetMessage (msgCid) {
    if (typeof CID.asCID !== 'function') {
      throw new TypeError('msgCid must be a CID')
    }
    const cacheFile = pathJoin(this.apiCachePath, `chainGetMessage-${msgCid.toString()}.json`)
    try {
      await fs.access(cacheFile)
      const cacheData = await fs.readFile(cacheFile)
      return jsonDecode(cacheData)
    } catch (err) {}
    const result = await this.#request('Filecoin.ChainGetMessage', [msgCid])
    await fs.writeFile(cacheFile, jsonEncode(result))
    return result
  }

  async stateSectorGetInfo (address, sectorId, tipsetKeyCids) {
    if (typeof address !== 'string') {
      throw new TypeError('address must be a string')
    }
    if (typeof sectorId !== 'number') {
      throw new TypeError('sectorId must be a number')
    }
    if (!Array.isArray(tipsetKeyCids)) {
      throw new TypeError('tipsetKeyCids must be an array')
    }
    let cacheFile
    if (tipsetKeyCids.length > 0) {
      const tskCid = await new TipSetKey(...tipsetKeyCids).cid()
      cacheFile = pathJoin(this.apiCachePath, `stateSectorGetInfo-${address}-${sectorId}-${tskCid.toString()}.json`)
      try {
        await fs.access(cacheFile)
        const cacheData = await fs.readFile(cacheFile)
        return jsonDecode(cacheData)
      } catch (err) {}
    }
    const tsk = tipsetKeyCids.map((c) => ({ '/': c.toString() }))
    const params = [address, sectorId, tsk]
    const result = await this.#request('Filecoin.StateSectorGetInfo', params)
    if (tipsetKeyCids.length > 0) {
      await fs.writeFile(cacheFile, jsonEncode(result))
    }
    return result
  }

  /**
   * Get builtin actor events
   * @param {number} fromHeight - The height to start from, or -1 for the current head
   * @param {number} toHeight - The height to end at, or -1 for the current head
   * @param {string[]} eventTypes - The types of events to filter for
   * @returns {AsyncIterable<Object>} - An async iterable of event objects
   *
   * Valid eventTypes:
   *  "verifier-balance"
   *  "allocation"
   *  "allocation-removed"
   *  "claim"
   *  "claim-updated"
   *  "claim-removed"
   *  "deal-published"
   *  "deal-activated"
   *  "deal-terminated"
   *  "deal-completed"
   *  "sector-precommitted"
   *  "sector-activated"
   *  "sector-updated"
   *  "sector-terminated"
   */
  builtinActorEvents (fromHeight, toHeight, eventTypes) {
    // TODO: this function should be able to handle a large height range and work in batches,
    // currently it just makes a single call and processes the singular result as an iterator

    if (fromHeight !== -1 && typeof fromHeight !== 'number') {
      throw new TypeError('fromHeight must be a number or -1')
    }
    if (toHeight !== -1 && typeof toHeight !== 'number') {
      throw new TypeError('toHeight must be a number or -1')
    }
    // make sure eventTypes is either null or an array of strings
    if (eventTypes !== null && !Array.isArray(eventTypes)) {
      throw new TypeError('eventTypes must be an array of strings or null')
    }
    const params = [{
      fromHeight,
      toHeight,
      fields: {
        $type: eventTypes.map(eventTypeString => {
          // string must be encoded as CBOR and then presented as a base64 encoded string
          const eventTypeEncoded = base64pad.baseEncode(cborEncode(eventTypeString))
          // Codec 81 is CBOR and will only give us builtin-actor events, FEVM events are all RAW
          return { Codec: 81, Value: eventTypeEncoded }
        })
      }
    }]
    // console.log(JSON.stringify(params))
    let result = null
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (result == null) {
            // first call, make the request
            result = await this.#request('Filecoin.GetActorEventsRaw', params)
            if (result != null && result.length === maxActorEventsResults) {
              throw new MaxResultsError('Max results reached for GetActorEventsRaw')
            }
            await builtinActorEventInit()
          }
          if (result != null && result.length > 0) {
            const rawEvent = result.shift()
            const event = builtinActorEventTransform(rawEvent)
            return { value: { rawEvent, event }, done: false }
          } else {
            return { done: true }
          }
        }
      })
    }
  }

  async #request (method, params) {
    const reqBody = JSON.stringify({ method, params, id: 1, jsonrpc: '2.0' })
    // console.log(reqBody)
    const { body } = await request(this.lotusHttpRpc, {
      bodyTimeout: 1000 * 60,
      headersTimeout: 1000 * 60,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: reqBody
    })
    const rawBody = await body.arrayBuffer()
    // console.log('rawBody: [', Buffer.from(rawBody).toString(), ']')
    // console.log(`done, got ${rawBody.byteLength} bytes`)
    let parsed
    try {
      parsed = jsonDecode(new Uint8Array(rawBody))
    } catch (e) {
      console.error(`Body: [${rawBody}]`)
      throw new Error('Invalid JSON response')
    }
    if (parsed.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC version')
    }
    if (parsed.error) {
      throw new Error(parsed.error.message)
    }
    if (parsed.result === undefined) {
      throw new Error('Missing result')
    }
    return parsed.result
  }
}

/**
 * Create a new API instance.
 * @returns {Promise<{LotusApi}>} config
 */
export async function createApi (config) {
  const apiCachePath = pathJoin(config.apiCachePath, config.network)
  await fs.mkdir(apiCachePath, { recursive: true })
  return new LotusApi(config.lotusHttpRpc, apiCachePath)
}
