export type Algorithm = 'xor' | 'aes-gcm'

/** Where the loader gets the decryption key. */
export type KeySource = 'header' | 'native'

/** What the loader does when a `native` key provider yields nothing. */
export type KeyFallback = 'none' | 'header'

export interface ByteGuardOptions {
  /** Encoding algorithm. Default: 'xor' */
  algorithm?: Algorithm
  /** Encryption key size in bytes. Default: 32 */
  keySize?: number
  /** Glob patterns to exclude from encoding */
  exclude?: string[]
  /** Encoded file extension. Default: 'bin' */
  extension?: string
  /**
   * Where the key lives. Default: 'header'.
   *
   * - `'header'` — in the file, as every release before 0.5 wrote it.
   * - `'native'` — not in the file. The loader reads it at runtime from the
   *   global named by `keyProvider`, which the host page defines before the
   *   loader runs (a native bridge, typically). Requires `key`.
   */
  keySource?: KeySource
  /** Global the loader reads the key from. Default: '__byteguardKey' */
  keyProvider?: string
  /**
   * With `keySource: 'native'`, what to do when the provider yields nothing.
   * Default: 'none' — fail loudly, fetch nothing, run nothing. `'header'`
   * also writes the key into the file and uses it only when the provider is
   * absent; a debug-build setting, since it puts the key back on disk.
   */
  fallback?: KeyFallback
  /**
   * The key to encrypt with, for `keySource: 'native'` — the same bytes the
   * runtime provider will return. Also accepted with `'header'`, where it
   * makes the build reproducible instead of randomly keyed.
   */
  key?: Uint8Array | (() => Uint8Array)
}

/** Binary format magic bytes: "BGRD" */
export const MAGIC = new Uint8Array([0x42, 0x47, 0x52, 0x44])
export const VERSION = 0x01
export const ALG_XOR = 0x01
export const ALG_AES_GCM = 0x02

/** Default global the generated loader reads a `native` key from. */
export const DEFAULT_KEY_PROVIDER = '__byteguardKey'

/**
 * Global the generated loader publishes its provider name on, so a runtime
 * helper such as `loadWorker` reaches the same key with no configuration.
 */
export const KEY_PROVIDER_MARKER = '__byteguardKeyProvider'
