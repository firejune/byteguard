import {
  ALG_AES_GCM,
  ALG_XOR,
  DEFAULT_KEY_PROVIDER,
  FLAG_GZIP,
  KEY_PROVIDER_MARKER,
  MAGIC,
  VERSION,
  VERSION_FLAGS
} from '../types'
import { byteguardInflate } from './inflate'

export type KeyMaterial = Uint8Array | ArrayBuffer

/**
 * A view onto a plain ArrayBuffer.
 *
 * WebCrypto will not take `Uint8Array<ArrayBufferLike>`, since that admits a
 * SharedArrayBuffer it cannot read. Everything here comes from `fetch` or
 * from `new Uint8Array(n)`, so the narrower type is the true one.
 */
type Bytes = Uint8Array<ArrayBuffer>

export interface LoadWorkerOptions extends WorkerOptions {
  /**
   * Global to read the key from. Defaults to the name the page's own loader
   * published, and to `'__byteguardKey'` when there is none.
   */
  keyProvider?: string
  /** Key bytes, used instead of the provider and of the file's own key. */
  key?: KeyMaterial | (() => KeyMaterial | Promise<KeyMaterial>) | Promise<KeyMaterial>
}

interface Container {
  algorithm: number
  flags: number
  /** The key carried by the file, if it carries one. */
  key: Bytes | null
  iv: Bytes | null
  payload: Bytes
}

/**
 * Fetch an encoded worker chunk, decode it, and start it.
 *
 * Runs in the page, so it reaches the same key the entry loader used — the
 * one the host set on the provider global — and needs no configuration when
 * the entry was built by the same plugin.
 *
 * Replaces the plain constructor one-for-one:
 *
 * ```js
 * // before
 * const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
 * // after
 * const worker = await loadWorker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
 * ```
 */
export async function loadWorker(
  url: string | URL,
  options: LoadWorkerOptions = {}
): Promise<Worker> {
  const { keyProvider, key, ...workerOptions } = options

  const response = await fetch(String(url))
  if (!response.ok) {
    throw new Error(
      `[byteguard] could not fetch worker ${String(url)}: ${response.status}`
    )
  }

  const bytes = new Uint8Array(await response.arrayBuffer()) as Bytes
  const container = parseContainer(bytes, String(url))
  const material = await resolveKey(container, key, keyProvider)
  const plain = await decrypt(container, material)
  const source = new TextDecoder().decode(
    container.flags & FLAG_GZIP ? await inflate(plain) : plain
  )

  const blobUrl = URL.createObjectURL(
    new Blob([source], { type: 'text/javascript' })
  )
  try {
    return new Worker(blobUrl, workerOptions)
  } finally {
    // The worker has already been handed the blob; holding the URL open only
    // leaks it.
    URL.revokeObjectURL(blobUrl)
  }
}

/**
 * Read the container header.
 *
 * Unlike the generated loader — which is built alongside one file and can
 * hard-code its offsets — this walks the header, because it is shipped code
 * that may meet either version.
 */
function parseContainer(bytes: Bytes, source: string): Container {
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new Error(`[byteguard] ${source} is not a ByteGuard container`)
    }
  }

  const version = bytes[4]
  const algorithm = bytes[5]
  let at = 6
  let flags = 0

  if (version === VERSION_FLAGS) {
    flags = bytes[at++]
  } else if (version !== VERSION) {
    throw new Error(
      `[byteguard] ${source} is format version ${version}; this build reads 1 and 2`
    )
  }

  const keyLen = bytes[at] | (bytes[at + 1] << 8)
  at += 2
  const key = keyLen > 0 ? bytes.subarray(at, at + keyLen) : null
  at += keyLen

  let iv: Bytes | null = null
  if (algorithm === ALG_AES_GCM) {
    const ivLen = bytes[at++]
    iv = bytes.subarray(at, at + ivLen)
    at += ivLen
  } else if (algorithm !== ALG_XOR) {
    throw new Error(`[byteguard] ${source} uses unknown algorithm ${algorithm}`)
  }

  return { algorithm, flags, key, iv, payload: bytes.subarray(at) }
}

/**
 * The key: what the caller passed, else what the file carries, else what the
 * page provides. A file that carries its own key is self-describing, so it
 * wins over a provider that may have been set for something else.
 */
async function resolveKey(
  container: Container,
  supplied: LoadWorkerOptions['key'],
  keyProvider?: string
): Promise<Bytes> {
  if (supplied) return toBytes(await (typeof supplied === 'function' ? supplied() : supplied))
  if (container.key) return container.key

  const globals = globalThis as unknown as Record<string, unknown>
  const name =
    keyProvider ??
    (typeof globals[KEY_PROVIDER_MARKER] === 'string'
      ? (globals[KEY_PROVIDER_MARKER] as string)
      : DEFAULT_KEY_PROVIDER)

  const provider = globals[name]
  const value = await (typeof provider === 'function'
    ? (provider as () => KeyMaterial | Promise<KeyMaterial>)()
    : provider)

  if (!value) {
    throw new Error(`[byteguard] no key: ${name} is not set on the page`)
  }

  const bytes = toBytes(value as KeyMaterial)
  if (bytes.length === 0) {
    throw new Error(`[byteguard] no key: ${name} yielded no bytes`)
  }
  return bytes
}

function toBytes(value: KeyMaterial): Bytes {
  return (
    value instanceof Uint8Array ? value : new Uint8Array(value)
  ) as Bytes
}

async function decrypt(container: Container, key: Bytes): Promise<Bytes> {
  const { payload } = container

  if (container.algorithm === ALG_XOR) {
    const out = new Uint8Array(payload.length) as Bytes
    for (let i = 0; i < payload.length; i++) {
      out[i] = payload[i] ^ key[i % key.length]
    }
    return out
  }

  const imported = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, [
    'decrypt'
  ])
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: container.iv as Bytes },
    imported,
    payload
  )
  return new Uint8Array(opened) as Bytes
}

/** `DecompressionStream` where the engine has it, the inlined decoder where not. */
async function inflate(bytes: Bytes): Promise<Bytes> {
  if (typeof DecompressionStream === 'undefined') {
    return byteguardInflate(bytes) as Bytes
  }

  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer()) as Bytes
}
