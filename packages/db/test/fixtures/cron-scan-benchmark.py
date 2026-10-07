"""Local synthetic benchmark; never connects to D1 or reads credentials.

Run from repository root: python packages/db/test/fixtures/cron-scan-benchmark.py
SQLite VM instructions measure work, NOT Cloudflare D1 rows_read or CPU billing.
The baseline comes from the authorized local investigation SHA, via git show.
"""
import json
import hashlib
import pathlib
import re
import sqlite3
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[4]
BASE = 'f5164efce3456be17dd4f32722fd901b25a8b50d'
NOW = '2026-10-07T00:00:00.000Z'
OLD = '2025-01-01T00:00:00.000Z'
FUTURE = '2026-10-08T00:00:00.000Z'
LOOKBACK = '2026-10-04T00:00:00.000Z'


def read(path, previous):
    if previous:
        return subprocess.check_output(['git', 'show', f'{BASE}:{path}'], cwd=ROOT, text=True)
    return (ROOT / path).read_text()


def sqls(previous):
    specs = [
        ('expiry', 'apps/worker/src/services/outbound-line-delivery.ts', 'retireExpiredOutboundLineDeliveries', [NOW] * 3),
        ('broadcast', 'apps/worker/src/services/outbound-line-delivery.ts', 'reconcileAttemptedBroadcastTestPushes', [100]),
        ('accepted', 'apps/worker/src/services/outbound-line-delivery.ts', 'reconcileAcceptedScenarioReplies', []),
        ('unsent', 'apps/worker/src/services/outbound-line-delivery.ts', 'reconcileUnsentScenarioReplies', [NOW] * 2),
        ('myna', 'apps/worker/src/custom/pharmacy/myna/notifications.ts', 'processExpiredMynaHandoffNotifications', [LOOKBACK if previous else NOW, 50]),
        ('emergency', 'apps/worker/src/custom/pharmacy/emergency-contraception/status-notifications.ts', 'processEmergencyIntakeStatusNotifications', [LOOKBACK if previous else NOW, 50]),
    ]
    result = []
    for name, path, fn, values in specs:
        body = read(path, previous).split('export async function ' + fn)[1].split('\nexport ')[0]
        statements = re.findall(r'\.prepare\(\s*`([\s\S]*?)`', body)
        result.append((name, statements[0], values))
        if name == 'unsent':
            result.append(('resume', statements[1], [NOW]))
    if not previous:
        expiry = work_sql()[0]
        result.insert(0, ('myna_work_expiry', expiry, ['myna', NOW, NOW]))
        result.insert(1, ('emergency_work_expiry', expiry, ['emergency', NOW, NOW]))
    return result


