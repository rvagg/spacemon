import { request } from 'undici'
import { encode as cborEncode } from '@ipld/dag-cbor'
import { decode as jsonDecode } from '@ipld/dag-json'
import { base64pad } from 'multiformats/bases/base64'

import { init as builtinActorEventInit, transform as builtinActorEventTransform } from './builtin-actor-events.js'

export class LotusApi {
  #config

  constructor (config) {
    this.config = config
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
  builtinActorEvents(fromHeight, toHeight, eventTypes) {
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
    let result = null
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (result == null) {
            // first call, make the request
            result = await this.#request('Filecoin.GetActorEventsRaw', params)
            await builtinActorEventInit()
          }
          if (result.length > 0) {
            const value = builtinActorEventTransform(result.shift())
            return { value, done: false };
          } else {
            return { done: true };
          }
        }
      })
    };
  }

  async #request (method, params) {
    const { body } = await request(this.config.lotusHttpRpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params, id: 1, jsonrpc: '2.0' })
    })
    const rawBody = await body.arrayBuffer()
    const parsed = jsonDecode(new Uint8Array(rawBody))
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

/* TODO: if we want to SubscribeActorEventsRaw, we need to use the websocket API

import WebSocket from 'ws'

const ws = new WebSocket(config.lotusWebsocketRpc)

ws.on('error', (err) => {
  console.error(err)
  process.exit(0)
})

ws.on('open', function open () {
  ws.send('{"method":"Filecoin.SubscribeActorEventsRaw", "params": [{"fromHeight":1470000}],"id":1,"jsonrpc":"2.0"}')
})

ws.on('message', function message (data) {
  console.log(data.toString())
})
*/

