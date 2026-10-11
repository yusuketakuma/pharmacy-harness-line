import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// README 用スクリーンショット生成。通常の test:e2e では README 資産を上書きしない。
// 実行: cd apps/web && README_SCREENSHOTS=1 pnpm exec playwright test e2e/readme-screenshots.e2e.ts
test.skip(!process.env.README_SCREENSHOTS, 'README screenshots are generated on demand');
test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
});

const outDir = path.resolve(__dirname, '../../../docs/assets/readme/screenshots');
const accountId = 'acct-sakura-ekimae';
const checkedAt = '2026-10-09T01:30:00.000Z';

// すべて架空のデータ。実在の薬局・患者・LINE ID・環境 URL は使わない。
const patients = [
  {
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
  },
  {
    id: 'patient-kenichi',
    relationship: 'self',
    name: '佐藤 健一',
    name_kana: 'サトウ ケンイチ',
    birth_date: '1958-11-30',
    sex: 'male',
    contact_phone: null,
    postal_code: null,
    prefecture: null,
    city: null,
    address_line1: null,
    address_line2: null,
    archived_at: null,
    updated_at: '2026-09-20T00:00:00.000Z',
  },
];

const queueItem = (id: string, name: string, status: string, createdAt: string, desiredPickupAt: string | null) => ({
  id,
  friend_id: `friend-${id}`,
  patient_display_name: name,
  status,
  desired_pickup_at: desiredPickupAt,
  desired_fulfillment_method: 'PICKUP',
  arrival_reported_at: null,
  requested_at: createdAt,
  created_at: createdAt,
  updated_at: createdAt,
});

const domain = (activeCount: number, statusCounts: Record<string, number>) => ({
  enabled: true,
  activeCount,
  statusCounts,
  updatedAt: checkedAt,
  error: false,
});

const disabledDomain = { enabled: false, activeCount: 0, statusCounts: {}, updatedAt: null, error: false };

const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  matureCohort: denominator,
  immatureCohort: 0,
});

const envelope = (data: unknown) => ({ success: true, data });