def seed(db, history, pending, future=False):
    # Synthetic account/friend identifiers and placeholder credentials only.
    db.execute('PRAGMA foreign_keys = OFF')
    db.executescript("""
    INSERT INTO tenants(id,tenant_code,display_name,status) VALUES('t','t','synthetic','active');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,is_active)
      VALUES('a','a','synthetic','synthetic','synthetic',1);
    INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES('t','a');
    INSERT INTO friends(id,line_user_id,provider_line_user_id,line_account_id,is_following)
      VALUES('f','synthetic','synthetic','a',1);
    INSERT INTO scenarios(id,name,trigger_type,tenant_id,line_account_id) VALUES('s','synthetic','manual','t','a');
    INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES('step','s',1,'text','synthetic');
    INSERT INTO friend_scenarios(id,friend_id,scenario_id,status,delivery_claim_token)
      VALUES('paused','f','s','paused','claim');
    INSERT INTO staff_members(id,name,role,api_key) VALUES('staff','synthetic','staff','synthetic');
    INSERT INTO tenant_staff_memberships(tenant_id,staff_id,role) VALUES('t','staff','staff');
    INSERT INTO pharmacy_staff_accounts(line_account_id,staff_id,created_at,updated_at)
      VALUES('a','staff','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
    INSERT INTO pharmacy_emergency_pharmacists(line_account_id,staff_id,training_registration_number,created_at,updated_at)
      VALUES('a','staff','synthetic','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
    INSERT INTO pharmacy_emergency_slots(id,line_account_id,pharmacist_staff_id,starts_at,ends_at,created_by,created_at,updated_at)
      VALUES('slot','a','staff','2099-01-01T00:00:00.000Z','2099-01-01T01:00:00.000Z','staff','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
    INSERT INTO pharmacy_emergency_settings
      (line_account_id,is_enabled,pharmacy_registration_number,product_code,manufacturer_check_url,privacy_policy_url,
       privacy_contact,purpose_text,consent_version,retention_days,consultation_minutes,reservation_ttl_minutes,
       privacy_space_ready,drinking_water_ready,partner_clinic_url,support_center_url,updated_by,created_at,updated_at)
      VALUES('a',1,'synthetic','synthetic','https://example.invalid','https://example.invalid','synthetic','synthetic','v1',30,30,30,1,1,
             'https://example.invalid','https://example.invalid','staff','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
    INSERT INTO pharmacy_emergency_inventory(line_account_id,product_code,on_hand,updated_by,created_at,updated_at)
      VALUES('a','synthetic',10,'staff','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
    INSERT INTO pharmacy_emergency_intakes
      (id,reference_code,tenant_id,line_account_id,owner_friend_id,slot_id,status,encrypted_payload,
       age_band,safe_contact_mode,consent_version,product_code,idempotency_key,expires_at,created_at,updated_at)
      VALUES('intake','synthetic-reference','t','a','f','slot','reviewed','synthetic',
             'adult','neutral_line','v1','synthetic','synthetic-key','2026-10-08T00:00:00.000Z','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
    """)
    outbound = '''INSERT INTO outbound_line_deliveries
      (id,tenant_id,line_account_id,source,delivery_type,outcome,prepare_token,attempt_count,retry_until,
       settled_at,created_at,updated_at,retry_key) VALUES(?,'t','a',? ,?,?,'synthetic',?,?,?, ?,?,?)'''
    db.executemany(outbound, [(f'o{i}', 'scenario', 'reply', 'accepted', 1, OLD, OLD, OLD, OLD, None) for i in range(history)])
    db.executemany('INSERT INTO friend_scenarios(id,friend_id,scenario_id,status) VALUES(?,?,?,?)',
                   [(f'fs{i}','f','s','completed') for i in range(history)])
    db.executemany("""INSERT INTO outbound_line_delivery_payloads
      (operation_id,tenant_id,line_account_id,friend_id,message_type,log_content,log_delivery_type,
       scenario_enrollment_id,scenario_step_id,scenario_claim_token,created_at)
      VALUES(?,'t','a','f','text','synthetic','reply',?,'step','old-claim',?)""",
      [(f'o{i}',f'fs{i}',OLD) for i in range(history)])
    db.executemany("""INSERT INTO messages_log
      (id,friend_id,line_account_id,direction,message_type,content,delivery_type,
       scenario_step_id,outbound_operation_id,created_at)
      VALUES(?,'f','a','outgoing','text','synthetic','reply','step',?,?)""",
      [(f'log{i}',f'o{i}',OLD) for i in range(history)])
    if pending:
        db.executemany(outbound, [(f'open{i}', 'automation', 'push', 'open', 0, FUTURE if future else OLD, None, NOW, NOW, f'open{i}') for i in range(5)])
        db.executemany(outbound, [(f'broadcast{i}', 'broadcast', 'push', 'open', 1, FUTURE, None, NOW, NOW, f'broadcast{i}') for i in range(5)])
    myna = '''INSERT INTO pharmacy_myna_handoffs
      (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
      VALUES(?,'a','f','PAPER',?,'LIFF',?,?,?,?)'''
    db.executemany(myna, [(f'closed{i}','CLOSED',f'closed{i}',OLD,OLD,OLD) for i in range(history)])
    event = '''INSERT INTO pharmacy_emergency_intake_events
      (id,intake_id,line_account_id,event_type,actor_type,actor_id,idempotency_key,occurred_at)
      VALUES(?,'intake','a',?,'system','system',?,?)'''
    db.executemany(event, [(f'created{i}','created',f'created-key{i}',OLD) for i in range(history)])
    notice = '''INSERT INTO pharmacy_notification_events
      (id,line_account_id,friend_id,message_id,category,outcome,occurred_at,idempotency_key,created_at)
      VALUES(?,'a','f','synthetic','transactional_care','sent',?,?,?)'''
    for i in range(history // 10):
        mid, eid = f'sent-m{i}', f'sent-e{i}'
        db.execute(myna, (mid,'EXPIRED',mid,NOW,NOW,NOW))
        db.execute(event, (eid,'reviewed',f'event-key{i}',NOW))
        db.execute(notice, (mid,NOW,f'myna-status:{mid}:EXPIRED',NOW))
        db.execute(notice, (eid,NOW,f'emergency-intake-status:{eid}',NOW))
    for i in range(pending):
        mid, eid = f'pending-m{i:04}', f'pending-e{i:04}'
        ts = FUTURE if future else NOW
        db.execute(myna, (mid,'EXPIRED',mid,ts,ts,ts))
        db.execute(event, (eid,'reviewed',f'pending-key{i}',ts))
    db.commit()


def measure(db, sql, values):
    plan = [row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + sql, values)]
    instructions = 0
    def progress():
        nonlocal instructions
        instructions += 1
        return 0
    db.set_progress_handler(progress, 1)
    changes = db.total_changes
    rows = db.execute(sql, values).fetchall()
    db.set_progress_handler(None, 0)
    return {'vm_instructions': instructions, 'selected': len(rows), 'selection_digest': hashlib.sha256(repr([row[0] for row in rows]).encode()).hexdigest(), 'logical_changes': db.total_changes - changes, 'plan': plan}


