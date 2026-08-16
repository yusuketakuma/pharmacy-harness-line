import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { continuityApi, type ContinuityObligation } from './api.js';

const labels: Record<ContinuityObligation['status'], string> = {
  active: '次回のご相談時期を確認中',
  linked: '次の処方せんと紐付け済み',
  fulfilled: '完了',
  paused: 'フォローを一時停止中',
  ended: '終了',
};

export default function ContinuityPage() {
  const [items, setItems] = useState<ContinuityObligation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await continuityApi.list()).obligations);
    } catch (err) {
      setError(err instanceof Error ? err.message : '継続フォローを読み込めませんでした。');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function pause(id: string) {
    if (!window.confirm('今後の継続フォローを一時停止しますか？')) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      await continuityApi.pause(id);
      setSuccess('継続フォローを一時停止しました。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '継続フォローを変更できませんでした。');
    } finally { setBusy(false); }
  }

  return (
    <main className="max-w-md mx-auto min-h-screen bg-gray-50 pb-10">
      <header className="bg-white border-b px-4 py-4"><h1 className="text-lg font-bold text-gray-900">継続フォロー</h1><p className="mt-1 text-xs text-gray-600">調剤後の次回相談時期を確認できます。</p></header>
      <div className="p-4 space-y-4">
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {success && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{success}</div>}
        {items.length === 0 ? <p className="rounded-xl bg-white p-6 text-center text-sm text-gray-500">現在、継続フォローはありません。</p> : <ul className="space-y-3">{items.map((item) => <li key={item.id} className="rounded-xl bg-white p-4 shadow-sm"><p className="font-bold">{labels[item.status]}</p><p className="mt-2 text-sm text-gray-600">次回の目安：{item.expected_next_from}〜{item.expected_next_to}</p>{item.candidate_submission_id && <p className="mt-1 text-xs text-green-700">次の処方せんを受付中です。</p>}{(item.status === 'active' || item.status === 'linked') && <button type="button" onClick={() => void pause(item.id)} disabled={busy} className="mt-3 text-sm text-gray-600 underline disabled:opacity-50">フォローを一時停止</button>}</li>)}</ul>}
        <Link to="/prescriptions" className="block w-full rounded-xl bg-green-600 px-4 py-4 text-center font-bold text-white">処方せん事前送信へ</Link>
      </div>
    </main>
  );
}
