import { decode as cborDecode } from '@ipld/dag-cbor'
import { base64pad } from 'multiformats/bases/base64'
import { readFile } from 'node:fs/promises'
import { fromDSL } from '@ipld/schema/from-dsl.js'
import { create } from '@ipld/schema/typed.js'

const validators = {}

export async function init () {
  if (Object.keys(validators).length > 0) {
    return
  }
  const schemaPath = new URL('../builtin-actor-events-schemas.ipldsch', import.meta.url)
  const schemaDsl = await readFile(schemaPath, 'utf8')
  const schemaDmt = fromDSL(schemaDsl)
  for (const [name, type] of Object.entries(schemaDmt.types)) {
    if (name.endsWith('Event')) {
      validators[name] = create(schemaDmt, name)
    }
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
  const type = cborDecode(base64pad.baseDecode(entries[0].Value))
  const event = {}
  for (const { Key, Value } of entries.slice(1)) {
    const value = cborDecode(base64pad.baseDecode(Value))
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
  if (Object.keys(validators).length === 0) {
    throw new Error('init() must be called before transform')
  }
  const { entries, ...rest } = eventData
  const { type, event } = entriesToEvent(entries)
  // validators is indexed by TitleCase type from title-case original name with "Event" suffix
  const typeName = `${type.charAt(0).toUpperCase()}${type.substring(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Event`
  const validator = validators[typeName]
  if (!validator) {
    throw new Error(`Unknown event type ${type}, no schema for ${typeName}`)
  }
  const typedEvent = validator.toTyped(event)
  if (typedEvent === undefined) {
    throw new Error(`Invalid event data format, ${type} event doesn't conform to ${typeName} schema`)
  }
  return { type: typedEvent, event, ...rest }
}