def measured_batch(db, operations):
    instructions = 0
    def progress():
        nonlocal instructions
        instructions += 1
        return 0
    db.set_progress_handler(progress, 1)
    changes = db.total_changes
    with db:
        for sql, values in operations:
            db.execute(sql, values)
    db.set_progress_handler(None, 0)
    return {'sql_statements': len(operations), 'local_transactions': 1 if operations else 0,
            'vm_instructions': instructions, 'logical_changes': db.total_changes - changes}


def work_sql():
    source = read('apps/worker/src/custom/pharmacy/status-notification-work.ts', False)
    return re.findall(r'\.prepare\(\s*`([\s\S]*?)`', source)


def mutation_cases():
    output = []
    _, claim, finish = work_sql()
    later = '2026-10-07T00:05:00.000Z'
    for previous in [True, False]:
        db = sqlite3.connect(':memory:')
        db.executescript(read('packages/db/bootstrap.sql', previous))
        seed(db, 10000, 0)
        for i in range(20):
            db.execute("""INSERT INTO pharmacy_myna_handoffs
              (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
              VALUES(?,'a','f','PAPER','CREATED','LIFF',?,?,?,?)""", (f'change{i}', f'change{i}',NOW,NOW,NOW))
        db.commit()
        phases = {}
        phases['state_change_20'] = measured_batch(db, [("UPDATE pharmacy_myna_handoffs SET status='EXPIRED',updated_at=? WHERE id=?", [NOW,f'change{i}']) for i in range(20)])
        if not previous:
            phases['queue_claim_20'] = measured_batch(db, [(claim,[later,'owner','pending','a',f'myna-status:change{i}:EXPIRED',NOW,'2026-10-10T00:00:00.000Z']) for i in range(20)])
        phases['sender_claim_20'] = measured_batch(db, [("""INSERT INTO pharmacy_notification_events
          (id,line_account_id,friend_id,message_id,category,outcome,occurred_at,idempotency_key,created_at)
          VALUES(?,'a','f','myna_handoff_status_v1','transactional_care','attempted',?,?,?)""",
          [f'change-notice{i}',NOW,f'myna-status:change{i}:EXPIRED',NOW]) for i in range(20)])
        phases['sender_failed_ack_20'] = measured_batch(db, [("UPDATE pharmacy_notification_events SET outcome='failed' WHERE id=?", [f'change-notice{i}']) for i in range(20)])
        if not previous:
            phases['queue_reschedule_20'] = measured_batch(db, [(finish,['pending',later,'a',f'myna-status:change{i}:EXPIRED','owner']) for i in range(20)])
            phases['queue_retry_claim_20'] = measured_batch(db, [(claim,['2026-10-07T00:10:00.000Z','retry','pending','a',f'myna-status:change{i}:EXPIRED',later,'2026-10-10T00:00:00.000Z']) for i in range(20)])
        phases['sender_retry_claim_20'] = measured_batch(db, [("UPDATE pharmacy_notification_events SET outcome='attempted',occurred_at=? WHERE id=?", [later,f'change-notice{i}']) for i in range(20)])
        phases['sender_sent_ack_20'] = measured_batch(db, [("UPDATE pharmacy_notification_events SET outcome='sent' WHERE id=?", [f'change-notice{i}']) for i in range(20)])
        if not previous:
            phases['queue_finish_after_sent_20'] = measured_batch(db, [(finish,['done','2026-10-07T00:10:00.000Z','a',f'myna-status:change{i}:EXPIRED','retry']) for i in range(20)])
            assert db.execute("SELECT COUNT(*) FROM pharmacy_status_notification_work WHERE kind='myna' AND state='pending'").fetchone()[0] == 0
        output.append({'version':'before' if previous else 'after','history_per_domain':10000,
                       'changed_jobs':20,'phases':phases,'scope':'actual queue SQL plus synthetic sender SQL; no HTTP, Worker CPU, D1 billing, or full authorization reads measured'})
        db.close()
    return output


