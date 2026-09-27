from pathlib import Path
import sqlite3,json,time,statistics,datetime,hashlib
root=Path.cwd(); out=root/'docs/pharmacy/evidence/audit-20260922'
queries={}
for version in ['P','W']:
    unique={q['sql']:q for q in json.loads((out/f'F33-{version}-queries.json').read_text()) if 'messages_log' in q['sql']}
    queries[version]=list(unique.values())
    for q in queries[version]:
        if 'julianday(created_at) < julianday(?)' in q['sql']:q['params'][1]='2023-01-01T00:01:00.000Z'
assert len(queries['P'])==len(queries['W'])==8
result={'sqliteVersion':sqlite3.sqlite_version,'runs':9,'warmups':3,'population':'10 friends, total 50/500/5000 mixed-offset messages, 8 actual SELECTs; identical before parameter','threshold':'W median <= max(2*P median,P median+15ms)','rowsScanned':'not measured; Python sqlite3 lacks statement scanstatus','samples':[]}
for n in [50,500,5000]:
    db=sqlite3.connect(':memory:');db.execute('PRAGMA foreign_keys=ON');db.executescript((root/'packages/db/bootstrap.sql').read_text())
    db.executescript("""INSERT INTO tenants(id,tenant_code,display_name) VALUES('synthetic-tenant','synthetic-tenant','Synthetic');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('synthetic-account','synthetic-channel','Synthetic','synthetic-token','synthetic-secret');
    INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES('synthetic-tenant','synthetic-account');
    INSERT INTO staff_members(id,name,role,api_key,is_active) VALUES('synthetic-staff','Synthetic','admin','synthetic-key',1);
    INSERT INTO tenant_staff_memberships(tenant_id,staff_id,role,is_active) VALUES('synthetic-tenant','synthetic-staff','admin',1);
    INSERT INTO pharmacy_staff_accounts(line_account_id,staff_id,is_active,created_at,updated_at) VALUES('synthetic-account','synthetic-staff',1,'2023-01-01T00:00:00Z','2023-01-01T00:00:00Z');""")
    friends=['synthetic-friend']+[f'synthetic-friend-{i}' for i in range(1,10)]
    for f in friends:db.execute("INSERT INTO friends(id,line_user_id,provider_line_user_id,display_name,line_account_id,is_following) VALUES(?,?,?,?,'synthetic-account',1)",(f,f,f,f))
    start=datetime.datetime(2023,1,1,tzinfo=datetime.timezone.utc)
    for i in range(n):
        at=start+datetime.timedelta(milliseconds=i*1000)
        at=at.astimezone(datetime.timezone(datetime.timedelta(hours=9))).isoformat(timespec='milliseconds') if i%2 else at.isoformat(timespec='milliseconds').replace('+00:00','Z')
        direction='outgoing' if i%3==0 else 'incoming';source='manual' if direction=='outgoing' else 'user'
        db.execute("INSERT INTO messages_log(id,friend_id,line_account_id,direction,message_type,content,source,created_at) VALUES(?,?,'synthetic-account',?,'text',?,?,?)",(f'm-{i}',friends[i%10],direction,'synthetic '+str(i),source,at))
    db.commit()
    samples={'P':[],'W':[]};plans={};counts={}
    for version in ['P','W']:
        plans[version]=[list(db.execute('EXPLAIN QUERY PLAN '+q['sql'],q['params'])) for q in queries[version]]
    for run in range(12):
        for version in (['P','W'] if run%2==0 else ['W','P']):
            start_ns=time.perf_counter_ns();rows=[len(db.execute(q['sql'],q['params']).fetchall()) for q in queries[version]]
            elapsed=(time.perf_counter_ns()-start_ns)/1e6
            if run>=3:samples[version].append(elapsed)
            counts[version]=rows
    med={v:statistics.median(x) for v,x in samples.items()};ceiling=max(med['P']*2,med['P']+15)
    result['samples'].append({'messages':n,'medianMs':med,'ceilingMs':ceiling,'pass':med['W']<=ceiling,'runsMs':samples,'returnedRows':counts,'plans':plans})
    db.close()
(out/'F33-performance.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps([{k:v for k,v in x.items() if k in ['messages','medianMs','ceilingMs','pass']} for x in result['samples']],indent=2))
assert all(x['pass'] for x in result['samples'])
