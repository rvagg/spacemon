import { join as pathJoin, basename } from 'node:path'
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
  /** @type {string[]} */
  #rawFiles
  /** @type {string[]} */
  #eventFiles
  /** @type {number} */
  #currentQuant
  /** @type {fs.FileHandle} */
  #currentRawFd
  #currentEventFd

  /**
   * Create a new Store instance.
   * @param {string} storePath - The path to the store directory, assumed to exist.
   */
  constructor (storePath, rawFiles, eventFiles) {
    this.#storePath = storePath
    this.#rawFiles = rawFiles
    this.#eventFiles = eventFiles
  }

  /**
   * @returns {Promise<number|null>} The latest epoch in the store, or null if there are no files.
   */
  async latestEpoch () {
    if (this.#rawFiles.length === 0) {
      return null
    }
    const findLatestEpoch = async (files) => {
      let lastFilePath = files[files.length - 1]
      // if lastFilePath is zero-bytes, it's truncated so look at the previous one
      const stat = await fs.stat(lastFilePath)
      if (stat.size === 0) {
        if (files.length < 2) {
          throw new Error('Unexpected empty file')
        }
        lastFilePath = files[files.length - 2]
      }
      const readStream = createReadStream(lastFilePath)
      let lastLine = null
      await pipeline(readStream, split2(), async function * (source) {
        for await (const line of source) {
          lastLine = line
        }
      })
      if (lastLine === null) {
        throw new Error('Unexpected empty file')
      }
      return JSON.parse(lastLine).height
    }
    const epochs = await Promise.all([findLatestEpoch(this.#rawFiles), findLatestEpoch(this.#eventFiles)])
    if (epochs[0] !== epochs[1]) {
      // TODO: this might not be a good idea if we are opening a store that's currently being used,
      // we might catch the files in an inconsistent state, and we also don't really care.
      throw new Error(`Latest raw and event file epochs do not match (${epochs[0]} vs ${epochs[1]})`)
    }
    return epochs[0]
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
    this.#rawFiles.push(rawFile(this.#storePath, fileName))
    this.#eventFiles.push(eventFile(this.#storePath, fileName))
    const fds = await Promise.all([
      fs.open(this.#rawFiles[this.#rawFiles.length - 1], 'a'),
      fs.open(this.#eventFiles[this.#eventFiles.length - 1], 'a')
    ])
    console.log('Switched to new save-set', fileName)
    this.#currentRawFd = fds[0]
    this.#currentEventFd = fds[1]
    this.#currentQuant = quant
  }

  /**
   * Lists all event files in the store and returns them as an array of objects with path and
   * last modified date (mtime).
   *
   * @returns {Promise<[{string, Date}]>}
   */
  async listEventFiles () {
    return this.#listFiles(this.#eventFiles)
  }

  /**
   * Lists all raw files in the store and returns them as an array of objects with path and
   * last modified date (mtime).
   *
   * @param {string[]} paths
   * @returns {Promise<[{string, Date}]>}
   */
  async #listFiles (paths) {
    return Promise.all(paths.map(async (path) => {
      const stat = await fs.stat(path)
      return { path, mtime: stat.mtime }
    }))
  }

  /**
   * Lists all compiled DDO files in the store and returns them as an array of objects with path and
   * a last modified date (mtime).
   * @returns {Promise<[{string, Date}]>}
   */
  async listCompiledDDOFiles () {
    const compiledDDOFiles = (await fs.readdir(compiledDDODir(this.#storePath))).sort().map((file) => compiledDDOFile(this.#storePath, file))
    return this.#listFiles(compiledDDOFiles)
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
 * @returns {Promise<Store>} config
 */
export async function createStore (config, pruneLast = false) {
  const storePath = pathJoin(config.storePath, config.network)
  await Promise.all([
    fs.mkdir(rawDir(storePath), { recursive: true }),
    fs.mkdir(eventDir(storePath), { recursive: true }),
    fs.mkdir(compiledDDODir(storePath), { recursive: true })
  ])

  const [rawFiles, eventFiles] = await Promise.all([
    (async () => (await fs.readdir(rawDir(storePath))).sort().map((file) => rawFile(storePath, file)))(),
    (async () => (await fs.readdir(eventDir(storePath))).sort().map((file) => eventFile(storePath, file)))()
  ])
  if (rawFiles.length !== eventFiles.length) {
    throw new Error('raw and event file counts do not match')
  }
  if (rawFiles.length > 0) {
    if (basename(rawFiles[rawFiles.length - 1]) !== basename(eventFiles[eventFiles.length - 1])) {
      throw new Error(`last raw and event filenames do not match (${rawFiles[rawFiles.length - 1]} vs ${eventFiles[eventFiles.length - 1]})`)
    }
    if (pruneLast) {
      // pruneLast is set if we want to re-fetch the latest set of data, so we delete the latest
      // which will trigger a re-fetch from the last epoch of the previous set. This is useful to
      // deal with a possible case of only having partial data for the latest epoch.
      console.log('Have existing event data, truncating latest set for re-fetch...')
      await Promise.all([
        fs.truncate(rawFiles[rawFiles.length - 1]),
        fs.truncate(eventFiles[eventFiles.length - 1])
      ])
    }
  }

  return new Store(storePath, rawFiles, eventFiles)
}

function rawDir (storePath) {
  return `${storePath}/raw`
}

function eventDir (storePath) {
  return `${storePath}/event`
}

function compiledDDODir (storePath) {
  return `${storePath}/compiled-ddo`
}

function rawFile (storePath, file) {
  return `${storePath}/raw/${file}${file.endsWith('.json') ? '' : '.json'}`
}

function eventFile (storePath, file) {
  return `${storePath}/event/${file}${file.endsWith('.json') ? '' : '.json'}`
}

export function compiledDDOFile (storePath, file) {
  return `${storePath}/compiled-ddo/${file}${file.endsWith('.json') ? '' : '.json'}`
}
