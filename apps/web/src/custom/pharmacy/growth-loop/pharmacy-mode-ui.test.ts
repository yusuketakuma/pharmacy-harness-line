import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('pharmacy mode UI boundary', () => {
  it('uses the pharmacy dashboard instead of generic growth APIs', () => {
    const dashboard = read('app/page.tsx')

    expect(dashboard).toContain("import GrowthDashboardPage from '@/custom/pharmacy/growth-loop/GrowthDashboardPage'")
    expect(dashboard).toContain("import TodayOperationsSummary from '@/custom/pharmacy/growth-loop/TodayOperationsSummary'")
    expect(dashboard).toContain('if (loading) return')
    expect(dashboard).toContain('if (!selectedAccount) return')
    expect(dashboard).toContain('if (selectedAccount?.pharmacyMode) return <><TodayOperationsSummary /><GrowthDashboardPage /></>')
    expect(dashboard).not.toContain('your-worker.your-subdomain.workers.dev')
  })

  it('does not render generic global link settings for a pharmacy tenant', () => {
    const accounts = read('app/accounts/page.tsx')

    expect(accounts).toContain('pharmacyMode: boolean')
    expect(accounts).toContain('!accounts.some((account) => account.pharmacyMode) &&')
  })

  it('does not offer LINE account creation to a pharmacy tenant', () => {
    const accounts = read('app/accounts/page.tsx')

    expect(accounts).toContain('!loading && !accounts.some((account) => account.pharmacyMode) && (')
  })

  it('does not offer LINE account deletion for a pharmacy-mode account', () => {
    const accounts = read('app/accounts/page.tsx')

    expect(accounts).toContain('!account.pharmacyMode && (')
  })

  it('confirms and serializes LINE account mutations and surfaces failures', () => {
    const accounts = read('app/accounts/page.tsx')

    expect(accounts).toContain('if (mutatingAccountId !== null) return')
    expect(accounts).toContain('window.confirm(accountToggleConfirmation(accountName, currentActive))')
    expect(accounts).toContain('disabled={mutatingAccountId !== null}')
    expect(accounts).toContain('LINEアカウントの状態を更新できませんでした。')
    expect(accounts).toContain('LINEアカウントを削除できませんでした。')
  })

  it('surfaces global LINE account loading failures', () => {
    const context = read('contexts/account-context.tsx')

    expect(context).toContain('LINEアカウント情報を取得できませんでした。')
    expect(context).toContain('{error && <div role="alert"')
  })

  it('remounts tenant page state when the selected LINE account changes', () => {
    const shell = read('components/app-shell.tsx')

    expect(shell).toContain('const { selectedAccountId } = useAccount()')
    expect(shell).toContain("key={selectedAccountId ?? 'no-account'}")
    expect(shell).toContain('<AccountScopedLayout>{children}</AccountScopedLayout>')
  })

  it('does not expose server internals on tenant login and clears account state on logout', () => {
    const login = read('app/login/page.tsx')
    const sidebar = read('components/layout/sidebar.tsx')
    const shell = read('components/app-shell.tsx')

    expect(login).not.toContain('loginData?.error ||')
    expect(login).not.toContain('data?.error ||')
    expect(sidebar).toContain("localStorage.removeItem('lh_selected_account')")
    expect(login).toContain("fetch(`${apiUrl}/api/auth/session`")
    expect(login).toContain('sessionData.data.mustChangePassword')
    expect(shell).toContain('患者向けLINE送信は全体管理者により一時停止中です')
  })
})
