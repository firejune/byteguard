import { DEFAULT_KEY_PROVIDER, KEY_PROVIDER_MARKER } from './types'
import type {
  Algorithm,
  Compression,
  InflateMode,
  KeyFallback,
  KeySource
} from './types'
import { INFLATE_SOURCE } from './runtime/inflate'

export interface LoaderOptions {
  /** Where the loader gets the key. Default: 'header' */
  keySource?: KeySource
  /** Global holding the key, for `keySource: 'native'`. Default: '__byteguardKey' */
  keyProvider?: string
  /** What to do when the provider yields nothing. Default: 'none' */
  fallback?: KeyFallback
  /** Whether the payload is gzipped — must match the encode. Default: 'none' */
  compress?: Compression
  /** Which inflate to use. Default: 'auto' */
  inflate?: InflateMode
}

/** Offset of the flags byte, in a version 2 container. */
const FLAGS_OFFSET = 6

/**
 * Generate minimal inline loader script for the browser.
 * The loader fetches the .bin file, decodes it, and executes via V8.
 *
 * The output is dependency-free and safe to run at document start: it reads
 * nothing but the fetched bytes and, in `native` key mode, one global the
 * host page defines before this script.
 *
 * With default options this emits exactly the 0.4.1 loader, byte for byte —
 * pinned by `test/format-fixture.test.ts`.
 */
export function generateLoader(
  binPath: string,
  algorithm: Algorithm,
  isModule: boolean,
  options: LoaderOptions = {}
): string {
  const {
    keySource = 'header',
    keyProvider = DEFAULT_KEY_PROVIDER,
    fallback = 'none',
    compress = 'none',
    inflate = 'auto'
  } = options

  // A gzipped payload is written as version 2, whose flags byte pushes every
  // field after it along by one.
  const layout: Layout = compress === 'gzip' ? V2 : V1

  const decode =
    algorithm === 'xor'
      ? xorDecodeSnippet(layout, keySource, keyProvider, fallback, compress, inflate)
      : aesDecodeSnippet(layout, keySource, keyProvider, fallback, compress, inflate)

  const execute = isModule
    ? `const u=URL.createObjectURL(new Blob([t],{type:'text/javascript'}));const s=document.createElement('script');s.type='module';s.src=u;s.onload=()=>URL.revokeObjectURL(u);document.head.appendChild(s)`
    : `(new Function(t))()`

  return `(async()=>{const r=await fetch('${binPath}');const b=new Uint8Array(await r.arrayBuffer());${decode}${execute}})()`
}

interface Layout {
  /** Offset of the 2-byte key length field. */
  keyLen: number
  /** Offset of the key section, and of the IV length that follows it. */
  key: number
}

const V1: Layout = { keyLen: 6, key: 8 }
const V2: Layout = { keyLen: 7, key: 9 }

/** `const kl=…` — the key length, wherever the key itself ends up living. */
function keyLenSnippet(layout: Layout): string {
  return `const kl=b[${layout.keyLen}]|b[${layout.keyLen + 1}]<<8`
}

/**
 * `k` — the key, from the header or from the page's provider.
 *
 * In native mode the loader also publishes the provider's name, so runtime
 * helpers (`loadWorker`) reach the same key without being configured twice.
 */
function keySnippet(
  layout: Layout,
  keySource: KeySource,
  keyProvider: string,
  fallback: KeyFallback
): string {
  const headerSlice = `b.slice(${layout.key},${layout.key}+kl)`
  if (keySource === 'header') return `const k=${headerSlice}`

  const global = `globalThis[${JSON.stringify(keyProvider)}]`
  const missing =
    fallback === 'header'
      ? `k=${headerSlice}`
      : `throw new Error('[byteguard] no key: ${keyProvider} is not set on the page')`

  return [
    `globalThis[${JSON.stringify(KEY_PROVIDER_MARKER)}]=${JSON.stringify(keyProvider)}`,
    `let k=${global}`,
    `if(typeof k==='function')k=k()`,
    `k=await k`,
    `if(k)k=k instanceof Uint8Array?k:new Uint8Array(k)`,
    `if(!k||!k.length)${missing}`
  ].join(';')
}

/**
 * `Z` — inflate, defined only for a gzipped payload.
 *
 * `'auto'` carries both paths: `DecompressionStream` where the engine has it,
 * and the inlined decoder where it does not (Safari below 16.4, which is
 * exactly the fleet this option exists for).
 */
function inflateSnippet(compress: Compression, mode: InflateMode): string {
  if (compress !== 'gzip') return ''

  const native = `new Uint8Array(await new Response(new Blob([x]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())`
  const inlineDecoder = `const J=${INFLATE_SOURCE};`

  if (mode === 'native') return `const Z=async x=>${native};`
  if (mode === 'inline' || mode === 'fflate') {
    return `${inlineDecoder}const Z=async x=>J(x);`
  }
  return `${inlineDecoder}const Z=async x=>typeof DecompressionStream<'u'?${native}:J(x);`
}

/**
 * `t` — the source text, inflated first when the file says it is compressed.
 *
 * The flag is read from the file rather than assumed from the build options,
 * so a loader paired with the wrong .bin fails loudly instead of decoding
 * gzip bytes as JavaScript.
 */
function textSnippet(bytes: string, compress: Compression): string {
  if (compress !== 'gzip') return `const t=new TextDecoder().decode(${bytes});`
  return `const t=new TextDecoder().decode(b[${FLAGS_OFFSET}]&1?await Z(${bytes}):${bytes});`
}

/** XOR decode: take the key, XOR the payload. */
function xorDecodeSnippet(
  layout: Layout,
  keySource: KeySource,
  keyProvider: string,
  fallback: KeyFallback,
  compress: Compression,
  inflate: InflateMode
): string {
  // `kl` is the header key length, which is 0 in native mode — so the repeat
  // has to run over the key actually in hand.
  const period = keySource === 'header' ? 'kl' : 'k.length'
  return (
    inflateSnippet(compress, inflate) +
    [
      keyLenSnippet(layout),
      keySnippet(layout, keySource, keyProvider, fallback),
      `const d=b.slice(${layout.key}+kl)`,
      `const o=new Uint8Array(d.length)`,
      `for(let i=0;i<d.length;i++)o[i]=d[i]^k[i%${period}]`,
      textSnippet('o', compress)
    ].join(';')
  )
}

/** AES-GCM decode: take the key, read the IV from the header, use WebCrypto. */
function aesDecodeSnippet(
  layout: Layout,
  keySource: KeySource,
  keyProvider: string,
  fallback: KeyFallback,
  compress: Compression,
  inflate: InflateMode
): string {
  const iv = layout.key + 1
  const plain = compress === 'gzip' ? 'new Uint8Array(dc)' : 'dc'
  return (
    inflateSnippet(compress, inflate) +
    [
      keyLenSnippet(layout),
      keySnippet(layout, keySource, keyProvider, fallback),
      `const il=b[${layout.key}+kl]`,
      `const iv=b.slice(${iv}+kl,${iv}+kl+il)`,
      `const d=b.slice(${iv}+kl+il)`,
      `const ck=await crypto.subtle.importKey('raw',k,'AES-GCM',false,['decrypt'])`,
      `const dc=await crypto.subtle.decrypt({name:'AES-GCM',iv},ck,d)`,
      textSnippet(plain, compress)
    ].join(';')
  )
}
