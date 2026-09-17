import type {
  PatientRelationship,
  PatientSex,
  PharmacyPatient,
} from './api.js';
import { PharmacySpinner } from '../feedback.js';

const prefectures = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;

export const PATIENT_PROXY_TERMS_TEXT = '保護者として、この未成年の患者情報とアンケートを代理入力します。代理権限は登録から最長90日間（18歳になるまで）有効で、自動更新されず、いつでも取り消せます。';
export const PATIENT_PROXY_TERMS_HASH = '129e9ad353fff88b8623931245b5a1bed3ba30f2cb54e6b5f2c9be854c743f7c';

export interface PatientProfileDraft {
  relationship: PatientRelationship;
  name: string;
  nameKana: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  birthDate: string;
  sex: PatientSex | null;
  contactPhone: string;
  postalCode: string;
  prefecture: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
  proxyConsentAccepted: boolean;
}

export function emptyPatientProfileDraft(
  relationship: PatientRelationship,
): PatientProfileDraft {
  return {
    relationship,
    name: '',
    nameKana: '',
    birthYear: '',
    birthMonth: '',
    birthDay: '',
    birthDate: '',
    sex: null,
    contactPhone: '',
    postalCode: '',
    prefecture: '',
    city: '',
    addressLine1: '',
    addressLine2: '',
    proxyConsentAccepted: false,
  };
}

export function patientProfileDraft(patient: PharmacyPatient): PatientProfileDraft {
  const [birthYear = '', birthMonth = '', birthDay = ''] = patient.birth_date.split('-');
  return {
    relationship: patient.relationship,
    name: patient.name,
    nameKana: patient.name_kana,
    birthYear,
    birthMonth,
    birthDay,
    birthDate: patient.birth_date,
    sex: patient.sex,
    contactPhone: patient.contact_phone ?? '',
    postalCode: patient.postal_code ?? '',
    prefecture: patient.prefecture ?? '',
    city: patient.city ?? '',
    addressLine1: patient.address_line1 ?? '',
    addressLine2: patient.address_line2 ?? '',
    proxyConsentAccepted: false,
  };
}

function isRealBirthDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [year, month, day] = iso.split('-').map(Number);
  if (year < 1900 || month < 1 || month > 12 || day < 1) return false;
  if (day > new Date(year, month, 0).getDate()) return false;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return iso <= today;
}

export type PatientProfileErrors = Partial<Record<keyof PatientProfileDraft, string>>;

function isMinorBirthDate(birthDate: string): boolean {
  if (!birthDate) return false;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (birthDate > today) return false;
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = today.split('-').map(Number);
  return year - birthYear - (month < birthMonth || (month === birthMonth && day < birthDay) ? 1 : 0) < 18;
}

export function patientProfileErrors(
  draft: PatientProfileDraft,
  editing = false,
): PatientProfileErrors {
  const errors: PatientProfileErrors = {};
  if (!draft.name.trim()) errors.name = '氏名を入力してください';
  if (!draft.nameKana.trim()) errors.nameKana = '氏名カナを入力してください';
  if (!draft.birthDate) errors.birthDate = draft.birthYear || draft.birthMonth || draft.birthDay
    ? '生年月日を正しい日付で入力してください'
    : '生年月日を入力してください';
  if (!editing && ['spouse', 'parent', 'other'].includes(draft.relationship)) {
    errors.relationship = '成人のご家族は薬局で本人確認が必要です';
  } else if (!editing && draft.relationship === 'child' && draft.birthDate &&
             !isMinorBirthDate(draft.birthDate)) {
    errors.relationship = '18歳以上のご家族は薬局で本人確認が必要です';
  } else if (!editing && draft.relationship === 'child' && !draft.proxyConsentAccepted) {
    errors.proxyConsentAccepted = '代理入力の条件を確認して同意してください';
  }
  const hasAddress = Boolean(
    draft.postalCode.trim() || draft.prefecture || draft.city.trim() ||
    draft.addressLine1.trim() || draft.addressLine2.trim(),
  );
  if (hasAddress) {
    if (!/^\d{3}-?\d{4}$/.test(draft.postalCode.trim())) errors.postalCode = '郵便番号は 000-0000 の形式で入力してください';
    if (!draft.prefecture) errors.prefecture = '都道府県を選んでください';
    if (!draft.city.trim()) errors.city = '市区町村を入力してください';
    if (!draft.addressLine1.trim()) errors.addressLine1 = '番地を入力してください';
  }
  return errors;
}

