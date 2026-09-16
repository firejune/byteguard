// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { encode } from '../src/encoder'
import { loadWorker } from '../src/runtime/worker'
import { KEY_PROVIDER_MARKER } from '../src/types'

const WORKER_SOURCE = `
self.onmessage = event => {
  const total = event.data.reduce((sum, n) => sum + n, 0)
  self.postMessage({ total, tag: "한글 🎴" })
}
`.repeat(20)

const XOR_KEY = new Uint8Array(Array.from({ length: 16 }, (_, i) => i * 3 + 1))
const AES_KEY = new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 5 + 2))

/** Every Worker the code under test constructed, with the source it was given. */
interface StartedWorker {
  url: string
  options: WorkerOptions | undefined
  source: string
}

let started: StartedWorker[] = []
let revoked: string[] = []
let served = new Map<string, Uint8Array>()

class FakeWorker {
  constructor(
    public url: string,
    public options?: WorkerOptions
  ) {
    started.push({ url, options, source: blobSources.get(url) ?? '' })
  }
  terminate(): void {}
}

const blobSources = new Map<string, string>()
const blobParts = new Map<Blob, string>()
let nextBlobId = 0

const RealURL = globalThis.URL
const RealBlob = globalThis.Blob

beforeEach(() => {
  started = []
  revoked = []
  served = new Map()
  blobSources.clear()
  blobParts.clear()

  vi.stubGlobal('Worker', FakeWorker)

  // happy-dom has no Worker and no blob-URL registry, so stand in for both:
  // record what each object URL was made from, so the test can read back the
  // exact source the worker would have run.
  vi.stubGlobal(
    'URL',
    class extends RealURL {
      static createObjectURL(blob: Blob): string {
        const url = `blob:byteguard/${nextBlobId++}`
        // Blob.text() is async; the source is needed synchronously inside the
        // Worker constructor, so pull it from the parts we were handed.
        blobSources.set(url, blobParts.get(blob) ?? '')
        return url
      }
      static revokeObjectURL(url: string): void {
        revoked.push(url)
      }
    }
  )

  vi.stubGlobal(
    'Blob',
    class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        blobParts.set(this, parts.map(part => String(part)).join(''))
      }
    }
  )

  vi.stubGlobal('fetch', async (url: string) => {
    const body = served.get(String(url))
    if (!body) return { ok: false, status: 404 }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).__byteguardKey
  delete (globalThis as Record<string, unknown>).appKey
  delete (globalThis as Record<string, unknown>)[KEY_PROVIDER_MARKER]
})

