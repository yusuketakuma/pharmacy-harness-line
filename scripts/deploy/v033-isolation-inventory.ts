import { buildV032RouteInventory } from './v032-route-inventory.js';

export type IsolationEvidenceKind = 'route' | 'page' | 'job' | 'storage' | 'patient';

export interface IsolationEvidenceRow {
  id: string;
  kind: IsolationEvidenceKind;
  source: string;
  sourceToken: string;
  testReferences: string[];
  fixture: string;
  expectedHttp: string;
  expectedDb: string;
  expectedLog: string;
  evidenceId: string;
}

type BoundaryDefinition = Omit<IsolationEvidenceRow, 'fixture' | 'evidenceId'>;

const job = (
  id: string,
  sourceToken: string,
  source: string,
  testReferences: string[],
  expectedDb: string,
  expectedLog = 'PHI-free count/status/error only',
): BoundaryDefinition => ({
  id: `job-${id}`,
  kind: 'job',
  source,
  sourceToken,
  testReferences,
  expectedHttp: 'not-applicable: scheduled Worker job',
  expectedDb,
  expectedLog,
});

const jobs: BoundaryDefinition[] = [
  job('generic-cron-guard', 'shouldRunGenericCron(', 'apps/worker/src/custom/pharmacy/cron-access.ts', ['apps/worker/src/custom/pharmacy/cron-access.test.ts'], 'mixed or pharmacy-only account sets fail closed before generic jobs'),
  job('token-refresh', 'refreshLineAccessTokens(', 'apps/worker/src/services/token-refresh.ts', ['apps/worker/src/services/token-refresh.test.ts'], 'credential update remains line-account scoped'),
  job('recover-stalled-broadcasts', 'recoverStalledBroadcasts(', 'packages/db/src/broadcasts.ts', ['apps/worker/src/services/broadcast-personalized-delivery.test.ts'], 'broadcast identity and account projection remain fixed'),
  job('recover-stuck-deliveries', 'recoverStuckDeliveries(', 'packages/db/src/broadcasts.ts', ['apps/worker/src/services/dedup-broadcast.test.ts'], 'deduplicated broadcast recovery remains account scoped'),
  job('booking-reminders', 'processDueReminders(', 'apps/worker/src/services/booking-reminders.ts', ['apps/worker/src/services/booking-reminders.test.ts'], 'claimed booking account selects the sender and settlement'),
  job('event-booking-reminders', 'processDueEventReminders(', 'apps/worker/src/services/event-booking-reminders.ts', ['apps/worker/src/services/event-booking-reminders.test.ts'], 'event booking account selects the sender and settlement'),
  job('meet-reminders', 'processDueMeetConsultationReminders(', 'apps/worker/src/services/meet-consultation-reminders.ts', ['apps/worker/src/services/meet-consultation-reminders.test.ts'], 'consultation tenant/account and reminder claim are fixed'),
  job('webinar-reminders', 'processWebinarReminders(', 'apps/worker/src/services/webinar-reminders.ts', ['apps/worker/src/services/webinar-reminders.test.ts'], 'pharmacy accounts are denied and generic sends retain account scope'),
  job('webinar-followups', 'processWebinarFollowups(', 'apps/worker/src/services/webinar-followups.ts', ['apps/worker/src/services/webinar-followups.test.ts'], 'pharmacy accounts are denied and generic sends retain account scope'),
  job('scenario-steps', 'processStepDeliveries(', 'apps/worker/src/services/step-delivery.ts', ['apps/worker/src/services/step-delivery.test.ts'], 'claim, tenant, account, friend, and step remain fenced'),
  job('scheduled-broadcasts', 'processScheduledBroadcasts(', 'apps/worker/src/services/broadcast.ts', ['apps/worker/src/services/broadcast-personalized-delivery.test.ts'], 'broadcast account and durable recipient projection remain fixed'),
  job('generic-reminders', 'processReminderDeliveries(', 'apps/worker/src/services/reminder-delivery.ts', ['apps/worker/src/services/reminder-delivery-pharmacy-mode.test.ts'], 'pharmacy delivery is denied and generic reminder account is resolved server-side'),
  job('queued-broadcasts', 'processQueuedBroadcasts(', 'apps/worker/src/services/broadcast.ts', ['apps/worker/src/services/broadcast-personalized-delivery.test.ts'], 'queue lock, account, and recipient projection remain fixed'),
  job('account-health', 'checkAccountHealth(', 'apps/worker/src/services/ban-monitor.ts', ['apps/worker/src/services/ban-monitor.test.ts'], 'message volume query binds line_account_id before risk calculation'),
  job('test-push-reconciliation', 'reconcileAttemptedBroadcastTestPushes(', 'apps/worker/src/services/outbound-line-delivery.ts', ['apps/worker/src/services/outbound-line-delivery.test.ts'], 'stored tenant/account request and retry key are replayed'),
  job('accepted-reply-reconciliation', 'reconcileAcceptedScenarioReplies(', 'apps/worker/src/services/outbound-line-delivery.ts', ['apps/worker/src/services/outbound-line-delivery.test.ts'], 'accepted reply settlement remains scenario/account/claim scoped'),
  job('unsent-reply-reconciliation', 'reconcileUnsentScenarioReplies(', 'apps/worker/src/services/outbound-line-delivery.ts', ['apps/worker/src/services/outbound-line-delivery.test.ts'], 'proven-unsent reply settlement remains scenario/account/claim scoped'),
  job('delivery-retirement', 'retireExpiredOutboundLineDeliveries(', 'apps/worker/src/services/outbound-line-delivery.ts', ['apps/worker/src/services/outbound-line-delivery.test.ts'], 'immutable retry deadline drives count-only retirement'),
  job('webhook-inbox-sweep', 'sweepWebhookInbox(', 'apps/worker/src/routes/integrations/webhook.ts', ['apps/worker/src/routes/integrations/webhook-durable-inbox.test.ts'], 'receipt tenant/account selects credentials, payload, and R2 key'),
  job('medication-followup', 'processDueMedicationFollowUps(', 'apps/worker/src/custom/pharmacy/medication-followup/notifications.ts', ['apps/worker/src/custom/pharmacy/medication-followup/notifications.test.ts'], 'follow-up account and tenant credential must match'),
  job('emergency-reminders', 'processEmergencyAppointmentReminders(', 'apps/worker/src/custom/pharmacy/emergency-contraception/notifications.ts', ['apps/worker/src/custom/pharmacy/emergency-contraception/notifications.test.ts'], 'appointment account and tenant credential must match'),
  job('mileage-queue', 'processPendingMileageEvents(', 'packages/db/src/mileage.ts', ['packages/db/test/mileage-rules.test.ts'], 'friend account is resolved before pharmacy-mode exclusion and mutation'),
  job('insight-fetch', 'processInsightFetch(', 'apps/worker/src/services/insight-fetcher.ts', ['apps/worker/src/services/insight-fetcher.test.ts'], 'an explicit line_account_id never falls back to another LINE client'),
  job('webhook-receipt-purge', 'purgeWebhookEventReceipts(', 'apps/worker/src/routes/integrations/webhook.ts', ['apps/worker/src/routes/integrations/webhook-durable-inbox.test.ts'], 'only terminal durable receipts past retention are purged'),
  job('prescription-image-cleanup', 'cleanupPrescriptionImages(', 'apps/worker/src/custom/pharmacy/prescriptions/cleanup.ts', ['apps/worker/src/custom/pharmacy/prescriptions/cleanup.test.ts'], 'submission/account ownership and R2 state are rechecked'),
  job('emergency-retention', 'purgeEmergencyIntakesPastRetention(', 'apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts', ['apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.test.ts'], 'each account retention promise and legal hold are applied independently'),
  job('prescription-notification-retry', 'retryFailedPrescriptionNotifications(', 'apps/worker/src/custom/pharmacy/prescriptions/notifications.ts', ['apps/worker/src/custom/pharmacy/prescriptions/notifications.test.ts'], 'submission account selects tenant credential and approved template'),
  job('continuity-claim', 'claimDueNextIntakeExpectations(', 'apps/worker/src/custom/pharmacy/continuity/next-intake.ts', ['apps/worker/src/custom/pharmacy/continuity/next-intake.test.ts'], 'expectation claim is tenant/account keyed'),
  job('continuity-reminder', 'deliverContinuityReminder(', 'apps/worker/src/custom/pharmacy/continuity/notifications.ts', ['apps/worker/src/custom/pharmacy/continuity/notifications.test.ts'], 'expectation account selects tenant credential and neutral template'),
  job('prescription-validity', 'processDuePrescriptionValidityReminders(', 'apps/worker/src/custom/pharmacy/growth-loop/validity.ts', ['apps/worker/src/custom/pharmacy/growth-loop/validity.test.ts'], 'submission account and active tenant mapping are rechecked'),
  job('following-mileage', 'enqueueFollowingMileageMilestones(', 'packages/db/src/mileage.ts', ['packages/db/test/mileage-rules.test.ts'], 'milestone event and friend identity remain idempotent'),
  job('booking-expirer', 'runExpirer(', 'apps/worker/src/services/booking-expirer.ts', ['apps/worker/src/services/booking-expirer.test.ts'], 'booking claim/account settlement remains atomic'),
  job('event-booking-expirer', 'runEventBookingExpirer(', 'apps/worker/src/services/event-booking-expirer.ts', ['apps/worker/src/services/event-booking-expirer.test.ts'], 'event booking expiry remains event/account scoped'),
];

