import { DEFAULT_KEY_PROVIDER, KEY_PROVIDER_MARKER } from './types'
import type { Algorithm, KeyFallback, KeySource } from './types'

export interface LoaderOptions {
  /** Where the loader gets the key. Default: 'header' */
  keySource?: KeySource
  /** Global holding the key, for `keySource: 'native'`. Default: '__byteguardKey' */
  keyProvider?: string
  /** What to do when the provider yields nothing. Default: 'none' */
  fallback?: KeyFallback
}

/** Offset of the 2-byte key length field. */
const KEY_LEN_OFFSET = 6
/** Offset of the key section, and of the IV length that follows it. */
const KEY_OFFSET = KEY_LEN_OFFSET + 2

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
    fallback = 'none'
  } = options

  const decode =
    algorithm === 'xor'
      ? xorDecodeSnippet(keySource, keyProvider, fallback)
      : aesDecodeSnippet(keySource, keyProvider, fallback)

  const execute = isModule
    ? `const u=URL.createObjectURL(new Blob([t],{type:'text/javascript'}));const s=document.createElement('script');s.type='module';s.src=u;s.onload=()=>URL.revokeObjectURL(u);document.head.appendChild(s)`
    : `(new Function(t))()`

  return `(async()=>{const r=await fetch('${binPath}');const b=new Uint8Array(await r.arrayBuffer());${decode}${execute}})()`
}

/** `const kl=…` — the key length, wherever the key itself ends up living. */
function keyLenSnippet(): string {
  return `const kl=b[${KEY_LEN_OFFSET}]|b[${KEY_LEN_OFFSET + 1}]<<8`
}

/**
 * `k` — the key, from the header or from the page's provider.
 *
 * In native mode the loader also publishes the provider's name, so runtime
 * helpers (`loadWorker`) reach the same key without being configured twice.
 */
function keySnippet(
  keySource: KeySource,
  keyProvider: string,
  fallback: KeyFallback
): string {
  const headerSlice = `b.slice(${KEY_OFFSET},${KEY_OFFSET}+kl)`
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

/** XOR decode: take the key, XOR the payload. */
function xorDecodeSnippet(
  keySource: KeySource,
  keyProvider: string,
  fallback: KeyFallback
): string {
  // `kl` is the header key length, which is 0 in native mode — so the repeat
  // has to run over the key actually in hand.
  const period = keySource === 'header' ? 'kl' : 'k.length'
  return [
    keyLenSnippet(),
    keySnippet(keySource, keyProvider, fallback),
    `const d=b.slice(${KEY_OFFSET}+kl)`,
    `const o=new Uint8Array(d.length)`,
    `for(let i=0;i<d.length;i++)o[i]=d[i]^k[i%${period}]`,
    `const t=new TextDecoder().decode(o);`
  ].join(';')
}

/** AES-GCM decode: take the key, read the IV from the header, use WebCrypto. */
function aesDecodeSnippet(
  keySource: KeySource,
  keyProvider: string,
  fallback: KeyFallback
): string {
  const iv = KEY_OFFSET + 1
  return [
    keyLenSnippet(),
    keySnippet(keySource, keyProvider, fallback),
    `const il=b[${KEY_OFFSET}+kl]`,
    `const iv=b.slice(${iv}+kl,${iv}+kl+il)`,
    `const d=b.slice(${iv}+kl+il)`,
    `const ck=await crypto.subtle.importKey('raw',k,'AES-GCM',false,['decrypt'])`,
    `const dc=await crypto.subtle.decrypt({name:'AES-GCM',iv},ck,d)`,
    `const t=new TextDecoder().decode(dc);`
  ].join(';')
}
