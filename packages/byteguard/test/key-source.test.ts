import { describe, it, expect } from 'vitest'
import { createDecipheriv } from 'node:crypto'
import { encode } from '../src/encoder'
import { generateLoader } from '../src/decoder'
import { ALG_AES_GCM, ALG_XOR, MAGIC, VERSION } from '../src/types'

const SOURCE = 'const secret = "in the bundle"; console.log(secret)'
const XOR_KEY = new Uint8Array(Array.from({ length: 16 }, (_, i) => i * 3 + 1))
const AES_KEY = new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 5 + 2))

describe('keySource', () => {
  describe('encoding', () => {
    it('should keep the key in the header by default', () => {
      const bin = encode(SOURCE, 'xor', 16)
      expect(keyLen(bin)).toBe(16)
    })

    it('should omit the key entirely for native without fallback', () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        key: XOR_KEY
      })

      expect(keyLen(bin)).toBe(0)
      expect(bin.length).toBe(8 + SOURCE.length)
      // The header is still a well-formed v1 container: an absent key
      // shortens it, it does not change its shape.
      expect(Array.from(bin.slice(0, 4))).toEqual(Array.from(MAGIC))
      expect(bin[4]).toBe(VERSION)
      expect(bin[5]).toBe(ALG_XOR)
      expect(Buffer.from(bin).includes(Buffer.from(XOR_KEY))).toBe(false)
    })

    it('should write the key back for native with header fallback', () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        fallback: 'header',
        key: XOR_KEY
      })

      expect(keyLen(bin)).toBe(16)
      expect(Array.from(bin.slice(8, 24))).toEqual(Array.from(XOR_KEY))
    })

    it('should keep the AES IV in the header when the key is omitted', () => {
      const bin = encode(SOURCE, 'aes-gcm', 32, {
        keySource: 'native',
        key: AES_KEY
      })

      expect(bin[5]).toBe(ALG_AES_GCM)
      expect(keyLen(bin)).toBe(0)
      expect(bin[8]).toBe(12) // IV length sits where the key would have ended
      expect(Buffer.from(bin).includes(Buffer.from(AES_KEY))).toBe(false)
    })

    it('should round-trip a keyless XOR container with the runtime key', () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        key: XOR_KEY
      })

      const payload = bin.slice(8)
      const plain = payload.map((byte, i) => byte ^ XOR_KEY[i % XOR_KEY.length])
      expect(new TextDecoder().decode(plain)).toBe(SOURCE)
    })

    it('should round-trip a keyless AES container with the runtime key', () => {
      const bin = encode(SOURCE, 'aes-gcm', 32, {
        keySource: 'native',
        key: AES_KEY
      })

      const ivLen = bin[8]
      const iv = bin.slice(9, 9 + ivLen)
      const sealed = bin.slice(9 + ivLen)
      const decipher = createDecipheriv('aes-256-gcm', AES_KEY, iv)
      decipher.setAuthTag(sealed.slice(sealed.length - 16))
      const opened = Buffer.concat([
        decipher.update(sealed.slice(0, sealed.length - 16)),
        decipher.final()
      ])

      expect(opened.toString('utf-8')).toBe(SOURCE)
    })

    it('should accept a key factory', () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        fallback: 'header',
        key: () => XOR_KEY
      })
      expect(Array.from(bin.slice(8, 24))).toEqual(Array.from(XOR_KEY))
    })

    it('should make header builds reproducible when given a key', () => {
      const a = encode(SOURCE, 'aes-gcm', 32, { key: AES_KEY })
      const b = encode(SOURCE, 'aes-gcm', 32, { key: AES_KEY })
      // Same key in the header; the IV still differs, as it must.
      expect(Array.from(a.slice(8, 40))).toEqual(Array.from(AES_KEY))
      expect(Array.from(a.slice(8, 40))).toEqual(Array.from(b.slice(8, 40)))
    })

    it('should refuse native mode without a key', () => {
      expect(() => encode(SOURCE, 'xor', 16, { keySource: 'native' })).toThrow(
        /needs a key/
      )
    })

    it('should refuse an empty key', () => {
      expect(() =>
        encode(SOURCE, 'xor', 16, {
          keySource: 'native',
          key: new Uint8Array(0)
        })
      ).toThrow(/must not be empty/)
    })

    it('should refuse an AES key of the wrong size', () => {
      expect(() =>
        encode(SOURCE, 'aes-gcm', 32, {
          keySource: 'native',
          key: new Uint8Array(20)
        })
      ).toThrow(/16, 24 or 32 bytes/)
    })
  })

  describe('loader generation', () => {
    it('should read the default global in native mode', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        keySource: 'native'
      })

      expect(loader).toContain('globalThis["__byteguardKey"]')
      expect(loader).toContain('globalThis["__byteguardKeyProvider"]="__byteguardKey"')
      expect(loader).toContain("if(typeof k==='function')k=k()")
      expect(loader).toContain('k=await k')
    })

    it('should read a custom global', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        keySource: 'native',
        keyProvider: 'myAppKey'
      })

      expect(loader).toContain('globalThis["myAppKey"]')
      expect(loader).toContain('globalThis["__byteguardKeyProvider"]="myAppKey"')
      expect(loader).not.toContain('__byteguardKey"]')
    })

    it('should throw instead of falling back when fallback is none', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        keySource: 'native'
      })

      expect(loader).toContain('throw new Error')
      // Nothing may decode or execute without a key.
      expect(loader.indexOf('throw new Error')).toBeLessThan(
        loader.indexOf('URL.createObjectURL')
      )
      expect(loader).not.toContain('k=b.slice(8,8+kl)')
    })

    it('should fall back to the header key when asked', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        keySource: 'native',
        fallback: 'header'
      })

      expect(loader).toContain('if(!k||!k.length)k=b.slice(8,8+kl)')
      expect(loader).not.toContain('throw new Error')
    })

    it('should repeat the runtime key over its own length, not the header field', () => {
      // `kl` is 0 in native mode: `i % kl` would be NaN for every byte.
      const native = generateLoader('./a.bin', 'xor', true, {
        keySource: 'native'
      })
      expect(native).toContain('o[i]=d[i]^k[i%k.length]')

      const header = generateLoader('./a.bin', 'xor', true)
      expect(header).toContain('o[i]=d[i]^k[i%kl]')
    })

    it('should still read the IV from the header in native AES mode', () => {
      const loader = generateLoader('./a.bin', 'aes-gcm', true, {
        keySource: 'native'
      })

      expect(loader).toContain('const il=b[8+kl]')
      expect(loader).toContain('const iv=b.slice(9+kl,9+kl+il)')
      expect(loader).toContain('crypto.subtle.importKey')
    })

    it('should escape an exotic provider name rather than splice it in raw', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        keySource: 'native',
        keyProvider: 'we"ird'
      })
      expect(loader).toContain('globalThis["we\\"ird"]')
    })
  })

  describe('end to end through the generated loader', () => {
    it('should decode a keyless XOR bin by running the loader text', async () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        key: XOR_KEY
      })
      expect(await runLoader(bin, 'xor', { keySource: 'native' }, XOR_KEY)).toBe(
        SOURCE
      )
    })

    it('should fall back to the header key when the provider is empty', async () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        fallback: 'header',
        key: XOR_KEY
      })
      expect(
        await runLoader(
          bin,
          'xor',
          { keySource: 'native', fallback: 'header' },
          undefined
        )
      ).toBe(SOURCE)
    })

    it('should throw without a key and fetch nothing further', async () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        key: XOR_KEY
      })
      await expect(
        runLoader(bin, 'xor', { keySource: 'native' }, undefined)
      ).rejects.toThrow(/no key/)
    })

    it('should accept a key returned by a function provider', async () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        key: XOR_KEY
      })
      expect(
        await runLoader(bin, 'xor', { keySource: 'native' }, () => XOR_KEY)
      ).toBe(SOURCE)
    })

    it('should accept an ArrayBuffer from the provider', async () => {
      const bin = encode(SOURCE, 'xor', 16, {
        keySource: 'native',
        key: XOR_KEY
      })
      const buffer = XOR_KEY.buffer.slice(
        XOR_KEY.byteOffset,
        XOR_KEY.byteOffset + XOR_KEY.byteLength
      )
      expect(await runLoader(bin, 'xor', { keySource: 'native' }, buffer)).toBe(
        SOURCE
      )
    })

    it('should accept a promise from the provider', async () => {
      const bin = encode(SOURCE, 'aes-gcm', 32, {
        keySource: 'native',
        key: AES_KEY
      })
      expect(
        await runLoader(
          bin,
          'aes-gcm',
          { keySource: 'native' },
          Promise.resolve(AES_KEY)
        )
      ).toBe(SOURCE)
    })
  })
})