const storage = (
  id: string,
  source: string,
  sourceToken: string,
  testReferences: string[],
  expectedHttp: string,
  expectedDb: string,
): BoundaryDefinition => ({
  id: `storage-${id}`,
  kind: 'storage',
  source,
  sourceToken,
  testReferences,
  expectedHttp,
  expectedDb,
  expectedLog: 'no object body, patient identifier, secret, or upstream response body',
});

const storageBoundaries: BoundaryDefinition[] = [
  storage('admin-images', 'apps/worker/src/routes/admin/images.ts', 'c.env.IMAGES', ['apps/worker/src/routes/admin/images.test.ts'], 'private keys require authenticated tenant; public keys use an explicit namespace', 'tenant prefix and assigned account are checked before mutation'),
  storage('generic-rich-menu', 'apps/worker/src/routes/messaging/rich-menu-groups.ts', 'c.env.IMAGES', ['apps/worker/src/routes/messaging/rich-menu-groups.test.ts'], 'group/account authorization precedes image access and publish', 'group account and immutable pharmacy version are server validated'),
  storage('pharmacy-rich-menu', 'apps/worker/src/custom/pharmacy/rich-menu/routes.ts', 'c.env.IMAGES', ['apps/worker/src/custom/pharmacy/rich-menu/routes.test.ts'], 'staff/account capability precedes draft image access', 'catalog/version/account evidence is fixed before LINE mutation'),
  storage('webinar-video', 'apps/worker/src/routes/messaging/webinars.ts', 'c.env.IMAGES', ['apps/worker/src/routes/messaging/webinars.test.ts'], 'pharmacy mode denies the generic webinar surface', 'video prefix is resolved from the authorized webinar'),
  storage('webhook-incoming-image', 'apps/worker/src/routes/integrations/webhook.ts', 'c.env.IMAGES', ['apps/worker/src/routes/integrations/webhook-durable-inbox.test.ts'], 'verified destination account owns the deterministic incoming-image key', 'tracking row is durable before completion'),
  storage('prescription-files', 'apps/worker/src/custom/pharmacy/prescriptions/routes.ts', 'c.env.IMAGES', ['apps/worker/src/custom/pharmacy/prescriptions/routes.test.ts', 'apps/worker/src/custom/pharmacy/prescriptions/cleanup.test.ts'], 'verified patient/staff account and submission own every file read/write/delete', 'D1 pending/ready/deletion CAS fences R2 state'),
  storage('retention-inventory', 'apps/worker/src/custom/pharmacy/platform-admin/data-protection-routes.ts', 'c.env.IMAGES', ['apps/worker/src/custom/pharmacy/retention/incoming-images.test.ts', 'apps/worker/src/custom/pharmacy/prescriptions/retention-purge.test.ts', 'apps/worker/src/custom/pharmacy/platform-admin/data-protection-routes.test.ts'], 'platform auth, scoped operation, preflight, approval, and execution fence precede mutation', 'tenant/account execution owns every inventory/disposition row'),
  storage('platform-webhook-retry', 'apps/worker/src/custom/pharmacy/platform-admin/routes.ts', 'c.env.IMAGES', ['apps/worker/src/custom/pharmacy/platform-admin/routes.test.ts'], 'support action is platform-authenticated and tenant path scoped', 'stored receipt tenant/account is reused; request selectors are not authority'),
];

