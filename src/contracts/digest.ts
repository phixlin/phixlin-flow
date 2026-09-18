import { createHash } from 'node:crypto'

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('canonical JSON does not support undefined')
  return serialized
}

export function digestJson(value: unknown): string {
  return sha256(canonicalJson(value))
}
