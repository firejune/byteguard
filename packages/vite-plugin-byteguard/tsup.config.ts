import { defineConfig } from 'tsup'

export default defineConfig({
  // `index` is the build-time plugin; `runtime` is the browser half, which
  // re-exports byteguard/runtime and must stay free of Vite and Node.
  entry: {
    index: 'src/index.ts',
    runtime: 'src/runtime.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  external: ['vite']
})
