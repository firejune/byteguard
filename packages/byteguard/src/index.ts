export { encode } from './encoder'
export { generateLoader } from './decoder'
export { xorEncode } from './algorithms/xor'
export { aesEncode } from './algorithms/aes'
export {
  MAGIC,
  VERSION,
  ALG_XOR,
  ALG_AES_GCM,
  DEFAULT_KEY_PROVIDER,
  KEY_PROVIDER_MARKER
} from './types'
export type {
  Algorithm,
  ByteGuardOptions,
  KeySource,
  KeyFallback
} from './types'
export type { EncodeOptions } from './encoder'
export type { LoaderOptions } from './decoder'
