import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: the build-time half (`byteguard`), and the browser half
  // (`byteguard/runtime`), which must stay free of Node built-ins.
  entry: {
    index: 'src/index.ts',
    runtime: 'src/runtime/index.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18'
})
