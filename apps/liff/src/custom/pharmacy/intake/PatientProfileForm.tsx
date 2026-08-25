import type {
  PatientRelationship,
  PatientSex,
  PharmacyPatient,
} from './api.js';

const prefectures = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;

export interface PatientProfileDraft {
  relationship: PatientRelationship;
  name: string;
  nameKana: string;
  birthDate: string;
  sex: PatientSex | null;
  contactPhone: string;
  postalCode: string;
  prefecture: string;
  city: string;
  addressLine1: string;
  addressLine2: string;
}

export function emptyPatientProfileDraft(
  relationship: PatientRelationship,
): PatientProfileDraft {
  return {
    relationship,
    name: '',
    nameKana: '',
    birthDate: '',
    sex: null,
    contactPhone: '',
    postalCode: '',
    prefecture: '',
    city: '',
    addressLine1: '',
    addressLine2: '',
  };
}

export function patientProfileDraft(patient: PharmacyPatient): PatientProfileDraft {
  return {
    relationship: patient.relationship,
    name: patient.name,
    nameKana: patient.name_kana,
    birthDate: patient.birth_date,
    sex: patient.sex,
    contactPhone: patient.contact_phone ?? '',
    postalCode: patient.postal_code ?? '',
    prefecture: patient.prefecture ?? '',
    city: patient.city ?? '',
    addressLine1: patient.address_line1 ?? '',
    addressLine2: patient.address_line2 ?? '',
  };
}

export type PatientProfileErrors = Partial<Record<keyof PatientProfileDraft, string>>;

export function patientProfileErrors(draft: PatientProfileDraft): PatientProfileErrors {
  const errors: PatientProfileErrors = {};
  if (!draft.name.trim()) errors.name = '氏名を入力してください';
  if (!draft.nameKana.trim()) errors.nameKana = '氏名カナを入力してください';
  if (!draft.birthDate) errors.birthDate = '生年月日を入力してください';
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
  return message ? <span role="alert" className="mt-1 block text-sm font-bold text-red-700">{message}</span> : null;
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
  return (
    <div className="space-y-3" aria-label="家族を追加">
      <label className="block text-sm">
        続柄
        <select
          value={draft.relationship}
          onChange={(event) => onChange('relationship', event.target.value as PatientRelationship)}
          className="mt-1 block w-full rounded-lg border p-3"
        >
          <option value="self">本人</option>
          <option value="child">子ども</option>
          <option value="spouse">配偶者</option>
          <option value="parent">親</option>
          <option value="other">その他</option>
        </select>
      </label>
      <label className="block text-sm">
        氏名{REQUIRED_BADGE}
        <input required aria-invalid={errors.name ? true : undefined} autoComplete="name" value={draft.name} onChange={(event) => onChange('name', event.target.value)} className="mt-1 block w-full rounded-lg border p-3 aria-[invalid]:border-red-500" />
        <FieldError message={errors.name} />
      </label>
      <label className="block text-sm">
        氏名カナ{REQUIRED_BADGE}
        <input required aria-invalid={errors.nameKana ? true : undefined} autoComplete="off" value={draft.nameKana} onChange={(event) => onChange('nameKana', event.target.value)} className="mt-1 block w-full rounded-lg border p-3 aria-[invalid]:border-red-500" />
        <FieldError message={errors.nameKana} />
      </label>
      <label className="block text-sm">
        生年月日{REQUIRED_BADGE}
        <input required aria-invalid={errors.birthDate ? true : undefined} type="date" autoComplete="bday" value={draft.birthDate} onChange={(event) => onChange('birthDate', event.target.value)} className="mt-1 block w-full rounded-lg border p-3 aria-[invalid]:border-red-500" />
        <FieldError message={errors.birthDate} />
      </label>
      <label className="block text-sm">
        性別（任意）
        <select value={draft.sex ?? ''} onChange={(event) => onChange('sex', (event.target.value || null) as PatientSex | null)} className="mt-1 block w-full rounded-lg border p-3">
          <option value="">回答しない</option>
          <option value="male">男性</option>
          <option value="female">女性</option>
          <option value="other">その他</option>
        </select>
      </label>
      <label className="block text-sm">
        電話番号（任意）
        <input type="tel" inputMode="tel" autoComplete="tel" value={draft.contactPhone} onChange={(event) => onChange('contactPhone', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" placeholder="薬局からの連絡用" maxLength={40} />
      </label>
      <button type="button" className="pharmacy-control min-h-11 text-left text-base font-bold text-green-800" onClick={onToggleAddress}>
        {showAddress ? '住所を閉じる' : '住所を登録する（配送・訪問時に使用）'}
      </button>
      {showAddress && <div className="space-y-3 rounded-lg bg-gray-50 p-3">
        <label className="block text-sm">
          郵便番号
          <input aria-invalid={errors.postalCode ? true : undefined} inputMode="numeric" autoComplete="postal-code" value={draft.postalCode} onChange={(event) => onChange('postalCode', event.target.value)} className="mt-1 block w-full rounded-lg border p-3 aria-[invalid]:border-red-500" placeholder="000-0000" maxLength={8} />
          <FieldError message={errors.postalCode} />
        </label>
        <label className="block text-sm">
          都道府県
          <select aria-invalid={errors.prefecture ? true : undefined} autoComplete="address-level1" value={draft.prefecture} onChange={(event) => onChange('prefecture', event.target.value)} className="mt-1 block w-full rounded-lg border p-3">
            <option value="">選択してください</option>
            {prefectures.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <FieldError message={errors.prefecture} />
        </label>
        <label className="block text-sm">
          市区町村
          <input aria-invalid={errors.city ? true : undefined} autoComplete="address-level2" value={draft.city} onChange={(event) => onChange('city', event.target.value)} className="mt-1 block w-full rounded-lg border p-3 aria-[invalid]:border-red-500" maxLength={120} />
          <FieldError message={errors.city} />
        </label>
        <label className="block text-sm">
          番地
          <input aria-invalid={errors.addressLine1 ? true : undefined} autoComplete="street-address" value={draft.addressLine1} onChange={(event) => onChange('addressLine1', event.target.value)} className="mt-1 block w-full rounded-lg border p-3 aria-[invalid]:border-red-500" maxLength={240} />
          <FieldError message={errors.addressLine1} />
        </label>
        <label className="block text-sm">
          建物名・部屋番号（任意）
          <input autoComplete="address-line2" value={draft.addressLine2} onChange={(event) => onChange('addressLine2', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" maxLength={240} />
        </label>
      </div>}
      <button type="button" onClick={onSubmit} disabled={busy} className="min-h-11 w-full rounded-lg bg-green-700 px-4 py-3 font-bold text-white disabled:bg-gray-300">
        {editing ? '患者情報を更新する' : '患者を登録する'}
      </button>
    </div>
  );
}
