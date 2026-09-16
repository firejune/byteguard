import { describe, it, expect } from 'vitest'
import { gzipSync, deflateRawSync } from 'node:zlib'
import { byteguardInflate, INFLATE_SOURCE } from '../src/runtime/inflate'

/** Evaluate the text the loader inlines, to prove it stands on its own. */
const inlined = new Function(`return (${INFLATE_SOURCE})`)() as typeof byteguardInflate

function gz(input: Uint8Array | string, level?: number): Uint8Array {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return new Uint8Array(gzipSync(bytes, level === undefined ? {} : { level }))
}

describe('byteguardInflate', () => {
  it('should round-trip text through gzip', () => {
    const source = 'const x = 1; console.log(x)'
    expect(new TextDecoder().decode(byteguardInflate(gz(source)))).toBe(source)
  })

  it('should round-trip an empty payload', () => {
    expect(byteguardInflate(gz('')).length).toBe(0)
  })

  it('should round-trip unicode', () => {
    const source = 'const msg = "한글 테스트 🎴".repeat(50)'
    expect(new TextDecoder().decode(byteguardInflate(gz(source)))).toBe(source)
  })

  it('should handle stored blocks (level 0)', () => {
    // Level 0 emits uncompressed blocks — a separate branch of the decoder,
    // and the only one that reads straight out of the source buffer.
    const source = 'x'.repeat(200_000)
    const out = byteguardInflate(gz(source, 0))
    expect(out.length).toBe(200_000)
    expect(new TextDecoder().decode(out)).toBe(source)
  })

  it('should handle fixed-Huffman blocks (level 1, short input)', () => {
    const source = 'ab'
    expect(new TextDecoder().decode(byteguardInflate(gz(source, 1)))).toBe(source)
  })

  it('should handle dynamic-Huffman blocks at every level', () => {
    const source = buildBundleLikeSource()
    for (let level = 1; level <= 9; level++) {
      const out = byteguardInflate(gz(source, level))
      expect(
        new TextDecoder().decode(out),
        `level ${level} did not round-trip`
      ).toBe(source)
    }
  })

  it('should handle long back-references and repeated runs', () => {
    // Maximum match length (258) and long distances, produced by a payload
    // built from a small alphabet with far-apart repeats.
    const chunk = 'abcdefghij'.repeat(40)
    const source = chunk + 'z'.repeat(60_000) + chunk + 'q' + chunk
    expect(new TextDecoder().decode(byteguardInflate(gz(source)))).toBe(source)
  })

  it('should handle binary payloads of every byte value', () => {
    const bytes = new Uint8Array(256 * 400)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff
    expect(Buffer.from(byteguardInflate(gz(bytes)))).toEqual(Buffer.from(bytes))
  })

  it('should handle incompressible (random) payloads', () => {
    const bytes = new Uint8Array(120_000)
    let seed = 12345
    for (let i = 0; i < bytes.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      bytes[i] = seed & 0xff
    }
    expect(Buffer.from(byteguardInflate(gz(bytes)))).toEqual(Buffer.from(bytes))
  })

  it('should inflate a multi-megabyte bundle-shaped payload', () => {
    // The size this exists for: the consumer's 2.97 MB -> 6.27 MB entry.
    const source = buildBundleLikeSource().repeat(400)
    expect(source.length).toBeGreaterThan(5_000_000)
    const out = byteguardInflate(gz(source))
    expect(out.length).toBe(source.length)
    expect(new TextDecoder().decode(out)).toBe(source)
  })

  it('should accept a raw deflate stream without the gzip wrapper', () => {
    const source = buildBundleLikeSource()
    const raw = new Uint8Array(deflateRawSync(Buffer.from(source)))
    expect(new TextDecoder().decode(byteguardInflate(raw))).toBe(source)
  })

  it('should skip gzip headers carrying a filename', () => {
    // FNAME is set by some producers; the header walk must step past it.
    const source = 'const a = 1'
    const framed = withFilename(gz(source), 'bundle.js')
    expect(new TextDecoder().decode(byteguardInflate(framed))).toBe(source)
  })

  it('should throw on a corrupt stream rather than return garbage', () => {
    const bad = gz(buildBundleLikeSource())
    bad[40] ^= 0xff
    bad[41] ^= 0xff
    expect(() => byteguardInflate(bad)).toThrow()
  })
})

describe('INFLATE_SOURCE', () => {
  it('should be a self-contained function expression', () => {
    expect(INFLATE_SOURCE.startsWith('function')).toBe(true)
    // A free variable would resolve against the loader's scope at runtime
    // and only fail in a browser. Catch the usual suspects here.
    expect(INFLATE_SOURCE).not.toMatch(/\brequire\(/)
    expect(INFLATE_SOURCE).not.toMatch(/\bimport\b/)
  })

  it('should inflate identically to the imported function', () => {
    const source = buildBundleLikeSource()
    const payload = gz(source)
    expect(new TextDecoder().decode(inlined(payload))).toBe(source)
    expect(Buffer.from(inlined(payload))).toEqual(
      Buffer.from(byteguardInflate(payload))
    )
  })

  it('should stay within the size the loader can afford', () => {
    expect(INFLATE_SOURCE.length).toBeLessThan(8_000)
  })
})

/** JS-shaped input: repeated identifiers, punctuation runs, long strings. */
function buildBundleLikeSource(): string {
  const parts: string[] = []
  for (let i = 0; i < 200; i++) {
    parts.push(
      `function handler${i}(state, payload) { const next = { ...state, value: ${i} }; ` +
        `if (payload && payload.kind === "update") { return next } return state }`
    )
  }
  parts.push(`const TABLE = ${JSON.stringify(Array.from({ length: 300 }, (_, i) => i * 7))}`)
  return parts.join('\n')
}

/** Rebuild a gzip member with FNAME set, to exercise the header walk. */
function withFilename(member: Uint8Array, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const out = new Uint8Array(member.length + nameBytes.length + 1)
  out.set(member.subarray(0, 10), 0)
  out[3] = member[3] | 8 // FNAME
  out.set(nameBytes, 10)
  out[10 + nameBytes.length] = 0
  out.set(member.subarray(10), 11 + nameBytes.length)
  return out
}
