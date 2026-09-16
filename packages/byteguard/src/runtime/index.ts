/**
 * Browser-side entry point: `byteguard/runtime`.
 *
 * Everything here runs in the page. Nothing here imports a Node built-in,
 * which is why it is a separate entry — the main entry is the build-time
 * half and pulls in `node:crypto` and `node:zlib`.
 */
export { loadWorker } from './worker'
export type { LoadWorkerOptions, KeyMaterial } from './worker'
export { byteguardInflate } from './inflate'
