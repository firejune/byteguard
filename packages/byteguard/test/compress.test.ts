import { describe, it, expect } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { encode } from '../src/encoder'
import { generateLoader } from '../src/decoder'
import { ALG_AES_GCM, FLAG_GZIP, VERSION, VERSION_FLAGS } from '../src/types'
import { runLoader } from './helpers/run-loader'

const SOURCE = `
const rows = ${JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'row ' + i })))}
export function total(state) { return rows.reduce((sum, row) => sum + row.id, state) }
`.repeat(4)

const KEY_16 = new Uint8Array(Array.from({ length: 16 }, (_, i) => i * 3 + 1))
const KEY_32 = new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 5 + 2))

describe('compress', () => {
  describe('container', () => {
    it('should stay version 1 when compression is off', () => {
      expect(encode(SOURCE, 'xor', 16)[4]).toBe(VERSION)
    })

    it('should write version 2 with the gzip flag set', () => {
      const bin = encode(SOURCE, 'xor', 16, { compress: 'gzip' })

      expect(bin[4]).toBe(VERSION_FLAGS)
      expect(bin[6]).toBe(FLAG_GZIP)
      // The flags byte pushes the key length along by one.
      expect(bin[7] | (bin[8] << 8)).toBe(16)
    })

    it('should shrink the payload', () => {
      const plain = encode(SOURCE, 'xor', 16)
      const packed = encode(SOURCE, 'xor', 16, { compress: 'gzip' })
      expect(packed.length).toBeLessThan(plain.length / 2)
    })

    it('should compress before encrypting, not after', () => {
      // The gzip magic must NOT be readable in the file: it is under the
      // cipher. Finding it there would mean the order had been swapped.
      const bin = encode(SOURCE, 'aes-gcm', 32, {
        compress: 'gzip',
        key: KEY_32
      })
      expect(bin[5]).toBe(ALG_AES_GCM)
      // header: 9 + 32 key + 1 + 12 IV = 54
      expect(Buffer.from(bin.slice(54)).indexOf(Buffer.from([0x1f, 0x8b]))).toBe(-1)

      // ...and the XOR payload, once un-XORed, is a gzip member.
      const xorBin = encode(SOURCE, 'xor', 16, { compress: 'gzip', key: KEY_16 })
      const payload = xorBin.slice(9 + 16)
      const gz = payload.map((byte, i) => byte ^ KEY_16[i % KEY_16.length])
      expect(gz[0]).toBe(0x1f)
      expect(gz[1]).toBe(0x8b)
      expect(gunzipSync(Buffer.from(gz)).toString('utf-8')).toBe(SOURCE)
    })

    it('should keep the key out of the file when both options are on', () => {
      const bin = encode(SOURCE, 'aes-gcm', 32, {
        compress: 'gzip',
        keySource: 'native',
        key: KEY_32
      })

      expect(bin[4]).toBe(VERSION_FLAGS)
      expect(bin[6]).toBe(FLAG_GZIP)
      expect(bin[7] | (bin[8] << 8)).toBe(0) // no key
      expect(bin[9]).toBe(12) // IV length follows immediately
      expect(Buffer.from(bin).includes(Buffer.from(KEY_32))).toBe(false)
    })
  })

  describe('loader generation', () => {
    it('should not mention inflate at all when compression is off', () => {
      const loader = generateLoader('./a.bin', 'xor', true)
      expect(loader).not.toContain('DecompressionStream')
      expect(loader).not.toContain('const J=')
    })

    it('should read the shifted offsets for a version 2 file', () => {
      const loader = generateLoader('./a.bin', 'aes-gcm', true, {
        compress: 'gzip'
      })

      expect(loader).toContain('const kl=b[7]|b[8]<<8')
      expect(loader).toContain('const k=b.slice(9,9+kl)')
      expect(loader).toContain('const il=b[9+kl]')
      expect(loader).toContain('const iv=b.slice(10+kl,10+kl+il)')
    })

    it('should carry both inflate paths under auto', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        compress: 'gzip'
      })

      expect(loader).toContain('DecompressionStream')
      expect(loader).toContain("typeof DecompressionStream<'u'")
      expect(loader).toContain('const J=function')
    })

    it('should carry only the stream API under native', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        compress: 'gzip',
        inflate: 'native'
      })

      expect(loader).toContain('DecompressionStream')
      expect(loader).not.toContain('const J=')
    })

    it('should carry only the inlined decoder under inline', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        compress: 'gzip',
        inflate: 'inline'
      })

      expect(loader).toContain('const J=function')
      expect(loader).not.toContain('DecompressionStream')
    })

    it("should treat 'fflate' as an alias for the inlined decoder", () => {
      expect(
        generateLoader('./a.bin', 'xor', true, {
          compress: 'gzip',
          inflate: 'fflate'
        })
      ).toBe(
        generateLoader('./a.bin', 'xor', true, {
          compress: 'gzip',
          inflate: 'inline'
        })
      )
    })

    it('should decide from the file flag, not from the build option', () => {
      const loader = generateLoader('./a.bin', 'xor', true, {
        compress: 'gzip'
      })
      expect(loader).toContain('b[6]&1?await Z(o):o')
    })

    it('should stay under 8 KB with the inlined decoder', () => {
      const loader = generateLoader('./a.bin', 'aes-gcm', true, {
        compress: 'gzip',
        keySource: 'native'
      })
      expect(loader.length).toBeLessThan(8 * 1024)
    })
  })

  describe('end to end through the generated loader', () => {
    const cases: Array<{ name: string; withoutDecompressionStream: boolean }> = [
      { name: 'with DecompressionStream', withoutDecompressionStream: false },
      { name: 'without DecompressionStream', withoutDecompressionStream: true }
    ]

    for (const { name, withoutDecompressionStream } of cases) {
      it(`should inflate an XOR payload ${name}`, async () => {
        const bin = encode(SOURCE, 'xor', 16, { compress: 'gzip' })
        expect(
          await runLoader({
            bin,
            options: { compress: 'gzip' },
            withoutDecompressionStream
          })
        ).toBe(SOURCE)
      })

      it(`should inflate an AES payload ${name}`, async () => {
        const bin = encode(SOURCE, 'aes-gcm', 32, { compress: 'gzip' })
        expect(
          await runLoader({
            bin,
            algorithm: 'aes-gcm',
            options: { compress: 'gzip' },
            withoutDecompressionStream
          })
        ).toBe(SOURCE)
      })

      it(`should inflate a native-key AES payload ${name}`, async () => {
        const bin = encode(SOURCE, 'aes-gcm', 32, {
          compress: 'gzip',
          keySource: 'native',
          key: KEY_32
        })
        expect(
          await runLoader({
            bin,
            algorithm: 'aes-gcm',
            options: { compress: 'gzip', keySource: 'native' },
            provider: KEY_32,
            withoutDecompressionStream
          })
        ).toBe(SOURCE)
      })
    }

    it('should fail under inflate: native when the engine has no stream API', async () => {
      const bin = encode(SOURCE, 'xor', 16, { compress: 'gzip' })
      await expect(
        runLoader({
          bin,
          options: { compress: 'gzip', inflate: 'native' },
          withoutDecompressionStream: true
        })
      ).rejects.toThrow()
    })

    it('should use the inlined decoder under inflate: inline even when the stream API exists', async () => {
      const bin = encode(SOURCE, 'xor', 16, { compress: 'gzip' })
      const loader = generateLoader('./entry.bin', 'xor', false, {
        compress: 'gzip',
        inflate: 'inline'
      })
      expect(loader).not.toContain('DecompressionStream')
      expect(
        await runLoader({
          bin,
          options: { compress: 'gzip', inflate: 'inline' },
          withoutDecompressionStream: false
        })
      ).toBe(SOURCE)
    })

    it('should skip the inflate when the file flag is clear', async () => {
      // The loader reads the flag rather than trusting the build option, so
      // a version 2 container whose payload was left uncompressed still
      // decodes. Hand-built, because the encoder never writes this shape.
      const source = 'const plain = 1'
      const payload = new TextEncoder().encode(source)
      const bin = new Uint8Array(9 + KEY_16.length + payload.length)
      bin.set([0x42, 0x47, 0x52, 0x44, VERSION_FLAGS, 0x01, 0x00], 0)
      bin[7] = KEY_16.length
      bin[8] = 0
      bin.set(KEY_16, 9)
      for (let i = 0; i < payload.length; i++) {
        bin[9 + KEY_16.length + i] = payload[i] ^ KEY_16[i % KEY_16.length]
      }

      expect(await runLoader({ bin, options: { compress: 'gzip' } })).toBe(source)
    })

    it('should round-trip unicode through the whole pipeline', async () => {
      const source = 'const msg = "한글 테스트 🎴".repeat(100)'
      const bin = encode(source, 'aes-gcm', 32, {
        compress: 'gzip',
        keySource: 'native',
        key: KEY_32
      })
      expect(
        await runLoader({
          bin,
          algorithm: 'aes-gcm',
          options: { compress: 'gzip', keySource: 'native' },
          provider: KEY_32,
          withoutDecompressionStream: true
        })
      ).toBe(source)
    })
  })
})
