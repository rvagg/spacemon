import { decode as cborDecode } from '@ipld/dag-cbor'
import { base64pad } from 'multiformats/bases/base64'
import { readFile } from 'node:fs/promises'
import { fromDSL } from '@ipld/schema/from-dsl.js'
import { create } from '@ipld/schema/typed.js'
import { encode as jsonEncode } from '@ipld/dag-json'
import { TipSetKey } from './tipsetkey.js'

const eventValidators = {}
const miscValidators = {}

export const allEventTypes = ['verifier-balance', 'allocation', 'allocation-removed', 'claim',
  'claim-updated', 'claim-removed', 'deal-published', 'deal-activated', 'deal-terminated',
  'deal-completed', 'sector-precommitted', 'sector-activated', 'sector-updated',
  'sector-terminated']

export async function init () {
  if (Object.keys(eventValidators).length > 0) {
    return
  }
  const schemaPath = new URL('../builtin-actor-events-schemas.ipldsch', import.meta.url)
  const schemaDsl = await readFile(schemaPath, 'utf8')
  const schemaDmt = fromDSL(schemaDsl)
  for (const [name] of Object.entries(schemaDmt.types)) {
    if (name.endsWith('Event')) {
      eventValidators[name] = create(schemaDmt, name)
    }
  }
  const miscSchemaPath = new URL('../misc.ipldsch', import.meta.url)
  const miscSchemaDsl = await readFile(miscSchemaPath, 'utf8')
  const miscSchemaDmt = fromDSL(miscSchemaDsl)
  for (const [name] of Object.entries(miscSchemaDmt.types)) {
    miscValidators[name] = create(miscSchemaDmt, name)
  }
}

// customSetters is for complex cases where we can't just set a value on a key property of the
// event object. These will be mostly array-style properties where the key is repeated.

function pieceCidSetter (event, value) {
  if (!event.pieces) {
    event.pieces = []
  }
  event.pieces.push({ pieceCid: value })
}

function pieceSizeSetter (event, value) {
  if (!Array.isArray(event.pieces) || event.pieces.length === 0) {
    throw new Error('Expected piece-cid before piece-size')
  }
  if (event.pieces[event.pieces.length - 1].pieceSize !== undefined) {
    throw new Error('Duplicate piece-size')
  }
  event.pieces[event.pieces.length - 1].pieceSize = value
}

const customSetters = {
  'sector-activated': {
    'piece-cid': pieceCidSetter,
    'piece-size': pieceSizeSetter
  },
  'sector-updated': {
    'piece-cid': pieceCidSetter,
    'piece-size': pieceSizeSetter
  }
}

