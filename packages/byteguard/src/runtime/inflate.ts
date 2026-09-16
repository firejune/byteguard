/**
 * Gzip / raw-DEFLATE decompression — RFC 1951 (DEFLATE) and RFC 1952 (gzip).
 *
 * Written as ONE self-contained function on purpose. It is used two ways and
 * both depend on that property:
 *
 *   1. called directly, by `loadWorker` and anything else in the page that
 *      has to inflate a payload without `DecompressionStream`;
 *   2. inlined as source text into the generated loader (`INFLATE_SOURCE`),
 *      which must run at document start with no bundler runtime behind it.
 *
 * So: no imports, no module-scope helpers, no free variables other than the
 * standard globals. Every table and helper lives inside the function body.
 * `test/inflate.test.ts` pins the second property by evaluating the emitted
 * text and round-tripping real `zlib.gzipSync` output through it.
 *
 * It is a table-driven decoder (one lookup per symbol, sized to the block's
 * longest code) rather than the bit-at-a-time walk, because the payload it
 * exists for is a multi-megabyte bundle on a phone.
 */
export function byteguardInflate(src: Uint8Array): Uint8Array {
  var pos = 0
  var size = 0

  // gzip wrapper: skip the header, and trust ISIZE for the exact output size.
  if (src[0] === 0x1f && src[1] === 0x8b) {
    var flg = src[3]
    pos = 10
    if (flg & 4) pos += 2 + (src[pos] | (src[pos + 1] << 8))
    if (flg & 8) while (src[pos++]) {}
    if (flg & 16) while (src[pos++]) {}
    if (flg & 2) pos += 2
    var end = src.length
    size =
      (src[end - 4] |
        (src[end - 3] << 8) |
        (src[end - 2] << 16) |
        (src[end - 1] << 24)) >>>
      0
  }

  var out = new Uint8Array(size || 8192)
  var len = 0
  var buf = 0
  var cnt = 0

  function fill(want: number): void {
    while (cnt < want) {
      buf |= (src[pos++] | 0) << cnt
      cnt += 8
    }
  }

  function take(n: number): number {
    if (n === 0) return 0
    fill(n)
    var v = buf & ((1 << n) - 1)
    buf >>>= n
    cnt -= n
    return v
  }

  function grow(n: number): void {
    var cap = out.length || 1
    while (cap < len + n) cap *= 2
    var next = new Uint8Array(cap)
    next.set(out.subarray(0, len))
    out = next
  }

  // Canonical code lengths -> flat lookup table indexed by the next `max`
  // bits as the reader yields them (LSB first), holding (symbol << 4) | bits.
  function build(lengths: Uint8Array, count: number): [Int32Array, number] {
    var max = 0
    var i = 0
    for (i = 0; i < count; i++) if (lengths[i] > max) max = lengths[i]
    if (max === 0) return [new Int32Array(1), 0]

    var byLen = new Int32Array(16)
    for (i = 0; i < count; i++) byLen[lengths[i]]++
    byLen[0] = 0

    var next = new Int32Array(16)
    var code = 0
    for (i = 1; i <= max; i++) {
      code = (code + byLen[i - 1]) << 1
      next[i] = code
    }

    var table = new Int32Array(1 << max)
    for (var sym = 0; sym < count; sym++) {
      var bits = lengths[sym]
      if (!bits) continue
      var canonical = next[bits]++
      var reversed = 0
      for (i = 0; i < bits; i++) reversed = (reversed << 1) | ((canonical >> i) & 1)
      var value = (sym << 4) | bits
      for (var slot = reversed; slot < table.length; slot += 1 << bits) {
        table[slot] = value
      }
    }
    return [table, max]
  }

  function decode(table: Int32Array, max: number): number {
    fill(max)
    var value = table[buf & ((1 << max) - 1)]
    var bits = value & 15
    if (bits === 0) throw new Error('byteguard: invalid huffman code')
    buf >>>= bits
    cnt -= bits
    return value >> 4
  }

  var lenBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
    83, 99, 115, 131, 163, 195, 227, 258
  ]
  var lenExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
    5, 5, 5, 0
  ]
  var distBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
  ]
  var distExtra = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13
  ]
  var clOrder = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
  ]

  var fixed: Array<[Int32Array, number]> | null = null
  var j = 0

  for (;;) {
    var last = take(1)
    var type = take(2)
    var lit: [Int32Array, number]
    var dist: [Int32Array, number]

    if (type === 0) {
      take(cnt & 7)
      var stored = take(16)
      take(16)
      if (len + stored > out.length) grow(stored)
      var from = pos - (cnt >> 3)
      out.set(src.subarray(from, from + stored), len)
      len += stored
      pos = from + stored
      buf = 0
      cnt = 0
      if (last) break
      continue
    }

    if (type === 1) {
      if (!fixed) {
        var litLengths = new Uint8Array(288)
        for (j = 0; j < 144; j++) litLengths[j] = 8
        for (; j < 256; j++) litLengths[j] = 9
        for (; j < 280; j++) litLengths[j] = 7
        for (; j < 288; j++) litLengths[j] = 8
        var distLengths = new Uint8Array(32)
        for (j = 0; j < 32; j++) distLengths[j] = 5
        fixed = [build(litLengths, 288), build(distLengths, 32)]
      }
      lit = fixed[0]
      dist = fixed[1]
    } else if (type === 2) {
      var nLit = take(5) + 257
      var nDist = take(5) + 1
      var nCode = take(4) + 4

      var clLengths = new Uint8Array(19)
      for (j = 0; j < nCode; j++) clLengths[clOrder[j]] = take(3)
      var cl = build(clLengths, 19)

      var lengths = new Uint8Array(nLit + nDist)
      for (j = 0; j < nLit + nDist; ) {
        var sym = decode(cl[0], cl[1])
        if (sym < 16) {
          lengths[j++] = sym
        } else if (sym === 16) {
          var prev = lengths[j - 1]
          for (var r = 3 + take(2); r > 0; r--) lengths[j++] = prev
        } else if (sym === 17) {
          j += 3 + take(3)
        } else {
          j += 11 + take(7)
        }
      }

      lit = build(lengths.subarray(0, nLit), nLit)
      dist = build(lengths.subarray(nLit), nDist)
    } else {
      throw new Error('byteguard: invalid block type')
    }

    for (;;) {
      var code = decode(lit[0], lit[1])
      if (code < 256) {
        if (len >= out.length) grow(1)
        out[len++] = code
        continue
      }
      if (code === 256) break
      code -= 257
      var copy = lenBase[code] + take(lenExtra[code])
      var dcode = decode(dist[0], dist[1])
      var back = distBase[dcode] + take(distExtra[dcode])
      if (len + copy > out.length) grow(copy)
      var at = len - back
      if (at < 0) throw new Error('byteguard: invalid distance')
      for (var c = 0; c < copy; c++) out[len++] = out[at++]
    }

    if (last) break
  }

  return len === out.length ? out : out.subarray(0, len)
}

/**
 * `byteguardInflate` as source text, for inlining into the generated loader.
 *
 * Taken from the function itself rather than kept as a second, hand-minified
 * copy: a vendored string drifts from the implementation it is supposed to
 * mirror, and nothing would fail when it did.
 */
export const INFLATE_SOURCE: string = byteguardInflate.toString()
