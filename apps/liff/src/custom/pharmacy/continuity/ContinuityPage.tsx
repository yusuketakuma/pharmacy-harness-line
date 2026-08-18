import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  continuityApi,
  type ContinuityObligation,
  type NextIntakeExpectation,
} from './api.js';

const labels: Record<ContinuityObligation['status'], string> = {
  active: '次回のご相談を受付中',
  linked: '次の処方せんと紐付け済み',
  fulfilled: '完了',
  paused: 'フォローを一時停止中',
  ended: '終了',
};

const expectationLabels: Record<NextIntakeExpectation['status'], string> = {
  offered: 'お知らせを受け取りますか？',
  accepted: 'お知らせを登録しました',
  active: 'お知らせを送信しています',
  reminded: 'お知らせ済みです',
  linked: '次の処方せんと紐付け済み',
  fulfilled: '完了',
  paused: '一時停止中',
  ended: '今回は登録しません',
};

export function NextIntakeExpectationCard({
  expectation,
  busy,
  onRespond,
}: {
  expectation: NextIntakeExpectation;
  busy: boolean;
  onRespond: (id: string, response: 'accepted' | 'ended') => Promise<void>;
}) {
  return <section className="mt-3 rounded-lg border border-green-100 bg-green-50 p-3">
    <p className="font-bold text-gray-900">次回事前送信のお知らせ</p>
    <p className="mt-1 text-sm text-gray-700">{expectationLabels[expectation.status]}</p>
    <p className="mt-1 text-sm text-gray-600">目安：{expectation.expected_from}〜{expectation.expected_to}</p>
    <p className="mt-2 text-xs text-gray-600">有効な処方せんは別途必要です。薬の確保や調剤を約束するものではありません。</p>
    {expectation.status === 'offered' && <div className="mt-3 grid gap-2">
      <button type="button" onClick={() => void onRespond(expectation.id, 'accepted')} disabled={busy} className="min-h-11 rounded-lg bg-green-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">お知らせを受け取る</button>
      <button type="button" onClick={() => void onRespond(expectation.id, 'ended')} disabled={busy} className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 disabled:opacity-50">今回は登録しない</button>
    </div>}
  </section>;
}

export default function ContinuityPage() {
  const [items, setItems] = useState<ContinuityObligation[]>([]);
  const [expectations, setExpectations] = useState<NextIntakeExpectation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await continuityApi.list();
      setItems(result.obligations);
      setExpectations(result.expectations);
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

  async function respond(id: string, response: 'accepted' | 'ended') {
    setBusy(true); setError(null); setSuccess(null);
    try {
      await continuityApi.respond(id, response);
      setSuccess(response === 'accepted' ? '次回事前送信のお知らせを登録しました。' : '今回は登録しません。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '次回事前送信のお知らせを変更できませんでした。');
    } finally { setBusy(false); }
  }

  const expectationByObligation = new Map(expectations.map((item) => [item.obligation_id, item]));

  return (
    <main className="max-w-md mx-auto min-h-screen bg-gray-50 pb-10">
      <header className="bg-white border-b px-4 py-4"><h1 className="text-lg font-bold text-gray-900">継続フォロー</h1><p className="mt-1 text-xs text-gray-600">次回の処方せん事前送信に向けたお知らせを確認できます。</p></header>
      <div className="p-4 space-y-4">
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {success && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{success}</div>}
        {items.length === 0 ? <p className="rounded-xl bg-white p-6 text-center text-sm text-gray-500">現在、継続フォローはありません。</p> : <ul className="space-y-3">{items.map((item) => {
          const expectation = expectationByObligation.get(item.id);
          return <li key={item.id} className="rounded-xl bg-white p-4 shadow-sm">
            <p className="font-bold">{labels[item.status]}</p>
            {expectation
              ? <NextIntakeExpectationCard expectation={expectation} busy={busy} onRespond={respond} />
              : <p className="mt-2 text-sm text-gray-600">次回のお知らせ時期はまだ設定されていません。</p>}
            {item.candidate_submission_id && <p className="mt-2 text-xs text-green-700">次の処方せんを受付中です。</p>}
            {(item.status === 'active' || item.status === 'linked') && <button type="button" onClick={() => void pause(item.id)} disabled={busy} className="mt-3 min-h-11 text-sm text-gray-600 underline disabled:opacity-50">フォローを一時停止</button>}
          </li>;
        })}</ul>}
        <Link to="/prescriptions" className="block w-full rounded-xl bg-green-600 px-4 py-4 text-center font-bold text-white">処方せん事前送信へ</Link>
      </div>
    </main>
  );
}
