import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// README 用スクリーンショット生成。通常の test:e2e では README 資産を上書きしない。
// 実行: cd apps/liff && README_SCREENSHOTS=1 pnpm exec playwright test e2e/readme-screenshots.e2e.ts
test.skip(!process.env.README_SCREENSHOTS, 'README screenshots are generated on demand');
test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
});

const outDir = fileURLToPath(new URL('../../../docs/assets/readme/screenshots/', import.meta.url));
const app = 'http://127.0.0.1:4303';

// すべて架空のデータ。実在の薬局・LINE ID・環境 URL は使わない。
const patient = {
  id: 'patient-hanako',
  relationship: 'self',
  name: '山田 花子',
  name_kana: 'ヤマダ ハナコ',
  birth_date: '1985-04-12',
  sex: 'female',
  contact_phone: null,
  postal_code: null,
  prefecture: null,
  city: null,
  address_line1: null,
  address_line2: null,
  archived_at: null,
  updated_at: '2026-10-01T00:00:00.000Z',
};

const submission = (id: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  active_revision: 1,
  upload_revision: 1,
  desired_pickup_at: null,
  desired_fulfillment_method: 'PICKUP',
  arrival_reported_at: null,
  estimated_ready_at: null,
  requirements_json: null,
  fulfillment_method: null,
  resubmission_reason_code: null,
  requested_at: createdAt,
  closed_at: null,
  created_at: createdAt,
  updated_at: createdAt,
  ...extra,
});

const bodies: Record<string, unknown> = {
  '/api/liff/pharmacy/feature-access': { data: { existingFeatures: ['prescription_intake', 'patient_intake'] } },
  '/api/liff/pharmacy/prescriptions/me': {
    submissions: [
      submission('rx-3', 'received', '2026-10-09T00:40:00.000Z', {
        desired_pickup_at: '2026-10-09T08:00:00.000Z',
      }),
      submission('rx-2', 'ready', '2026-10-02T06:10:00.000Z', {
        estimated_ready_at: '2026-10-02T08:30:00.000Z',
      }),
      submission('rx-1', 'closed', '2026-09-18T01:20:00.000Z', { closed_at: '2026-09-18T05:00:00.000Z' }),
    ],
  },
  '/api/liff/pharmacy/prescriptions/recovery': { recovery: { state: 'none' } },
  '/api/liff/pharmacy/patients': { patients: [patient] },
  '/api/liff/pharmacy/patients/patient-hanako/access': {
    access: {
      access: 'self',
      permission: 'patient_intake_v1',
      proxyExpiresAt: null,
      privacy: 'active',
      notifications: 'enabled',
      controlVersion: 1,
    },
  },
  '/api/liff/pharmacy/privacy-policy': {
    policy: {
      purpose_text: '調剤、服薬指導、お薬の準備に関するご連絡に利用します。',
      purpose_url: '',
      contact_point: 'さくら薬局 駅前店',
      entrustment_text: '',
      policy_version: 1,
      content_hash: 'a'.repeat(64),
    },
  },
  '/api/liff/pharmacy/myna-handoffs/active': { handoff: null },
  '/api/liff/pharmacy/continuity': { obligations: [], expectations: [] },
  '/api/liff/pharmacy/medication-followups': { followUps: [] },
};

// 処方せん送信画面はアンケート回答済みの状態で撮る（未回答だと送信前の案内が出る）。
const answeredIntake = {
  id: 'intake-hanako-1',
  patient_id: patient.id,
  revision: 1,
  schema_version: 3,
  patient_snapshot_json: '{}',
  answers_json: JSON.stringify({
    allergiesStatus: 'none',
    adverseReactionStatus: 'none',
    medicationStatus: 'none',
    medicalHistoryStatus: 'none',
    medicationNotebook: 'electronic',
    genericPreference: 'prefer',
    leftoverMedicationStatus: 'yes',
    leftoverMedicationDetail: '痛み止めが10錠ほど残っています',
  }),
  created_at: '2026-10-09T00:30:00.000Z',
};