def backlog_cases():
    output = []
    for previous in [True, False]:
        db = sqlite3.connect(':memory:')
        db.executescript(read('packages/db/bootstrap.sql', previous))
        seed(db,10000,200)
        myna = next((q,v) for name,q,v in sqls(previous) if name == 'myna')
        rows_per_tick, discovery_vm = [], []
        accepted = set()
        for tick in range(5):
            measured = measure(db,*myna)
            rows = db.execute(*myna).fetchall()
            ids = [row[0] for row in rows]
            rows_per_tick.append(len(ids)); discovery_vm.append(measured['vm_instructions'])
            assert not accepted.intersection(ids)
            accepted.update(ids)
            with db:
                for source_id in ids:
                    db.execute("""INSERT INTO pharmacy_notification_events
                      (id,line_account_id,friend_id,message_id,category,outcome,occurred_at,idempotency_key,created_at)
                      VALUES(?,'a','f','myna_handoff_status_v1','transactional_care','sent',?,?,?)""",
                      [f'drain-{source_id}',NOW,f'myna-status:{source_id}:EXPIRED',NOW])
        assert rows_per_tick == [50,50,50,50,0]
        assert len(accepted) == 200
        output.append({'version':'before' if previous else 'after','rows_per_tick':rows_per_tick,
                       'discovery_vm_per_tick':discovery_vm,'distinct_jobs':len(accepted),
                       'scope':'200 Myna jobs drained via synthetic sent records; no HTTP or real time waits'})
        db.close()
    return output


def expired_backlog_cases():
    output = []
    for previous in [True, False]:
        db = sqlite3.connect(':memory:')
        db.executescript(read('packages/db/bootstrap.sql', previous))
        seed(db,10000,1)
        for i in range(200):
            db.execute("""INSERT INTO pharmacy_myna_handoffs
              (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
              VALUES(?,'a','f','PAPER','EXPIRED','LIFF',?,?,?,?)""", (f'old-m{i}', f'old-m{i}',OLD,OLD,OLD))
            db.execute("""INSERT INTO pharmacy_emergency_intake_events
              (id,intake_id,line_account_id,event_type,actor_type,actor_id,idempotency_key,occurred_at)
              VALUES(?,'intake','a','reviewed','system','system',?,?)""", (f'old-e{i}', f'old-key{i}',OLD))
        results = {name:measure(db,sql,values) for name,sql,values in sqls(previous)
                   if name in ['myna_work_expiry','emergency_work_expiry','myna','emergency']}
        assert results['myna']['selected'] == results['emergency']['selected'] == 1
        if not previous:
            assert results['myna_work_expiry']['logical_changes'] == results['emergency_work_expiry']['logical_changes'] == 200
        output.append({'version':'before' if previous else 'after', 'expired_jobs_per_kind':200,
                       'live_jobs_reached_per_kind':1,'results':results})
        db.close()
    return output


def main():
    output = {'baseline': BASE, 'sqlite_version': sqlite3.sqlite_version, 'metric': 'SQLite VM instructions, not D1 rows_read', 'discovery_statement_count_per_tick': 7, 'added_expiry_range_statements_per_tick': 2, 'cases': []}
    for label, history, pending, future in [('normal-1k',1000,10,False),('normal-10k',10000,10,False),('normal-50k',50000,10,False),('idle-50k',50000,0,False),('burst-50k',50000,200,False),('future-50k',50000,200,True)]:
        case = {'name':label,'history_per_domain':history,'recent_sent_per_domain':history//10,'pending_per_notification_kind':pending,'versions':{}}
        for previous in [True, False]:
            db = sqlite3.connect(':memory:')
            db.executescript(read('packages/db/bootstrap.sql', previous))
            seed(db,history,pending,future)
            results = {name:measure(db,sql,values) for name,sql,values in sqls(previous)}
            case['versions']['before' if previous else 'after'] = results
            db.close()
        for name in ['expiry','broadcast','accepted','unsent','resume']:
            assert case['versions']['before'][name]['logical_changes'] == case['versions']['after'][name]['logical_changes']
        for name in ['myna','emergency']:
            # Future source times were not excluded by the old lookback query;
            # the new due queue deliberately waits until they become due.
            if not future:
                assert case['versions']['before'][name]['selected'] == case['versions']['after'][name]['selected']
                assert case['versions']['before'][name]['selection_digest'] == case['versions']['after'][name]['selection_digest']
        output['cases'].append(case)
    output['mutation_and_retry_cases'] = mutation_cases()
    output['backlog_cases'] = backlog_cases()
    output['expired_backlog_cases'] = expired_backlog_cases()
    print(json.dumps(output,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
