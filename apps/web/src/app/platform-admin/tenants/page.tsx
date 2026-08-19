'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { platformAdminApi, type PlatformTenant } from '@/lib/platform-admin-api'

function statusBadgeClass(status: string): string {
  return status === 'active'
    ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800'
    : 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800'
}

export default function PlatformAdminTenantsPage() {
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    platformAdminApi.tenants()
      .then((res) => setTenants(res.data))
      .catch((caught: Error) => setError(caught.message))
  }, [])

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">テナント一覧</h1>
      {error && <p role="alert" className="mb-4 text-sm text-red-600">{error}</p>}
      {!tenants && !error && <p className="text-sm text-gray-500">読み込み中...</p>}
      {tenants && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2">テナントコード</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">ステータス</th>
                <th className="px-3 py-2 text-right">LINEアカウント数</th>
                <th className="px-3 py-2 text-right">スタッフ数</th>
                <th className="px-3 py-2 text-right">登録患者数</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono">
                    <Link
                      href={`/platform-admin/tenants/detail?id=${encodeURIComponent(tenant.id)}`}
                      className="text-purple-800 underline"
                    >
                      {tenant.tenantCode}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{tenant.displayName}</td>
                  <td className="px-3 py-2">
                    <span className={statusBadgeClass(tenant.status)}>{tenant.status}</span>
                  </td>
                  <td className="px-3 py-2 text-right">{tenant.lineAccountCount}</td>
                  <td className="px-3 py-2 text-right">{tenant.staffCount}</td>
                  <td className="px-3 py-2 text-right">{tenant.patientCount}</td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">テナントがありません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
