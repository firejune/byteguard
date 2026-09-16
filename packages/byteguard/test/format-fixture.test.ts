import { describe, it, expect, beforeEach, vi } from 'vitest'

// Deterministic key material: the container is only byte-comparable if the
// random key and IV are fixed. Everything else in node:crypto stays real.
const rng = vi.hoisted(() => ({ calls: 0 }))

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (size: number) => {
      const nth = rng.calls++
      const out = Buffer.alloc(size)
      for (let i = 0; i < size; i++) out[i] = (i * 7 + nth * 31 + 11) & 0xff
      return out
    }
  }
})

import { encode } from '../src/encoder'
import { generateLoader } from '../src/decoder'

/**
 * Bytes and loader strings pinned against byteguard 0.4.1.
 *
 * These are the format's regression net: a v1 container written with the
 * default options must stay byte-identical forever, because every `.bin`
 * already shipped is read by a loader generated from the same defaults.
 * A deliberate format change belongs in a NEW fixture under a new version
 * byte — never in an edit to these literals.
 */
describe('format fixtures (v1, byteguard 0.4.1)', () => {
  beforeEach(() => {
    rng.calls = 0
  })

  const SOURCE = 'console.log("hello")'

  it('should pin the XOR container bytes', () => {
    const bin = encode(SOURCE, 'xor', 16)

    expect(hex(bin)).toBe(
      '42475244' + // BGRD
        '01' + // version 1
        '01' + // ALG_XOR
        '1000' + // key length 16, uint16 LE
        '0b121920272e353c434a51585f666d74' + // key
        '687d7753484250122f2536707d0e0818677d3b09' // payload
    )
  })

  it('should pin the AES-GCM container bytes', () => {
    const bin = encode(SOURCE, 'aes-gcm', 32)

    expect(hex(bin)).toBe(
      '42475244' + // BGRD
        '01' + // version 1
        '02' + // ALG_AES_GCM
        '2000' + // key length 32, uint16 LE
        '0b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4' + // key
        '0c' + // IV length
        '2a31383f464d545b62697077' + // IV
        'f9dd5af7fe7b195377dae2a7b7bdcae81d163484' + // ciphertext
        '39022cd1ae92a1192b1682442ada54d2' // GCM tag
    )
  })

  it('should pin bytes that still decode back to the source', async () => {
    // Guards the fixtures against being "whatever the encoder did": the
    // pinned key/IV must actually open the pinned payload.
    const { createDecipheriv } = await import('node:crypto')

    const xorBin = encode(SOURCE, 'xor', 16)
    const key = xorBin.slice(8, 24)
    const payload = xorBin.slice(24)
    const plain = payload.map((byte, i) => byte ^ key[i % key.length])
    expect(new TextDecoder().decode(plain)).toBe(SOURCE)

    rng.calls = 0
    const aesBin = encode(SOURCE, 'aes-gcm', 32)
    const aesKey = aesBin.slice(8, 40)
    const iv = aesBin.slice(41, 53)
    const sealed = aesBin.slice(53)
    const decipher = createDecipheriv('aes-256-gcm', aesKey, iv)
    decipher.setAuthTag(sealed.slice(sealed.length - 16))
    const opened = Buffer.concat([
      decipher.update(sealed.slice(0, sealed.length - 16)),
      decipher.final()
    ])
    expect(opened.toString('utf-8')).toBe(SOURCE)
  })

  it('should keep the key section first and the payload last', () => {
    // Offsets the shipped loaders hard-code. Spelled out so a layout shift
    // fails here with a readable message, not as a hex diff.
    const bin = encode(SOURCE, 'xor', 16)
    expect(Array.from(bin.slice(0, 4))).toEqual([0x42, 0x47, 0x52, 0x44])
    expect(bin[4]).toBe(0x01)
    expect(bin[5]).toBe(0x01)
    expect(bin[6] | (bin[7] << 8)).toBe(16)
    expect(bin.length).toBe(8 + 16 + SOURCE.length)
  })

  it('should pin the XOR module loader string', () => {
    expect(generateLoader('./assets/index.bin', 'xor', true)).toBe(
      `(async()=>{const r=await fetch('./assets/index.bin');const b=new Uint8Array(await r.arrayBuffer());const kl=b[6]|b[7]<<8;const k=b.slice(8,8+kl);const d=b.slice(8+kl);const o=new Uint8Array(d.length);for(let i=0;i<d.length;i++)o[i]=d[i]^k[i%kl];const t=new TextDecoder().decode(o);const u=URL.createObjectURL(new Blob([t],{type:'text/javascript'}));const s=document.createElement('script');s.type='module';s.src=u;s.onload=()=>URL.revokeObjectURL(u);document.head.appendChild(s)})()`
    )
  })

  it('should pin the XOR classic loader string', () => {
    expect(generateLoader('./assets/index.bin', 'xor', false)).toBe(
      `(async()=>{const r=await fetch('./assets/index.bin');const b=new Uint8Array(await r.arrayBuffer());const kl=b[6]|b[7]<<8;const k=b.slice(8,8+kl);const d=b.slice(8+kl);const o=new Uint8Array(d.length);for(let i=0;i<d.length;i++)o[i]=d[i]^k[i%kl];const t=new TextDecoder().decode(o);(new Function(t))()})()`
    )
  })

  it('should pin the AES-GCM module loader string', () => {
    expect(generateLoader('./assets/index.bin', 'aes-gcm', true)).toBe(
      `(async()=>{const r=await fetch('./assets/index.bin');const b=new Uint8Array(await r.arrayBuffer());const kl=b[6]|b[7]<<8;const k=b.slice(8,8+kl);const il=b[8+kl];const iv=b.slice(9+kl,9+kl+il);const d=b.slice(9+kl+il);const ck=await crypto.subtle.importKey('raw',k,'AES-GCM',false,['decrypt']);const dc=await crypto.subtle.decrypt({name:'AES-GCM',iv},ck,d);const t=new TextDecoder().decode(dc);const u=URL.createObjectURL(new Blob([t],{type:'text/javascript'}));const s=document.createElement('script');s.type='module';s.src=u;s.onload=()=>URL.revokeObjectURL(u);document.head.appendChild(s)})()`
    )
  })

  it('should pin the AES-GCM classic loader string', () => {
    expect(generateLoader('./assets/index.bin', 'aes-gcm', false)).toBe(
      `(async()=>{const r=await fetch('./assets/index.bin');const b=new Uint8Array(await r.arrayBuffer());const kl=b[6]|b[7]<<8;const k=b.slice(8,8+kl);const il=b[8+kl];const iv=b.slice(9+kl,9+kl+il);const d=b.slice(9+kl+il);const ck=await crypto.subtle.importKey('raw',k,'AES-GCM',false,['decrypt']);const dc=await crypto.subtle.decrypt({name:'AES-GCM',iv},ck,d);const t=new TextDecoder().decode(dc);(new Function(t))()})()`
    )
  })
})

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}
