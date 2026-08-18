import { quickReply, withQuickReply, type Message } from '@line-crm/line-sdk';

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
  | 'prescription_validity_reminder_v1'
  | 'medication_followup_v1';

export type PharmacyMessageVars = {
  status?: 'received' | 'accepted' | 'needs_resubmission' | 'ready' | 'closed' | 'cancelled';
  reasonCode?: 'blurred' | 'cropped' | 'glare' | 'unreadable' | 'missing_page';
  intakeMethod?: 'E_PRESCRIPTION' | 'PAPER' | 'MEDICAL_INSTITUTION_SENT';
  liffId?: string;
  submissionId?: string;
  genericDate?: string;
  genericTime?: string;
  followUpId?: string;
};

const REASONS: Record<NonNullable<PharmacyMessageVars['reasonCode']>, string> = {
  blurred: '画像を確認できませんでした',
  cropped: '画像を確認できませんでした',
  glare: '画像を確認できませんでした',
  unreadable: '画像を確認できませんでした',
  missing_page: '画像を確認できませんでした',
};

export function pharmacyPrescriptionPageUrl(liffId: string, submissionId: string): string {
  const query = new URLSearchParams({ page: 'prescription', submissionId, liffId });
  return `https://liff.line.me/${encodeURIComponent(liffId)}/?${query.toString()}`;
}

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
    case 'medication_followup_v1':
      return 'お薬を使い始めてからの体調はいかがですか。あてはまるものを選んでください。';
    case 'prescription_status_v1':
      switch (vars.status) {
        case 'received':
          return vars.intakeMethod === 'E_PRESCRIPTION'
            ? '処方せんを受け付けました。薬局で内容を確認し、準備状況をLINEでお知らせします。'
            : vars.intakeMethod === 'MEDICAL_INSTITUTION_SENT'
              ? '受付内容を確認しています。準備状況はLINEでお知らせします。'
              : '受付内容の確認待ちです。確認後、LINEでお知らせします。処方せん原本は来局時にお持ちください。';
        case 'accepted':
          return '処方せんを確認し、受付しました。お薬を準備しています。';
        case 'needs_resubmission':
          return `処方せん画像をもう一度送信してください。${REASONS[vars.reasonCode ?? 'unreadable']}${vars.liffId && vars.submissionId
            ? `\n再送する: ${pharmacyPrescriptionPageUrl(vars.liffId, vars.submissionId)}`
            : ''}`;
        case 'ready':
          return vars.intakeMethod === 'E_PRESCRIPTION'
            ? 'お薬の準備ができました。ご案内した受取方法でお受け取りください。'
            : vars.intakeMethod === 'MEDICAL_INSTITUTION_SENT'
              ? 'お薬の準備ができました。薬局へ受取方法をご確認ください。'
              : 'お薬の準備ができました。処方せん原本を持って薬局へお越しください。';
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
  'medication_followup_v1',
]);
const VARIABLE_KEYS = new Set(['status', 'reasonCode', 'intakeMethod', 'liffId', 'submissionId', 'genericDate', 'genericTime', 'followUpId']);
const STATUSES = new Set(['received', 'accepted', 'needs_resubmission', 'ready', 'closed', 'cancelled']);
const REASON_CODES = new Set(Object.keys(REASONS));
const UNSAFE_RENDERED_TEXT = /薬剤名|疾患名|病名|医療機関名|医師名|患者名|自由記述|(?:病院|医院|診療所|クリニック|歯科)|(?:糖尿病|高血圧|がん|癌)|(?:ロキソニン|アムロジピン)|drug\s+name|diagnos(?:is|es)|hospital\s+name/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIFF_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Approved templates are the primary control. This final check is a cheap
 * second fence, not a claim of complete clinical-language detection.
 */
export function assertPharmacyAutomatedText(text: string): void {
  if (!text || text.length > 500) throw new Error('pharmacy notification payload rejected');
  if (UNSAFE_RENDERED_TEXT.test(text)) {
    throw new Error('pharmacy notification payload rejected');
  }
}

