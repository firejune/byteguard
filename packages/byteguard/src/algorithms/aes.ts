import { randomBytes, createCipheriv } from 'node:crypto'

export function aesEncode(
  data: Uint8Array,
  keySize: number,
  suppliedKey?: Uint8Array
): { encoded: Uint8Array; key: Uint8Array; iv: Uint8Array } {
  // Normalize to valid AES key size (16, 24, or 32 bytes)
  const validKeySize = keySize <= 16 ? 16 : keySize <= 24 ? 24 : 32

  if (suppliedKey && ![16, 24, 32].includes(suppliedKey.length)) {
    throw new Error(
      `[byteguard] AES-GCM key must be 16, 24 or 32 bytes, got ${suppliedKey.length}`
    )
  }

  const key = suppliedKey ?? new Uint8Array(randomBytes(validKeySize))
  const iv = new Uint8Array(randomBytes(12)) // 96-bit nonce for GCM

  const algo =
    key.length === 16 ? 'aes-128-gcm' : key.length === 24 ? 'aes-192-gcm' : 'aes-256-gcm'
  const cipher = createCipheriv(algo, key, iv)
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
  const authTag = cipher.getAuthTag() // 16 bytes

  // WebCrypto expects: ciphertext + authTag concatenated
  const encoded = new Uint8Array(encrypted.length + authTag.length)
  encoded.set(encrypted, 0)
  encoded.set(authTag, encrypted.length)

  return { encoded, key, iv }
}
