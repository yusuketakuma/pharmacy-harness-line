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
})
