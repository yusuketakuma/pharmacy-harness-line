'use client'

import Header from '@/components/layout/header'
import WebinarForm from '@/components/webinars/webinar-form'

export default function NewWebinarPage() {
  return (
    <>
      <Header title="ウェビナー作成" description="新しいウェビナーを作成します。" />
      <div className="p-6">
        <WebinarForm />
      </div>
    </>
  )
}
