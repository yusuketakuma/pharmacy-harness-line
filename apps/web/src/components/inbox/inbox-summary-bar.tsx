'use client';

import StatCard from '@/components/common/stat-card';

const fmt = new Intl.NumberFormat('ja-JP');

function formatOldest(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${min}分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間`;
  const day = Math.floor(hr / 24);
  return `${day}日`;
}

interface Props {
  total: number;
  byAccount: Array<{ accountId: string; accountName: string; count: number }>;
  oldestWaitMinutes: number | null;
}

export default function InboxSummaryBar({ total, byAccount, oldestWaitMinutes }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard label="未対応" value={fmt.format(total)} hint="人間の返事待ち" />
      <StatCard label="最古の待ち時間" value={formatOldest(oldestWaitMinutes)} hint="最も古い incoming" />
      <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200">
        <div className="text-xs font-medium text-gray-500">アカウント別</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {byAccount.length === 0 ? (
            <span className="text-xs text-gray-400">—</span>
          ) : (
            byAccount.map((a) => (
              <span
                key={a.accountId}
                className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
              >
                {a.accountName} {a.count}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