async function mockPharmacy(page: Page, intake: typeof answeredIntake | null = null): Promise<string[]> {
  const unexpected: string[] = [];
  await page.clock.setFixedTime(new Date('2026-10-09T10:30:00+09:00'));
  await page.route('**/api/liff/config?**', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          accountName: 'さくら薬局 駅前店',
          enabledFeatures: [
            'prescription_intake',
            'patient_intake',
            'electronic_prescription',
            'continuity',
            'medication_followup',
            'emergency_contraception',
            'pharmacy_info',
          ],
          // 3 未満だとジェネリック・残薬の新質問が表示されない。
          intakeSchemaVersion: 3,
        },
      },
    }),
  );
  await page.route('**/api/liff/pharmacy/**', (route) => {
    const { pathname } = new URL(route.request().url());
    const body =
      route.request().method() !== 'GET'
        ? undefined
        : pathname === `/api/liff/pharmacy/patients/${patient.id}/intake`
          ? { intake }
          : bodies[pathname];
    if (body) return route.fulfill({ json: body });
    unexpected.push(`${route.request().method()} ${pathname}`);
    return route.fulfill({ status: 404, json: {} });
  });
  return unexpected;
}

async function shoot(page: Page, name: string) {
  await page.evaluate(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    await document.fonts.ready;
  });
  await page.screenshot({ path: `${outDir}${name}`, animations: 'disabled' });
}

async function choose(page: Page, name: string, value: string) {
  await page
    .locator('label')
    .filter({ has: page.locator(`input[name="${name}"][value="${value}"]`) })
    .click();
}

test('liff-menu.png', async ({ page }) => {
  const unexpected = await mockPharmacy(page);
  await page.goto(`${app}/pharmacy/menu?liffId=e2e-liff`);
  await expect(page.getByRole('heading', { name: 'すべての機能', level: 1 })).toBeVisible();
  await expect(page.getByText('さくら薬局 駅前店')).toBeVisible();
  await shoot(page, 'liff-menu.png');
  expect(unexpected).toEqual([]);
});

test('liff-prescription.png', async ({ page }) => {
  const unexpected = await mockPharmacy(page, answeredIntake);
  await page.goto(`${app}/prescriptions?view=send&liffId=e2e-liff`);
  await expect(page.getByRole('heading', { name: '処方せん事前送信', level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox').first()).toContainText('山田 花子');
  await expect(page.getByText('未送信の状態を確認しています')).toHaveCount(0);
  await expect(page.getByText('この患者のアンケートに回答')).toHaveCount(0);
  await shoot(page, 'liff-prescription.png');
  expect(unexpected).toEqual([]);
});

test('liff-status.png', async ({ page }) => {
  const unexpected = await mockPharmacy(page);
  await page.goto(`${app}/prescriptions?view=history&liffId=e2e-liff`);
  await expect(page.getByText('受付内容の確認待ち')).toBeVisible();
  await expect(page.getByRole('button', { name: '来局しました' })).toBeVisible();
  await page.locator('#history-heading').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -16));
  await shoot(page, 'liff-status.png');
  expect(unexpected).toEqual([]);
});

test('liff-intake-step2.png / liff-intake-confirm.png', async ({ page }) => {
  const unexpected = await mockPharmacy(page);
  await page.goto(`${app}/pharmacy/patient-intake?liffId=e2e-liff`);
  await expect(page.getByLabel('患者を選択')).toHaveValue('patient-hanako');
  await expect(page.getByText('設定を確認しています...')).toHaveCount(0);

  await choose(page, 'allergiesStatus', 'none');
  await choose(page, 'adverseReactionStatus', 'none');
  await choose(page, 'medicationStatus', 'none');
  await page.getByRole('button', { name: '次へ' }).click();

  await expect(page.getByRole('heading', { name: '体調・生活', level: 3 })).toBeVisible();
  await choose(page, 'medicalHistoryStatus', 'none');
  await choose(page, 'medicationNotebook', 'electronic');
  await choose(page, 'genericPreference', 'prefer');
  await choose(page, 'leftoverMedicationStatus', 'yes');
  await page
    .getByRole('textbox', { name: '余っているお薬の名前や量（わかる範囲で・任意）' })
    .fill('痛み止めが10錠ほど残っています');
  await page.locator('#intake-medicationNotebook').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -16));
  await shoot(page, 'liff-intake-step2.png');

  await page.getByRole('button', { name: '次へ' }).click();
  const summary = page.getByRole('group', { name: '送信内容の確認' });
  await expect(summary).toContainText('ジェネリックを希望する');
  await expect(summary).toContainText('余っているお薬（残薬）');
  await summary.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -16));
  await shoot(page, 'liff-intake-confirm.png');
  expect(unexpected).toEqual([]);
});