// Collect extra information for sector-activated and sector-updated events.
// The process is the same for both except in getting the activation / update manifests from the
// message, so we use a callback to check and decode that. Once decoded, we can check the returns
// to see if they succeeded and then compile an "extra" for the event that has the sector pieces
// and their properties: { sector: [ { cid, size, verified, f05 } ]
async function sectorActivatedOrUpdated (event, lotusApi, decodeMsgCb) {
  if (event.event.unsealedCid == null) {
    // no data/pieces in here to inspect
    return
  }
  const tipset = (await lotusApi.chainGetTipSetByHeight(event.height + 1)).Cids

  // Get message so we can look at the params and find the execution return
  const msg = await lotusApi.chainGetMessage(event.msgCid)
  const decodedMsg = decodeMsgCb(msg)
  if (decodedMsg == null) {
    return
  }
  let [method, manifests] = decodedMsg

  // console.log('manifests', new TextDecoder().decode(jsonEncode(manifests)))

  // Execution return
  const msgLookup = await lotusApi.stateSearchMsg(tipset, event.msgCid, 2, true)
  if (msgLookup == null) {
    throw new Error(`No stateSearchMsg result for ${event.msgCid.toString()} (tipset ${await (new TipSetKey(...tipset).cid()).toString()})`)
  }
  if (typeof msgLookup.Receipt !== 'object') {
    throw new Error(`Unexpected stateSearchMsg result (${event.msgCid.toString()})`)
  }
  if (typeof msgLookup.Receipt.Return !== 'string') {
    throw new Error(`Unexpected stateSearchMsg receipt (${event.msgCid.toString()})`)
  }
  const returnEncoded = decodeCborInBase64(msgLookup.Receipt.Return)
  const returnValidator = miscValidators.BatchReturn
  if (!returnValidator) {
    throw new Error('No schema for BatchReturn')
  }
  const batchReturn = returnValidator.toTyped(returnEncoded) // tells us which activations failed
  if (batchReturn == null) {
    console.error(`Message ${event.msgCid} for ${event.type} doesn't have a valid BatchReturn: ${new TextDecoder().decode(jsonEncode(returnEncoded))}`)
    return
  }

  // Attach our own piece manifest to the event: { sectors: [ { sector, pieces [ { cid, size, verified, f05 } ] } ] }
  // find the manifest that has a sector that matches event.event.sector

  // Filter out failed manifests, just to be sure we're getting correct data
  if (batchReturn.failCodes.length > 0) {
    manifests = manifests.filter((manifest, i) => {
      for (const fail of batchReturn.failCodes) {
        if (fail.index === i) {
          // this sector activation failed, don't include it
          console.error(`Sector activation failed: ${manifest.sector} (${fail.code}) in message ${event.msgCid.toString()}`)
          return false
        }
      }
      return true
    })
  }

  // Filter out manifests that don't match the sector of the event, there should be strictly one
  manifests = manifests.filter((m) => m.sector === event.event.sector)
  if (manifests.length === 0) {
    console.dir(manifests, { depth: null })
    console.error(`No manifest found for sector ${event.event.sector} in message ${event.msgCid.toString()}`)
    return
  } else if (manifests.length > 1) {
    console.error(`Multiple manifests found for sector ${event.event.sector} in message ${event.msgCid.toString()}`)
    return
  }

  const pieces = manifests[0].pieces.map((p) => {
    // notifies f05? address will be a byte array with [0, 5]
    const f05 = p.notify.some((n) => n.address.length === 2 && n.address[0] === 0 && n.address[1] === 5)
    if (!f05 && p.notify.length > 0) {
      // as of nv22 this shouldn't be allowed and should have failed
      console.error(`Unexpected non-f05 data in sector ${manifests[0].sector} for ${event.msgCid.toString()}, notify: ${new TextDecoder().decode(jsonEncode(p.notify))}`)
    }
    return {
      cid: p.cid,
      size: p.size,
      verified: p.verifiedAllocationKey != null,
      f05
    }
  })
  return { method, pieces }
}

const stateCollectors = {
  'sector-activated': async (event, lotusApi) => {
    return sectorActivatedOrUpdated(event, lotusApi, function (msg) {
      if (msg.Method === 26) { // ProveCommitAggregate, no DDO in here
        return
      }
      if (msg.Method !== 34) {
        throw new Error(`Unexpected method on message for sector-activated source (${event.msgCid.toString()}): ${msg.Method}`)
      }
      // Params
      const paramsEncoded = decodeCborInBase64(msg.Params)
      const paramsValidator = miscValidators.ProveCommitSectors3Params
      if (!paramsValidator) {
        throw new Error('No schema for ProveCommitSectors3Params')
      }
      const params = paramsValidator.toTyped(paramsEncoded)
      if (params == null) {
        console.error(`Message ${event.msgCid} for sector-activated doesn't have ProveCommitSectors3Params: ${new TextDecoder().decode(jsonEncode(paramsEncoded))}`)
        return
      }
      return ['ProveCommitSectors3', params.sectorActivations]
    })
  },

  'sector-updated': async (event, lotusApi) => {
    return sectorActivatedOrUpdated(event, lotusApi, function (msg) {
      if (msg.Method !== 35) {
        throw new Error(`Unexpected method on message for sector-updated source (${event.msgCid.toString()}): ${msg.Method}`)
      }
      // Params
      const paramsEncoded = decodeCborInBase64(msg.Params)
      const paramsValidator = miscValidators.ProveReplicaUpdates3Params
      if (!paramsValidator) {
        throw new Error('No schema for ProveReplicaUpdates3Params')
      }
      const params = paramsValidator.toTyped(paramsEncoded)
      if (params == null) {
        console.error(`Message ${event.msgCid} for sector-updated doesn't have ProveReplicaUpdates3Params: ${new TextDecoder().decode(jsonEncode(paramsEncoded))}`)
        return
      }
      return ['ProveReplicaUpdates3', params.sectorUpdates]
    })
  }
}

