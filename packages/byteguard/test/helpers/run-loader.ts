import { generateLoader } from '../../src/decoder'
import type { LoaderOptions } from '../../src/decoder'
import type { Algorithm } from '../../src/types'

export interface RunLoaderInput {
  bin: Uint8Array
  algorithm?: Algorithm
  options?: LoaderOptions
  /** What the page put on the key provider global, if anything. */
  provider?: unknown
  /** Hide `DecompressionStream`, as Safari below 16.4 does. */
  withoutDecompressionStream?: boolean
}

/**
 * Run a generated loader for real and return the source it was about to
 * execute.
 *
 * The loader is a string meant for a browser, so the only honest way to test
 * it is to run it: this supplies the globals a page would (`fetch`, the key
 * provider, optionally no `DecompressionStream`) and swaps the execution sink
 * for one that records. Everything else — the header walk, the key handling,
 * the decrypt, the inflate — is the shipped code path.
 */
export async function runLoader({
  bin,
  algorithm = 'xor',
  options = {},
  provider,
  withoutDecompressionStream = false
}: RunLoaderInput): Promise<string> {
  const loader = generateLoader('./entry.bin', algorithm, false, options)

  const providerName = options.keyProvider ?? '__byteguardKey'
  const scope: Record<string, unknown> = { [providerName]: provider }

  const fetchStub = async (url: string) => {
    if (url !== './entry.bin') throw new Error(`unexpected fetch: ${url}`)
    return {
      arrayBuffer: async () =>
        bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
    }
  }

  let ran = ''
  // The classic loader ends in `(new Function(t))()`; hand it a Function that
  // records its argument instead of executing the bundle. It has to be a real
  // function — the loader calls it with `new`.
  const capture = function (source: string) {
    ran = source
    return () => {}
  }

  const scoped = new Function(
    'globalThis',
    'fetch',
    'Function',
    'DecompressionStream',
    `return ${loader}`
  )

  await scoped(
    scope,
    fetchStub,
    capture,
    withoutDecompressionStream ? undefined : globalThis.DecompressionStream
  )

  return ran
}
