'use client'
import { usePathname } from 'next/navigation'
import Sidebar from './layout/sidebar'
import AuthGuard from './auth-guard'
import { AccountProvider } from '@/contexts/account-context'
import { useAccount } from '@/contexts/account-context'

function OutboundPauseBanner() {
  const { selectedAccount } = useAccount()
  if (!selectedAccount?.outboundMessagingPausedAt) return null
  return <div role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">
    患者向けLINE送信は全体管理者により一時停止中です。受信と画面上の記録は継続しますが、自動通知・手動通知は送信されません。
  </div>
}

function AccountScopedLayout({ children }: { children: React.ReactNode }) {
  const { selectedAccountId } = useAccount()

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main key={selectedAccountId ?? 'no-account'} className="flex-1 overflow-auto pt-[72px] lg:pt-0">
          <div className="px-4 pb-6 sm:px-6 lg:pt-8 lg:px-8 lg:pb-8">
            <OutboundPauseBanner />
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/login') {
    return <>{children}</>
  }

  // 全体管理者はテナントに属さない別ロール。テナント用の AuthGuard /
  // AccountProvider / Sidebar は一切通さず、自前の guard とシェルだけを使う。
  if (pathname?.startsWith('/platform-admin')) {
    return <>{children}</>
  }

  return (
    <AuthGuard>
      <AccountProvider>
        <AccountScopedLayout>{children}</AccountScopedLayout>
      </AccountProvider>
    </AuthGuard>
  )
}
