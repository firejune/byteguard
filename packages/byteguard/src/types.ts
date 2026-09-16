export type Algorithm = 'xor' | 'aes-gcm'

/** Where the loader gets the decryption key. */
export type KeySource = 'header' | 'native'

/** What the loader does when a `native` key provider yields nothing. */
export type KeyFallback = 'none' | 'header'

/** Payload compression, applied before encryption. */
export type Compression = 'none' | 'gzip'

/**
 * Which inflate the loader uses.
 *
 * - `'auto'` — `DecompressionStream('gzip')` when the engine has it, the
 *   inlined decoder otherwise. The only value with a fallback.
 * - `'native'` — `DecompressionStream` only; smallest loader, and it fails
 *   outright on engines without it (Safari before 16.4).
 * - `'inline'` — the inlined decoder always. `'fflate'` is accepted as an
 *   alias for the same thing; the implementation is byteguard's own.
 */
export type InflateMode = 'auto' | 'native' | 'inline' | 'fflate'

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
  /**
   * Compress the payload before encrypting it. Default: 'none'.
   *
   * The order is fixed — obfuscate, gzip, encrypt — because ciphertext does
   * not compress. A compressed payload sets a flag byte the v1 layout has no
   * room for, so these files are written as version 2.
   */
  compress?: Compression
  /** Which inflate the loader uses. Default: 'auto' */
  inflate?: InflateMode
  /**
   * Also encode worker bundles. Default: false.
   *
   * - `true` — every emitted `.js` asset, which is how the bundler hands
   *   over a worker build.
   * - `string[]` — glob patterns, matched against emitted `.js` assets and
   *   non-entry chunks.
   *
   * An encoded worker is no longer loadable by `new Worker(url)`; the page
   * has to start it with `loadWorker` from `byteguard/runtime`.
   */
  workers?: boolean | string[]
}

/** Binary format magic bytes: "BGRD" */
export const MAGIC = new Uint8Array([0x42, 0x47, 0x52, 0x44])
export const VERSION = 0x01
/** Layout with a flags byte, written only when a flag is set. */
export const VERSION_FLAGS = 0x02
export const ALG_XOR = 0x01
export const ALG_AES_GCM = 0x02

/** Version 2 flags: bit 0 — the payload is gzipped. */
export const FLAG_GZIP = 0x01

/** Default global the generated loader reads a `native` key from. */
export const DEFAULT_KEY_PROVIDER = '__byteguardKey'

/**
 * Global the generated loader publishes its provider name on, so a runtime
 * helper such as `loadWorker` reaches the same key with no configuration.
 */
export const KEY_PROVIDER_MARKER = '__byteguardKeyProvider'
