import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const V032_SNAPSHOT = 'eaf35aa8aa8bb6cd831c84d30d2067662b48d3b7';

export type InventorySurface = 'pharmacy-admin' | 'platform-admin' | 'patient-liff';
export type InventoryKind = 'page' | 'api';
export type RouteReachability = 'reachable' | 'source-only-unmounted' | 'deferred';
export type QueryAuthority =
  | 'not-applicable'
  | 'selector-only-server-validated'
  | 'server-tenant/account-bound'
  | 'not-explicitly-server-scoped';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RoutePattern {
  method: HttpMethod;
  path: string;
}

export interface InventoryEntry {
  id: string;
  kind: InventoryKind;
  surface: InventorySurface;
  path: string;
  source: string;
  componentSource?: string;
  routePaths?: RoutePattern[];
  testReferences: string[];
  roles: string[];
  authority: string;
  lineAccountIdAuthority: string;
  displayedInfo: string[];
  mutation: string;
  confirmation: string;
  phiClassification: string;
  audit: string;
  queryAuthority: QueryAuthority;
  manualOneToOne: 'required' | 'not-applicable';
  meetFollowUp:
    | 'not-applicable'
    | 'required-calendar-and-reminders'
    | 'unverified-existing-gap';
  reachability: RouteReachability;
}

export interface V032RouteInventory {
  snapshot: string;
  pages: InventoryEntry[];
  apis: InventoryEntry[];
  customPharmacyRouteSources: string[];
}

type EntryDefinition = Omit<InventoryEntry, 'routePaths'>;

const customRoutePrefix = '/api/custom/pharmacy/';
const platformAdminPrefix = '/api/platform-admin/';
const platformPharmacyPrefix = '/api/platform/pharmacy/';

