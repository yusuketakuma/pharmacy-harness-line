export type PharmacyAdminApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type PharmacyAdminApiAccountScope =
  | 'tenant'
  | 'query:accountId'
  | 'query:line_account_id'
  | 'path:before-last'
  | 'path:last';

export type PharmacyAdminApiCoverage = {
  method: PharmacyAdminApiMethod;
  path: RegExp;
  accountScope: PharmacyAdminApiAccountScope;
  safeOutput: boolean;
  secretOutput?: true;
  mutationGate: 'read-only' | 'apply' | 'confirmation';
};

export type PharmacyAdminApiDeferred = {
  method: PharmacyAdminApiMethod;
  path: RegExp;
  reason: 'binary-output' | 'destructive-operation' | 'external-operation' |
    'legacy-lifecycle' | 'patient-operation' | 'retired';
};

const read = (path: RegExp, accountScope: PharmacyAdminApiAccountScope): PharmacyAdminApiCoverage => ({
  method: 'GET', path, accountScope, safeOutput: true, mutationGate: 'read-only',
});
const mutate = (
  method: Exclude<PharmacyAdminApiMethod, 'GET'>,
  path: RegExp,
  accountScope: PharmacyAdminApiAccountScope,
  mutationGate: 'apply' | 'confirmation' = 'apply',
  secretOutput = false,
): PharmacyAdminApiCoverage => ({
  method,
  path,
  accountScope,
  safeOutput: !secretOutput,
  mutationGate,
  ...(secretOutput ? { secretOutput: true as const } : {}),
});

const LINE_ACCOUNT = /^\/api\/line-accounts\/(?!order$)[^/]+$/u;
const STAFF = /^\/api\/staff\/[^/]+$/u;
const STAFF_ACCOUNTS = /^\/api\/staff\/[^/]+\/accounts$/u;
const STAFF_RESET_PASSWORD = /^\/api\/staff\/[^/]+\/reset-password$/u;
const GROWTH_CONFIG = /^\/api\/custom\/pharmacy\/growth\/config$/u;
const GROWTH_DASHBOARD = /^\/api\/custom\/pharmacy\/growth\/dashboard$/u;
const GROWTH_SOURCES = /^\/api\/custom\/pharmacy\/growth\/sources$/u;
const GROWTH_SOURCE = /^\/api\/custom\/pharmacy\/growth\/sources\/[^/]+$/u;
const PUBLIC_PROFILE = /^\/api\/custom\/pharmacy\/public-profile$/u;
const PRIVACY_POLICY = /^\/api\/custom\/pharmacy\/privacy-policy$/u;
const MYNA_ENDPOINT = /^\/api\/custom\/pharmacy\/myna-endpoint$/u;
const MYNA_ENDPOINT_VERIFICATION = /^\/api\/custom\/pharmacy\/myna-endpoint\/verification$/u;
const EC = /^\/api\/custom\/pharmacy\/emergency-contraception\/(?:config|reminders)$/u;
const EC_PHARMACIST = /^\/api\/custom\/pharmacy\/emergency-contraception\/pharmacists\/[^/]+$/u;
const EC_SLOT = /^\/api\/custom\/pharmacy\/emergency-contraception\/slots$/u;
const EC_SLOT_CANCEL = /^\/api\/custom\/pharmacy\/emergency-contraception\/slots\/[^/]+\/cancel$/u;
const EC_INVENTORY = /^\/api\/custom\/pharmacy\/emergency-contraception\/inventory$/u;
const EC_COUNTER_CONFIRMATION =
  /^\/api\/custom\/pharmacy\/emergency-contraception\/intakes\/[^/]+\/counter-confirmations\/[^/]+$/u;
const EC_SALE = /^\/api\/custom\/pharmacy\/emergency-contraception\/intakes\/[^/]+\/sale$/u;
const RICH_LAYOUT = /^\/api\/custom\/pharmacy\/rich-menus\/(?:layout|lifecycle)$/u;
const RICH_VERSIONS = /^\/api\/custom\/pharmacy\/rich-menus\/versions$/u;
const RICH_VERSION = /^\/api\/custom\/pharmacy\/rich-menus\/versions\/[^/]+$/u;
const RICH_PUBLISH = /^\/api\/rich-menu-groups\/[^/]+\/publish$/u;
const RICH_DEFAULT = /^\/api\/rich-menu-groups\/[^/]+\/apply-to-tag$/u;
const RICH_OPERATION = /^\/api\/rich-menu-groups\/operations\/[^/]+\/(?:reconcile|resume)$/u;

