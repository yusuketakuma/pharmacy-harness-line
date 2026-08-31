import type { Message } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  computeNextDeliveryAt,
  getScenarioSteps,
  jstNow,
  type DeliveryMode,
} from '@line-crm/db';

const LINE_RETRY_HORIZON_MS = 24 * 60 * 60_000;
const LINE_RETRY_SAFETY_MARGIN_MS = 60_000;
// The minute cron is the only durable retry after request-time processing.
// Keep a small scheduling margin; an expired-token 400 is terminalized below.
const LINE_REPLY_RETRY_HORIZON_MS = 65_000;
const LINE_REPLY_PREPARE_LEASE_MS = 15_000;
// ponytail: one cron-sized batch; shard by account only if a measured backlog exceeds one tick.
const OUTBOUND_REPLAY_BATCH_SIZE = 100;

type DeliveryResult =
  | 'sent'
  | 'already_sent'
  | 'in_flight'
  | 'reconciliation_required'
  | 'not_sent';

interface TrackedMessageParams {
  db: D1Database;
  now?: Date;
  operationId: string;
  tenantId: string;
  lineAccountId: string;
  friendId: string;
  messageType: string;
  content: string;
  source: string;
  broadcastId?: string | null;
  scenarioEnrollmentId?: string | null;
  scenarioStepId?: string | null;
  scenarioClaimToken?: string | null;
  templateIdAtSend?: string | null;
}

interface DeliveryRow {
  outcome: 'open' | 'accepted' | 'retired';
  source: string;
  delivery_type: 'push' | 'reply' | 'broadcast';
  retry_key: string | null;
  request_json: string | null;
  prepare_token: string;
  retry_until: string;
  stop_reason: string | null;
  attempt_count: number;
  updated_at: string;
}

interface PayloadRow {
  friend_id: string;
  message_type: string;
  log_content: string;
  log_delivery_type: 'push' | 'reply' | 'test';
  request_json: string | null;
  broadcast_id: string | null;
  scenario_enrollment_id: string | null;
  scenario_step_id: string | null;
  scenario_claim_token: string | null;
  template_id_at_send: string | null;
}

interface AttemptedPushRow extends DeliveryRow {
  operation_id: string;
  tenant_id: string;
  line_account_id: string;
  payload_operation_id: string | null;
  friend_id: string | null;
  message_type: string | null;
  log_content: string | null;
  log_delivery_type: 'push' | 'reply' | 'test' | null;
  request_json: string | null;
  broadcast_id: string | null;
  scenario_enrollment_id: string | null;
  scenario_step_id: string | null;
  scenario_claim_token: string | null;
  template_id_at_send: string | null;
}

export interface TrackedLinePushRequest {
  to: string;
  messages: Message[];
}

type TrackedLinePushSender = (
  request: TrackedLinePushRequest,
  retryKey: string,
) => Promise<void>;

export async function retireExpiredOutboundLineDeliveries(
  db: D1Database,
  now: Date = new Date(),
): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db.prepare(
    `UPDATE outbound_line_deliveries
        SET outcome = 'retired', settled_at = ?, stop_reason = 'retry_window_expired',
            updated_at = ?
      WHERE outcome = 'open' AND retry_until <= ?`,
  ).bind(nowIso, nowIso, nowIso).run();
  return result.meta?.changes ?? 0;
}

