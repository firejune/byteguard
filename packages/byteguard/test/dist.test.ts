import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Checks against the built package rather than `src`.
 *
 * The loader inlines `byteguardInflate` by taking its source text at runtime,
 * which means the thing that ships is the *bundled* function, not the one the
 * other tests import. A bundler that renamed it, split it, or reached a helper
 * out of its body would leave every other test green and break the loader in
 * a browser.
 *
 * Skipped when dist is absent; CI builds before it tests (see ci.yml).
 */
const dist = join(import.meta.dirname, '..', 'dist', 'index.js')
const built = existsSync(dist)

describe.skipIf(!built)('built package', () => {
  it('should still inline a self-contained inflate', async () => {
    const { generateLoader, byteguardInflate, INFLATE_SOURCE } = await import(dist)

    expect(typeof byteguardInflate).toBe('function')
    expect(INFLATE_SOURCE.startsWith('function')).toBe(true)

    // Evaluate the text exactly as the browser will, in a scope that has
    // nothing from the module around it.
    const inlined = new Function(`return (${INFLATE_SOURCE})`)()
    const { gzipSync } = await import('node:zlib')
    const source = 'const answer = 42; export function get() { return answer }'.repeat(50)
    const payload = new Uint8Array(gzipSync(Buffer.from(source)))

    expect(new TextDecoder().decode(inlined(payload))).toBe(source)

    // And the generated loader carries that same text.
    const loader = generateLoader('./a.bin', 'xor', true, { compress: 'gzip' })
    expect(loader).toContain(INFLATE_SOURCE)
  })

  it('should keep the browser entry free of Node built-ins', async () => {
    // `byteguard/runtime` is what application code imports. A Node built-in
    // reaching it through a shared chunk would break a browser build.
    const { readFileSync, readdirSync } = await import('node:fs')
    const distDir = join(import.meta.dirname, '..', 'dist')

    const seen = new Set<string>()
    const queue = ['runtime.js']

    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)

      const code = readFileSync(join(distDir, file), 'utf-8')
      expect(code, `${file} imports a Node built-in`).not.toMatch(
        /from\s*["'](node:)?(crypto|zlib|fs|path|os)["']/
      )

      for (const match of code.matchAll(/from\s*["']\.\/([^"']+)["']/g)) {
        queue.push(match[1])
      }
    }

    expect(seen.size).toBeGreaterThan(1) // the entry plus its chunk
    expect(readdirSync(distDir)).toContain('runtime.d.ts')
  })
})