/** CLI-visible, non-PHI pharmacy administration API contract. */
export const PHARMACY_ADMIN_API_COVERAGE: readonly PharmacyAdminApiCoverage[] = [
  read(/^\/api\/account-settings\/(?:link-base-url|tracked-link-base-url)$/u, 'tenant'),
  mutate('PUT', /^\/api\/account-settings\/(?:link-base-url|tracked-link-base-url)$/u, 'tenant'),
  read(/^\/api\/line-accounts$/u, 'tenant'),
  read(LINE_ACCOUNT, 'path:last'),
  mutate('PATCH', LINE_ACCOUNT, 'path:last'),
  mutate('PUT', LINE_ACCOUNT, 'path:last'),
  mutate('POST', /^\/api\/line-accounts$/u, 'tenant'),
  mutate('PATCH', /^\/api\/line-accounts\/order$/u, 'tenant'),
  mutate('POST', /^\/api\/line-accounts\/[^/]+\/connect$/u, 'path:before-last'),

  read(/^\/api\/staff(?:\/me|\/[^/]+|\/[^/]+\/accounts)?$/u, 'tenant'),
  mutate('POST', /^\/api\/staff$/u, 'tenant', 'apply', true),
  mutate('PATCH', STAFF, 'tenant'),
  mutate('PUT', STAFF_ACCOUNTS, 'tenant'),
  mutate('POST', STAFF_RESET_PASSWORD, 'tenant', 'apply', true),
  mutate('DELETE', STAFF, 'tenant'),
  read(/^\/api\/tags$/u, 'tenant'),

  read(GROWTH_CONFIG, 'query:line_account_id'),
  mutate('PUT', GROWTH_CONFIG, 'query:line_account_id'),
  read(GROWTH_DASHBOARD, 'query:line_account_id'),
  read(GROWTH_SOURCES, 'query:line_account_id'),
  mutate('POST', GROWTH_SOURCES, 'query:line_account_id'),
  mutate('PATCH', GROWTH_SOURCE, 'query:line_account_id'),
  read(/^\/api\/custom\/pharmacy\/readiness$/u, 'query:line_account_id'),
  read(/^\/api\/custom\/pharmacy\/(?:operations-summary|active-work)$/u, 'query:line_account_id'),
  read(PUBLIC_PROFILE, 'query:line_account_id'),
  mutate('PUT', PUBLIC_PROFILE, 'query:line_account_id'),
  read(PRIVACY_POLICY, 'query:line_account_id'),
  mutate('PUT', PRIVACY_POLICY, 'query:line_account_id'),
  read(MYNA_ENDPOINT, 'query:line_account_id'),
  mutate('PUT', MYNA_ENDPOINT, 'query:line_account_id'),
  mutate('PATCH', MYNA_ENDPOINT, 'query:line_account_id'),
  mutate('POST', MYNA_ENDPOINT_VERIFICATION, 'query:line_account_id'),

  read(EC, 'query:line_account_id'),
  mutate('PUT', EC, 'query:line_account_id'),
  mutate('PUT', EC_PHARMACIST, 'query:line_account_id'),
  mutate('POST', EC_SLOT, 'query:line_account_id'),
  mutate('POST', EC_SLOT_CANCEL, 'query:line_account_id'),
  mutate('PUT', EC_INVENTORY, 'query:line_account_id'),

  read(RICH_LAYOUT, 'query:accountId'),
  mutate('PUT', RICH_LAYOUT, 'query:accountId'),
  read(/^\/api\/custom\/pharmacy\/rich-menus\/candidate$/u, 'query:accountId'),
  read(RICH_VERSIONS, 'query:accountId'),
  read(/^\/api\/custom\/pharmacy\/rich-menus\/versions\/[^/]+\/diff$/u, 'query:accountId'),
  mutate('POST', RICH_VERSIONS, 'query:accountId'),
  mutate('PATCH', RICH_VERSION, 'query:accountId'),
  mutate('DELETE', RICH_VERSION, 'query:accountId'),
  mutate('POST', RICH_PUBLISH, 'query:accountId', 'confirmation'),
  mutate('POST', RICH_DEFAULT, 'query:accountId', 'confirmation'),
  mutate('POST', RICH_OPERATION, 'query:accountId', 'confirmation'),
  read(/^\/api\/rich-menu-groups$/u, 'query:accountId'),
  read(/^\/api\/rich-menu-groups\/external$/u, 'query:accountId'),
  read(/^\/api\/rich-menu-groups\/[^/]+$/u, 'query:accountId'),
];

