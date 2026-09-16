import type { Plugin } from 'vite'
import type { OutputAsset, OutputChunk } from 'rollup'
import type { ByteGuardOptions } from 'byteguard'
import { encode, generateLoader, DEFAULT_KEY_PROVIDER } from 'byteguard'

export type {
  ByteGuardOptions,
  Algorithm,
  KeySource,
  KeyFallback,
  Compression,
  InflateMode
} from 'byteguard'

export default function byteguard(options: ByteGuardOptions = {}): Plugin {
  const {
    algorithm = 'xor',
    keySize = 32,
    exclude = [],
    extension = 'bin',
    keySource = 'header',
    keyProvider = DEFAULT_KEY_PROVIDER,
    fallback = 'none',
    key,
    compress = 'none',
    inflate = 'auto',
    workers = false
  } = options

  const encodeOptions = { keySource, fallback, key, compress }
  const loaderOptions = { keySource, keyProvider, fallback, compress, inflate }

  return {
    name: 'vite-plugin-byteguard',
    apply: 'build',
    enforce: 'post',

    generateBundle(_, bundle) {
      const jsChunks = new Map<string, OutputChunk>()

      // Collect entry JS chunks only (skip workers, dynamic imports, etc.)
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk' || !fileName.endsWith('.js')) continue
        if (!chunk.isEntry) continue
        if (isExcluded(fileName, exclude)) continue
        jsChunks.set(fileName, chunk)
      }

      // Worker bundles are a separate rollup build that Vite emits into this
      // one — as an *asset*, not a chunk, which is why the entry-chunk pass
      // above has always walked past them.
      const workerFiles = collectWorkers(bundle, workers, exclude, jsChunks)

      if (jsChunks.size === 0 && workerFiles.size === 0) return

      // Worker names have to be settled before any code is encoded: the entry
      // holds the worker's URL as a plain string, and that string has to point
      // at the .bin before it goes under the cipher.
      const workerBins = new Map<string, string>()
      for (const fileName of workerFiles.keys()) {
        workerBins.set(fileName, binName(fileName, extension))
      }

      // Every surviving chunk, encoded or not, has to follow the rename.
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue
        item.code = rewriteWorkerUrls(item.code, workerBins)
      }

      const binMap = new Map<string, string>()

      // Encode each entry chunk → .bin
      for (const [fileName, chunk] of jsChunks) {
        // The directory prefix of the entry chunk (e.g. "assets/")
        const dir = fileName.substring(0, fileName.lastIndexOf('/') + 1)

        const code = chunk.code
          // Fix import.meta.url: inline scripts get page URL instead of asset URL.
          // Replace with a computed URL that resolves to the original asset path.
          .replace(/import\.meta\.url/g, `new URL("${fileName}",document.baseURI).href`)
          // Vite 8(Rolldown): __VITE_PRELOAD__ references are injected by Vite's preload optimizer.
          // In local execution (Capacitor/Electron) they are unnecessary. Replace with void 0.
          .replace(/__VITE_PRELOAD__/g, 'void 0')
          // Fix dynamic import(): relative paths resolve against the document URL
          // in inline/Blob script context, not the original asset directory.
          // Convert relative paths to absolute URLs via document.baseURI.
          .replace(/import\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g, (_, relPath: string) => {
            const absPath = resolvePath(dir, relPath)
            return `import(new URL("${absPath}",document.baseURI).href)`
          })
        const encoded = encode(code, algorithm, keySize, encodeOptions)
        const binFileName = binName(fileName, extension)

        this.emitFile({
          type: 'asset',
          fileName: binFileName,
          source: encoded
        })

        binMap.set(fileName, binFileName)
        delete bundle[fileName]
      }

      // Encode each worker → .bin. No import.meta.url or dynamic-import
      // rewriting here: those rewrites resolve against `document`, which a
      // worker does not have. A worker chunk that needs them is not a
      // candidate for encoding — see the README.
      for (const [fileName, source] of workerFiles) {
        const binFileName = workerBins.get(fileName) as string

        this.emitFile({
          type: 'asset',
          fileName: binFileName,
          source: encode(rewriteWorkerUrls(source, workerBins), algorithm, keySize, encodeOptions)
        })

        delete bundle[fileName]
      }

      // Update HTML: replace <script> tags with inline loader
      for (const [, asset] of Object.entries(bundle)) {
        if (!String(asset.fileName).endsWith('.html') || asset.type !== 'asset') continue

        let html = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source)

        for (const [jsFileName, binFileName] of binMap) {
          const escaped = escapeRegex(jsFileName)
          const scriptRe = new RegExp(`<script([^>]*)src=["']([^"']*${escaped})["']([^>]*)>\\s*</script>`, 'g')

          html = html.replace(scriptRe, (_match, pre: string) => {
            const isModule = /type\s*=\s*["']module["']/.test(pre)
            const loader = generateLoader(`./${binFileName}`, algorithm, isModule, loaderOptions)
            return `<script>${loader}</script>`
          })
        }

        ;(asset as OutputAsset).source = html
      }

      const names = [...binMap.values(), ...workerBins.values()].join(', ')
      const count = binMap.size + workerBins.size
      console.log(`\x1b[36m[byteguard]\x1b[0m Encoded ${count} chunk(s) with ${algorithm}: ${names}`)
    }
  }
}

