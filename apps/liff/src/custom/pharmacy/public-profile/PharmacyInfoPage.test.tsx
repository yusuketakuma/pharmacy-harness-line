import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PharmacyInfoContent,
  pharmacyGoogleMapsUrl,
} from './PharmacyInfoPage.js';

const profile = {
  line_account_id: 'account-a', display_name: 'みどり薬局', phone: '03-1234-5678', fax_number: '03-1234-5679',
  postal_code: '100-0001', address: '東京都千代田区千代田1-1',
  business_hours: '月〜金 9:00〜18:00', closure_notice: '日曜・祝日は休業',
  access_note: '駅東口から徒歩3分', parking_note: '店舗前に2台',
  google_maps_url: '', prescription_reception_hours: '月〜金 17:30まで',
  after_hours_note: '時間外は電話でご相談ください', services_note: 'オンライン服薬指導',
  accessibility_note: '車いすで入店できます', supported_languages: '日本語・英語',
  payment_methods: '現金・クレジットカード', website_url: 'https://pharmacy.example.test',
  updated_at: '2026-08-20T00:00:00.000Z',
};

describe('pharmacy information LIFF page', () => {
  it('renders patient-useful public information and safe actions', () => {
    const html = renderToStaticMarkup(<PharmacyInfoContent profile={profile} />);
    for (const text of ['みどり薬局', '営業時間', '月〜金 9:00〜18:00', '住所',
      'Google Mapsで開く', '電話番号', '03-1234-5678', '電話する', 'FAX番号',
      '03-1234-5679', '休業・臨時案内', 'アクセス', '駐車場']) {
      expect(html).toContain(text);
    }
    for (const text of ['処方せん受付時間', '時間外の対応', '利用できるサービス',
      'バリアフリー', '対応言語', '支払方法', '公式サイト', '最終更新']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('bg-green-700');
    expect(html).not.toContain('account-a');

    const unsafe = renderToStaticMarkup(<PharmacyInfoContent profile={{
      ...profile, website_url: 'javascript:alert(1)', updated_at: null,
    }} />);
    expect(unsafe).not.toContain('公式サイト');
    expect(unsafe).not.toContain('javascript:');
  });

  it('derives a Google Maps search URL from the address when no custom URL exists', () => {
    expect(pharmacyGoogleMapsUrl(profile)).toBe(
      'https://www.google.com/maps/search/?api=1&query=%E6%9D%B1%E4%BA%AC%E9%83%BD%E5%8D%83%E4%BB%A3%E7%94%B0%E5%8C%BA%E5%8D%83%E4%BB%A3%E7%94%B01-1',
    );
    expect(pharmacyGoogleMapsUrl({ ...profile, google_maps_url: 'https://maps.app.goo.gl/test' }))
      .toBe('https://maps.app.goo.gl/test');
  });

  it('keeps the FAX field visible when the pharmacy has not configured a number', () => {
    const html = renderToStaticMarkup(<PharmacyInfoContent profile={{
      ...profile, fax_number: '',
    }} />);
    expect(html).toContain('FAX番号');
    expect(html).toContain('未設定');
  });
});
