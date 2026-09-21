import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const mocks = vi.hoisted(() => ({ root: '', wrangler: vi.fn(), repoPnpm: vi.fn() }));
vi.mock('node:os', () => ({ tmpdir: () => mocks.root }));
vi.mock('../src/lib/wrangler.js', () => ({ wrangler: mocks.wrangler, WranglerError: class extends Error {} }));
vi.mock('../src/lib/pnpm.js', () => ({ repoPnpm: mocks.repoPnpm }));
vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { warn: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
import { deployAdmin } from '../src/steps/deploy-admin.js';

describe('release Admin staging', () => {
  beforeEach(() => {
    mocks.root = mkdtempSync(resolve('.audit-admin-test-'));
    mocks.wrangler.mockReset().mockResolvedValue('');
    mocks.repoPnpm.mockReset();
  });
  afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));
  const run = (files: Map<string, Buffer>) => deployAdmin({
    repoDir: mocks.root, workerUrl: 'https://synthetic.example',
    projectName: 'synthetic', adminFiles: files,
  });

  it.each(['../escape.txt', 'assets/../../escape.txt', '..\\escape.txt',
    'C:/escape.txt', 'C:escape.txt', '\\server\\escape.txt', ''])
  ('rejects unsafe path %j before writing or invoking deployment', async (path) => {
    await expect(run(new Map([
      ['index.html', Buffer.from('safe')], [path, Buffer.from('synthetic')],
    ]))).rejects.toThrow(/unsafe.*path/i);
    expect(readdirSync(mocks.root)).toEqual([]);
    expect(mocks.wrangler).not.toHaveBeenCalled();
    expect(mocks.repoPnpm).not.toHaveBeenCalled();
  });

  it('rejects an absolute path before staging', async () => {
    await expect(run(new Map([[join(mocks.root, 'escape.txt'), Buffer.from('x')]])))
      .rejects.toThrow(/unsafe.*path/i);
    expect(readdirSync(mocks.root)).toEqual([]);
    expect(mocks.wrangler).not.toHaveBeenCalled();
  });

  it('cleans incomplete staging when an asset conflicts with a directory', async () => {
    await expect(run(new Map([
      ['assets', Buffer.from('file')], ['assets/app.js', Buffer.from('nested')],
    ]))).rejects.toThrow();
    expect(readdirSync(mocks.root)).toEqual([]);
    expect(mocks.wrangler).not.toHaveBeenCalled();
  });

  it('materializes nested text, preserves binary bytes, and removes staging after deployment', async () => {
    let staged = '';
    const binary = Buffer.from([0, 255, 42]);
    mocks.wrangler.mockImplementation(async (args: string[]) => {
      if (args[1] === 'deploy') {
        staged = args[2];
        expect(readFileSync(join(staged, 'assets/app.js'), 'utf8')).toBe('https://synthetic.example/api');
        expect(readFileSync(join(staged, 'assets/logo.png'))).toEqual(binary);
      }
      return '';
    });
    expect(await run(new Map([
      ['assets/app.js', Buffer.from('https://__LH_WORKER_URL__/api')],
      ['assets/logo.png', binary],
    ]))).toEqual({ adminUrl: 'https://synthetic.pages.dev' });
    expect(staged).not.toBe('');
    expect(existsSync(staged)).toBe(false);
    expect(mocks.repoPnpm).not.toHaveBeenCalled();
  });
});