async function prepareDelivery(
  params: TrackedMessageParams,
  deliveryType: 'push' | 'reply',
  requestJson: string | null,
  logDeliveryType: 'push' | 'reply' | 'test',
): Promise<{ created: boolean; row: DeliveryRow; payload: PayloadRow | null; nowIso: string }> {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const retryWindow = deliveryType === 'reply'
    ? LINE_REPLY_RETRY_HORIZON_MS
    : LINE_RETRY_HORIZON_MS - LINE_RETRY_SAFETY_MARGIN_MS;
  const retryUntil = new Date(now.getTime() + retryWindow).toISOString();
  const prepareToken = crypto.randomUUID();
  const retryKey = deliveryType === 'push' ? params.operationId : null;
  const operation = params.db.prepare(
    `INSERT OR IGNORE INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?)`,
  ).bind(
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    params.source,
    deliveryType,
    retryKey,
    prepareToken,
    retryUntil,
    nowIso,
    nowIso,
  );
  const payload = params.db.prepare(
    `INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id, message_type, log_content,
       log_delivery_type, request_json, broadcast_id, scenario_enrollment_id, scenario_step_id, scenario_claim_token,
       template_id_at_send, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM outbound_line_deliveries
         WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND prepare_token = ?
      )`,
  ).bind(
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    params.friendId,
    params.messageType,
    params.content,
    logDeliveryType,
    requestJson,
    params.broadcastId ?? null,
    params.scenarioEnrollmentId ?? null,
    params.scenarioStepId ?? null,
    params.scenarioClaimToken ?? null,
    params.templateIdAtSend ?? null,
    nowIso,
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    prepareToken,
  );
  let prepared: D1Result[] | null = null;
  let prepareError: unknown = null;
  try {
    prepared = await params.db.batch([operation, payload]);
  } catch (error) {
    if (deliveryType !== 'reply') throw error;
    prepareError = error;
  }
  const readRow = () => params.db.prepare(
    `SELECT outcome, source, delivery_type, retry_key, request_json, prepare_token, retry_until,
            stop_reason, attempt_count, updated_at
       FROM outbound_line_deliveries
      WHERE id = ? AND tenant_id = ? AND line_account_id = ?`,
  ).bind(params.operationId, params.tenantId, params.lineAccountId).first<DeliveryRow>();
  let row: DeliveryRow | null;
  try {
    row = await readRow();
  } catch (error) {
    if (deliveryType !== 'reply') throw error;
    row = await readRow();
  }
  if (!row && prepareError) throw prepareError;
  if (!row || row.delivery_type !== deliveryType) {
    throw new Error('OUTBOUND_LINE_DELIVERY_SCOPE_MISMATCH');
  }
  let created = (prepared?.[0]?.meta?.changes ?? 0) === 1
    || row.prepare_token === prepareToken;
  const readPayload = () => params.db.prepare(
    `SELECT friend_id, message_type, log_content, log_delivery_type, request_json, broadcast_id,
            scenario_enrollment_id, scenario_step_id, scenario_claim_token,
            template_id_at_send
       FROM outbound_line_delivery_payloads WHERE operation_id = ?`,
  ).bind(params.operationId).first<PayloadRow>();
  let storedPayload: PayloadRow | null;
  try {
    storedPayload = await readPayload();
  } catch (error) {
    if (deliveryType !== 'reply') throw error;
    storedPayload = await readPayload();
  }
  if (!created && deliveryType === 'reply' && row.outcome === 'open'
    && row.attempt_count === 0) {
    const staleBefore = new Date(now.getTime() - LINE_REPLY_PREPARE_LEASE_MS).toISOString();
    const reclaimed = await params.db.prepare(
      `UPDATE outbound_line_deliveries
          SET prepare_token = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND line_account_id = ?
          AND delivery_type = 'reply' AND outcome = 'open' AND attempt_count = ?
          AND prepare_token = ? AND updated_at <= ? AND retry_until > ?`,
    ).bind(
      prepareToken,
      nowIso,
      params.operationId,
      params.tenantId,
      params.lineAccountId,
      row.attempt_count,
      row.prepare_token,
      staleBefore,
      nowIso,
    ).run();
    if ((reclaimed.meta?.changes ?? 0) === 1) {
      row.prepare_token = prepareToken;
      row.updated_at = nowIso;
      created = true;
    }
  }
  return { created, row, payload: storedPayload, nowIso };
}

async function retireMissingPayload(
  params: Pick<TrackedMessageParams, 'db' | 'operationId' | 'tenantId' | 'lineAccountId'>,
  nowIso: string,
): Promise<'reconciliation_required'> {
  await params.db.prepare(
    `UPDATE outbound_line_deliveries
        SET outcome = 'retired', settled_at = ?, stop_reason = 'payload_unavailable',
            updated_at = ?
      WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND outcome = 'open'`,
  ).bind(
    nowIso,
    nowIso,
    params.operationId,
    params.tenantId,
    params.lineAccountId,
  ).run();
  return 'reconciliation_required';
}

async function settleAccepted(
  params: Pick<TrackedMessageParams, 'db' | 'operationId' | 'tenantId' | 'lineAccountId'>,
  row: DeliveryRow,
  payload: PayloadRow,
  nowIso: string,
): Promise<void> {
  const log = params.db.prepare(
    `INSERT INTO messages_log
      (id, friend_id, direction, message_type, content, broadcast_id,
       scenario_step_id, delivery_type, source, template_id_at_send, line_account_id,
       outbound_operation_id, created_at)
     VALUES (?, ?, 'outgoing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(outbound_operation_id) WHERE outbound_operation_id IS NOT NULL DO NOTHING`,
  ).bind(
    params.operationId,
    payload.friend_id,
    payload.message_type,
    payload.log_content,
    payload.broadcast_id,
    payload.scenario_step_id,
    payload.log_delivery_type,
    row.source,
    payload.template_id_at_send,
    params.lineAccountId,
    params.operationId,
    nowIso,
  );
  const settle = params.db.prepare(
    `UPDATE outbound_line_deliveries
        SET outcome = 'accepted', settled_at = ?, stop_reason = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND line_account_id = ?
        AND outcome IN ('open', 'retired')
        AND EXISTS (
          SELECT 1 FROM messages_log
           WHERE outbound_operation_id = ? AND friend_id = ? AND line_account_id = ?
             AND delivery_type = ? AND source = ?
        )`,
  ).bind(
    nowIso,
    nowIso,
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    params.operationId,
    payload.friend_id,
    params.lineAccountId,
    payload.log_delivery_type,
    row.source,
  );
  try {
    const results = await params.db.batch([log, settle]);
    if ((results[1]?.meta?.changes ?? 0) === 0) {
      const row = await params.db.prepare(
        `SELECT outcome FROM outbound_line_deliveries
          WHERE id = ? AND tenant_id = ? AND line_account_id = ?`,
      ).bind(params.operationId, params.tenantId, params.lineAccountId)
        .first<{ outcome: string }>();
      if (row?.outcome !== 'accepted') throw new Error('fenced settlement lost');
    }
  } catch {
    throw new Error('OUTBOUND_LINE_SETTLEMENT_FAILED');
  }
}

