'use client';

import StatCard from '@/components/common/stat-card';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const fmt = new Intl.NumberFormat('ja-JP');

interface Stats {
  totalFollowing: number;
  uniquePeople: number;
  friendDups: number;
}

export default function SummaryBar() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.duplicates.stats().then((res) => {
      if (res.success) {
        setStats({
          totalFollowing: res.data.totalFollowing,
          uniquePeople: res.data.uniquePeople,
          friendDups: res.data.friendDups,
        });
      }
    });
  }, []);

  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 rounded-lg bg-white shadow-sm ring-1 ring-gray-200" />
        ))}
      </div>
    );
  }

  const dupRate = stats.totalFollowing > 0 ? (stats.friendDups / stats.totalFollowing) * 100 : 0;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard label="友だち総数" value={fmt.format(stats.totalFollowing)} />
      <StatCard label="ユニーク人数" value={fmt.format(stats.uniquePeople)} />
      {/* friendDups は行ベースの「余分な行数」(SUM(row_cnt - 1))。
          1人が3アカウントに居れば +2 とカウントされる。 */}
      <StatCard label="余分な行数" value={fmt.format(stats.friendDups)} hint="重複ぶんの行" />
      <StatCard label="余分率" value={`${dupRate.toFixed(1)}%`} hint="総行数のうち余分" />
    </div>
  );
}