const REQUIRED_BADGE = <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-sm font-bold text-red-800">必須</span>;

function FieldError({ message }: { message?: string }) {
  return message ? <span role="alert" className="mt-1 block text-base font-bold text-red-700">{message}</span> : null;
}

export function PatientProfileForm({
  draft,
  editing,
  busy,
  showAddress,
  errors = {},
  onChange,
  onToggleAddress,
  onSubmit,
}: {
  draft: PatientProfileDraft;
  editing: boolean;
  busy: boolean;
  showAddress: boolean;
  errors?: PatientProfileErrors;
  onChange: <K extends keyof PatientProfileDraft>(
    key: K,
    value: PatientProfileDraft[K],
  ) => void;
  onToggleAddress: () => void;
  onSubmit: () => void;
}) {
  const requiresPharmacyVerification = !editing && (
    ['spouse', 'parent', 'other'].includes(draft.relationship) ||
    (draft.relationship === 'child' && Boolean(draft.birthDate) &&
      !isMinorBirthDate(draft.birthDate))
  );

  function updateBirthPart(part: 'birthYear' | 'birthMonth' | 'birthDay', raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, part === 'birthYear' ? 4 : 2);
    const next = {
      birthYear: part === 'birthYear' ? digits : draft.birthYear,
      birthMonth: part === 'birthMonth' ? digits : draft.birthMonth,
      birthDay: part === 'birthDay' ? digits : draft.birthDay,
    };
    onChange(part, digits);
    const iso = next.birthYear.length === 4 && next.birthMonth && next.birthDay
      ? `${next.birthYear}-${next.birthMonth.padStart(2, '0')}-${next.birthDay.padStart(2, '0')}`
      : '';
    onChange('birthDate', iso && isRealBirthDate(iso) ? iso : '');
  }
  return (
    <div className="space-y-3" aria-label="家族を追加">
      {editing ? <p className="text-base">続柄：本人</p> : (
        <label className="block text-base">
          続柄
          <select
            value={draft.relationship}
            onChange={(event) => onChange('relationship', event.target.value as PatientRelationship)}
            className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base"
          >
            <option value="self">本人</option>
            <option value="child">子ども</option>
            <option value="spouse">配偶者</option>
            <option value="parent">親</option>
            <option value="other">その他</option>
          </select>
          <FieldError message={errors.relationship} />
        </label>
      )}
      {requiresPharmacyVerification && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-base text-amber-900">
          {draft.relationship === 'child' ? '18歳以上' : '成人'}のご家族は薬局で本人確認が必要です。薬局へお問い合わせください。
        </p>
      )}
      {!editing && draft.relationship === 'child' && !requiresPharmacyVerification && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-base leading-6 text-gray-800">
          <p className="font-bold">保護者による代理入力</p>
          <p>{PATIENT_PROXY_TERMS_TEXT}</p>
          <label className="mt-2 flex min-h-11 items-start gap-3 font-bold">
            <input
              type="checkbox"
              checked={draft.proxyConsentAccepted}
              onChange={(event) => onChange('proxyConsentAccepted', event.target.checked)}
              className="mt-1 h-5 w-5 text-base"
            />
            私は、この子どもの情報を代理入力する権限のある親または法定代理人であることを申し出て、条件に同意します
          </label>
          <FieldError message={errors.proxyConsentAccepted} />
        </div>
      )}
      <label className="block text-base">
        氏名{REQUIRED_BADGE}
        <input required aria-invalid={errors.name ? true : undefined} autoComplete="name" value={draft.name} onChange={(event) => onChange('name', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" />
        <FieldError message={errors.name} />
      </label>
      <label className="block text-base">
        氏名カナ{REQUIRED_BADGE}
        <input required aria-invalid={errors.nameKana ? true : undefined} autoComplete="off" value={draft.nameKana} onChange={(event) => onChange('nameKana', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" />
        <FieldError message={errors.nameKana} />
      </label>
      <fieldset className="space-y-1" aria-invalid={errors.birthDate ? true : undefined}>
        <legend className="text-base">生年月日{REQUIRED_BADGE}</legend>
        <div className="flex items-center gap-2">
          <label className="min-w-0 flex-[2]"><span className="sr-only">年（西暦）</span>
            <input id="birth-year" required aria-invalid={errors.birthDate ? true : undefined} type="text" inputMode="numeric" autoComplete="bday-year" placeholder="1950" maxLength={4}
              value={draft.birthYear} onChange={(event) => updateBirthPart('birthYear', event.target.value)} className="block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" disabled={busy} />
          </label>
          <span className="text-base">年</span>
          <label className="min-w-0 flex-1"><span className="sr-only">月</span>
            <input id="birth-month" required aria-invalid={errors.birthDate ? true : undefined} type="text" inputMode="numeric" autoComplete="bday-month" placeholder="1" maxLength={2}
              value={draft.birthMonth} onChange={(event) => updateBirthPart('birthMonth', event.target.value)} className="block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" disabled={busy} />
          </label>
          <span className="text-base">月</span>
          <label className="min-w-0 flex-1"><span className="sr-only">日</span>
            <input id="birth-day" required aria-invalid={errors.birthDate ? true : undefined} type="text" inputMode="numeric" autoComplete="bday-day" placeholder="5" maxLength={2}
              value={draft.birthDay} onChange={(event) => updateBirthPart('birthDay', event.target.value)} className="block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" disabled={busy} />
          </label>
          <span className="text-base">日</span>
        </div>
        <p className="text-base text-gray-600">西暦で入力してください。</p>
        <FieldError message={errors.birthDate} />
      </fieldset>
      <label className="block text-base">
        性別（任意）
        <select value={draft.sex ?? ''} onChange={(event) => onChange('sex', (event.target.value || null) as PatientSex | null)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base">
          <option value="">回答しない</option>
          <option value="male">男性</option>
          <option value="female">女性</option>
          <option value="other">その他</option>
        </select>
      </label>
      <label className="block text-base">
        電話番号（任意）
        <input type="tel" inputMode="tel" autoComplete="tel" value={draft.contactPhone} onChange={(event) => onChange('contactPhone', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base" placeholder="薬局からの連絡用" maxLength={40} />
      </label>
      <button type="button" className="pharmacy-control min-h-11 text-left text-base font-bold text-green-800" onClick={onToggleAddress}>
        {showAddress ? '住所を閉じる' : '住所を登録する（配送・訪問時に使用）'}
      </button>
      {showAddress && <div className="space-y-3 rounded-lg bg-gray-50 p-3">
        <label className="block text-base">
          郵便番号
          <input aria-invalid={errors.postalCode ? true : undefined} inputMode="numeric" autoComplete="postal-code" value={draft.postalCode} onChange={(event) => onChange('postalCode', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" placeholder="000-0000" maxLength={8} />
          <FieldError message={errors.postalCode} />
        </label>
        <label className="block text-base">
          都道府県
          <select aria-invalid={errors.prefecture ? true : undefined} autoComplete="address-level1" value={draft.prefecture} onChange={(event) => onChange('prefecture', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base">
            <option value="">選択してください</option>
            {prefectures.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <FieldError message={errors.prefecture} />
        </label>
        <label className="block text-base">
          市区町村
          <input aria-invalid={errors.city ? true : undefined} autoComplete="address-level2" value={draft.city} onChange={(event) => onChange('city', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" maxLength={120} />
          <FieldError message={errors.city} />
        </label>
        <label className="block text-base">
          番地
          <input aria-invalid={errors.addressLine1 ? true : undefined} autoComplete="street-address" value={draft.addressLine1} onChange={(event) => onChange('addressLine1', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base aria-[invalid]:border-red-500" maxLength={240} />
          <FieldError message={errors.addressLine1} />
        </label>
        <label className="block text-base">
          建物名・部屋番号（任意）
          <input autoComplete="address-line2" value={draft.addressLine2} onChange={(event) => onChange('addressLine2', event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border p-3 text-base" maxLength={240} />
        </label>
      </div>}
      <button type="button" onClick={onSubmit} disabled={busy || requiresPharmacyVerification} aria-busy={busy} className="min-h-11 w-full rounded-lg bg-green-700 px-4 py-3 font-bold text-white disabled:bg-gray-300">
        {busy ? <PharmacySpinner label="送信中…" /> : editing ? '患者情報を更新する' : '患者を登録する'}
      </button>
    </div>
  );
}