function parseTrackedLinePushRequest(requestJson: string | null): TrackedLinePushRequest | null {
  try {
    if (!requestJson) return null;
    const parsed = JSON.parse(requestJson) as Partial<TrackedLinePushRequest>;
    if (typeof parsed.to !== 'string' || !Array.isArray(parsed.messages)) return null;
    return { to: parsed.to, messages: parsed.messages as Message[] };
  } catch {
    return null;
  }
}

export interface TrackedLineBroadcastRequest {
  messages: Message[];
}

function parseTrackedLineBroadcastRequest(requestJson: string | null): TrackedLineBroadcastRequest | null {
  try {
    if (!requestJson) return null;
    const parsed = JSON.parse(requestJson) as Partial<TrackedLineBroadcastRequest>;
    if (!Array.isArray(parsed.messages)) return null;
    return { messages: parsed.messages as Message[] };
  } catch {
    return null;
  }
}

export async function deliverTrackedLineBroadcast(params: {
  db: D1Database;
  now?: Date;
  operationId: string;
  tenantId: string;
  lineAccountId: string;
  request: TrackedLineBroadcastRequest;
  send: (request: TrackedLineBroadcastRequest, retryKey: string) => Promise<void>;
}): Promise<DeliveryResult> {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const retryUntil = new Date(
    now.getTime() + LINE_RETRY_HORIZON_MS - LINE_RETRY_SAFETY_MARGIN_MS,
  ).toISOString();
  await params.db.prepare(
    `INSERT OR IGNORE INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       request_json, prepare_token, attempt_count, retry_until, created_at, updated_at)
     VALUES (?, ?, ?, 'broadcast', 'broadcast', 'open', ?, ?, ?, 0, ?, ?, ?)`,
  ).bind(
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    params.operationId,
    JSON.stringify(params.request),
    crypto.randomUUID(),
    retryUntil,
    nowIso,
    nowIso,
  ).run();
  const row = await params.db.prepare(
    `SELECT outcome, source, delivery_type, retry_key, request_json, prepare_token,
            retry_until, stop_reason, attempt_count, updated_at
       FROM outbound_line_deliveries
      WHERE id = ? AND tenant_id = ? AND line_account_id = ?`,
  ).bind(params.operationId, params.tenantId, params.lineAccountId).first<DeliveryRow>();
  if (!row || row.delivery_type !== 'broadcast' || !row.retry_key) {
    throw new Error('OUTBOUND_LINE_DELIVERY_SCOPE_MISMATCH');
  }
  if (row.outcome === 'accepted') return 'already_sent';
  if (row.outcome === 'retired') return 'reconciliation_required';
  const request = parseTrackedLineBroadcastRequest(row.request_json);
  if (!request) return retireMissingPayload(params, nowIso);
  if (row.retry_until <= nowIso) {
    await retireExpiredOutboundLineDeliveries(params.db, now);
    return 'reconciliation_required';
  }

  const attempt = await params.db.prepare(
    `UPDATE outbound_line_deliveries
        SET attempt_count = attempt_count + 1,
            first_attempted_at = COALESCE(first_attempted_at, ?),
            attempted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND line_account_id = ?
        AND delivery_type = 'broadcast' AND outcome = 'open' AND retry_until > ?`,
  ).bind(
    nowIso,
    nowIso,
    nowIso,
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    nowIso,
  ).run();
  if ((attempt.meta?.changes ?? 0) !== 1) {
    const current = await params.db.prepare(
      `SELECT outcome FROM outbound_line_deliveries
        WHERE id = ? AND tenant_id = ? AND line_account_id = ?`,
    ).bind(params.operationId, params.tenantId, params.lineAccountId)
      .first<{ outcome: string }>();
    return current?.outcome === 'accepted' ? 'already_sent' : 'reconciliation_required';
  }

  await params.send(request, row.retry_key);
  try {
    const settled = await params.db.prepare(
      `UPDATE outbound_line_deliveries
          SET outcome = 'accepted', settled_at = ?, stop_reason = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND line_account_id = ?
          AND delivery_type = 'broadcast' AND outcome = 'open'`,
    ).bind(
      nowIso,
      nowIso,
      params.operationId,
      params.tenantId,
      params.lineAccountId,
    ).run();
    if ((settled.meta?.changes ?? 0) !== 1) {
      const current = await params.db.prepare(
        `SELECT outcome FROM outbound_line_deliveries
          WHERE id = ? AND tenant_id = ? AND line_account_id = ?`,
      ).bind(params.operationId, params.tenantId, params.lineAccountId)
        .first<{ outcome: string }>();
      if (current?.outcome !== 'accepted') throw new Error('fenced settlement lost');
    }
  } catch {
    throw new Error('OUTBOUND_LINE_SETTLEMENT_FAILED');
  }
  return 'sent';
}