const pharmacyPageDefinitions: EntryDefinition[] = [
  {
    id: 'page-pharmacy-login',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/login',
    source: 'apps/web/src/app/login/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/provisioning/login-ui.test.ts',
      'apps/web/src/custom/pharmacy/growth-loop/tenant-admin-ux.test.ts',
    ],
    roles: ['unauthenticated', 'tenant-admin'],
    authority: 'login establishes the server-side tenant staff session; pharmacyCode is an input, not authority',
    lineAccountIdAuthority: 'authentication-input-only; server resolves the tenant/account membership',
    displayedInfo: ['login state', 'password-change requirement', 'safe redirect notice'],
    mutation: 'login, logout/session renewal, and tenant-admin password change',
    confirmation: 'credential validation, CSRF for authenticated mutation, and no external side effect',
    phiClassification: 'none',
    audit: 'authentication success/failure is server logged; session lifecycle is server controlled',
    queryAuthority: 'not-applicable',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-home',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/',
    source: 'apps/web/src/app/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/growth-loop/GrowthDashboardPage.tsx',
    testReferences: ['apps/web/src/custom/pharmacy/growth-loop/pharmacy-mode-ui.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'authenticated staff session plus server pharmacy capability/account scope',
    lineAccountIdAuthority: 'server derives the selected account and validates tenant membership',
    displayedInfo: ['today operations summary', 'pharmacy growth/readiness dashboard', 'active work counts'],
    mutation: 'dashboard is read-only; child actions navigate to separately gated surfaces',
    confirmation: 'read-only display; child mutations use their own confirmation/CAS',
    phiClassification: 'operational-sensitive',
    audit: 'readiness and operations reads are server scoped; page-level audit is not a mutation log',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-prescriptions',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/prescriptions',
    source: 'apps/web/src/app/prescriptions/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueuePage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueuePage.test.tsx',
      'apps/web/src/custom/pharmacy/prescriptions/api.test.ts',
      'apps/web/src/custom/pharmacy/growth-loop/v032-a2-contract.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff authorization and prescriptionLineAccountId tenant/account scope',
    lineAccountIdAuthority: 'server-derived from the authenticated staff tenant; query account selector is validated',
    displayedInfo: ['prescription queue', 'submission status', 'patient/submission detail and prescription files'],
    mutation: 'prescription workflow actions and fulfillment quote changes',
    confirmation: 'CSRF plus action-specific confirmation and expected-version/stale-state handling',
    phiClassification: 'PHI',
    audit: 'prescription events and staff actor are server recorded; binary file access is scoped',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-prescriptions-print',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/prescriptions/print',
    source: 'apps/web/src/app/prescriptions/print/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/prescriptions/PrescriptionPrintPage.tsx',
    testReferences: ['apps/web/src/custom/pharmacy/prescriptions/boundary.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff authorization and submission/account scope',
    lineAccountIdAuthority: 'server derives account scope from the authenticated staff context',
    displayedInfo: ['print preparation task', 'submission identifiers and print status'],
    mutation: 'prepare, claim, and acknowledge a print task',
    confirmation: 'CSRF plus task claim/acknowledgement and server state transition',
    phiClassification: 'PHI',
    audit: 'print task actor/status is server recorded; page must not broaden submission scope',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-myna',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/myna',
    source: 'apps/web/src/app/myna/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/myna/MynaAdminPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/myna/MynaAdminPage.test.tsx',
      'apps/web/src/custom/pharmacy/growth-loop/v032-a2-contract.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff authorization and Myna handoff account scope',
    lineAccountIdAuthority: 'server-derived/validated against the tenant line-account mapping',
    displayedInfo: ['electronic prescription handoffs', 'verification state', 'Myna endpoint configuration status'],
    mutation: 'handoff verification and endpoint configuration/verification',
    confirmation: 'CSRF plus verification workflow and stale/error handling',
    phiClassification: 'PHI',
    audit: 'verification actor and endpoint operations are server audited where route tests require it',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-emergency-contraception',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/emergency-contraception',
    source: 'apps/web/src/app/emergency-contraception/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.test.tsx',
      'apps/web/src/custom/pharmacy/emergency-contraception/api.test.ts',
      'apps/web/src/custom/pharmacy/growth-loop/v032-a2-contract.test.ts',
    ],
    roles: ['tenant-admin', 'pharmacist', 'staff'],
    authority: 'server staff scope; trained-pharmacist checks protect pharmacist-only actions',
    lineAccountIdAuthority: 'server-derived and validated against the tenant line-account mapping',
    displayedInfo: ['emergency-contraception configuration', 'slots/inventory', 'intake and sale workflow'],
    mutation: 'configuration, reminder, pharmacist, slot, inventory, intake transition, and sale operations',
    confirmation: 'CSRF plus pharmacist authorization, expected state, and explicit confirmation for sale/destructive transitions',
    phiClassification: 'PHI',
    audit: 'workflow transitions and sale actor are server recorded; errors do not silently complete a sale',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-activity-notifications',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/pharmacy-notifications',
    source: 'apps/web/src/app/pharmacy-notifications/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/activity-notifications/PharmacyActivityNotificationsPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/activity-notifications/PharmacyActivityNotificationsPage.test.ts',
      'apps/web/src/custom/pharmacy/activity-notifications/api.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff/account scope for pharmacy activity notifications',
    lineAccountIdAuthority: 'server-derived and validated against the authenticated tenant account',
    displayedInfo: ['pharmacy activity notification list', 'acknowledgement status'],
    mutation: 'acknowledge an activity notification',
    confirmation: 'CSRF and server actor/account validation; acknowledgement is idempotent',
    phiClassification: 'PHI',
    audit: 'acknowledgement actor and timestamp are server recorded',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-continuity',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/continuity',
    source: 'apps/web/src/app/continuity/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/continuity/ContinuityAdminPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/continuity/ContinuityAdminPage.test.tsx',
      'apps/web/src/custom/pharmacy/growth-loop/v032-a2-contract.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff/account scope for continuity records',
    lineAccountIdAuthority: 'server derives account scope and validates every patient/expectation identifier',
    displayedInfo: ['continuity follow-up queue', 'expectations and current status'],
    mutation: 'create and end a continuity expectation',
    confirmation: 'CSRF plus state transition validation and stale/error handling',
    phiClassification: 'PHI',
    audit: 'continuity actor and transition are server recorded',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-patient-intakes',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/patient-intakes',
    source: 'apps/web/src/app/patient-intakes/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/intake/PatientIntakeAdminPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/intake/PatientIntakeAdminPage.test.ts',
      'apps/web/src/custom/pharmacy/intake/api.test.ts',
      'apps/web/src/custom/pharmacy/intake/labels.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff authorization and encrypted intake tenant/account scope',
    lineAccountIdAuthority: 'server-derived tenant/account scope; patient id is a selector only',
    displayedInfo: ['patient intake queue', 'patient history and encrypted intake details'],
    mutation: 'admin intake review and related state operations',
    confirmation: 'CSRF plus encrypted readback, server authorization, and stale/error handling',
    phiClassification: 'PHI',
    audit: 'intake reads/actions include staff actor and tenant/account scope',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-privacy-policy',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/privacy-policy',
    source: 'apps/web/src/app/privacy-policy/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/privacy-policy/PrivacyPolicyAdminPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/privacy-policy/api.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff/account scope for the tenant privacy policy',
    lineAccountIdAuthority: 'server derives and validates the tenant line-account mapping',
    displayedInfo: ['current privacy policy text and revision state'],
    mutation: 'update the tenant privacy policy',
    confirmation: 'CSRF plus server validation and revision-aware update',
    phiClassification: 'none',
    audit: 'policy revision and actor are server recorded where route contract requires it',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-data-subject-requests',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/data-subject-requests',
    source: 'apps/web/src/app/data-subject-requests/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/data-subject-requests/DataSubjectRequestAdminPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/data-subject-requests/DataSubjectRequestAdminPage.test.tsx',
      'apps/web/src/custom/pharmacy/data-subject-requests/api.test.ts',
    ],
    roles: ['tenant-admin', 'privacy-staff'],
    authority: 'server staff/account authorization for data-subject request records',
    lineAccountIdAuthority: 'server derives account scope and validates request ownership',
    displayedInfo: ['data-subject request status', 'identity-verification/legal-hold/resolution state'],
    mutation: 'create request, verify identity, assess legal hold, and resolve request',
    confirmation: 'CSRF, identity verification, legal-hold gate, and explicit resolution state',
    phiClassification: 'PHI',
    audit: 'request lifecycle and actor are server audited for accountability',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-features',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/pharmacy-features',
    source: 'apps/web/src/app/pharmacy-features/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/growth-loop/FeatureSettingsPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/growth-loop/FeatureSettingsPage.test.tsx',
      'apps/web/src/custom/pharmacy/growth-loop/v032-a2-contract.test.ts',
    ],
    roles: ['tenant-admin'],
    authority: 'server tenant-admin capability authorization',
    lineAccountIdAuthority: 'server validates selected account against tenant membership',
    displayedInfo: ['pharmacy capability configuration', 'readiness blockers and rich-menu configuration status'],
    mutation: 'update pharmacy capability configuration',
    confirmation: 'CSRF plus expected revision/CAS; external rich-menu actions remain separately gated',
    phiClassification: 'operational-sensitive',
    audit: 'configuration revision and actor are server recorded',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-info',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/pharmacy-info',
    source: 'apps/web/src/app/pharmacy-info/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/public-profile/PharmacyInfoAdminPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/public-profile/PharmacyInfoAdminPage.test.tsx',
      'apps/web/src/custom/pharmacy/public-profile/api.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff/account scope for patient-facing pharmacy profile',
    lineAccountIdAuthority: 'server derives and validates the selected tenant account',
    displayedInfo: ['patient-facing pharmacy name/contact/hours/profile'],
    mutation: 'update public pharmacy profile',
    confirmation: 'CSRF plus server validation and revision-aware update',
    phiClassification: 'none',
    audit: 'profile revision and actor are server recorded where route contract requires it',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-pharmacy-growth',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/pharmacy-growth',
    source: 'apps/web/src/app/pharmacy-growth/page.tsx',
    componentSource: 'apps/web/src/custom/pharmacy/growth-loop/GrowthDashboardPage.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/growth-loop/GrowthDashboardPage.test.tsx',
      'apps/web/src/custom/pharmacy/growth-loop/tenant-admin-ux.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server pharmacy dashboard capability and tenant/account scope',
    lineAccountIdAuthority: 'server derives and validates account selector against tenant membership',
    displayedInfo: ['growth metrics', 'source/submission validity', 'readiness and active-work state'],
    mutation: 'manage growth sources, associate submissions, and update validity',
    confirmation: 'CSRF plus expected revision/state validation; no automatic external messaging',
    phiClassification: 'operational-sensitive',
    audit: 'source/submission operations record actor and account scope',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-generic-friends',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/friends',
    source: 'apps/web/src/app/friends/page.tsx',
    testReferences: [
      'apps/web/src/app/ui-safety.test.ts',
      'apps/web/src/custom/pharmacy/growth-loop/menu.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server authenticated tenant/account scope; friend id is a selector only',
    lineAccountIdAuthority: 'server tenant/account authorization is applied before friend access',
    displayedInfo: ['friend list/profile', 'tags and mileage metadata', 'message history summary'],
    mutation: 'tag/metadata changes and one-to-one message send through the chat flow',
    confirmation: 'CSRF; one-to-one send requires explicit confirmation and manual source header',
    phiClassification: 'PHI',
    audit: 'friend/message route tests cover tenant boundaries; message actor/source is server checked',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'required',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-generic-chats',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/chats',
    source: 'apps/web/src/app/chats/page.tsx',
    testReferences: [
      'apps/web/src/app/chats/page.test.ts',
      'apps/web/src/custom/pharmacy/growth-loop/v032-a2-contract.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server chat/friend tenant pair scope; chat id is a selector only',
    lineAccountIdAuthority: 'server validates both chat and friend account/tenant ownership',
    displayedInfo: ['conversation messages', 'chat assignment/loading state', 'send failure state'],
    mutation: 'chat assignment/loading and manual one-to-one message send',
    confirmation: 'CSRF, single-flight client lock, explicit window.confirm, and X-Line-Harness-Source: manual',
    phiClassification: 'PHI',
    audit: 'chat/message route tests cover cross-tenant denial and manual source boundary',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'required',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-generic-notifications',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/notifications',
    source: 'apps/web/src/app/notifications/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/growth-loop/menu.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server inbox and line-account tenant/account scope',
    lineAccountIdAuthority: 'server derives account scope for inbox and line-account reads',
    displayedInfo: ['unanswered/inbox count', 'operational notification summary'],
    mutation: 'read-only notification/inbox view',
    confirmation: 'read-only; no outbound notification mutation from this page',
    phiClassification: 'operational-sensitive',
    audit: 'read-only route coverage; explicit mutation audit is not applicable',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-generic-rich-menus',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/rich-menus',
    source: 'apps/web/src/app/rich-menus/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/rich-menu/PharmacyRichMenuLayoutPanel.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
      'apps/web/src/custom/pharmacy/growth-loop/menu-layout.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant/account scope and pharmacy rich-menu capability',
    lineAccountIdAuthority: 'server validates accountId selector against tenant membership',
    displayedInfo: ['generic/rich-menu groups', 'pharmacy layout/version/lifecycle state', 'preview and diff'],
    mutation: 'rich-menu draft/version/layout/lifecycle operations and external publish/apply operations',
    confirmation: 'CSRF plus expected revision/CAS and explicit external publish/apply confirmation',
    phiClassification: 'operational-sensitive',
    audit: 'rich-menu operations include operation/reconcile state and actor audit where applicable',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-generic-staff',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/staff',
    source: 'apps/web/src/app/staff/page.tsx',
    testReferences: [
      'apps/web/src/app/staff/page.test.ts',
      'apps/web/src/custom/pharmacy/growth-loop/tenant-admin-ux.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server staff session and tenant membership; only tenant-admin can administer staff',
    lineAccountIdAuthority: 'server tenant scope; account assignment is validated server-side',
    displayedInfo: ['staff list/profile', 'roles and account assignments', 'active/disabled status'],
    mutation: 'create/update/disable/delete staff and reset password',
    confirmation: 'CSRF plus tenant-admin authorization and explicit destructive confirmation',
    phiClassification: 'operational-sensitive',
    audit: 'staff administration and session revocation are server audited',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-generic-accounts',
    kind: 'page',
    surface: 'pharmacy-admin',
    path: '/accounts',
    source: 'apps/web/src/app/accounts/page.tsx',
    testReferences: [
      'apps/web/src/app/ui-safety.test.ts',
      'apps/web/src/custom/pharmacy/provisioning/line-connection-ui.test.ts',
      'apps/web/src/custom/pharmacy/rich-menu/PharmacyRichMenuLayoutPanel.test.ts',
    ],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant/account scope; credentials never come from a query parameter as authority',
    lineAccountIdAuthority: 'server validates selected line account against tenant membership',
    displayedInfo: ['LINE account names/status', 'connection and channel readiness', 'account settings'],
    mutation: 'LINE account connect/update/order and account-setting changes',
    confirmation: 'CSRF plus explicit connection/update confirmation and secret redaction',
    phiClassification: 'credentials',
    audit: 'connection/configuration operations are server audited; secrets are not displayed',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
];

const patientLiffPageDefinitions: EntryDefinition[] = [
  {
    id: 'page-patient-liff-menu', kind: 'page', surface: 'patient-liff', path: '/pharmacy/menu',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/menu/MainMenuPage.tsx',
    testReferences: ['apps/liff/src/custom/pharmacy/menu/MainMenuPage.test.tsx', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'LINE ID token plus server-side LIFF/account/friend binding',
    lineAccountIdAuthority: 'liffId is a selector; server resolves one account and binds the verified LINE subject',
    displayedInfo: ['enabled features', 'existing-only state', 'three patient journey groups'],
    mutation: 'fixed manual consultation message only; feature navigation is read-only',
    confirmation: 'LINE client check, explicit confirmation, send-time feature recheck and single-flight',
    phiClassification: 'PHI-free-default', audit: 'manual consultation uses the fixed LINE client action; no patient identifier is displayed',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'page-patient-liff-prescriptions', kind: 'page', surface: 'patient-liff', path: '/prescriptions',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/prescriptions/PrescriptionPage.tsx',
    testReferences: ['apps/liff/src/custom/pharmacy/prescriptions/PrescriptionPage.test.tsx', 'apps/liff/src/custom/pharmacy/prescriptions/api.test.ts', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'verified LINE subject plus server prescription owner/account scope',
    lineAccountIdAuthority: 'liffId and submission id are selectors; server validates account and friend ownership',
    displayedInfo: ['send steps', 'owned prescription history/status', 'electronic handoff state'],
    mutation: 'reserve/upload/submit/cancel/resubmit/arrival and patient Myna actions',
    confirmation: 'consent, review step, idempotency/CAS, feature gate, single-flight and explicit cancellation/arrival confirmation',
    phiClassification: 'PHI', audit: 'submission/file/workflow events retain the scoped patient actor without exposing internal ids in shell navigation',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'page-patient-liff-intake', kind: 'page', surface: 'patient-liff', path: '/pharmacy/patient-intake',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/intake/PatientIntakePage.tsx',
    testReferences: ['apps/liff/src/custom/pharmacy/intake/PatientIntakePage.test.tsx', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'verified LINE subject plus server patient/friend/account ownership',
    lineAccountIdAuthority: 'liffId and patient id are selectors; server validates the owner relationship',
    displayedInfo: ['patient profile', 'three-step questionnaire', 'latest owned response'],
    mutation: 'create/update/archive patient profile and submit encrypted intake response',
    confirmation: 'required safety answers, privacy/representative consent, busy guard and in-memory-only draft warning',
    phiClassification: 'PHI', audit: 'server records scoped patient/intake revisions; browser storage is not used for drafts',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'page-patient-liff-continuity', kind: 'page', surface: 'patient-liff', path: '/pharmacy/continuity',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/continuity/ContinuityPage.tsx',
    testReferences: ['apps/liff/src/custom/pharmacy/continuity/ContinuityPage.test.tsx', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'verified LINE subject plus server continuity owner/account scope',
    lineAccountIdAuthority: 'liffId and expectation id are selectors; server validates friend/account ownership',
    displayedInfo: ['continuity status', 'next action', 'owned expectations'], mutation: 'respond to expectation or pause owned continuity',
    confirmation: 'feature existing-only gate, single-flight, server state transition and safe retry state',
    phiClassification: 'PHI', audit: 'continuity transitions are server recorded under the scoped owner/account',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'page-patient-liff-medication-followup', kind: 'page', surface: 'patient-liff', path: '/pharmacy/medication-followup',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/medication-followup/MedicationFollowUpPage.tsx',
    testReferences: ['apps/liff/src/custom/pharmacy/medication-followup/MedicationFollowUpPage.test.tsx', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'verified LINE subject plus server follow-up owner/account scope',
    lineAccountIdAuthority: 'liffId and follow-up id are selectors; server validates friend/account ownership',
    displayedInfo: ['follow-up state', 'response options', 'next action'], mutation: 'submit one owned follow-up response',
    confirmation: 'feature existing-only gate, single-flight and server transition/idempotency checks',
    phiClassification: 'PHI', audit: 'follow-up response transition is server recorded under the scoped owner/account',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'page-patient-liff-emergency', kind: 'page', surface: 'patient-liff', path: '/pharmacy/emergency-contraception',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionPage.tsx',
    testReferences: ['apps/liff/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionPage.test.tsx', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'verified LINE subject plus server EC owner/account and operational-readiness gates',
    lineAccountIdAuthority: 'liffId and intake id are selectors; server validates friend/account ownership',
    displayedInfo: ['availability/readiness', 'intake state', 'time-sensitive next action'], mutation: 'create or cancel one owned EC intake',
    confirmation: 'approved consent, explicit review, single-flight, feature/readiness and server state checks',
    phiClassification: 'PHI', audit: 'EC access/intake transitions are fail-closed and server audited without patient-facing risk leakage',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'page-patient-liff-info', kind: 'page', surface: 'patient-liff', path: '/pharmacy/info',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/public-profile/PharmacyInfoPage.tsx',
    testReferences: ['apps/liff/src/custom/pharmacy/public-profile/PharmacyInfoPage.test.tsx', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'server uniquely resolves the liffId to one active pharmacy account',
    lineAccountIdAuthority: 'liffId is a selector; query line_account_id is ignored as authority',
    displayedInfo: ['patient-facing pharmacy profile', 'hours/services/access'], mutation: 'read-only profile and explicit external map/phone/site navigation',
    confirmation: 'HTTPS/host allowlist for external links and no hidden patient mutation', phiClassification: 'none',
    audit: 'public profile is account-scoped and no PHI is returned', queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'page-patient-liff-receive-redirect', kind: 'page', surface: 'patient-liff', path: '/pharmacy/receive',
    source: 'apps/liff/src/App.tsx', componentSource: 'apps/liff/src/custom/pharmacy/navigation.ts',
    testReferences: ['apps/liff/src/custom/pharmacy/navigation.test.ts', 'apps/liff/src/custom/pharmacy/v032-contract.test.ts'],
    roles: ['line-patient'], authority: 'client redirect only; destination performs the normal LINE/server authority checks',
    lineAccountIdAuthority: 'the redirect preserves liffId but does not make it authority', displayedInfo: ['deprecated route redirect'],
    mutation: 'none', confirmation: 'replace navigation to the tenant-preserving prescription route', phiClassification: 'none',
    audit: 'not applicable to a client-only redirect', queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
];

const platformPageDefinitions: EntryDefinition[] = [
  {
    id: 'page-platform-login',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/login',
    source: 'apps/web/src/app/platform-admin/login/page.tsx',
    testReferences: ['apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts'],
    roles: ['unauthenticated', 'platform-admin'],
    authority: 'globally unique platform-admin credential and platform-admin session cookie',
    lineAccountIdAuthority: 'not-applicable; platform-admin identity is not tenant selected',
    displayedInfo: ['platform-admin login and password-change state'],
    mutation: 'platform-admin login and password change',
    confirmation: 'platform-admin CSRF/session gate; no tenant data mutation during login',
    phiClassification: 'PHI-free-default',
    audit: 'platform-admin login/logout/access events are server audited',
    queryAuthority: 'not-applicable',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-dashboard',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin',
    source: 'apps/web/src/app/platform-admin/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['platform-admin'],
    authority: 'platform-admin session; dashboard is platform-wide operational view',
    lineAccountIdAuthority: 'server maps each reported account through tenant_line_accounts',
    displayedInfo: ['tenant/account counts', 'readiness counts', 'webhook backlog/failures', 'runtime versions'],
    mutation: 'read-only dashboard',
    confirmation: 'platform-admin session and CSRF cookie; no external side effect',
    phiClassification: 'PHI-free-default',
    audit: 'every platform-admin dashboard read records platform_admin_access',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-tenants',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/tenants',
    source: 'apps/web/src/app/platform-admin/tenants/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts',
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-labels.test.ts',
      'apps/web/src/app/platform-admin/tenants/tenant-readiness-contract.test.ts',
    ],
    roles: ['platform-admin'],
    authority: 'platform-admin session; tenant id is server-validated path selector',
    lineAccountIdAuthority: 'server tenant/path scope; line-account ids are never trusted from query alone',
    displayedInfo: ['tenant status', 'account/staff counts', 'webhook/config/readiness issue counts'],
    mutation: 'tenant status/outbound-messaging changes, webhook retry, support grant start',
    confirmation: 'platform-admin CSRF plus explicit operational confirmation, retry idempotency, and support-grant reason',
    phiClassification: 'PHI-free-default',
    audit: 'platform-admin access and mutations are audited with tenant context',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-tenants-new',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/tenants/new',
    source: 'apps/web/src/app/platform-admin/tenants/new/page.tsx',
    testReferences: ['apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts'],
    roles: ['platform-admin'],
    authority: 'platform-admin session and provisioning payload validation',
    lineAccountIdAuthority: 'server creates and binds tenant/line account; request identifiers are not authority',
    displayedInfo: ['tenant and LINE setup form', 'provisioning receipt/status'],
    mutation: 'provision pharmacy tenant, staff bootstrap, and LINE channel configuration',
    confirmation: 'platform-admin CSRF, explicit human confirmation, idempotent request hash, and no implicit production retry',
    phiClassification: 'credentials',
    audit: 'provisioning receipt and platform-admin access are recorded; secrets are redacted',
    queryAuthority: 'not-applicable',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-tenant-detail',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/tenants/detail',
    source: 'apps/web/src/app/platform-admin/tenants/detail/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['platform-admin'],
    authority: 'platform-admin session plus validated tenant id; support grant gates patient reads',
    lineAccountIdAuthority: 'server tenant/path scope and tenant_line_accounts validation',
    displayedInfo: ['tenant health', 'LINE/webhook/readiness state', 'staff/support controls'],
    mutation: 'tenant operations, support grant start/end, outbound pause, and session revocation',
    confirmation: 'platform-admin CSRF, explicit destructive/external confirmation, support-grant reason, and audit',
    phiClassification: 'PHI-free-default',
    audit: 'tenant detail reads/mutations and support grants are platform-admin audited',
    queryAuthority: 'server-tenant/account-bound',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-patients',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/tenants/patients',
    source: 'apps/web/src/app/platform-admin/tenants/patients/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['platform-admin-with-support-grant'],
    authority: 'platform-admin session plus active, purpose-bound, unexpired PHI support grant',
    lineAccountIdAuthority: 'server validates tenant path and patient/account ownership; query is selector only',
    displayedInfo: ['minimum patient list identifiers under support mode'],
    mutation: 'read-only patient list navigation',
    confirmation: 'support grant and PHI banner are mandatory; no mutation from list page',
    phiClassification: 'PHI-with-support-grant',
    audit: 'patient access is platform_admin_access audited with grant/tenant context',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-patient-detail',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/tenants/patients/detail',
    source: 'apps/web/src/app/platform-admin/tenants/patients/detail/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts',
      'apps/web/src/custom/pharmacy/intake/labels.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['platform-admin-with-support-grant'],
    authority: 'platform-admin session plus active, purpose-bound, unexpired PHI support grant',
    lineAccountIdAuthority: 'server validates tenant and patient path selectors against ownership',
    displayedInfo: ['patient profile', 'intake/history and permitted PHI detail'],
    mutation: 'read-only support-mode patient detail in this surface',
    confirmation: 'support grant, PHI banner, CSRF/session, and audit; no silent escalation',
    phiClassification: 'PHI-with-support-grant',
    audit: 'patient detail access is platform_admin_access audited with support-grant context',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-logs',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/logs',
    source: 'apps/web/src/app/platform-admin/logs/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['platform-admin'],
    authority: 'platform-admin session; log filters are selectors only',
    lineAccountIdAuthority: 'server filters by validated tenant/account identifiers and redacts patient audit detail',
    displayedInfo: ['webhook/prescription/platform access logs', 'failure and operational metadata'],
    mutation: 'read-only log view',
    confirmation: 'platform-admin session; no external side effect',
    phiClassification: 'PHI-free-default',
    audit: 'log read itself is platform-admin audited; patient audit payload is redacted',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
  {
    id: 'page-platform-audit',
    kind: 'page',
    surface: 'platform-admin',
    path: '/platform-admin/audit',
    source: 'apps/web/src/app/platform-admin/audit/page.tsx',
    testReferences: [
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-ui.test.ts',
      'apps/web/src/custom/pharmacy/platform-admin/platform-admin-labels.test.ts',
      'apps/web/src/app/ui-safety.test.ts',
    ],
    roles: ['platform-admin'],
    authority: 'platform-admin session; audit filters are selectors only',
    lineAccountIdAuthority: 'server validates tenant/account context and keeps patient details redacted by default',
    displayedInfo: ['platform-admin access history', 'actor/action/tenant/time and redacted detail'],
    mutation: 'read-only audit view',
    confirmation: 'platform-admin session; no external side effect',
    phiClassification: 'PHI-free-default',
    audit: 'this surface displays the server audit trail and does not replace it',
    queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable',
    meetFollowUp: 'not-applicable',
    reachability: 'reachable',
  },
];

const apiDefinitions: EntryDefinition[] = [
  {
    id: 'api-admin-auth',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/auth/*', source: 'apps/worker/src/routes/admin/admin-auth.ts',
    testReferences: ['apps/worker/src/middleware/auth.test.ts', 'apps/worker/src/custom/pharmacy/provisioning/admin-auth.test.ts'],
    roles: ['unauthenticated', 'tenant-admin', 'staff'],
    authority: 'server authentication resolves tenant staff session; pharmacyCode/login selectors never grant access',
    lineAccountIdAuthority: 'authentication-input-only; server derives tenant/account membership',
    displayedInfo: ['session identity', 'password-change requirement'],
    mutation: 'login, logout, password change',
    confirmation: 'credential validation, CSRF on authenticated mutation, timing-safe failure',
    phiClassification: 'none',
    audit: 'authentication/session events are server logged',
    queryAuthority: 'not-applicable', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-account-settings',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/account-settings/*', source: 'apps/worker/src/routes/admin/account-settings.ts',
    testReferences: ['apps/worker/src/routes/admin/account-settings-tenant-scope.test.ts'],
    roles: ['tenant-admin'],
    authority: 'server tenant/account authorization; account selector is validated',
    lineAccountIdAuthority: 'server validates selected line account against tenant membership',
    displayedInfo: ['test recipients', 'link-base/tracked-link-base settings'],
    mutation: 'update account-level operational settings',
    confirmation: 'CSRF plus tenant-admin authorization and server validation',
    phiClassification: 'operational-sensitive',
    audit: 'settings actor/revision is server controlled',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-line-accounts',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/line-accounts/*', source: 'apps/worker/src/routes/admin/line-accounts.ts',
    testReferences: ['apps/worker/src/routes/admin/line-accounts.test.ts', 'apps/worker/src/middleware/tenant-boundary.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant membership and account ownership; credentials are never query authority',
    lineAccountIdAuthority: 'server validates every account id against tenant_line_accounts',
    displayedInfo: ['LINE account metadata/status', 'follower insight/import progress', 'connection readiness'],
    mutation: 'LINE account connect/update/order/import operations',
    confirmation: 'CSRF, explicit connection/import confirmation, idempotency/progress checks, secret redaction',
    phiClassification: 'credentials',
    audit: 'connection/import/configuration operations are server audited',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-staff',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/staff/*', source: 'apps/worker/src/routes/admin/staff.ts',
    testReferences: ['apps/worker/src/routes/admin/staff-tenant-scope.test.ts', 'apps/worker/src/routes/admin/staff-profile-tenant.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant membership; tenant-admin authorization for staff administration',
    lineAccountIdAuthority: 'server tenant/account assignment validation',
    displayedInfo: ['staff profile/role', 'account assignments', 'active/session state'],
    mutation: 'create/update/delete/disable staff and reset password',
    confirmation: 'CSRF, role authorization, explicit destructive confirmation, session revocation',
    phiClassification: 'operational-sensitive',
    audit: 'staff administration is server audited',
    queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-friends',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/friends/*', source: 'apps/worker/src/routes/crm/friends.ts',
    testReferences: ['apps/worker/src/routes/crm/friends-tenant-scope.test.ts', 'apps/worker/src/routes/crm/friends-manual-message.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant/account/friend ownership; friend id is selector only',
    lineAccountIdAuthority: 'server validates friend account against tenant mapping',
    displayedInfo: ['friend profile', 'tags/mileage', 'message history'],
    mutation: 'tags/metadata and manual one-to-one messages',
    confirmation: 'CSRF; manual message requires explicit confirmation and X-Line-Harness-Source: manual',
    phiClassification: 'PHI',
    audit: 'tenant-boundary and manual-message tests cover actor/source safety',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'required', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-tags',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/tags/*', source: 'apps/worker/src/routes/crm/tags.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant/account scope; pharmacy menu allowlist determines whether generic surface is reachable',
    lineAccountIdAuthority: 'server validates tag/account ownership',
    displayedInfo: ['tag list', 'mileage rule metadata'],
    mutation: 'create/update/delete tags and mileage settings',
    confirmation: 'CSRF plus server tenant validation and explicit destructive confirmation',
    phiClassification: 'operational-sensitive',
    audit: 'generic route/tenant guard coverage; explicit audit persistence is not uniformly verified',
    queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'deferred',
  },
  {
    id: 'api-inbox',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/inbox/*', source: 'apps/worker/src/routes/crm/inbox.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant/account scope for inbox and unanswered summaries',
    lineAccountIdAuthority: 'server derives account scope from authenticated staff/session mapping',
    displayedInfo: ['activity digest', 'unanswered messages', 'unanswered count'],
    mutation: 'read-only digest/count view',
    confirmation: 'read-only; no outbound send or acknowledgement mutation here',
    phiClassification: 'operational-sensitive',
    audit: 'read-only route coverage; mutation audit is not applicable',
    queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-chats',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/chats/*', source: 'apps/worker/src/routes/crm/chats.ts',
    testReferences: ['apps/worker/src/routes/crm/chats-list.test.ts', 'apps/worker/src/routes/crm/chats-manual-message.test.ts', 'apps/worker/src/routes/crm/chats-tenant-pair.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server validates chat/friend tenant pair; chat id is selector only',
    lineAccountIdAuthority: 'server validates both chat and friend account ownership',
    displayedInfo: ['chat list/messages', 'operator/loading state', 'send result/failure'],
    mutation: 'chat assignment/loading and manual one-to-one message send',
    confirmation: 'CSRF, single-flight/retry-safe client behavior, explicit confirmation, X-Line-Harness-Source: manual',
    phiClassification: 'PHI',
    audit: 'tenant-pair and manual-message route tests cover isolation/source header',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'required', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-conversations',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/conversations/*', source: 'apps/worker/src/routes/crm/conversations.ts',
    testReferences: ['apps/worker/src/routes/crm/conversations-tenant-scope.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant/friend ownership; friend id is selector only',
    lineAccountIdAuthority: 'server validates conversation account against tenant mapping',
    displayedInfo: ['conversation list/detail'],
    mutation: 'read-only conversation view',
    confirmation: 'read-only route with server tenant-boundary validation',
    phiClassification: 'PHI',
    audit: 'tenant-scope regression test covers cross-tenant denial',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-generic-rich-menu-groups',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/rich-menu-groups/*', source: 'apps/worker/src/routes/messaging/rich-menu-groups.ts',
    testReferences: ['apps/worker/src/routes/messaging/rich-menu-groups.test.ts', 'apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server tenant/account scope and rich-menu ownership; ids are selectors only',
    lineAccountIdAuthority: 'server validates group/account ownership against tenant mapping',
    displayedInfo: ['rich-menu groups/pages/images', 'publish/reconcile operation state'],
    mutation: 'create/update/delete/upload/publish/unpublish/apply-to-tag operations',
    confirmation: 'CSRF plus expected revision/operation reconcile and explicit external publish/apply confirmation',
    phiClassification: 'operational-sensitive',
    audit: 'operation/reconcile state and route tests cover external failure/cleanup behavior',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-meet-consultations',
    kind: 'api', surface: 'pharmacy-admin', path: '/api/meet-consultations*', source: 'apps/worker/src/routes/booking/meet-consultations.ts',
    testReferences: ['apps/worker/src/services/meet-consultation-reminders.test.ts', 'apps/worker/src/services/webinar-consultation-booking.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'authenticated tenant is server context; list uses tenant mapping and mutations resolve friend/event to an owned LINE account',
    lineAccountIdAuthority: 'server resolves friendId/externalEventId selectors through tenant_line_accounts and rechecks exact line_account_id in the shared service',
    displayedInfo: ['Google Calendar event id', 'LINE friend id', 'date/time and Meet URL'],
    mutation: 'register/update consultation follow-up and cancel external event/reminders',
    confirmation: 'required human confirmation plus calendar registration and day-before/hour-before reminders',
    phiClassification: 'operational-sensitive',
    audit: 'consultation/reminder rows retain lifecycle state; account-scope negative tests cover list/register/cancel',
    queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'required-calendar-and-reminders', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-activity-notifications',
    kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}activity-notifications*`, source: 'apps/worker/src/custom/pharmacy/activity-notifications/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/activity-notifications/routes.test.ts'],
    roles: ['tenant-admin', 'staff'],
    authority: 'server pharmacy staff/account scope',
    lineAccountIdAuthority: 'server-derived and account-validated',
    displayedInfo: ['activity notification queue and acknowledgement state'],
    mutation: 'acknowledge activity notification',
    confirmation: 'CSRF and server actor/account validation',
    phiClassification: 'PHI', audit: 'acknowledgement actor/timestamp are server recorded', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-continuity',
    kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}continuity*`, source: 'apps/worker/src/custom/pharmacy/continuity/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/continuity/routes.test.ts'],
    roles: ['tenant-admin', 'staff'], authority: 'server pharmacy staff/account scope', lineAccountIdAuthority: 'server-derived and patient/account validated',
    displayedInfo: ['continuity queue and expectation state'], mutation: 'create/end continuity expectations', confirmation: 'CSRF, state transition and stale validation', phiClassification: 'PHI', audit: 'continuity actor/transition audit', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-data-subject-requests',
    kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}data-subject-requests*`, source: 'apps/worker/src/custom/pharmacy/data-subject-requests/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/data-subject-requests/routes.test.ts'], roles: ['tenant-admin', 'privacy-staff'],
    authority: 'server pharmacy staff/account scope and request ownership', lineAccountIdAuthority: 'server-derived and request/account validated', displayedInfo: ['request lifecycle and legal hold state'], mutation: 'create/verify/hold/resolve data-subject request', confirmation: 'CSRF, identity verification, legal-hold and resolution gates', phiClassification: 'PHI', audit: 'request lifecycle actor/audit', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-emergency-contraception', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}emergency-contraception*`, source: 'apps/worker/src/custom/pharmacy/emergency-contraception/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/emergency-contraception/routes.test.ts'], roles: ['tenant-admin', 'pharmacist', 'staff'], authority: 'server staff/account scope plus trained-pharmacist authorization', lineAccountIdAuthority: 'server-derived and account-validated', displayedInfo: ['configuration/reminders', 'slots/inventory', 'intake/sale workflow'], mutation: 'configuration, inventory, slot, intake transition and sale operations', confirmation: 'CSRF, pharmacist gate, explicit confirmation and state/version checks', phiClassification: 'PHI', audit: 'workflow/sale actor audit', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-fulfillment', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}fulfillment-quotes/*`, source: 'apps/worker/src/custom/pharmacy/fulfillment/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/fulfillment/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff/submission/account scope', lineAccountIdAuthority: 'server validates submission account ownership', displayedInfo: ['fulfillment quote state and options'], mutation: 'create/update fulfillment quote', confirmation: 'CSRF, staff auth and expected submission/state validation', phiClassification: 'PHI', audit: 'quote actor/state audit', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-growth-loop', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}growth/*`, source: 'apps/worker/src/custom/pharmacy/growth-loop/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/growth-loop/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server pharmacy capability and tenant/account scope', lineAccountIdAuthority: 'server validates account selector against tenant membership', displayedInfo: ['readiness/operations summary', 'growth dashboard/source/submission state'], mutation: 'configuration, source association and submission validity changes', confirmation: 'CSRF plus capability/expected revision/state validation', phiClassification: 'operational-sensitive', audit: 'source/submission/configuration actor audit', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-intake', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}patients*`, source: 'apps/worker/src/custom/pharmacy/intake/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/intake/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff authorization and encrypted intake tenant/account scope', lineAccountIdAuthority: 'server-derived; patient id is selector only', displayedInfo: ['patient list/history/detail/intake'], mutation: 'admin intake workflow operations', confirmation: 'CSRF, encrypted readback, server authorization and stale handling', phiClassification: 'PHI', audit: 'intake actor/tenant/account audit', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-medication-followup', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}medication-followups*`, source: 'apps/worker/src/custom/pharmacy/medication-followup/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/medication-followup/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff/account scope for medication follow-up', lineAccountIdAuthority: 'server-derived and submission/account validated', displayedInfo: ['follow-up queue/status'], mutation: 'create follow-up and transition status', confirmation: 'CSRF plus workflow state/CAS validation', phiClassification: 'PHI', audit: 'follow-up actor/transition audit', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-myna', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}myna-*`, source: 'apps/worker/src/custom/pharmacy/myna/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/myna/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff/account scope for Myna handoffs/endpoint', lineAccountIdAuthority: 'server-derived and account-validated', displayedInfo: ['handoffs/verification and endpoint status'], mutation: 'handoff verification and endpoint configuration', confirmation: 'CSRF plus verification/state checks', phiClassification: 'PHI', audit: 'verification/configuration actor audit', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-print', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}print/*`, source: 'apps/worker/src/custom/pharmacy/print/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/print/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff/submission/account scope', lineAccountIdAuthority: 'server validates submission/account ownership', displayedInfo: ['print preparation/task state'], mutation: 'prepare/claim/acknowledge print tasks', confirmation: 'CSRF plus task state transition and idempotent acknowledgement', phiClassification: 'PHI', audit: 'print task actor/status audit', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-privacy-policy', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}privacy-policy`, source: 'apps/worker/src/custom/pharmacy/privacy-policy/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/privacy-policy/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff/account scope', lineAccountIdAuthority: 'server-derived and account-validated', displayedInfo: ['tenant privacy policy/revision'], mutation: 'update privacy policy', confirmation: 'CSRF plus server validation/revision check', phiClassification: 'none', audit: 'policy actor/revision audit', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-provisioning', kind: 'api', surface: 'platform-admin', path: '/api/platform/pharmacy/* and /api/platform-admin/tenants', source: 'apps/worker/src/custom/pharmacy/provisioning/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/provisioning/routes.test.ts', 'apps/worker/src/custom/pharmacy/provisioning/cli-break-glass.test.ts', 'apps/worker/src/custom/pharmacy/provisioning/admin-auth.test.ts'], roles: ['platform-admin', 'tenant-admin'], authority: 'server platform-admin/tenant-admin session and explicit provisioning authorization', lineAccountIdAuthority: 'server creates/validates tenant and line-account bindings; payload ids are not authority', displayedInfo: ['provisioning receipt', 'bootstrap/session state', 'credential migration coverage'], mutation: 'tenant/admin bootstrap, CLI break-glass, credential/intake encryption migration', confirmation: 'explicit human approval/ticket, CSRF/session, idempotent request hash, production gate', phiClassification: 'credentials', audit: 'provisioning/migration actor and receipt audit; secrets redacted', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-public-profile', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}public-profile`, source: 'apps/worker/src/custom/pharmacy/public-profile/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/public-profile/routes.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff/account scope', lineAccountIdAuthority: 'server-derived and account-validated', displayedInfo: ['patient-facing pharmacy profile'], mutation: 'update public profile', confirmation: 'CSRF plus server validation/revision check', phiClassification: 'none', audit: 'profile actor/revision audit', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-prescriptions', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}prescriptions*`, source: 'apps/worker/src/custom/pharmacy/prescriptions/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/prescriptions/routes.test.ts', 'apps/worker/src/custom/pharmacy/prescriptions/boundary.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff authorization and prescriptionLineAccountId scope', lineAccountIdAuthority: 'server-derived/validated; submission/file ids are selectors only', displayedInfo: ['prescription queue/stats/detail/files'], mutation: 'prescription workflow actions', confirmation: 'CSRF, action confirmation, expected state/version and binary access checks', phiClassification: 'PHI', audit: 'prescription event/actor audit and scoped file access', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-pharmacy-rich-menu', kind: 'api', surface: 'pharmacy-admin', path: `${customRoutePrefix}rich-menus/*`, source: 'apps/worker/src/custom/pharmacy/rich-menu/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/rich-menu/routes.test.ts', 'apps/worker/src/custom/pharmacy/platform-admin/api-coverage.test.ts'], roles: ['tenant-admin', 'staff'], authority: 'server staff/capability/account scope; platform admin is explicitly forbidden on tenant route', lineAccountIdAuthority: 'server validates accountId selector against tenant membership', displayedInfo: ['pharmacy layout/candidate/lifecycle/version/diff'], mutation: 'layout/lifecycle/version create/rename/delete/prepare', confirmation: 'CSRF, capability gate, expected revision/CAS, external cleanup outcome', phiClassification: 'operational-sensitive', audit: 'rich-menu operation/revision/cleanup audit', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-platform-admin-core', kind: 'api', surface: 'platform-admin', path: `${platformAdminPrefix}login|tenants|support-grants|logs|audit`, source: 'apps/worker/src/custom/pharmacy/platform-admin/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/platform-admin/routes.test.ts', 'apps/worker/src/custom/pharmacy/platform-admin/api-coverage.test.ts'], roles: ['platform-admin'], authority: 'platform-admin session middleware and platform-admin CSRF', lineAccountIdAuthority: 'server validates tenant/path/account mapping; query ids are selectors only', displayedInfo: ['tenant metadata/health inputs', 'support grant state', 'logs/audit'], mutation: 'tenant update/outbound pause/webhook retry/support grant/session auth', confirmation: 'platform-admin CSRF, reason/ticket/support grant, explicit operational confirmation and retry safety', phiClassification: 'PHI-free-default', audit: 'every platform-admin access/mutation records platform_admin_access', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-platform-admin-dashboard', kind: 'api', surface: 'platform-admin', path: `${platformAdminPrefix}dashboard|integrity|tenants/:id/health`, source: 'apps/worker/src/custom/pharmacy/platform-admin/dashboard-routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/platform-admin/dashboard-routes.test.ts'], roles: ['platform-admin'], authority: 'platform-admin session middleware', lineAccountIdAuthority: 'server maps account readiness through tenant_line_accounts', displayedInfo: ['platform-wide counters/readiness', 'tenant operational health', 'integrity findings'], mutation: 'read-only operational/health views', confirmation: 'platform-admin session; no external side effect', phiClassification: 'PHI-free-default', audit: 'dashboard/health/integrity reads record platform_admin_access', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-platform-admin-operations', kind: 'api', surface: 'platform-admin', path: `${platformAdminPrefix}tenants/:id/staff|revoke-sessions|line-status|test-connection`, source: 'apps/worker/src/custom/pharmacy/platform-admin/operations-routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/platform-admin/operations-routes.test.ts'], roles: ['platform-admin'], authority: 'platform-admin session and validated tenant/staff/account path scope', lineAccountIdAuthority: 'server validates tenant_line_accounts; lineAccountId path selector is not authority', displayedInfo: ['staff status', 'session/LINE connection status'], mutation: 'disable staff, revoke tenant sessions, test LINE connection', confirmation: 'platform-admin CSRF, explicit operational confirmation, no hidden production send', phiClassification: 'credentials', audit: 'platform-admin access and operation actor audit; secrets redacted', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-platform-data-protection', kind: 'api', surface: 'platform-admin', path: '/api/platform-admin/data-protection/recovery-operations*', source: 'apps/worker/src/custom/pharmacy/platform-admin/data-protection-routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/platform-admin/data-protection-routes.test.ts', 'scripts/deploy/v032-route-inventory.test.ts'], roles: ['platform-admin'], authority: 'platform-admin session middleware precedes the mounted recovery workflow', lineAccountIdAuthority: 'server recovery operation scope fixes tenant, LINE account, and environment; body identity is never authority', displayedInfo: ['recovery operation/preflight/approval/execution state'], mutation: 'preflight, approve, execute, inspect recovery operation', confirmation: 'human approval, preflight, CAS/idempotency, and production data-loss gate', phiClassification: 'credentials', audit: 'every recovery operation transition records platform_admin_access', queryAuthority: 'server-tenant/account-bound', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
];

const patientLiffApiDefinitions: EntryDefinition[] = [
  {
    id: 'api-patient-liff-core', kind: 'api', surface: 'patient-liff', path: '/api/liff/config and /api/liff/pharmacy/feature-access', source: 'apps/worker/src/routes/liff/liff.ts',
    testReferences: ['apps/worker/src/routes/liff/liff-pharmacy-oauth-boundary.test.ts', 'apps/worker/src/custom/pharmacy/growth-loop/patient-feature-access.test.ts'],
    roles: ['unauthenticated-config', 'line-patient'], authority: 'unique server LIFF resolution; feature access additionally requires a verified LINE ID token and friend/account binding',
    lineAccountIdAuthority: 'liffId is a selector; the server resolves the account and query account ids are never authority', displayedInfo: ['account name and enabled features', 'owned existing-feature projection'],
    mutation: 'read-only', confirmation: 'unique LIFF mapping, no-store config and authenticated owner projection', phiClassification: 'PHI-free-default',
    audit: 'no patient identifier is returned; ambiguous LIFF mapping fails closed', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-prescriptions', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/prescriptions*', source: 'apps/worker/src/custom/pharmacy/prescriptions/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/prescriptions/routes.test.ts', 'apps/worker/src/custom/pharmacy/prescriptions/boundary.test.ts'],
    roles: ['line-patient'], authority: 'verified LINE subject and server prescription owner/account scope', lineAccountIdAuthority: 'liffId/submission/file ids are selectors and every resource is server owner/account validated',
    displayedInfo: ['owned prescription history/status'], mutation: 'reserve/upload/submit/cancel/resubmit/arrival', confirmation: 'feature admission, consent, idempotency, CAS and R2 checksum/ready transition',
    phiClassification: 'PHI', audit: 'prescription/file/workflow events are scoped to the bound owner/account', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-intake', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/patients*', source: 'apps/worker/src/custom/pharmacy/intake/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/intake/routes.test.ts', 'apps/worker/src/custom/pharmacy/intake/repository.test.ts'], roles: ['line-patient'],
    authority: 'verified LINE subject and server patient/friend/account ownership', lineAccountIdAuthority: 'liffId/patient id are selectors and the owner relation is server validated',
    displayedInfo: ['owned patient profiles and latest intake'], mutation: 'create/update/archive patient and submit encrypted intake', confirmation: 'owner binding, validation, encrypted-write-first and revision checks',
    phiClassification: 'PHI', audit: 'patient/intake revisions remain tenant/account/owner scoped', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-continuity', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/continuity*', source: 'apps/worker/src/custom/pharmacy/continuity/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/continuity/routes.test.ts'], roles: ['line-patient'], authority: 'verified LINE subject and server continuity owner/account scope',
    lineAccountIdAuthority: 'liffId/expectation id are selectors and friend/account ownership is server validated', displayedInfo: ['owned continuity state'], mutation: 'respond to expectation or pause continuity',
    confirmation: 'feature existing-only admission and server state/idempotency validation', phiClassification: 'PHI', audit: 'continuity transitions record the scoped owner/account',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-myna', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/myna-handoffs*', source: 'apps/worker/src/custom/pharmacy/myna/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/myna/routes.test.ts'], roles: ['line-patient'], authority: 'verified LINE subject and server Myna handoff owner/account scope',
    lineAccountIdAuthority: 'liffId/handoff id are selectors and ownership is server validated', displayedInfo: ['active owned handoff state'], mutation: 'create/launch/report an owned handoff',
    confirmation: 'feature admission, one-active-handoff, signed launch and state/idempotency checks', phiClassification: 'PHI', audit: 'handoff events are scoped and external URLs contain no patient/friend/LIFF id',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-followup', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/medication-followups*', source: 'apps/worker/src/custom/pharmacy/medication-followup/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/medication-followup/routes.test.ts', 'apps/worker/src/custom/pharmacy/medication-followup/respond-pagination.test.ts'], roles: ['line-patient'],
    authority: 'verified LINE subject and server follow-up owner/account scope', lineAccountIdAuthority: 'liffId/follow-up id are selectors and ownership is server validated',
    displayedInfo: ['owned follow-up state'], mutation: 'submit an owned response', confirmation: 'feature existing-only admission and server transition/idempotency checks',
    phiClassification: 'PHI', audit: 'follow-up events record the scoped owner/account', queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-emergency', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/emergency-contraception*', source: 'apps/worker/src/custom/pharmacy/emergency-contraception/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/emergency-contraception/routes.test.ts'], roles: ['line-patient'], authority: 'verified LINE subject plus server EC owner/account and operational-readiness gates',
    lineAccountIdAuthority: 'liffId/intake id are selectors and ownership is server validated', displayedInfo: ['availability and owned intake status'], mutation: 'create/cancel an owned EC intake',
    confirmation: 'feature/readiness, consent version/hash, encrypted payload and state checks', phiClassification: 'PHI', audit: 'EC access/intake events are fail-closed and owner/account scoped',
    queryAuthority: 'selector-only-server-validated', manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-privacy-policy', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/privacy-policy', source: 'apps/worker/src/custom/pharmacy/privacy-policy/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/privacy-policy/routes.test.ts'], roles: ['line-patient'], authority: 'server uniquely resolves liffId and binds the active account policy',
    lineAccountIdAuthority: 'liffId is a selector; the server resolves the account and query account id is not authority', displayedInfo: ['published pharmacy privacy policy'], mutation: 'read-only',
    confirmation: 'unique LIFF mapping and no-store account scope', phiClassification: 'none', audit: 'no patient data is returned', queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
  {
    id: 'api-patient-liff-public-profile', kind: 'api', surface: 'patient-liff', path: '/api/liff/pharmacy/public-profile', source: 'apps/worker/src/custom/pharmacy/public-profile/routes.ts',
    testReferences: ['apps/worker/src/custom/pharmacy/public-profile/routes.test.ts'], roles: ['line-patient'], authority: 'server uniquely resolves liffId to one active pharmacy account',
    lineAccountIdAuthority: 'liffId is a selector; the server resolves the account and query account id is not authority', displayedInfo: ['published patient-facing pharmacy profile'], mutation: 'read-only',
    confirmation: 'unique LIFF mapping, safe projection and no-store response', phiClassification: 'none', audit: 'no PHI is returned', queryAuthority: 'selector-only-server-validated',
    manualOneToOne: 'not-applicable', meetFollowUp: 'not-applicable', reachability: 'reachable',
  },
];

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function repoPath(repoRoot: string, path: string): string {
  return relative(repoRoot, join(repoRoot, path)).split('/').join('/');
}

export function discoverCustomPharmacyRouteSources(repoRoot = process.cwd()): string[] {
  const root = join(repoRoot, 'apps/worker/src/custom/pharmacy');
  return walkFiles(root)
    .filter((path) => /(?:^|-)routes\.ts$/u.test(basename(path)))
    .map((path) => relative(repoRoot, path).split('/').join('/'))
    .sort();
}

function readConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const pattern = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"`])([\s\S]*?)\2/g;
  for (const match of source.matchAll(pattern)) constants.set(match[1], match[3]);
  return constants;
}

function interpolatePath(rawPath: string, constants: Map<string, string>): string {
  return rawPath.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
    const name = expression.trim();
    return constants.get(name) ?? `:${name.replace(/[^A-Za-z0-9_]+/gu, '-')}`;
  });
}

export function extractRoutePatterns(source: string, prefixes?: readonly string[]): RoutePattern[] {
  const constants = readConstants(source);
  const routes: RoutePattern[] = [];
  const add = (method: string, rawPath: string) => {
    const path = interpolatePath(rawPath, constants);
    if (!path.startsWith('/api/')) return;
    if (prefixes && !prefixes.some((prefix) => path.startsWith(prefix))) return;
    routes.push({ method: method.toUpperCase() as HttpMethod, path });
  };

  const literal = /\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([\s\S]*?)\2/g;
  for (const match of source.matchAll(literal)) add(match[1], match[3]);

  const identifier = /\.\s*(get|post|put|patch|delete)\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,/g;
  for (const match of source.matchAll(identifier)) {
    const resolved = constants.get(match[2]);
    if (resolved) add(match[1], resolved);
  }

  const unique = new Map<string, RoutePattern>();
  for (const route of routes) unique.set(`${route.method} ${route.path}`, route);
  return [...unique.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function cloneDefinition(definition: EntryDefinition): InventoryEntry {
  return {
    ...definition,
    testReferences: [...definition.testReferences],
    roles: [...definition.roles],
    displayedInfo: [...definition.displayedInfo],
  };
}

export function buildV032RouteInventory(repoRoot = process.cwd()): V032RouteInventory {
  const customSources = discoverCustomPharmacyRouteSources(repoRoot);
  const pages = [...pharmacyPageDefinitions, ...patientLiffPageDefinitions, ...platformPageDefinitions]
    .map(cloneDefinition);
  const apis = [...apiDefinitions, ...patientLiffApiDefinitions].map((definition) => {
    const entry = cloneDefinition(definition);
    const source = readFileSync(join(repoRoot, entry.source), 'utf8');
    const prefixes = entry.surface === 'patient-liff'
      ? entry.source === 'apps/worker/src/routes/liff/liff.ts'
        ? ['/api/liff/config', '/api/liff/pharmacy/feature-access']
        : ['/api/liff/pharmacy/']
      : entry.source.startsWith('apps/worker/src/custom/pharmacy/')
        ? [customRoutePrefix, platformAdminPrefix, platformPharmacyPrefix]
        : undefined;
    entry.routePaths = extractRoutePatterns(source, prefixes);
    return entry;
  });

  return {
    snapshot: V032_SNAPSHOT,
    pages,
    apis,
    customPharmacyRouteSources: customSources,
  };
}

export function inventorySourceExists(repoRoot: string, entry: InventoryEntry): boolean {
  const paths = [entry.source, entry.componentSource, ...entry.testReferences].filter(
    (path): path is string => Boolean(path),
  );
  return paths.every((path) => existsSync(join(repoRoot, path)));
}
