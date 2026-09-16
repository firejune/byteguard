import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import type { OutputAsset, OutputChunk, RollupOutput } from 'rollup'
import byteguard from '../src/index'

/**
 * These run a real Vite build over a fixture app with a worker, and judge the
 * result by what is in the emitted files — not by what the config asked for.
 * The plugin's whole job happens in `generateBundle`, where a worker is an
 * asset rather than a chunk; nothing short of a build proves it was caught.
 */

const ENTRY_MARKER = 'ENTRY_PLAINTEXT_MARKER_9f2a'
const WORKER_MARKER = 'WORKER_PLAINTEXT_MARKER_7c31'

let root = ''

beforeAll(() => {
  // realpath: on macOS the temp dir is behind a symlink, and Vite resolves
  // the html input against the real path.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'byteguard-build-')))
  mkdirSync(join(root, 'src'))

  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>'
  )
  writeFileSync(
    join(root, 'src', 'sim.worker.js'),
    `const MARKER = '${WORKER_MARKER}'\n` +
      'self.onmessage = event => { self.postMessage({ echo: event.data, MARKER }) }\n'
  )
  writeFileSync(
    join(root, 'src', 'main.js'),
    `const MARKER = '${ENTRY_MARKER}'\n` +
      "const worker = new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' })\n" +
      'worker.postMessage([1, 2, 3])\n' +
      'console.log(MARKER)\n'
  )
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('vite build', () => {
  it('should leave workers alone by default', async () => {
    const out = await run({})

    expect(names(out, '.bin')).toEqual(['assets/index.bin'])
    expect(worker(out, '.js').fileName).toMatch(/^assets\/sim\.worker.*\.js$/)
    expect(text(worker(out, '.js'))).toContain(WORKER_MARKER)
  })

  it('should encode the worker when asked', async () => {
    const out = await run({ workers: true })

    expect(names(out, '.js')).toEqual([])
    expect(names(out, '.bin')).toHaveLength(2)
    expect(worker(out, '.bin').fileName).toMatch(/^assets\/sim\.worker.*\.bin$/)
  })

  it('should leave no plaintext in the encoded worker', async () => {
    const out = await run({ workers: true })
    const encoded = bytes(worker(out, '.bin'))

    // The point of the feature, checked on the bytes that ship.
    expect(encoded.includes(Buffer.from(WORKER_MARKER))).toBe(false)
    expect(encoded.includes(Buffer.from('self.onmessage'))).toBe(false)
    expect(encoded.subarray(0, 4)).toEqual(Buffer.from([0x42, 0x47, 0x52, 0x44]))
  })

  it('should point the entry at the encoded worker', async () => {
    const out = await run({ workers: true, algorithm: 'xor', keySize: 16 })
    const workerName = worker(out, '.bin').fileName

    // The entry is encoded too, so read it the way the loader would.
    const decoded = decodeXor(bytes(find(out, 'assets/index.bin')))
    expect(decoded).toContain(workerName)
    expect(decoded).not.toContain(workerName.replace(/\.bin$/, '.js'))
    expect(decoded).toContain(ENTRY_MARKER)
  })

  it('should follow glob patterns', async () => {
    const out = await run({ workers: ['**/*.worker-*.js'] })
    expect(names(out, '.bin')).toHaveLength(2)
    expect(names(out, '.js')).toEqual([])
  })

  it('should not encode a worker a glob does not name', async () => {
    const out = await run({ workers: ['**/nothing-*.js'] })
    expect(worker(out, '.js')).toBeTruthy()
    expect(names(out, '.bin')).toEqual(['assets/index.bin'])
  })

  it('should honour exclude over workers', async () => {
    const out = await run({ workers: true, exclude: ['**/sim.worker*.js'] })
    expect(worker(out, '.js')).toBeTruthy()
    expect(names(out, '.bin')).toEqual(['assets/index.bin'])
  })

  it('should change the encoded bytes when the worker source changes', async () => {
    // Guards against "the file is named .bin but nothing was encoded".
    const first = await run({ workers: true, algorithm: 'xor', keySize: 16 })
    writeFileSync(
      join(root, 'src', 'sim.worker.js'),
      `const MARKER = '${WORKER_MARKER}'\nself.onmessage = () => { self.postMessage('changed') }\n`
    )
    const second = await run({ workers: true, algorithm: 'xor', keySize: 16 })

    const a = decodeXor(bytes(worker(first, '.bin')))
    const b = decodeXor(bytes(worker(second, '.bin')))
    expect(a).not.toBe(b)
    expect(b).toContain('changed')
  })

  it('should carry the new options into the emitted files', async () => {
    const key = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1))
    const out = await run({
      workers: true,
      algorithm: 'aes-gcm',
      keySource: 'native',
      key,
      compress: 'gzip'
    })

    for (const item of [find(out, 'assets/index.bin'), worker(out, '.bin')]) {
      const file = bytes(item)
      expect(file[4]).toBe(0x02) // version 2: a flag is set
      expect(file[5]).toBe(0x02) // aes-gcm
      expect(file[6]).toBe(0x01) // gzip
      expect(file[7] | (file[8] << 8)).toBe(0) // no key in the file
      expect(file.includes(Buffer.from(key))).toBe(false)
    }

    const html = text(find(out, 'index.html'))
    expect(html).toContain('globalThis["__byteguardKey"]')
    expect(html).toContain('DecompressionStream')
    expect(html).toContain('assets/index.bin')
    expect(html).not.toContain('<script type="module" crossorigin src=')
  })

  it('should still emit the 0.4.1 shape for a 0.4.1 config', async () => {
    const out = await run({ algorithm: 'xor' })
    const entry = bytes(find(out, 'assets/index.bin'))

    expect(entry[4]).toBe(0x01) // version 1
    expect(entry[5]).toBe(0x01) // xor
    expect(entry[6] | (entry[7] << 8)).toBe(32) // key in the header

    const html = text(find(out, 'index.html'))
    expect(html).toContain('const kl=b[6]|b[7]<<8')
    expect(html).not.toContain('globalThis[')
    expect(html).not.toContain('DecompressionStream')
  })
})

