import { join as pathJoin, basename } from 'node:path'
import { open, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import split2 from 'split2'
import { compiledDDOFile } from './store.js'

const ddoEventRegexp = /^\{"type":"sector-(activated|updated)",.+,"reverted":false,.+"extra":/

export async function compileDDOData (store, storePath, epoch0Time) {
  const eventFiles = await store.listEventFiles()
  const compiledDDOFiles = await store.listCompiledDDOFiles()
  console.log('Found', eventFiles.length, 'event files')
  console.log('Found', compiledDDOFiles.length, 'compiled DDO files')

  let modified = false
  for (let i = 0; i < eventFiles.length; i++) {
    const eventFile = eventFiles[i]
    if (compiledDDOFiles.length > i) {
      if (basename(compiledDDOFiles[i].path) !== basename(eventFile.path)) {
        throw new Error(`Event file and compiled DDO file mismatch: ${eventFile.path} vs ${compiledDDOFiles[i].path}`)
      }
      // if events is older than ddo, skip
      if (eventFile.mtime <= compiledDDOFiles[i].mtime) {
        console.log('Skipping', eventFile.path, '...')
        continue
      }
    }
    compiledDDOFiles[i] = { path: compiledDDOFile(storePath, basename(eventFile.path)), mtime: new Date() }
    console.log('Compiling', eventFile.path, 'to', compiledDDOFiles[i].path)
    const compiled = await compileEventFile(epoch0Time, eventFile.path)
    if (compiled.length === 0) {
      compiledDDOFiles.splice(i, 1)
      console.log(`No events to compile in ${eventFile.path}, skipping ...`)
      continue
    }
    const out = '[\n' + compiled.map((e, i) => JSON.stringify(e) + (i < compiled.length - 1 ? ',' : '')).join('\n') + '\n]\n'
    await writeFile(compiledDDOFiles[i].path, out)
    modified = true
  }
  if (!modified) {
    console.log('No new events to compile')
    return
  }

  // read all compiledDDOFiles and merge them into one file, stripping off leading [ and trailing ] from source and replacing them in one file
  const mergedPath = pathJoin(storePath, 'compiled-ddo.json')
  const outFd = await open(mergedPath, 'w')
  await outFd.write('[')
  let first = true
  for (const file of compiledDDOFiles) {
    await pipeline(
      createReadStream(file.path),
      split2(),
      async function * (source) {
        for await (let line of source) {
          if (line === '[' || line === ']') {
            continue
          }
          line = line.replace(/,$/, '')
          await outFd.write(`${first ? '' : ','}\n${line}`)
          first = false
        }
      }
    )
  }
  await outFd.write('\n]')
  await outFd.close()
}

async function compileEventFile (epoch0Time, eventFile) {
  const compiled = []
  await pipeline(
    createReadStream(eventFile),
    split2(),
    async function * (source) {
      for await (const line of source) {
        if (ddoEventRegexp.test(line)) {
          const event = JSON.parse(line)
          compiled.push({
            time: new Date(epoch0Time.getTime() + event.height * 30 * 1000),
            epoch: event.height,
            msg: event.msgCid,
            provider: event.emitter,
            sector: event.event.sector,
            ...event.extra
          })
        }
      }
    }
  )
  return compiled
}