const patient = (
  id: string,
  source: string,
  testReferences: string[],
  expectedDb: string,
): BoundaryDefinition => ({
  id: `patient-${id}`,
  kind: 'patient',
  source,
  sourceToken: 'line_account_id',
  testReferences,
  expectedHttp: 'foreign or unverified patient/account returns 403 or indistinguishable 404 before data access',
  expectedDb,
  expectedLog: 'audit is scoped and PHI-free; no patient payload in general logs',
});

const patientBoundaries: BoundaryDefinition[] = [
  patient('intake', 'apps/worker/src/custom/pharmacy/intake/repository.ts', ['apps/worker/src/custom/pharmacy/intake/routes.test.ts', 'apps/worker/src/custom/pharmacy/intake/repository.test.ts'], 'tenant/account/LINE owner/patient and policy proof bind every revision'),
  patient('prescriptions', 'apps/worker/src/custom/pharmacy/prescriptions/repository.ts', ['apps/worker/src/custom/pharmacy/prescriptions/routes.test.ts', 'apps/worker/src/custom/pharmacy/prescriptions/repository.test.ts'], 'account/owner/submission/file and optional patient revision are bound'),
  patient('continuity', 'apps/worker/src/custom/pharmacy/continuity/repository.ts', ['apps/worker/src/custom/pharmacy/continuity/routes.test.ts', 'apps/worker/src/custom/pharmacy/continuity/repository.test.ts'], 'account/owner/expectation and prescription linkage are bound'),
  patient('medication-followup', 'apps/worker/src/custom/pharmacy/medication-followup/repository.ts', ['apps/worker/src/custom/pharmacy/medication-followup/routes.test.ts', 'apps/worker/src/custom/pharmacy/medication-followup/repository.test.ts'], 'verified account/owner and submission-derived patient scope are bound'),
  patient('emergency-contraception', 'apps/worker/src/custom/pharmacy/emergency-contraception/repository.ts', ['apps/worker/src/custom/pharmacy/emergency-contraception/routes.test.ts', 'apps/worker/src/custom/pharmacy/emergency-contraception/repository.test.ts'], 'tenant/account/owner/patient/intake and pharmacist role are bound'),
  patient('myna', 'apps/worker/src/custom/pharmacy/myna/repository.ts', ['apps/worker/src/custom/pharmacy/myna/routes.test.ts', 'apps/worker/src/custom/pharmacy/myna/repository.test.ts'], 'account/owner/handoff and formal verification state are bound'),
];