export async function collectExtraState (event, lotusApi) {
  if (!stateCollectors[event.type]) {
    return
  }
  return await stateCollectors[event.type](event, lotusApi)
}

/**
 * Convert an array of raw entries to an event object and its type. Performs base64pad and CBOR
 * decoding on values and converts keys to camelCase.
 * This method expects builtin actor event types, so they should be CBOR encoded and have a "$type"
 *
 * @param {Object[]} entries - An array of entries
 * @returns {{type: string, event: Object}} - The event object and its type
 */
function entriesToEvent (entries) {
  if (!Array.isArray(entries)) {
    throw new Error('Expected entries to be an array')
  }
  if (entries.length === 0) {
    throw new Error('Expected at least one entry')
  }
  if (entries[0].Key !== '$type') {
    throw new Error('Expected $type as first entry')
  }
  const type = decodeCborInBase64(entries[0].Value)
  const event = {}
  for (const { Key, Value } of entries.slice(1)) {
    const value = decodeCborInBase64(Value)
    if (customSetters[type] && customSetters[type][Key]) {
      customSetters[type][Key](event, value)
      continue
    }
    const key = Key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (event[key] !== undefined) {
      throw new Error(`Unexpected duplicate key ${key} in event`)
    }
    event[key] = value
  }
  return { type, event }
}

/**
 * Transform an event object by leaving all properties as they are but replacing the "entries"
 * property with a new "event" property representing the form of event defined by its $type, plus a
 * "type" proprety with the value of the $type.
 *
 * We go from:
 *
 * {
 *  "emitter": "f06",
 *  "entries": [
 *    { "Flags": 3, "Key": "$type", "Codec": 81, "Value": "amFsbG9jYXRpb24=" },
 *    { "Flags": 3, "Key": "client", "Codec": 81, "Value": "GYlO" },
 *    { "Flags": 1, "Key": "expiration", "Codec": 81, "Value": "GgAW6pA=" },
 *    ...
 *  ],
 *  "height": 1470000,
 *  "msgCid": CID(bafy2bzaft..."),
 *  "reverted": false,
 *  "tipsetKey": [ CID(bafy2bzace..."), ... ]
 * }
 *
 * To:
 *
 * {
 *  "emitter": "f06",
 *  "event": {
 *    "client": 1234,
 *    "expiration": 1470000,
 *    ...
 *  },
 *  "height": 1470000,
 *  "msgCid": CID(bafy2bzaft..."),
 *  "reverted": false,
 *  "tipsetKey": [ CID(bafy2bzace..."), ... ],
 *  "type": "allocation",
 * }
 */
export function transform (eventData) {
  if (Object.keys(eventValidators).length === 0) {
    throw new Error('init() must be called before transform')
  }
  const { entries, ...rest } = eventData
  const { type, event } = entriesToEvent(entries)
  // eventValidators is indexed by TitleCase type from title-case original name with "Event" suffix
  const typeName = `${type.charAt(0).toUpperCase()}${type.substring(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Event`
  const validator = eventValidators[typeName]
  if (!validator) {
    throw new Error(`Unknown event type ${type}, no schema for ${typeName}`)
  }
  const typedEvent = validator.toTyped(event)
  if (typedEvent === undefined) {
    throw new Error(`Invalid event data format, ${type} event doesn't conform to ${typeName} schema`)
  }
  return { type, event: typedEvent, ...rest }
}

function decodeCborInBase64 (data) {
  return cborDecode(base64pad.baseDecode(data))
}