const responses: Record<string, unknown> = {
  '/api/auth/session': {
    success: true,
    data: {
      id: 'staff-misaki',
      name: '高橋 美咲',
      role: 'owner',
      tenantId: 'tenant-sakura',
      tenantCode: 'SAKURA',
      tenantName: 'さくら薬局',
      mustChangePassword: false,
    },
    csrfToken: 'readme-csrf',
  },
  '/api/line-accounts': envelope([
    {
      id: accountId,
      channelId: 'channel-sakura-ekimae',
      name: 'さくら薬局 駅前店',
      displayName: 'さくら薬局 駅前店',
      isActive: true,
      country: 'JP',
      role: null,
      displayOrder: 0,
      pharmacyMode: true,
    },
  ]),
  '/api/custom/pharmacy/growth/config': envelope({
    line_account_id: accountId,
    mode: 'pharmacy',
    // 1440x900 でサイドバーの4グループ名（ホーム〜設定・安全）が収まるよう、有効機能を絞る。
    capabilities: [
      'prescription_intake',
      'patient_intake',
      'medication_followup',
      'pharmacy_info',
      'pharmacy_dashboard',
    ],
    proactive_monthly_limit: 4,
    unfollow_alert_state: 'alert_only',
    revision: 1,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  }),
  '/api/custom/pharmacy/active-work': envelope({}),
  '/api/inbox/unanswered/count': envelope({ total: 0 }),
  '/api/custom/pharmacy/operations-summary': envelope({
    accountId,
    checkedAt,
    capabilityError: false,
    domains: {
      prescriptionIntake: domain(3, { received: 1, accepted: 1, ready: 1 }),
      electronicPrescription: disabledDomain,
      patientIntake: domain(2, { unreviewed: 2 }),
      continuity: disabledDomain,
      medicationFollowup: domain(1, { delivered: 1 }),
      emergencyContraception: disabledDomain,
    },
    richMenu: {
      status: 'READY',
      capabilityEnabled: true,
      layoutConfigured: true,
      savedVersionAvailable: true,
      catalogVersionCurrent: true,
      publishedVersionAvailable: true,
      currentDefaultRecorded: true,
      error: false,
    },
  }),
  '/api/custom/pharmacy/action-queue': envelope({
    accountId,
    checkedAt,
    partial: false,
    truncated: false,
    items: [
      { domain: 'prescriptionIntake', status: 'received', deadline: 'today', detailHref: '/prescriptions' },
      { domain: 'patientIntake', status: 'unreviewed', deadline: 'today', detailHref: '/patient-intakes' },
      { domain: 'medicationFollowup', status: 'delivered', deadline: 'upcoming', detailHref: '/patient-intakes' },
    ],
  }),
  '/api/custom/pharmacy/growth/dashboard': envelope({
    from: '2026-09-10',
    to: '2026-10-09',
    entry: {
      firstTimeFollows: 42,
      measurableFollows: 40,
      firstSubmissions: 18,
      secondSubmissions: 7,
      firstSubmissionRate: rate(18, 40),
      secondSubmissionRate: rate(7, 18),
    },
    sources: {
      primary: 12,
      other: 4,
      unknown: 2,
      otherShare: 0.25,
      knownDenominator: 16,
      attributionCoverage: 0.89,
    },
    promises: {
      promised: 20,
      onTime: 18,
      late: 2,
      onTimeRate: 0.9,
      p50LatenessMinutes: 5,
      p90LatenessMinutes: 15,
      promiseRevisionCount: 1,
      promiseWithoutReady: 0,
      readyEvents: 20,
      promiseWithoutQuote: 0,
      graceMinutes: 10,
    },
    validity: {
      verified: 15,
      reminderSent: 2,
      reminderClosedInTime: 2,
      expiredReviewRequired: 0,
      confirmedExpired: 0,
    },
    notifications: {
      counts: { sent: 30 },
      proactiveCapBlocked: 0,
      proactiveAttempts: 6,
      attempted: 30,
      reconciliationRequired: 0,
      alertState: 'alert_only',
    },
    messaging: {
      sent: 64,
      received: 51,
      manual: 22,
      automated: 42,
      sourceUnverified: 0,
      push: 30,
      reply: 34,
      deliveryUnverified: 0,
      uniqueCorrespondents: 25,
      attempted: 64,
      reconciliationRequired: 0,
      legacyUnscoped: { count: null, status: 'UNVERIFIED' },
    },
    unfollow: {
      exposedFriends: 30,
      within24h: 0,
      within72h: 1,
      sampleSize: 30,
      interpretation: 'insufficient_sample',
    },
  }),
  '/api/custom/pharmacy/growth/sources': envelope([]),
  '/api/custom/pharmacy/prescriptions/stats': {
    stats: {
      pending_count: 1,
      oldest_wait_at: '2026-10-09T00:40:00.000Z',
      draft_count: 0,
      received_count: 1,
      needs_resubmission_count: 0,
      accepted_count: 1,
      ready_count: 1,
      closed_count: 0,
      cancelled_count: 0,
      total_count: 3,
    },
  },
  '/api/custom/pharmacy/prescriptions': {
    items: [
      queueItem('rx-hanako', '山田 花子', 'received', '2026-10-09T00:40:00.000Z', '2026-10-09T08:00:00.000Z'),
      queueItem('rx-kenichi', '佐藤 健一', 'accepted', '2026-10-09T00:15:00.000Z', null),
      queueItem('rx-yoko', '鈴木 陽子', 'ready', '2026-10-08T06:10:00.000Z', '2026-10-08T09:30:00.000Z'),
    ],
    nextCursor: null,
  },
  '/api/custom/pharmacy/patients': { patients },
  '/api/custom/pharmacy/patients/patient-hanako/history': {
    history: {
      patient: patients[0],
      intakes: [
        {
          id: 'intake-hanako-1',
          patient_id: 'patient-hanako',
          revision: 1,
          schema_version: 3,
          representative_consent_at: '2026-10-09T00:30:00.000Z',
          privacy_consent_at: '2026-10-09T00:30:00.000Z',
          created_at: '2026-10-09T00:30:00.000Z',
        },
      ],
      latestIntake: {
        id: 'intake-hanako-1',
        patient_id: 'patient-hanako',
        revision: 1,
        schema_version: 3,
        representative_consent_at: '2026-10-09T00:30:00.000Z',
        privacy_consent_at: '2026-10-09T00:30:00.000Z',
        created_at: '2026-10-09T00:30:00.000Z',
        answers: {
          allergiesStatus: 'none',
          adverseReactionStatus: 'none',
          medicationStatus: 'none',
          medicalHistoryStatus: 'none',
          medicalHistoryTags: [],
          medicationNotebook: 'electronic',
          genericPreference: 'prefer',
          leftoverMedicationStatus: 'yes',
          leftoverMedicationDetail: '痛み止めが10錠ほど残っています',
          smokingStatus: 'unknown',
          alcoholStatus: 'unknown',
          medicationAdherence: 'unknown',
          pregnancyStatus: 'not_applicable',
          breastfeedingStatus: 'not_applicable',
          notes: '',
        },
      },
      prescriptions: [
        {
          id: 'rx-hanako',
          status: 'received',
          active_revision: 1,
          desired_pickup_at: '2026-10-09T08:00:00.000Z',
          requested_at: '2026-10-09T00:40:00.000Z',
          closed_at: null,
          created_at: '2026-10-09T00:40:00.000Z',
          updated_at: '2026-10-09T00:40:00.000Z',
        },
      ],
      quotes: [],
      continuity: [],
      medicationFollowUps: [],
      timeline: [
        { kind: 'prescription', occurred_at: '2026-10-09T00:40:00.000Z', label: '処方せん受付', status: 'received' },
        { kind: 'intake', occurred_at: '2026-10-09T00:30:00.000Z', label: 'アンケート回答 第1版', status: null },
      ],
    },
  },
  '/api/custom/pharmacy/medication-followups/operations': { operations: null },
  '/api/custom/pharmacy/medication-followups/assignees': {
    assignees: [{ id: 'staff-misaki', name: '高橋 美咲', role: 'owner' }],
  },
};

