import { gzipSync } from 'node:zlib'
import { MAGIC, VERSION, VERSION_FLAGS, FLAG_GZIP, ALG_XOR, ALG_AES_GCM } from './types'
import type { Algorithm, Compression, KeyFallback, KeySource } from './types'
import { xorEncode } from './algorithms/xor'
import { aesEncode } from './algorithms/aes'

const EMPTY_KEY = new Uint8Array(0)

export interface EncodeOptions {
  /** Where the loader will get the key. Default: 'header' */
  keySource?: KeySource
  /** What the loader does when a `native` provider yields nothing. Default: 'none' */
  fallback?: KeyFallback
  /** Key bytes to encrypt with. Required when `keySource` is 'native'. */
  key?: Uint8Array | (() => Uint8Array)
  /** Compress the payload before encrypting it. Default: 'none' */
  compress?: Compression
}

/**
 * Encode a JS string into ByteGuard binary format.
 *
 * Version 1 (unflagged payload — what every release before 0.5 wrote):
 *   [Magic 4B] [Version 1B] [Algorithm 1B] [KeyLen 2B LE] [Key NB]
 *   [AES-GCM only: IVLen 1B] [IV MB]
 *   [Payload]
 *
 * Version 2 (a flag is set — today, only `compress: 'gzip'`):
 *   [Magic 4B] [Version 1B] [Algorithm 1B] [Flags 1B] [KeyLen 2B LE] [Key NB]
 *   [AES-GCM only: IVLen 1B] [IV MB]
 *   [Payload]
 *
 * `KeyLen` is 0 when the key is not in the file (`keySource: 'native'` with
 * no header fallback). Every field is length-prefixed and the algorithm byte
 * says whether an IV section follows, so an absent key shortens the header
 * without making it ambiguous — that alone never bumps the version. The
 * flags byte does, because it is the one field a v1 reader cannot skip.
 *
 * Order is obfuscate (the caller's job), then gzip, then encrypt: ciphertext
 * does not compress.
 */
export function encode(
  js: string,
  algorithm: Algorithm = 'xor',
  keySize: number = 32,
  options: EncodeOptions = {}
): Uint8Array {
  const { keySource = 'header', fallback = 'none', compress = 'none' } = options
  const text = new TextEncoder().encode(js)
  const gzipped = compress === 'gzip'
  const data = gzipped ? new Uint8Array(gzipSync(text)) : text
  const flags = gzipped ? FLAG_GZIP : 0
  const suppliedKey = resolveKey(options.key)

  if (keySource === 'native' && !suppliedKey) {
    throw new Error(
      "[byteguard] keySource 'native' needs a key: pass `key` with the same " +
        'bytes the runtime provider will return, otherwise nothing can ever ' +
        'decrypt this file.'
    )
  }
  if (suppliedKey && suppliedKey.length === 0) {
    throw new Error('[byteguard] key must not be empty')
  }

  if (algorithm === 'xor') {
    const { encoded, key } = xorEncode(data, keySize, suppliedKey)
    return packBinary(ALG_XOR, headerKey(key, keySource, fallback), encoded, flags)
  } else {
    const { encoded, key, iv } = aesEncode(data, keySize, suppliedKey)
    return packBinary(
      ALG_AES_GCM,
      headerKey(key, keySource, fallback),
      encoded,
      flags,
      iv
    )
  }
}

function resolveKey(
  key: Uint8Array | (() => Uint8Array) | undefined
): Uint8Array | undefined {
  return typeof key === 'function' ? key() : key
}

/** The key as it goes into the file — omitted entirely in native mode. */
function headerKey(
  key: Uint8Array,
  keySource: KeySource,
  fallback: KeyFallback
): Uint8Array {
  if (keySource === 'native' && fallback === 'none') return EMPTY_KEY
  return key
}

function packBinary(
  algorithm: number,
  key: Uint8Array,
  payload: Uint8Array,
  flags: number,
  iv?: Uint8Array
): Uint8Array {
  const ivSection = iv ? 1 + iv.length : 0
  const flagSection = flags ? 1 : 0
  const headerSize =
    MAGIC.length + 1 + 1 + flagSection + 2 + key.length + ivSection
  const result = new Uint8Array(headerSize + payload.length)
  let offset = 0

  // Magic "BGRD"
  result.set(MAGIC, offset)
  offset += MAGIC.length

  // Version — bumped only when the header grows a field older readers would
  // mistake for the start of the key length.
  result[offset++] = flags ? VERSION_FLAGS : VERSION

  // Algorithm ID
  result[offset++] = algorithm

  // Flags (version 2 only)
  if (flags) result[offset++] = flags

  // Key length (uint16 LE) — 0 when the key is not in the file
  result[offset++] = key.length & 0xff
  result[offset++] = (key.length >> 8) & 0xff

  // Key
  result.set(key, offset)
  offset += key.length

  // IV (AES-GCM only). Not secret: it stays in the header in every key mode.
  if (iv) {
    result[offset++] = iv.length
    result.set(iv, offset)
    offset += iv.length
  }

  // Payload
  result.set(payload, offset)

  return result
}
