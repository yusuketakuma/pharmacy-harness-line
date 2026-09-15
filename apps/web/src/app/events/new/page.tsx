'use client'

import Header from '@/components/layout/header'
import EventForm from '@/components/events/event-form'
import { useAccount } from '@/contexts/account-context'

export default function NewEventPage() {
  const { selectedAccountId } = useAccount()
  if (!selectedAccountId) {
    return (
      <>
        <Header title="新規イベント" description="新しいイベントを作成します。" />
        <div className="p-4 text-gray-500">アカウントを選択してください。</div>
      </>
    )
  }
  return (
    <>
      <Header title="新規イベント" description="新しいイベントを作成します。" />
      <EventForm accountId={selectedAccountId} eventId={null} />
    </>
  )
}