describe('loadWorker', () => {
  it('should decode a header-keyed worker and start it', async () => {
    serve('/assets/sim.worker.bin', encode(WORKER_SOURCE, 'xor', 16))

    const worker = await loadWorker('/assets/sim.worker.bin', { type: 'module' })

    expect(worker).toBeInstanceOf(FakeWorker)
    expect(started).toHaveLength(1)
    expect(started[0].source).toBe(WORKER_SOURCE)
    expect(started[0].options).toEqual({ type: 'module' })
  })

  it('should take the key from the page provider when the file has none', async () => {
    // What the native bridge does before anything else runs.
    ;(window as unknown as Record<string, unknown>).__byteguardKey = XOR_KEY
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'xor', 16, { keySource: 'native', key: XOR_KEY })
    )

    await loadWorker('/assets/sim.worker.bin', { type: 'module' })
    expect(started[0].source).toBe(WORKER_SOURCE)
  })

  it('should follow the provider name the entry loader published', async () => {
    ;(window as unknown as Record<string, unknown>).appKey = AES_KEY
    ;(window as unknown as Record<string, unknown>)[KEY_PROVIDER_MARKER] = 'appKey'
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'aes-gcm', 32, {
        keySource: 'native',
        key: AES_KEY
      })
    )

    await loadWorker('/assets/sim.worker.bin', { type: 'module' })
    expect(started[0].source).toBe(WORKER_SOURCE)
  })

  it('should accept a provider that is a function returning a promise', async () => {
    ;(window as unknown as Record<string, unknown>).__byteguardKey = () =>
      Promise.resolve(AES_KEY.buffer.slice(0))
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'aes-gcm', 32, {
        keySource: 'native',
        key: AES_KEY
      })
    )

    await loadWorker('/assets/sim.worker.bin')
    expect(started[0].source).toBe(WORKER_SOURCE)
  })

  it('should accept an explicit key over everything else', async () => {
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'aes-gcm', 32, {
        keySource: 'native',
        key: AES_KEY
      })
    )

    await loadWorker('/assets/sim.worker.bin', {
      type: 'module',
      key: AES_KEY
    })
    expect(started[0].source).toBe(WORKER_SOURCE)
    // The byteguard-only options must not reach the Worker constructor.
    expect(started[0].options).toEqual({ type: 'module' })
  })

  it('should inflate a gzipped worker', async () => {
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'aes-gcm', 32, { compress: 'gzip' })
    )

    await loadWorker('/assets/sim.worker.bin', { type: 'module' })
    expect(started[0].source).toBe(WORKER_SOURCE)
  })

  it('should inflate without DecompressionStream', async () => {
    vi.stubGlobal('DecompressionStream', undefined)
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'xor', 16, { compress: 'gzip' })
    )

    await loadWorker('/assets/sim.worker.bin', { type: 'module' })
    expect(started[0].source).toBe(WORKER_SOURCE)
  })

  it('should handle the full combination: native key, gzip, aes', async () => {
    ;(window as unknown as Record<string, unknown>).__byteguardKey = AES_KEY
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'aes-gcm', 32, {
        compress: 'gzip',
        keySource: 'native',
        key: AES_KEY
      })
    )

    await loadWorker('/assets/sim.worker.bin', { type: 'module' })
    expect(started[0].source).toBe(WORKER_SOURCE)
  })

  it('should accept a URL object', async () => {
    serve('https://app.local/assets/sim.worker.bin', encode(WORKER_SOURCE, 'xor', 16))

    await loadWorker(new URL('https://app.local/assets/sim.worker.bin'))
    expect(started[0].source).toBe(WORKER_SOURCE)
  })

  it('should release the object URL once the worker holds it', async () => {
    serve('/assets/sim.worker.bin', encode(WORKER_SOURCE, 'xor', 16))

    await loadWorker('/assets/sim.worker.bin')
    expect(revoked).toEqual([started[0].url])
  })

  it('should throw when the file is missing', async () => {
    await expect(loadWorker('/assets/nope.bin')).rejects.toThrow(/404/)
  })

  it('should throw when there is no key anywhere', async () => {
    serve(
      '/assets/sim.worker.bin',
      encode(WORKER_SOURCE, 'xor', 16, { keySource: 'native', key: XOR_KEY })
    )

    await expect(loadWorker('/assets/sim.worker.bin')).rejects.toThrow(
      /no key: __byteguardKey/
    )
    expect(started).toHaveLength(0)
  })

  it('should throw on a file that is not a container', async () => {
    serve('/assets/sim.worker.bin', new TextEncoder().encode('just some js'))

    await expect(loadWorker('/assets/sim.worker.bin')).rejects.toThrow(
      /not a ByteGuard container/
    )
  })

  it('should throw on a format version it does not know', async () => {
    const bin = encode(WORKER_SOURCE, 'xor', 16)
    bin[4] = 0x09

    serve('/assets/sim.worker.bin', bin)
    await expect(loadWorker('/assets/sim.worker.bin')).rejects.toThrow(
      /format version 9/
    )
  })

  it('should throw on a tampered AES payload rather than run it', async () => {
    const bin = encode(WORKER_SOURCE, 'aes-gcm', 32)
    bin[bin.length - 1] ^= 0xff

    serve('/assets/sim.worker.bin', bin)
    await expect(loadWorker('/assets/sim.worker.bin')).rejects.toThrow()
    expect(started).toHaveLength(0)
  })
})

function serve(url: string, bytes: Uint8Array): void {
  served.set(url, bytes)
}
