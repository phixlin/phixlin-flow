// TODO: replace with real-entry smoke once CLI exists
import { describe, expect, it } from 'vitest'
import { packageName } from '../src/index.js'

describe('package entrypoint', () => {
  it('exports package metadata', () => {
    expect(packageName).toBe('@phixlin/phixlin-flow')
  })
})
