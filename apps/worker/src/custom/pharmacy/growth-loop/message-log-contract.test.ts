import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('messages_log write contract', () => {
  it('keeps every in-process provider message call behind its durable delivery contract', () => {
    const calls = sourceFiles(join(process.cwd(), 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const count = (pattern: RegExp) => [...source.matchAll(pattern)].length;
      const provider = {
        push: count(/\.pushMessage\s*\(/g),
        reply: count(/\.replyMessage\s*\(/g),
        multicast: count(/\.multicast\s*\(/g),
        broadcast: count(/\.broadcast\s*\(/g),
      };
      return Object.values(provider).some(Boolean) ? [{ file, source, provider }] : [];
    });

    expect(calls.map(({ file }) => relative(process.cwd(), file)).sort()).toEqual([
      'src/index.ts',
      'src/routes/booking/meet-callback.ts',
      'src/routes/crm/chats.ts',
      'src/routes/crm/friends.ts',
      'src/routes/integrations/webhook.ts',
      'src/routes/liff/liff.ts',
      'src/routes/messaging/broadcasts.ts',
      'src/services/affiliate-notifier.ts',
      'src/services/auto-reply.ts',
      'src/services/booking-notifier.ts',
      'src/services/broadcast.ts',
      'src/services/dedup-broadcast.ts',
      'src/services/event-booking-notifier.ts',
      'src/services/event-bus.ts',
      'src/services/immediate-first-step.ts',
      'src/services/reminder-delivery.ts',
      'src/services/step-delivery.ts',
    ]);

    for (const { file, source, provider } of calls) {
      const relativeFile = relative(process.cwd(), file);
      if (relativeFile === 'src/index.ts') {
        expect(provider, relativeFile).toEqual({ push: 1, reply: 0, multicast: 0, broadcast: 0 });
        expect(source).toContain('reconcileAttemptedBroadcastTestPushes({');
        expect(source).toContain('await client.pushMessage(request.to, request.messages, retryKey)');
        continue;
      }

      expect(
        [...source.matchAll(/deliverTrackedLinePush\s*\(/g)].length,
        `${relativeFile} push delivery contract`,
      ).toBe(provider.push);
      expect(
        [...source.matchAll(/deliverTrackedLineReply\s*\(/g)].length,
        `${relativeFile} reply delivery contract`,
      ).toBe(provider.reply);
      expect(
        [...source.matchAll(/deliverTrackedLineBroadcast\s*\(/g)].length,
        `${relativeFile} broadcast delivery contract`,
      ).toBe(provider.broadcast);

      if (relativeFile === 'src/services/dedup-broadcast.ts') {
        expect(provider.multicast).toBe(1);
        expect(source).toContain("'dedup-multicast'");
        expect(source).toContain('retryKey);');
      } else {
        expect(provider.multicast, `${relativeFile} multicast contract`).toBe(0);
      }
    }
  });

  it('freezes account and delivery type on every current message write path', () => {
    const inserts = sourceFiles(join(process.cwd(), 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/INSERT(?:\s+OR\s+IGNORE)?\s+INTO messages_log\s*\(([^)]*)\)/g)]
        .map((match) => ({ file, columns: match[1], sql: source.slice(match.index, match.index + 600) }));
    });

    expect(inserts.map((insert) => relative(process.cwd(), insert.file)).sort()).toEqual([
      'src/routes/integrations/line-proxy.ts',
      'src/routes/integrations/webhook.ts',
      'src/routes/integrations/webhook.ts',
      'src/routes/integrations/webhook.ts',
      'src/services/dedup-broadcast.ts',
      'src/services/event-bus.ts',
      'src/services/outbound-line-delivery.ts',
    ]);
    for (const insert of inserts) {
      expect(insert.columns, insert.file).toContain('line_account_id');
      if (insert.sql.includes("'outgoing'")) {
        expect(insert.columns, insert.file).toContain('delivery_type');
      }
    }
  });

  it('keeps multicast sends in the retry-keyed durable pipelines only', () => {
    const multicastFiles = sourceFiles(join(process.cwd(), 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('.multicast('))
      .map((file) => relative(process.cwd(), file))
      .sort();

    expect(multicastFiles).toEqual([
      'src/services/dedup-broadcast.ts',
    ]);
    for (const file of multicastFiles) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      for (const call of source.matchAll(/\.multicast\(([\s\S]*?)\);/g)) {
        expect(call[1], file).toContain('retryKey');
      }
    }
  });

  it('excludes test sends from production broadcast state', () => {
    const profileRefresh = readFileSync(
      join(process.cwd(), 'src/routes/crm/profile-refresh.ts'),
      'utf8',
    );

    expect(profileRefresh).toContain(
      "WHERE broadcast_id = ? AND COALESCE(delivery_type, '') != 'test'",
    );
  });
});