export async function deliverTrackedLinePush(params: TrackedMessageParams & {
  logDeliveryType?: 'test';
  request: TrackedLinePushRequest;
  send: (request: TrackedLinePushRequest, retryKey: string) => Promise<void>;
}): Promise<DeliveryResult> {
  const prepared = await prepareDelivery(
    params,
    'push',
    JSON.stringify(params.request),
    params.logDeliveryType ?? 'push',
  );
  if (prepared.row.outcome === 'accepted') return 'already_sent';
  if (prepared.row.outcome === 'retired') return 'reconciliation_required';
  if (!prepared.payload?.request_json) return retireMissingPayload(params, prepared.nowIso);
  if (prepared.row.retry_until <= prepared.nowIso) {
    await retireExpiredOutboundLineDeliveries(params.db, new Date(prepared.nowIso));
    return 'reconciliation_required';
  }

  const request = parseTrackedLinePushRequest(prepared.payload.request_json);
  if (!request) return retireMissingPayload(params, prepared.nowIso);
  const attempt = await params.db.prepare(
    `UPDATE outbound_line_deliveries
        SET attempt_count = attempt_count + 1,
            first_attempted_at = COALESCE(first_attempted_at, ?),
            attempted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND line_account_id = ?
        AND outcome = 'open' AND retry_until > ?`,
  ).bind(
    prepared.nowIso,
    prepared.nowIso,
    prepared.nowIso,
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    prepared.nowIso,
  ).run();
  if ((attempt.meta?.changes ?? 0) !== 1) {
    const current = await params.db.prepare(
      `SELECT outcome FROM outbound_line_deliveries
        WHERE id = ? AND tenant_id = ? AND line_account_id = ?`,
    ).bind(params.operationId, params.tenantId, params.lineAccountId)
      .first<{ outcome: string }>();
    return current?.outcome === 'accepted' ? 'already_sent' : 'reconciliation_required';
  }

  await params.send(request, prepared.row.retry_key!);
  await settleAccepted(params, prepared.row, prepared.payload, prepared.nowIso);
  return 'sent';
}

