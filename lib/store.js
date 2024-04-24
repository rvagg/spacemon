import { join as pathJoin } from 'node:path'
import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import split2 from 'split2'

const epochQuant = 2880 // one day per file

/**
 * @typedef {Object} HeightObject
 * @property {number} height
 * @property {Object.<string, *>} [additionalProperties]
 */

/**
 * @typedef {Object} Store
 * @property {function(HeightObject): Promise<void>} save - The method to save an event.
 * @property {function(): Promise<void>} close - The method to close the store.
 */

/**
 * Store is a class that saves events to files.
 */
export class Store {
  /** @type {string} */
  #storePath
  /** @type {number} */
  #currentQuant
  /** @type {fs.FileHandle} */
  #currentRawFd
  #currentEventFd

  /**
   * Create a new Store instance.
   * @param {string} storePath - The path to the store directory, assumed to exist.
   */
  constructor (storePath) {
    this.#storePath = storePath
  }

  /**
   * Save an event to the store.
   * @param {HeightObject} event
   */
  async save (rawEvent, event) {
    const quant = Math.floor(event.height / epochQuant)
    if (quant !== this.#currentQuant) {
      await this.#switchFiles(quant)
    }
    return Promise.all([
      this.#currentRawFd.write(JSON.stringify(rawEvent) + '\n'),
      this.#currentEventFd.write(JSON.stringify(event) + '\n')
    ])
  }

  async #switchFiles (quant) {
    await this.close()
    const fileName = `${quant * epochQuant}-${(quant + 1) * epochQuant - 1}`
    const fds = await Promise.all([
      fs.open(rawFile(this.#storePath, fileName), 'a'),
      fs.open(eventFile(this.#storePath, fileName), 'a')
    ])
    console.log('Switched to new save-set', fileName)
    this.#currentRawFd = fds[0]
    this.#currentEventFd = fds[1]
    this.#currentQuant = quant
  }

  async close () {
    return Promise.all([
      (async () => {
        if (this.#currentRawFd) {
          return this.#currentRawFd.close()
        }
      })(),
      (async () => {
        if (this.#currentEventFd) {
          return this.#currentEventFd.close()
        }
      })()
    ])
  }
}

export async function openStore (config) {
  const storePath = pathJoin(config.storePath, config.network)
  // rawDir and eventDir should exist, stat them and throw if they are not directories
  if (!(await fs.stat(rawDir(storePath))).isDirectory()) {
    throw new Error(`raw path is not a directory: ${rawDir(storePath)}`)
  }
  if (!(await fs.stat(eventDir(storePath))).isDirectory()) {
    throw new Error(`event path is not a directory: ${eventDir(storePath)}`)
  }
}

/**
 * Create a new Store instance.
 * @returns {Promise<{store:Store, latestEpoch:number}>} config
 */
export async function createStore (config, pruneLast = false) {
  const storePath = pathJoin(config.storePath, config.network)
  await fs.mkdir(rawDir(storePath), { recursive: true })
  await fs.mkdir(eventDir(storePath), { recursive: true })

  const [rawFiles, eventFiles] = await Promise.all([
    (async () => (await fs.readdir(rawDir(storePath))).sort())(),
    (async () => (await fs.readdir(eventDir(storePath))).sort())()
  ])
  if (rawFiles.length !== eventFiles.length) {
    throw new Error('raw and event file counts do not match')
  }
  if (rawFiles.length > 0) {
    if (rawFiles[rawFiles.length - 1] !== eventFiles[eventFiles.length - 1]) {
      throw new Error(`last raw and event filenames do not match (${rawFiles[rawFiles.length - 1]} vs ${eventFiles[eventFiles.length - 1]})`)
    }
    if (pruneLast) {
      // pruneLast is set if we want to re-fetch the latest set of data, so we delete the latest
      // which will trigger a re-fetch from the last epoch of the previous set. This is useful to
      // deal with a possible case of only having partial data for the latest epoch.
      console.log('Have existing event data, deleting latest set for re-fetch...')
      await Promise.all([
        fs.unlink(rawFile(storePath, rawFiles.pop())),
        fs.unlink(eventFile(storePath, eventFiles.pop()))
      ])
    }
  }
  let latestEpoch = null
  if (rawFiles.length > 0) {
    const findLatestEpoch = async (fileFn, files) => {
      const lastFilePath = fileFn(storePath, files.pop())
      const readStream = createReadStream(lastFilePath)
      let latestEpoch = null
      await pipeline(readStream, split2(JSON.parse), async function * (source) {
        for await (const obj of source) {
          latestEpoch = obj.height
        }
      })
      return latestEpoch
    }
    const epochs = await Promise.all([findLatestEpoch(rawFile, rawFiles), findLatestEpoch(eventFile, eventFiles)])
    if (epochs[0] !== epochs[1]) {
      // TODO: this might not be a good idea if we are opening a store that's currently being used,
      // we might catch the files in an inconsistent state, and we also don't really care.
      throw new Error(`Latest raw and event file epochs do not match (${epochs[0]} vs ${epochs[1]})`)
    }
    latestEpoch = epochs[0]
  }

  const store = new Store(storePath)
  return { store, latestEpoch }
}

function rawDir (storePath) {
  return `${storePath}/raw`
}

function eventDir (storePath) {
  return `${storePath}/event`
}

function rawFile (storePath, file) {
  return `${storePath}/raw/${file}${file.endsWith('.json') ? '' : '.json'}`
}

function eventFile (storePath, file) {
  return `${storePath}/event/${file}${file.endsWith('.json') ? '' : '.json'}`
}
