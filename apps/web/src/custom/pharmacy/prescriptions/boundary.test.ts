import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps Admin integration to a thin route and marked sidebar seam', () => {
  const route = readFileSync(join(process.cwd(), 'src', 'app', 'prescriptions', 'page.tsx'), 'utf8')
  const sidebar = readFileSync(join(process.cwd(), 'src', 'components', 'layout', 'sidebar.tsx'), 'utf8')

  expect(route.trim()).toBe(
    "export { default } from '@/custom/pharmacy/prescriptions/PrescriptionQueuePage' // custom:pharmacy-prescriptions",
  )
  expect(sidebar).toContain(
    "import PrescriptionSidebarBadge from '@/custom/pharmacy/prescriptions/PrescriptionSidebarBadge' // custom:pharmacy-prescriptions",
  )
  expect(sidebar).toContain("href: '/prescriptions'")
  expect(sidebar).toContain('<PrescriptionSidebarBadge active={active} />')
  expect(readFileSync(join(process.cwd(), 'src', 'app', 'patient-intakes', 'page.tsx'), 'utf8').trim()).toBe(
    "export { default } from '@/custom/pharmacy/intake/PatientIntakeAdminPage' // custom:pharmacy-intake",
  )
  expect(readFileSync(join(process.cwd(), 'src', 'app', 'continuity', 'page.tsx'), 'utf8').trim()).toBe(
    "export { default } from '@/custom/pharmacy/continuity/ContinuityAdminPage' // custom:pharmacy-continuity",
  )
  expect(sidebar).toContain("href: '/patient-intakes'")
  expect(sidebar).toContain("href: '/continuity'")

  const intakePage = readFileSync(
    join(process.cwd(), 'src', 'custom', 'pharmacy', 'intake', 'PatientIntakeAdminPage.tsx'),
    'utf8',
  )
  expect(intakePage).toContain('let cancelled = false')
  expect(intakePage).toContain('if (cancelled) return')
  expect(intakePage).toContain('return () => { cancelled = true }')
  expect(intakePage).toContain('const request = listRequestGate.start()')
  expect(intakePage).toContain('pharmacyIntakeAdminApi.list(selectedAccountId, request.signal)')
  expect(intakePage).toContain('if (!listRequestGate.isCurrent(request)) return')
  expect(intakePage).toContain('listRequestGate.abort()')
})