export async function reconcileAttemptedBroadcastTestPushes(params: {
  db: D1Database;
  now?: Date;
  resolveSender: (scope: { tenantId: string; lineAccountId: string }) => Promise<
    TrackedLinePushSender | null
  >;
}): Promise<{ accepted: number; pending: number; retired: number }> {
  const nowIso = (params.now ?? new Date()).toISOString();
  const rows = await params.db.prepare(
    `SELECT delivery.id AS operation_id, delivery.tenant_id, delivery.line_account_id,
            delivery.outcome, delivery.source, delivery.delivery_type, delivery.retry_key,
            delivery.prepare_token, delivery.retry_until, delivery.stop_reason,
            delivery.attempt_count, delivery.updated_at,
            payload.operation_id AS payload_operation_id, payload.friend_id,
            payload.message_type, payload.log_content, payload.log_delivery_type,
            payload.request_json, payload.broadcast_id, payload.scenario_enrollment_id,
            payload.scenario_step_id, payload.scenario_claim_token,
            payload.template_id_at_send
       FROM outbound_line_deliveries AS delivery
       LEFT JOIN outbound_line_delivery_payloads AS payload
              ON payload.operation_id = delivery.id
      WHERE delivery.delivery_type = 'push'
        AND delivery.outcome = 'open'
        AND delivery.attempt_count > 0
        AND delivery.source = 'broadcast'
        AND (payload.operation_id IS NULL OR payload.log_delivery_type = 'test')
      ORDER BY delivery.updated_at ASC
      LIMIT ?`,
  ).bind(OUTBOUND_REPLAY_BATCH_SIZE).all<AttemptedPushRow>();
  const senders = new Map<string, TrackedLinePushSender | null>();
  const result = { accepted: 0, pending: 0, retired: 0 };

  for (const row of rows.results ?? []) {
    const delivery = {
      db: params.db,
      operationId: row.operation_id,
      tenantId: row.tenant_id,
      lineAccountId: row.line_account_id,
    };
    if (row.retry_until <= nowIso) {
      const retired = await params.db.prepare(
        `UPDATE outbound_line_deliveries
            SET outcome = 'retired', settled_at = ?, stop_reason = 'retry_window_expired',
                updated_at = ?
          WHERE id = ? AND tenant_id = ? AND line_account_id = ?
            AND outcome = 'open' AND retry_until <= ?`,
      ).bind(
        nowIso,
        nowIso,
        row.operation_id,
        row.tenant_id,
        row.line_account_id,
        nowIso,
      ).run();
      result.retired += retired.meta?.changes ?? 0;
      continue;
    }

    const request = parseTrackedLinePushRequest(row.request_json);
    if (!row.payload_operation_id || !row.friend_id || !row.message_type
      || row.log_content == null || !row.log_delivery_type || !request || !row.retry_key) {
      await retireMissingPayload(delivery, nowIso);
      result.retired++;
      continue;
    }

    const scope = { tenantId: row.tenant_id, lineAccountId: row.line_account_id };
    const scopeKey = `${scope.tenantId}\u0000${scope.lineAccountId}`;
    if (!senders.has(scopeKey)) {
      let sender: TrackedLinePushSender | null = null;
      try {
        sender = await params.resolveSender(scope);
      } catch {
        sender = null;
      }
      senders.set(scopeKey, sender);
    }
    const sender = senders.get(scopeKey);
    if (!sender) {
      result.pending++;
      continue;
    }

    const attempt = await params.db.prepare(
      `UPDATE outbound_line_deliveries
          SET attempt_count = attempt_count + 1, attempted_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND line_account_id = ?
          AND outcome = 'open' AND attempt_count > 0 AND retry_until > ?`,
    ).bind(
      nowIso,
      nowIso,
      row.operation_id,
      row.tenant_id,
      row.line_account_id,
      nowIso,
    ).run();
    if ((attempt.meta?.changes ?? 0) !== 1) {
      result.pending++;
      continue;
    }

    const payload: PayloadRow = {
      friend_id: row.friend_id,
      message_type: row.message_type,
      log_content: row.log_content,
      log_delivery_type: row.log_delivery_type,
      request_json: row.request_json,
      broadcast_id: row.broadcast_id,
      scenario_enrollment_id: row.scenario_enrollment_id,
      scenario_step_id: row.scenario_step_id,
      scenario_claim_token: row.scenario_claim_token,
      template_id_at_send: row.template_id_at_send,
    };
    try {
      await sender(request, row.retry_key);
      await settleAccepted(delivery, row, payload, nowIso);
      result.accepted++;
    } catch {
      result.pending++;
    }
  }

  return result;
}