async function mockPharmacy(page: Page): Promise<string[]> {
  const unexpected: string[] = [];
  await page.clock.setFixedTime(new Date('2026-10-09T10:30:00+09:00'));
  await page.addInitScript(() => {
    localStorage.setItem('lh_staff_name', '高橋 美咲');
    localStorage.setItem('lh_staff_role', 'owner');
  });
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url());
    const json = route.request().method() === 'GET' ? responses[pathname] : undefined;
    if (json) return route.fulfill({ json });
    unexpected.push(`${route.request().method()} ${pathname}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected README screenshot request' } });
  });
  return unexpected;
}

async function shoot(page: Page, name: string) {
  await page.evaluate(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    await document.fonts.ready;
  });
  // next dev の開発用インジケータは製品 UI ではないため撮影時だけ隠す。
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.screenshot({ path: path.join(outDir, name), animations: 'disabled' });
}

test('admin-today.png (dashboard home)', async ({ page }) => {
  const unexpected = await mockPharmacy(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '本日の対応', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '対応が必要な項目' })).toBeVisible();
  for (const group of ['ホーム', '日常業務', '患者・法令', '設定・安全'])
    await expect(page.getByText(group, { exact: true }).filter({ visible: true })).toBeInViewport();
  await shoot(page, 'admin-today.png');
  expect(unexpected).toEqual([]);
});

test('admin-queue.png', async ({ page }) => {
  const unexpected = await mockPharmacy(page);
  await page.goto('/prescriptions');
  await page.getByRole('button', { name: /すべて/ }).click();
  await expect(page.getByRole('button', { name: /鈴木 陽子/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /山田 花子/ })).toBeVisible();
  await shoot(page, 'admin-queue.png');
  expect(unexpected).toEqual([]);
});

test('admin-intake.png', async ({ page }) => {
  const unexpected = await mockPharmacy(page);
  await page.goto('/patient-intakes');
  await expect(page.getByRole('heading', { name: '患者アンケート', level: 1 })).toBeVisible();
  await expect(page.getByText('ジェネリック医薬品の希望：')).toBeInViewport();
  await expect(page.getByText('残薬：')).toBeInViewport();
  await shoot(page, 'admin-intake.png');
  expect(unexpected).toEqual([]);
});
