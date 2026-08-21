import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROLE_LABELS, STATUS_LABELS, roleLabel, tenantStatusLabel } from '@/lib/platform-admin-labels'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('platform admin Japanese labels', () => {
  it('maps tenant status and staff role to Japanese, unknown values pass through', () => {
    expect(STATUS_LABELS.active).toBe('稼働中')
    expect(tenantStatusLabel('suspended')).toBe('停止中')
    expect(tenantStatusLabel('weird')).toBe('weird')
    expect(ROLE_LABELS.owner).toBe('オーナー')
    expect(roleLabel('staff')).toBe('スタッフ')
  })

  it('is applied on the tenant list and the tenant detail page', () => {
    const list = read('app/platform-admin/tenants/page.tsx')
    const detail = read('app/platform-admin/tenants/detail/page.tsx')
    expect(list).toContain('{tenantStatusLabel(tenant.status)}')
    expect(detail).toContain('{tenantStatusLabel(tenant.status)}')
    expect(detail).toContain('{roleLabel(member.role)}')
    expect(detail).toContain('<option value="active">稼働中</option>')
    expect(detail).not.toContain('read-back {')
    expect(detail).toContain('公開状態の確認')
  })
})