export async function deliverTrackedLineReply(params: TrackedMessageParams & {
  beforeSend?: () => Promise<boolean>;
  isDeterministicRejection?: (error: unknown) => boolean;
  send: () => Promise<void>;
}): Promise<DeliveryResult> {
  const prepared = await prepareDelivery(params, 'reply', null, 'reply');
  if (prepared.row.outcome === 'accepted') return 'already_sent';
  if (prepared.row.outcome === 'retired') {
    return prepared.row.stop_reason === 'reply_rejected'
      || (prepared.row.stop_reason === 'local_precondition_failed'
        && prepared.row.attempt_count === 0)
      ? 'not_sent'
      : 'reconciliation_required';
  }
  if (!prepared.payload) return retireMissingPayload(params, prepared.nowIso);
  if (prepared.row.retry_until <= prepared.nowIso) {
    await retireExpiredOutboundLineDeliveries(params.db, new Date(prepared.nowIso));
    return prepared.row.attempt_count === 0 ? 'not_sent' : 'reconciliation_required';
  }
  const replacedScenarioClaim = prepared.row.attempt_count === 0
    && params.scenarioClaimToken != null
    && prepared.payload.scenario_claim_token != null
    && params.scenarioClaimToken !== prepared.payload.scenario_claim_token;
  if (replacedScenarioClaim) {
    return retireLocalPreconditionFailure(
      params,
      prepared.nowIso,
      prepared.row.prepare_token,
    );
  }
  if (!prepared.created) {
    return prepared.row.attempt_count === 0 ? 'in_flight' : 'reconciliation_required';
  }

  if (params.beforeSend) {
    let ready = false;
    try {
      ready = await params.beforeSend();
    } catch (error) {
      await retireLocalPreconditionFailure(
        params,
        prepared.nowIso,
        prepared.row.prepare_token,
      ).catch(() => undefined);
      throw error;
    }
    if (!ready) {
      return retireLocalPreconditionFailure(
        params,
        prepared.nowIso,
        prepared.row.prepare_token,
      );
    }
  }

  const attemptNowIso = (params.now ?? new Date()).toISOString();
  if (prepared.row.retry_until <= attemptNowIso) {
    await retireExpiredOutboundLineDeliveries(params.db, new Date(attemptNowIso));
    return 'not_sent';
  }

  let attemptCommitted = false;
  try {
    const attempt = await params.db.prepare(
      `UPDATE outbound_line_deliveries
          SET attempt_count = attempt_count + 1,
              first_attempted_at = COALESCE(first_attempted_at, ?),
              attempted_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND line_account_id = ?
          AND outcome = 'open' AND attempt_count = ? AND prepare_token = ?
          AND retry_until > ?`,
    ).bind(
      attemptNowIso,
      attemptNowIso,
      attemptNowIso,
      params.operationId,
      params.tenantId,
      params.lineAccountId,
      prepared.row.attempt_count,
      prepared.row.prepare_token,
      attemptNowIso,
    ).run();
    attemptCommitted = (attempt.meta?.changes ?? 0) === 1;
  } catch (error) {
    const attemptState = await params.db.prepare(
      `SELECT outcome, attempt_count, prepare_token
         FROM outbound_line_deliveries
        WHERE id = ? AND tenant_id = ? AND line_account_id = ?`,
    ).bind(
      params.operationId,
      params.tenantId,
      params.lineAccountId,
    ).first<Pick<DeliveryRow, 'outcome' | 'attempt_count' | 'prepare_token'>>().catch(() => null);
    attemptCommitted = attemptState?.outcome === 'open'
      && attemptState.attempt_count === prepared.row.attempt_count + 1
      && attemptState.prepare_token === prepared.row.prepare_token;
    if (!attemptCommitted && attemptState?.outcome === 'open'
      && attemptState.attempt_count === prepared.row.attempt_count
      && attemptState.prepare_token === prepared.row.prepare_token) {
      await retireLocalPreconditionFailure(
        params,
        attemptNowIso,
        prepared.row.prepare_token,
      ).catch(() => undefined);
    }
    if (!attemptCommitted) throw error;
  }
  if (!attemptCommitted) return 'in_flight';
  const sendNowIso = (params.now ?? new Date()).toISOString();
  if (prepared.row.retry_until <= sendNowIso) {
    await retireExpiredOutboundLineDeliveries(params.db, new Date(sendNowIso));
    return 'reconciliation_required';
  }
  try {
    await params.send();
  } catch (error) {
    const deterministicRejection = params.isDeterministicRejection?.(error) === true;
    await params.db.prepare(
      `UPDATE outbound_line_deliveries
          SET outcome = 'retired', settled_at = ?, stop_reason = ?,
              updated_at = ?
        WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND outcome = 'open'`,
    ).bind(
      attemptNowIso,
      deterministicRejection ? 'reply_rejected' : 'reply_outcome_unknown',
      attemptNowIso,
      params.operationId,
      params.tenantId,
      params.lineAccountId,
    ).run().catch(() => undefined);
    if (deterministicRejection) return 'not_sent';
    throw error;
  }

  await settleAccepted(params, prepared.row, prepared.payload, attemptNowIso);
  return 'sent';
}

async function retireLocalPreconditionFailure(
  params: TrackedMessageParams,
  nowIso: string,
  prepareToken: string,
  maxAttemptCount = 0,
): Promise<'not_sent'> {
  await params.db.prepare(
    `UPDATE outbound_line_deliveries
        SET outcome = 'retired', settled_at = ?, stop_reason = 'local_precondition_failed',
            updated_at = ?
      WHERE id = ? AND tenant_id = ? AND line_account_id = ?
        AND outcome = 'open' AND attempt_count <= ? AND prepare_token = ?`,
  ).bind(
    nowIso,
    nowIso,
    params.operationId,
    params.tenantId,
    params.lineAccountId,
    maxAttemptCount,
    prepareToken,
  ).run();
  return 'not_sent';
}

interface AcceptedScenarioReplyRow {
  enrollment_id: string;
  friend_id: string;
  scenario_id: string;
  current_step_order: number;
  started_at: string;
  scenario_step_id: string;
  accepted_at: string;
  delivery_mode: DeliveryMode;
  step_order: number;
  on_reach_tag_id: string | null;
  claim_token: string;
}

