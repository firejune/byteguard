export { encode } from './encoder'
export { generateLoader } from './decoder'
export { xorEncode } from './algorithms/xor'
export { aesEncode } from './algorithms/aes'
export { byteguardInflate, INFLATE_SOURCE } from './runtime/inflate'
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
