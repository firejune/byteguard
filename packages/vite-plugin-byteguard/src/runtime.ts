/**
 * Browser-side entry point: `vite-plugin-byteguard/runtime`.
 *
 * A re-export of `byteguard/runtime`, so an app that already depends on the
 * plugin does not need to name the core as a second dependency. Nothing here
 * touches Vite or Node — it is the code that runs in the page.
 */
export { loadWorker, byteguardInflate } from 'byteguard/runtime'
export type { LoadWorkerOptions, KeyMaterial } from 'byteguard/runtime'