export function buildApprovedPharmacyMessage(
  id: PharmacyAutomatedMessageId,
  vars: PharmacyMessageVars = {},
): Message {
  if (!IDS.has(id)) throw new Error('unknown pharmacy notification message');
  if (Object.keys(vars).some((key) => !VARIABLE_KEYS.has(key))) {
    throw new Error('pharmacy notification variable rejected');
  }
  for (const [key, value] of Object.entries(vars)) {
    const maxLength = key === 'submissionId' ? 128 : 64;
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > maxLength)) {
      throw new Error('pharmacy notification variable rejected');
    }
  }
  if (vars.status && !STATUSES.has(vars.status)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (vars.reasonCode && !REASON_CODES.has(vars.reasonCode)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (vars.intakeMethod && !['E_PRESCRIPTION', 'PAPER', 'MEDICAL_INSTITUTION_SENT'].includes(vars.intakeMethod)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (vars.liffId && !LIFF_ID_RE.test(vars.liffId)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (vars.submissionId && !OPAQUE_ID_RE.test(vars.submissionId)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (id === 'prescription_status_v1' &&
      ((Boolean(vars.liffId) !== Boolean(vars.submissionId)) ||
       (Boolean(vars.liffId) && vars.status !== 'needs_resubmission') ||
       (Boolean(vars.intakeMethod) && vars.status !== 'received' && vars.status !== 'ready'))) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (vars.genericDate && !isDateOnly(vars.genericDate)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if (vars.genericTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(vars.genericTime)) {
    throw new Error('pharmacy notification variable rejected');
  }
  if ((id === 'medication_followup_v1') !== Boolean(vars.followUpId) ||
      (vars.followUpId && !UUID_RE.test(vars.followUpId)) ||
      (id === 'medication_followup_v1' && Object.keys(vars).some((key) => key !== 'followUpId'))) {
    throw new Error('pharmacy notification variable rejected');
  }
  const text = textFor(id, vars);
  assertPharmacyAutomatedText(text);
  if (id === 'medication_followup_v1') {
    const followUpId = vars.followUpId!;
    return withQuickReply({ type: 'text', text } as Message, quickReply([
      { type: 'action', action: { type: 'postback', label: '問題なし', data: `pharmacy-followup:${followUpId}:no_issue` } },
      { type: 'action', action: { type: 'postback', label: '気になることがある', data: `pharmacy-followup:${followUpId}:concern` } },
      { type: 'action', action: { type: 'postback', label: '薬剤師に相談したい', data: `pharmacy-followup:${followUpId}:pharmacist_requested` } },
    ]));
  }
  return { type: 'text', text };
}

export function isPharmacyAutomatedMessageId(value: string): value is PharmacyAutomatedMessageId {
  return IDS.has(value as PharmacyAutomatedMessageId);
}

export function isApprovedRenderedPharmacyMessage(
  id: string,
  message: Message,
): boolean {
  if (!isPharmacyAutomatedMessageId(id) || message.type !== 'text') return false;
  const same = (candidate: Message) => JSON.stringify(candidate) === JSON.stringify(message);
  if (id === 'medication_followup_v1') {
    const data = (message as Message & {
      quickReply?: { items?: Array<{ action?: { data?: string } }> };
    }).quickReply?.items?.[0]?.action?.data;
    const followUpId = /^pharmacy-followup:([^:]+):no_issue$/.exec(data ?? '')?.[1];
    if (!followUpId || !UUID_RE.test(followUpId)) return false;
    return same(buildApprovedPharmacyMessage(id, { followUpId }));
  }
  if (id === 'prescription_status_v1') {
    const variants = [undefined, ...STATUSES]
      .map((status) => buildApprovedPharmacyMessage(id, {
        status: status as PharmacyMessageVars['status'],
      }))
      .concat(
        (['received', 'ready'] as const).flatMap((status) =>
          (['E_PRESCRIPTION', 'PAPER', 'MEDICAL_INSTITUTION_SENT'] as const).map((intakeMethod) =>
            buildApprovedPharmacyMessage(id, { status, intakeMethod }),
          )),
      );
    const linkMatch = /再送する: https:\/\/liff\.line\.me\/([A-Za-z0-9_-]{1,64})\/\?page=prescription&submissionId=([^&\s]+)&liffId=([A-Za-z0-9_-]{1,64})$/.exec(message.text);
    if (linkMatch) {
      try {
        const submissionId = decodeURIComponent(linkMatch[2]);
        if (OPAQUE_ID_RE.test(submissionId)) {
          variants.push(buildApprovedPharmacyMessage(id, {
            status: 'needs_resubmission',
            liffId: linkMatch[3],
            submissionId,
          }));
        }
      } catch {
        return false;
      }
    }
    return variants.some(same);
  }
  if (id === 'prescription_validity_reminder_v1') {
    const date = /^(?:処方せんの使用期限が近づいています。)(\d{4}-\d{2}-\d{2})(?:までに薬局へご相談ください。)$/.exec(message.text)?.[1];
    return (!date || isDateOnly(date)) && [
      buildApprovedPharmacyMessage(id),
      ...(date ? [buildApprovedPharmacyMessage(id, { genericDate: date })] : []),
    ].some(same);
  }
  const expected = buildApprovedPharmacyMessage(id);
  return same(expected);
}
