'use client'

import { useEffect, useState } from 'react'
import { useAccount } from '../../../contexts/account-context'
import { prescriptionAdminApi } from './api'

export default function PrescriptionSidebarBadge({ active }: { active: boolean }) {
  const { selectedAccountId } = useAccount()
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (!selectedAccountId) return setCount(0)
      try {
        const { stats } = await prescriptionAdminApi.stats(selectedAccountId)
        if (!cancelled) setCount(stats.pending_count)
      } catch {
        if (!cancelled) setCount(0)
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selectedAccountId])

  if (count === 0) return null
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${active ? 'bg-white text-green-700' : 'bg-green-600 text-white'}`}>
      {count > 99 ? '99+' : count}
    </span>
  )
}