/** Routes intentionally unavailable to the generic settings CLI. */
export const PHARMACY_ADMIN_API_DEFERRED: readonly PharmacyAdminApiDeferred[] = [
  {
    method: 'GET',
    path: /^\/api\/account-settings\/test-recipients$/u,
    reason: 'patient-operation',
  },
  {
    method: 'PUT',
    path: /^\/api\/account-settings\/test-recipients$/u,
    reason: 'patient-operation',
  },
  {
    method: 'GET',
    path: /^\/api\/custom\/pharmacy\/emergency-contraception\/intakes(?:\/[^/]+)?$/u,
    reason: 'patient-operation',
  },
  {
    method: 'POST',
    path: /^\/api\/custom\/pharmacy\/emergency-contraception\/intakes\/[^/]+\/transitions$/u,
    reason: 'patient-operation',
  },
  { method: 'GET', path: EC_COUNTER_CONFIRMATION, reason: 'patient-operation' },
  { method: 'PUT', path: EC_COUNTER_CONFIRMATION, reason: 'patient-operation' },
  { method: 'POST', path: EC_SALE, reason: 'patient-operation' },
  { method: 'GET', path: EC_SALE, reason: 'patient-operation' },
  {
    method: 'GET',
    path: /^\/api\/custom\/pharmacy\/myna-handoffs(?:\/[^/]+)?$/u,
    reason: 'patient-operation',
  },
  {
    method: 'POST',
    path: /^\/api\/custom\/pharmacy\/myna-handoffs\/[^/]+\/verifications$/u,
    reason: 'patient-operation',
  },
  {
    method: 'POST',
    path: /^\/api\/custom\/pharmacy\/growth\/submissions\/[^/]+\/source$/u,
    reason: 'patient-operation',
  },
  {
    method: 'PUT',
    path: /^\/api\/custom\/pharmacy\/growth\/submissions\/[^/]+\/validity$/u,
    reason: 'patient-operation',
  },
  {
    method: 'GET',
    path: /^\/api\/custom\/pharmacy\/rich-menus\/candidate\/image$/u,
    reason: 'binary-output',
  },
  {
    method: 'POST',
    path: /^\/api\/custom\/pharmacy\/rich-menus\/prepare$/u,
    reason: 'retired',
  },
  { method: 'DELETE', path: /^\/api\/line-accounts\/[^/]+$/u, reason: 'destructive-operation' },
  {
    method: 'GET',
    path: /^\/api\/line-accounts\/[^/]+\/(?:follower-insight|follower-import)$/u,
    reason: 'patient-operation',
  },
  {
    method: 'POST',
    path: /^\/api\/line-accounts\/[^/]+\/follower-import\/(?:detect|start|step)$/u,
    reason: 'patient-operation',
  },
  {
    method: 'GET',
    path: /^\/api\/rich-menu-groups\/external\/[^/]+\/image$/u,
    reason: 'binary-output',
  },
  { method: 'GET', path: /^\/api\/rich-menu-images\/[^/]+$/u, reason: 'binary-output' },
  {
    method: 'POST',
    path: /^\/api\/rich-menu-groups\/[^/]+\/pages\/[^/]+\/image$/u,
    reason: 'binary-output',
  },
  { method: 'POST', path: /^\/api\/rich-menu-groups\/import$/u, reason: 'external-operation' },
  { method: 'DELETE', path: /^\/api\/rich-menu-groups\/external\/[^/]+$/u, reason: 'external-operation' },
  { method: 'POST', path: /^\/api\/rich-menu-groups$/u, reason: 'legacy-lifecycle' },
  { method: 'PATCH', path: /^\/api\/rich-menu-groups\/[^/]+$/u, reason: 'legacy-lifecycle' },
  { method: 'DELETE', path: /^\/api\/rich-menu-groups\/[^/]+$/u, reason: 'legacy-lifecycle' },
  { method: 'POST', path: /^\/api\/rich-menu-groups\/[^/]+\/unpublish$/u, reason: 'legacy-lifecycle' },
];

export function findPharmacyAdminApiCoverage(
  method: string,
  path: string,
): PharmacyAdminApiCoverage | undefined {
  return PHARMACY_ADMIN_API_COVERAGE.find((entry) => entry.method === method && entry.path.test(path));
}

export function findPharmacyAdminApiDeferred(
  method: string,
  path: string,
): PharmacyAdminApiDeferred | undefined {
  return PHARMACY_ADMIN_API_DEFERRED.find((entry) =>
    entry.method === method && entry.path.test(path));
}
