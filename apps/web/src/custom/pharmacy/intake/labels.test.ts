import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTAKE_QUESTION_LABELS, RELATIONSHIP_LABELS, SEX_LABELS, intakeAnswerText, intakeQuestionLabel } from './labels'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('shared intake labels', () => {
  it('translates question keys and enum answers, passing unknown values through', () => {
    expect(intakeQuestionLabel('allergiesStatus')).toBe('アレルギー')
    expect(intakeQuestionLabel('somethingNew')).toBe('somethingNew')
    expect(intakeAnswerText('allergiesStatus', 'yes')).toBe('あり')
    expect(intakeAnswerText('medicalHistoryTags', ['diabetes', 'asthma'])).toBe('糖尿病、喘息')
    expect(intakeAnswerText('medicationNotebook', 'electronic')).toBe('電子')
    expect(intakeAnswerText('notes', '夜間の連絡は避けてほしい')).toBe('夜間の連絡は避けてほしい')
    expect(intakeAnswerText('allergiesStatus', null)).toBe('未回答')
    expect(RELATIONSHIP_LABELS.child).toBe('子ども')
    expect(SEX_LABELS.prefer_not_to_say).toBe('回答しない')
    expect(Object.keys(INTAKE_QUESTION_LABELS)).toContain('pregnancyStatus')
  })

  it('is the single definition used by the tenant page and the platform admin patient page', () => {
    const tenantPage = read('custom/pharmacy/intake/PatientIntakeAdminPage.tsx')
    const adminPage = read('app/platform-admin/tenants/patients/detail/page.tsx')
    expect(tenantPage).toContain("from './labels'")
    expect(tenantPage).not.toContain('const SEX_LABELS')
    expect(adminPage).toContain("from '@/custom/pharmacy/intake/labels'")
    expect(adminPage).not.toContain('const SEX_LABELS')
    expect(adminPage).toContain('intakeQuestionLabel(key)')
    expect(adminPage).toContain('intakeAnswerText(key, value)')
  })
})
