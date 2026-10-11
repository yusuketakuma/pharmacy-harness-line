import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_PACKAGE_ROOT, Sqlite } from '../custom/pharmacy/test-sqlite.js';

const worker = join(DB_PACKAGE_ROOT, '../../apps/worker/src');
function queries(file: string, fn: string) {
  const source = readFileSync(join(worker, file), 'utf8').split(`export async function ${fn}`)[1];
  return [...source.split('\nexport ')[0].matchAll(/\.prepare\(\s*`([\s\S]*?)`/g)].map((match) => match[1]);
}
function plan(sql: string, bindings: unknown[] = []) {
  const db = new Sqlite(':memory:');
  try {
    db.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
  } finally {
    db.close();
  }
}

describe('cron discovery uses bounded work indexes', () => {
  it('expires pending history through its expiry range before notification LIMIT', () => {
    const rows = plan(queries('custom/pharmacy/status-notification-work.ts', 'expireStatusNotificationWorks')[0], [
      'myna',
      'now',
      'now',
    ]);
    expect(rows[0].detail).toContain('idx_pharmacy_status_work_expiry');
    expect(rows[0].detail).toContain('expires_at<?');
  });
  it('uses the expiry range, attempted replay subset and unattempted reply subset', () => {
    const file = 'services/outbound-line-delivery.ts';
    expect(plan(queries(file, 'retireExpiredOutboundLineDeliveries')[0], ['now', 'now', 'now'])[0].detail).toContain(
      'idx_outbound_open_expiry',
    );
    expect(plan(queries(file, 'reconcileAttemptedBroadcastTestPushes')[0], [100])[0].detail).toContain(
      'idx_outbound_broadcast_test_replay',
    );
    const [retire, resume] = queries(file, 'reconcileUnsentScenarioReplies');
    expect(plan(retire, ['now', 'now'])[0].detail).toContain('idx_outbound_unattempted_scenario_reply');
    expect(plan(resume, ['now']).some(({ detail }) => detail.includes('idx_outbound_payload_scenario_claim'))).toBe(
      true,
    );
  });
  it('keeps lazy expiry account scoped and excludes terminal history from its index', () => {
    const mynaSource = readFileSync(join(worker, 'custom/pharmacy/myna/repository.ts'), 'utf8');
    const mynaSql = mynaSource
      .split('async function expireMynaHandoffs')[1]
      .match(/\.prepare\(\s*`([\s\S]*?)`/)?.[1]
      .replace(/\$\{idClause\}/, '');
    expect(mynaSql).toBeDefined();
    expect(plan(mynaSql ?? '', ['now', 'account-a', 'now'])[0].detail).toContain('idx_pharmacy_myna_active_expiry');
    expect(
      plan(queries('custom/pharmacy/emergency-contraception/repository.ts', 'expireEmergencyIntakes')[0], [
        'account-a',
        'now',
      ])[0].detail,
    ).toContain('idx_pharmacy_emergency_active_expiry');
  });
  it('starts accepted repair at paused claims and looks up payload by current claim', () => {
    const rows = plan(queries('services/outbound-line-delivery.ts', 'reconcileAcceptedScenarioReplies')[0]);
    expect(rows[0].detail).toContain('fs');
    expect(rows[0].detail).toContain('idx_friend_scenarios_paused_claim');
    expect(rows.some(({ detail }) => detail.includes('idx_outbound_payload_scenario_claim'))).toBe(true);
    expect(rows.some(({ detail }) => /SCAN operation/.test(detail))).toBe(false);
  });
  it.each([
    ['custom/pharmacy/myna/notifications.ts', 'processExpiredMynaHandoffNotifications'],
    ['custom/pharmacy/emergency-contraception/status-notifications.ts', 'processEmergencyIntakeStatusNotifications'],
  ])('reads due pending work for %s', (file, fn) => {
    const rows = plan(queries(file, fn)[0], ['2026-10-07T00:00:00.000Z', 50]);
    expect(rows[0].detail).toContain('idx_pharmacy_status_work_due');
    expect(rows[0].detail).toContain('due_at<?');
    expect(rows.some(({ detail }) => /SCAN (handoff|event|notice)/.test(detail))).toBe(false);
    expect(rows.some(({ detail }) => detail.includes('TEMP B-TREE'))).toBe(false);
  });
});