function keyLen(bin: Uint8Array): number {
  return bin[6] | (bin[7] << 8)
}

/**
 * Run a generated loader for real: stub `fetch` and the execution sink, put
 * the key where the page would put it, and return the source the loader was
 * about to run. This is what the browser does, minus the <script> tag.
 */
async function runLoader(
  bin: Uint8Array,
  algorithm: 'xor' | 'aes-gcm',
  options: Parameters<typeof generateLoader>[3],
  provider: unknown
): Promise<string> {
  const loader = generateLoader('./entry.bin', algorithm, false, options)
  const scope: Record<string, unknown> = {
    __byteguardKey: provider,
    fetch: async (url: string) => {
      if (url !== './entry.bin') throw new Error(`unexpected fetch: ${url}`)
      return {
        arrayBuffer: async () =>
          bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
      }
    },
    crypto: globalThis.crypto
  }

  let ran = ''
  // The classic loader ends in `(new Function(t))()`; hand it a Function that
  // records its argument instead of executing the bundle.
  const capture = function (source: string) {
    ran = source
    return () => {}
  }

  const scoped = new Function(
    'globalThis',
    'fetch',
    'crypto',
    'Function',
    `return ${loader}`
  )
  await scoped(scope, scope.fetch, scope.crypto, capture)
  return ran
}