async function run(options: Parameters<typeof byteguard>[0]): Promise<RollupOutput> {
  const result = await build({
    root,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]'
        }
      }
    },
    worker: { rollupOptions: { output: { assetFileNames: 'assets/[name].[ext]' } } },
    plugins: [byteguard(options)]
  })

  return (Array.isArray(result) ? result[0] : result) as RollupOutput
}

function find(out: RollupOutput, fileName: string): OutputChunk | OutputAsset {
  const item = out.output.find(entry => entry.fileName === fileName)
  if (!item) {
    throw new Error(
      `${fileName} not emitted; got: ${out.output.map(o => o.fileName).join(', ')}`
    )
  }
  return item
}

/** The single worker file with the given extension, whatever its hash. */
function worker(out: RollupOutput, extension: string): OutputChunk | OutputAsset {
  const found = out.output.filter(
    item => item.fileName.includes('sim.worker') && item.fileName.endsWith(extension)
  )
  if (found.length !== 1) {
    throw new Error(
      `expected one sim.worker${extension}; got: ${out.output.map(o => o.fileName).join(', ')}`
    )
  }
  return found[0]
}

function names(out: RollupOutput, extension: string): string[] {
  return out.output
    .map(item => item.fileName)
    .filter(fileName => fileName.endsWith(extension))
}

function bytes(item: OutputChunk | OutputAsset | OutputAsset['source']): Buffer {
  const source =
    typeof item === 'object' && item !== null && 'fileName' in item
      ? item.type === 'chunk'
        ? item.code
        : item.source
      : item
  return typeof source === 'string' ? Buffer.from(source) : Buffer.from(source as Uint8Array)
}

function text(item: OutputChunk | OutputAsset): string {
  return bytes(item).toString('utf-8')
}

/** Decode a header-keyed XOR container, the way the generated loader does. */
function decodeXor(bin: Buffer): string {
  const keyLen = bin[6] | (bin[7] << 8)
  const key = bin.subarray(8, 8 + keyLen)
  const payload = bin.subarray(8 + keyLen)
  const out = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % keyLen]
  return out.toString('utf-8')
}
