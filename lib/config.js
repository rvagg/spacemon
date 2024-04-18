import { readFile } from 'node:fs/promises'
import { fromDSL } from '@ipld/schema/from-dsl.js'
import { create } from '@ipld/schema/typed.js'
import { decode } from '@ipld/dag-json'

// The shape of the config file, in IPLD Schema Language, but parsed from JSON
const configSchemaDsl = `
type NetworkType enum {
  | mainnet
  | testnet
  | calibnet
}
type Config struct {
  network NetworkType
  lotusWebsocketRpc String
  lotusHttpRpc String
  storePath String
  apiCachePath String
}
`
const schemaDmt = fromDSL(configSchemaDsl)
const schemaTyped = create(schemaDmt, 'Config')

function parseConfig (data) {
  const typedData = schemaTyped.toTyped(data)
  if (typedData === undefined) {
    throw new TypeError(`Invalid config data format, must conform to schema:\n${configSchemaDsl}`)
  }
  return typedData
}

export async function loadConfig (path) {
  const data = await readFile(path)
  const config = decode(data)
  return parseConfig(config)
}