/** Repair the local scenario projection after a reply was durably accepted. */
export async function reconcileAcceptedScenarioReplies(db: D1Database): Promise<number> {
  const rows = await db.prepare(
    `SELECT fs.id AS enrollment_id, payload.friend_id, fs.scenario_id,
            fs.current_step_order, fs.started_at, payload.scenario_step_id,
            log.created_at AS accepted_at, scenario.delivery_mode,
            step.step_order, step.on_reach_tag_id,
            payload.scenario_claim_token AS claim_token
       FROM outbound_line_deliveries operation
       INNER JOIN outbound_line_delivery_payloads payload
               ON payload.operation_id = operation.id
              AND payload.tenant_id = operation.tenant_id
              AND payload.line_account_id = operation.line_account_id
       INNER JOIN friends friend
               ON friend.id = payload.friend_id
              AND friend.line_account_id = operation.line_account_id
       INNER JOIN scenario_steps step ON step.id = payload.scenario_step_id
       INNER JOIN scenarios scenario
               ON scenario.id = step.scenario_id
              AND (scenario.tenant_id = operation.tenant_id
                   OR (scenario.tenant_id IS NULL
                       AND scenario.line_account_id = operation.line_account_id))
              AND (scenario.line_account_id IS NULL
                   OR scenario.line_account_id = operation.line_account_id)
       INNER JOIN friend_scenarios fs
               ON fs.id = payload.scenario_enrollment_id
              AND fs.friend_id = payload.friend_id
              AND fs.scenario_id = step.scenario_id
              AND fs.delivery_claim_token = payload.scenario_claim_token
       INNER JOIN messages_log log
               ON log.outbound_operation_id = operation.id
              AND log.scenario_step_id = step.id
      WHERE operation.outcome = 'accepted'
        AND operation.delivery_type = 'reply'
        AND operation.source = 'scenario'
        AND payload.scenario_claim_token IS NOT NULL
        AND fs.status = 'paused'
        AND fs.current_step_order < step.step_order
      ORDER BY operation.settled_at ASC
      LIMIT 100`,
  ).all<AcceptedScenarioReplyRow>();

  let reconciled = 0;
  for (const row of rows.results) {
    const steps = await getScenarioSteps(db, row.scenario_id);
    const currentIndex = steps.findIndex((step) => step.id === row.scenario_step_id);
    if (currentIndex < 0) continue;
    const nextStep = steps[currentIndex + 1] ?? null;
    const now = jstNow();
    let result: D1Result;
    if (nextStep) {
      const enrolledAt = new Date(new Date(row.started_at).getTime() + 9 * 60 * 60_000);
      const acceptedAt = new Date(new Date(row.accepted_at).getTime() + 9 * 60 * 60_000);
      if (!Number.isFinite(enrolledAt.getTime()) || !Number.isFinite(acceptedAt.getTime())) continue;
      const nextDelivery = computeNextDeliveryAt(
        { delivery_mode: row.delivery_mode },
        nextStep,
        { enrolledAt, previousDeliveredAt: acceptedAt, now: acceptedAt },
      ).toISOString().slice(0, -1) + '+09:00';
      result = await db.prepare(
        `UPDATE friend_scenarios
            SET current_step_order = ?, next_delivery_at = ?, status = 'active',
                delivery_first_attempted_at = NULL, delivery_claim_token = NULL,
                updated_at = ?
          WHERE id = ? AND status = 'paused' AND current_step_order = ?
            AND delivery_claim_token = ?`,
      ).bind(
        row.step_order,
        nextDelivery,
        now,
        row.enrollment_id,
        row.current_step_order,
        row.claim_token,
      ).run();
    } else {
      result = await db.prepare(
        `UPDATE friend_scenarios
            SET status = 'completed', next_delivery_at = NULL,
                delivery_first_attempted_at = NULL, delivery_claim_token = NULL,
                updated_at = ?
          WHERE id = ? AND status = 'paused' AND current_step_order = ?
            AND delivery_claim_token = ?`,
      ).bind(now, row.enrollment_id, row.current_step_order, row.claim_token).run();
    }
    if ((result.meta?.changes ?? 0) !== 1) continue;
    reconciled++;
    if (row.on_reach_tag_id) {
      await addTagToFriend(db, row.friend_id, row.on_reach_tag_id).catch((error) => {
        console.error(`[outbound-line] scenario tag reconciliation failed step=${row.scenario_step_id}:`, error);
      });
    }
  }
  return reconciled;
}

