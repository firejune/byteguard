export { encode } from './encoder'
export { generateLoader } from './decoder'
export { xorEncode } from './algorithms/xor'
export { aesEncode } from './algorithms/aes'
export { byteguardInflate, INFLATE_SOURCE } from './runtime/inflate'
// Also reachable as `byteguard/runtime`, which is the import app code should
// use: this entry pulls in node:crypto and node:zlib for the encoder.
export { loadWorker } from './runtime/worker'
export type { LoadWorkerOptions, KeyMaterial } from './runtime/worker'
export {
  MAGIC,
  VERSION,
  VERSION_FLAGS,
  FLAG_GZIP,
  ALG_XOR,
  ALG_AES_GCM,
  DEFAULT_KEY_PROVIDER,
  KEY_PROVIDER_MARKER
} from './types'
export type {
  Algorithm,
  ByteGuardOptions,
  KeySource,
  KeyFallback,
  Compression,
  InflateMode
} from './types'
export type { EncodeOptions } from './encoder'
export type { LoaderOptions } from './decoder'
