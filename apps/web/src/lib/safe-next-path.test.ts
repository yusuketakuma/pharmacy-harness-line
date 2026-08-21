import { describe, expect, it } from 'vitest'
import { safeNextPath } from './safe-next-path'

describe('safeNextPath', () => {
  it('accepts only same-origin relative paths', () => {
    expect(safeNextPath('/prescriptions?submission=abc')).toBe('/prescriptions?submission=abc')
    expect(safeNextPath('/')).toBe('/')
  })

  it('falls back to / for anything that could leave the origin', () => {
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'prescriptions', '', null, undefined, '/login', '/login?reason=expired']) {
      expect(safeNextPath(bad)).toBe('/')
    }
  })
})
