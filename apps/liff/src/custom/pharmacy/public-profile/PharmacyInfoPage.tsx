import { useCallback, useEffect, useState } from 'react';
import {
  pharmacyPublicProfileApi,
  type PharmacyPublicProfile,
} from './api.js';

function safeGoogleMapsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && [
      'www.google.com', 'google.com', 'maps.google.com', 'www.google.co.jp', 'maps.app.goo.gl',
    ].includes(url.hostname) ? value : null;
  } catch {
    return null;
  }
}

export function pharmacyGoogleMapsUrl(
  profile: Pick<PharmacyPublicProfile, 'google_maps_url' | 'address'>,
): string | null {
  const configured = safeGoogleMapsUrl(profile.google_maps_url);
  if (configured) return configured;
  return profile.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(profile.address)}`
    : null;
}

export function PharmacyInfoContent({ profile }: { profile: PharmacyPublicProfile }) {
  const mapUrl = pharmacyGoogleMapsUrl(profile);
  const phoneHref = profile.phone ? `tel:${profile.phone.replace(/[^0-9+]/g, '')}` : null;
  return (
    <div className="space-y-4 p-4">
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <p className="text-xs font-bold tracking-wide text-green-700">PHARMACY</p>
        <h1 className="mt-1 text-2xl font-bold text-gray-950">{profile.display_name}</h1>
        {profile.closure_notice && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900"><span className="font-bold">休業・臨時案内</span><br />{profile.closure_notice}</p>}
      </section>
      <section className="rounded-2xl bg-white p-5 shadow-sm" aria-labelledby="hours-title">
        <h2 id="hours-title" className="font-bold text-gray-950">営業時間</h2>
        <p className="mt-2 whitespace-pre-line text-sm leading-7 text-gray-700">{profile.business_hours || '営業時間は薬局へお問い合わせください。'}</p>
      </section>
      <section className="rounded-2xl bg-white p-5 shadow-sm" aria-labelledby="access-title">
        <h2 id="access-title" className="font-bold text-gray-950">住所・アクセス</h2>
        <p className="mt-2 text-sm leading-6 text-gray-700"><span className="font-medium">住所</span><br />{[profile.postal_code && `〒${profile.postal_code}`, profile.address].filter(Boolean).join(' ') || '未設定'}</p>
        {profile.access_note && <p className="mt-3 whitespace-pre-line text-sm leading-6 text-gray-700"><span className="font-medium">アクセス</span><br />{profile.access_note}</p>}
        {profile.parking_note && <p className="mt-3 whitespace-pre-line text-sm leading-6 text-gray-700"><span className="font-medium">駐車場</span><br />{profile.parking_note}</p>}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {mapUrl && <a href={mapUrl} target="_blank" rel="noreferrer noopener" className="min-h-11 rounded-xl bg-green-700 px-4 py-3 text-center font-bold text-white">Google Mapsで開く</a>}
          {phoneHref && <a href={phoneHref} className="min-h-11 rounded-xl border border-green-600 bg-white px-4 py-3 text-center font-bold text-green-700">電話する</a>}
        </div>
      </section>
    </div>
  );
}

export default function PharmacyInfoPage() {
  const [profile, setProfile] = useState<PharmacyPublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setProfile((await pharmacyPublicProfileApi.get()).profile);
    } catch {
      setError('薬局情報を読み込めませんでした。通信状態を確認して再読み込みしてください。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="mx-auto min-h-screen max-w-md bg-gray-50 pb-10">
      {loading && <p role="status" className="p-8 text-center text-sm text-gray-600">薬局情報を読み込み中...</p>}
      {error && <div role="alert" className="m-4 rounded-xl bg-red-50 p-4 text-sm text-red-800"><p>{error}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-red-300 bg-white px-4 py-2 font-bold">再読み込み</button></div>}
      {!loading && !error && profile && <PharmacyInfoContent profile={profile} />}
    </main>
  );
}
