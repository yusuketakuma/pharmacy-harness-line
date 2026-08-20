import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('emergency controls', () => {
  it('shows completion only after every requested stop succeeds', () => {
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

    expect(page).not.toContain('Promise.allSettled')
    expect(page).toContain('if (!res.success) throw new Error')
    expect(page).toContain('if (results.some((result) => !result.success)) throw new Error')
  })
})