/**
 * Worker bundles in the output, as `fileName -> source`.
 *
 * Vite emits them as assets, but a `workers` pattern may also name a
 * non-entry chunk, so both are searched. Entry chunks are never candidates.
 */
function collectWorkers(
  bundle: Record<string, OutputChunk | OutputAsset>,
  workers: boolean | string[],
  exclude: string[],
  entries: Map<string, OutputChunk>
): Map<string, string> {
  const found = new Map<string, string>()
  if (workers === false) return found

  for (const [fileName, item] of Object.entries(bundle)) {
    if (!fileName.endsWith('.js')) continue
    if (entries.has(fileName)) continue
    if (item.type === 'chunk' && item.isEntry) continue
    if (isExcluded(fileName, exclude)) continue

    if (workers === true) {
      // Vite emits a worker bundle as an asset; a plain chunk here is a
      // dynamic import, which still has to be loadable as JavaScript.
      if (item.type !== 'asset') continue
    } else if (!matches(fileName, workers)) {
      continue
    }

    found.set(
      fileName,
      item.type === 'chunk'
        ? item.code
        : typeof item.source === 'string'
          ? item.source
          : new TextDecoder().decode(item.source)
    )
  }

  return found
}

/**
 * Point references at the encoded worker.
 *
 * Vite writes the worker's URL into its consumer as a plain string literal —
 * both for `new Worker(new URL('./x.worker.js', import.meta.url))` and for
 * `import url from './x.worker.js?worker&url'` — so renaming the file means
 * replacing that literal wherever it appears.
 */
function rewriteWorkerUrls(code: string, workerBins: Map<string, string>): string {
  let out = code
  for (const [fileName, binFileName] of workerBins) {
    out = out.split(fileName).join(binFileName)
  }
  return out
}

function binName(fileName: string, extension: string): string {
  return fileName.replace(/\.js$/, `.${extension}`)
}

function isExcluded(fileName: string, patterns: string[]): boolean {
  return matches(fileName, patterns)
}

function matches(fileName: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
      return re.test(fileName)
    }
    return fileName.includes(pattern)
  })
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolve a relative path against a directory prefix.
 * e.g. resolvePath('assets/', './chunk.js') → 'assets/chunk.js'
 *      resolvePath('assets/js/', '../shared/util.js') → 'assets/shared/util.js'
 */
export function resolvePath(dir: string, relPath: string): string {
  const parts = (dir + relPath).split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.' && part !== '') resolved.push(part)
  }
  return resolved.join('/')
}

/**
 * Rewrite relative dynamic import() paths in code to absolute URLs.
 * Exported for testing purposes.
 */
export function rewriteDynamicImports(code: string, dir: string): string {
  return code
    .replace(/__VITE_PRELOAD__/g, 'void 0')
    .replace(/import\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g, (_, relPath: string) => {
      const absPath = resolvePath(dir, relPath)
      return `import(new URL("${absPath}",document.baseURI).href)`
    })
}
