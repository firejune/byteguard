import { randomBytes } from 'node:crypto'

export function xorEncode(
  data: Uint8Array,
  keySize: number,
  key: Uint8Array = new Uint8Array(randomBytes(keySize))
): { encoded: Uint8Array; key: Uint8Array } {
  if (key.length === 0) {
    throw new Error('[byteguard] XOR key must not be empty')
  }

  const encoded = new Uint8Array(data.length)

  for (let i = 0; i < data.length; i++) {
    encoded[i] = data[i] ^ key[i % key.length]
  }

  return { encoded, key }
}