function finalize(definition: BoundaryDefinition): IsolationEvidenceRow {
  return {
    ...definition,
    fixture: definition.testReferences.join(', '),
    evidenceId: `V033-G4:${definition.id}`,
  };
}

export function buildV033IsolationInventory(repoRoot = process.cwd()): IsolationEvidenceRow[] {
  const routeInventory = buildV032RouteInventory(repoRoot);
  const routeRows = [...routeInventory.pages, ...routeInventory.apis].map((entry): IsolationEvidenceRow => ({
    id: entry.id,
    kind: entry.kind === 'api' ? 'route' : 'page',
    source: entry.source,
    sourceToken: entry.kind === 'api' ? '/api/' : entry.path,
    testReferences: [...entry.testReferences],
    fixture: entry.testReferences.join(', '),
    expectedHttp: entry.routePaths?.map(({ method, path }) => `${method} ${path}`).join(', ') ?? entry.path,
    expectedDb: entry.lineAccountIdAuthority,
    expectedLog: entry.audit,
    evidenceId: `V033-G4:${entry.id}`,
  }));
  return [...routeRows, ...jobs.map(finalize), ...storageBoundaries.map(finalize), ...patientBoundaries.map(finalize)];
}

export const V033_SCHEDULED_JOB_TOKENS = jobs.map(({ sourceToken }) => sourceToken);
