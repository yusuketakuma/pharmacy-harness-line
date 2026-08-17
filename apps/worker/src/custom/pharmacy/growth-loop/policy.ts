import type { Message } from '@line-crm/line-sdk';

export type PharmacyNotificationCategory =
  | 'transactional_care'
  | 'followup_care'
  | 'continuity'
  | 'proactive_noncare'
  | 'manual';

export type PharmacyAutomatedMessageId =
  | 'pharmacy_onboarding_v1'
  | 'prescription_status_v1'
  | 'continuity_reminder_v1'
  | 'prescription_validity_reminder_v1';

export type PharmacyMessageVars = {
  status?: 'received' | 'accepted' | 'needs_resubmission' | 'ready' | 'closed' | 'cancelled';
  reasonCode?: 'blurred' | 'cropped' | 'glare' | 'unreadable' | 'missing_page';
  genericDate?: string;
  genericTime?: string;
};

const REASONS: Record<NonNullable<PharmacyMessageVars['reasonCode']>, string> = {
  blurred: '画像を確認できませんでした',
  cropped: '画像を確認できませんでした',
  glare: '画像を確認できませんでした',
  unreadable: '画像を確認できませんでした',
  missing_page: '画像を確認できませんでした',
};

function textFor(id: PharmacyAutomatedMessageId, vars: PharmacyMessageVars): string {
  switch (id) {
    case 'pharmacy_onboarding_v1':
      return '次回から、処方せんはこのLINEから事前に送れます。薬局で確認後、ご用意の状況をお知らせします。';
    case 'continuity_reminder_v1':
      return '次回のお薬の相談時期が近づいています。必要な処方せんがあれば、薬局へ事前送信できます。';
    case 'prescription_validity_reminder_v1':
      return vars.genericDate
        ? `処方せんの使用期限が近づいています。${vars.genericDate}までに薬局へご相談ください。`
        : '処方せんの使用期限が近づいています。薬局へご相談ください。';
    case 'prescription_status_v1':
      switch (vars.status) {
        case 'received':
          return '受付内容の確認待ちです。確認後、LINEでお知らせします。処方せん原本は来局時にお持ちください。';
        case 'accepted':
          return '処方せんを確認し、受付しました。お薬を準備しています。';
        case 'needs_resubmission':
          return `処方せん画像をもう一度送信してください。${REASONS[vars.reasonCode ?? 'unreadable']}`;
        case 'ready':
          return 'お薬の準備ができました。処方せん原本を持って薬局へお越しください。';
        case 'closed':
          return 'お薬のお渡しが完了しました。ご利用ありがとうございました。';
        case 'cancelled':
          return '処方せんの受付をキャンセルしました。ご不明点は個別チャットでお問い合わせください。';
        default:
          return '処方せんの受付状況が更新されました。';
      }
  }
}

const IDS = new Set<PharmacyAutomatedMessageId>([
  'pharmacy_onboarding_v1',
  'prescription_status_v1',
  'continuity_reminder_v1',
  'prescription_validity_reminder_v1',
]);

/**
 * Approved templates are the primary control. This final check is a cheap
 * second fence, not a claim of complete clinical-language detection.
 */
export function assertPharmacyAutomatedText(text: string): void {
  if (!text || text.length > 500) throw new Error('pharmacy notification payload rejected');
  if (/薬剤名|疾患名|病名|医療機関名|医師名|患者名|自由記述|drug\s+name|diagnos(?:is|es)|hospital\s+name/i.test(text)) {
    throw new Error('pharmacy notification payload rejected');
  }
}

export function buildApprovedPharmacyMessage(
  id: PharmacyAutomatedMessageId,
  vars: PharmacyMessageVars = {},
): Message {
  if (!IDS.has(id)) throw new Error('unknown pharmacy notification message');
  for (const value of Object.values(vars)) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 64)) {
      throw new Error('pharmacy notification variable rejected');
    }
  }
  if (vars.genericDate && !/^\d{4}-\d{2}-\d{2}$/.test(vars.genericDate)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (vars.genericTime && !/^\d{2}:\d{2}$/.test(vars.genericTime)) {
    throw new Error('pharmacy notification variable rejected');
  }
  const text = textFor(id, vars);
  assertPharmacyAutomatedText(text);
  return { type: 'text', text };
}

export function isPharmacyAutomatedMessageId(value: string): value is PharmacyAutomatedMessageId {
  return IDS.has(value as PharmacyAutomatedMessageId);
}