/** Resume only scenario replies durably proven not to have reached LINE. */
export async function reconcileUnsentScenarioReplies(db: D1Database): Promise<number> {
  const operationNow = new Date().toISOString();
  const scenarioNow = jstNow();
  const retireOpen = db.prepare(
    `UPDATE outbound_line_deliveries
        SET outcome = 'retired', settled_at = ?, stop_reason = 'local_precondition_failed',
            updated_at = ?
      WHERE outcome = 'open' AND delivery_type = 'reply' AND source = 'scenario'
        AND attempt_count = 0
        AND EXISTS (
          SELECT 1
            FROM outbound_line_delivery_payloads payload
            INNER JOIN friends friend
                    ON friend.id = payload.friend_id
                   AND friend.line_account_id = outbound_line_deliveries.line_account_id
            INNER JOIN scenario_steps step ON step.id = payload.scenario_step_id
            INNER JOIN scenarios scenario
                    ON scenario.id = step.scenario_id
                   AND (scenario.tenant_id = outbound_line_deliveries.tenant_id
                        OR (scenario.tenant_id IS NULL
                            AND scenario.line_account_id = outbound_line_deliveries.line_account_id))
                   AND (scenario.line_account_id IS NULL
                        OR scenario.line_account_id = outbound_line_deliveries.line_account_id)
            INNER JOIN friend_scenarios fs
                    ON fs.id = payload.scenario_enrollment_id
                   AND fs.friend_id = payload.friend_id
                   AND fs.scenario_id = step.scenario_id
                   AND fs.delivery_claim_token = payload.scenario_claim_token
           WHERE payload.operation_id = outbound_line_deliveries.id
             AND payload.tenant_id = outbound_line_deliveries.tenant_id
             AND payload.line_account_id = outbound_line_deliveries.line_account_id
             AND payload.scenario_claim_token IS NOT NULL
             AND fs.status = 'paused'
             AND fs.current_step_order < step.step_order
        )`,
  ).bind(operationNow, operationNow);
  const resume = db.prepare(
    `UPDATE friend_scenarios
        SET status = 'active', delivery_first_attempted_at = NULL,
            delivery_claim_token = NULL, updated_at = ?
      WHERE status = 'paused'
        AND EXISTS (
          SELECT 1
            FROM outbound_line_delivery_payloads payload
            INNER JOIN outbound_line_deliveries operation
                    ON operation.id = payload.operation_id
                   AND operation.tenant_id = payload.tenant_id
                   AND operation.line_account_id = payload.line_account_id
            INNER JOIN friends friend
                    ON friend.id = payload.friend_id
                   AND friend.id = friend_scenarios.friend_id
                   AND friend.line_account_id = operation.line_account_id
            INNER JOIN scenario_steps step ON step.id = payload.scenario_step_id
            INNER JOIN scenarios scenario
                    ON scenario.id = step.scenario_id
                   AND scenario.id = friend_scenarios.scenario_id
                   AND (scenario.tenant_id = operation.tenant_id
                        OR (scenario.tenant_id IS NULL
                            AND scenario.line_account_id = operation.line_account_id))
                   AND (scenario.line_account_id IS NULL
                        OR scenario.line_account_id = operation.line_account_id)
           WHERE payload.scenario_enrollment_id = friend_scenarios.id
             AND payload.scenario_claim_token = friend_scenarios.delivery_claim_token
             AND payload.scenario_claim_token IS NOT NULL
             AND operation.delivery_type = 'reply' AND operation.source = 'scenario'
             AND operation.outcome = 'retired'
             AND ((operation.attempt_count = 0
                   AND operation.stop_reason != 'reply_outcome_unknown')
                  OR operation.stop_reason = 'reply_rejected')
             AND friend_scenarios.current_step_order < step.step_order
        )
        AND NOT EXISTS (
          SELECT 1
            FROM outbound_line_delivery_payloads payload
            INNER JOIN outbound_line_deliveries operation
                    ON operation.id = payload.operation_id
                   AND operation.tenant_id = payload.tenant_id
                   AND operation.line_account_id = payload.line_account_id
            INNER JOIN friends friend
                    ON friend.id = payload.friend_id
                   AND friend.id = friend_scenarios.friend_id
                   AND friend.line_account_id = operation.line_account_id
            INNER JOIN scenario_steps step ON step.id = payload.scenario_step_id
            INNER JOIN scenarios scenario
                    ON scenario.id = step.scenario_id
                   AND scenario.id = friend_scenarios.scenario_id
                   AND (scenario.tenant_id = operation.tenant_id
                        OR (scenario.tenant_id IS NULL
                            AND scenario.line_account_id = operation.line_account_id))
                   AND (scenario.line_account_id IS NULL
                        OR scenario.line_account_id = operation.line_account_id)
           WHERE payload.scenario_enrollment_id = friend_scenarios.id
             AND payload.scenario_claim_token = friend_scenarios.delivery_claim_token
             AND payload.scenario_claim_token IS NOT NULL
             AND operation.delivery_type = 'reply' AND operation.source = 'scenario'
             AND friend_scenarios.current_step_order < step.step_order
             AND (
               operation.outcome IN ('open', 'accepted')
               OR (operation.outcome = 'retired' AND (
                 operation.stop_reason = 'reply_outcome_unknown'
                 OR (operation.attempt_count > 0
                     AND operation.stop_reason != 'reply_rejected')
               ))
             )
        )`,
  ).bind(scenarioNow);
  const results = await db.batch([retireOpen, resume]);
  return results[1]?.meta?.changes ?? 0;
}
