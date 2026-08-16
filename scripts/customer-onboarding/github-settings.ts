#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

interface ApiOperation {
  method: 'PATCH' | 'PUT';
  path: string;
  body: Record<string, unknown>;
}

export interface RepositorySettings {
  repository: string;
  api: ApiOperation[];
  variables: Array<[string, string]>;
}

export function buildRepositorySettings(input: {
  customerRepository: string;
  sellerRepository: string;
}): RepositorySettings {
  requireRepository(input.customerRepository, 'customer');
  requireRepository(input.sellerRepository, 'seller');
  const repo = `repos/${input.customerRepository}`;
  return {
    repository: input.customerRepository,
    api: [
      { method: 'PATCH', path: repo, body: { allow_auto_merge: true } },
      { method: 'PUT', path: `${repo}/environments/development`, body: {} },
      { method: 'PUT', path: `${repo}/environments/production`, body: {} },
      {
        method: 'PUT',
        path: `${repo}/branches/main/protection`,
        body: {
          required_status_checks: {
            strict: true,
            contexts: ['Customer Update Policy / policy'],
          },
          enforce_admins: true,
          required_pull_request_reviews: {
            dismiss_stale_reviews: true,
            require_code_owner_reviews: true,
            required_approving_review_count: 1,
          },
          restrictions: null,
          required_conversation_resolution: true,
          allow_force_pushes: false,
          allow_deletions: false,
        },
      },
    ],
    variables: [
      ['LINE_HARNESS_SELLER_REPOSITORY', input.sellerRepository],
      ['CUSTOMER_UPDATE_MODE', 'manual'],
      ['CUSTOMER_UPDATE_CANARY_PASSED', 'false'],
      ['LINE_HARNESS_CLOUDFLARE_DEPLOY', 'false'],
    ],
  };
}

export function applyRepositorySettings(
  settings: RepositorySettings,
  sellerReadToken?: string,
): void {
  for (const operation of settings.api) {
    execFileSync(
      'gh',
      ['api', '--method', operation.method, operation.path, '--input', '-'],
      { input: JSON.stringify(operation.body), stdio: ['pipe', 'inherit', 'inherit'] },
    );
  }
  for (const [name, value] of settings.variables) {
    execFileSync(
      'gh',
      ['variable', 'set', name, '--repo', settings.repository, '--body', value],
      { stdio: 'inherit' },
    );
  }
  if (sellerReadToken !== undefined) {
    if (!sellerReadToken.trim()) throw new Error('seller read token cannot be empty');
    execFileSync(
      'gh',
      ['secret', 'set', 'LINE_HARNESS_SELLER_READ_TOKEN', '--repo', settings.repository],
      { input: sellerReadToken, stdio: ['pipe', 'inherit', 'inherit'] },
    );
  }
}

function requireRepository(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`invalid ${label} repository`);
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('github-settings requires --key value arguments');
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function main(): void {
  const args = parseArgs(argv.slice(2));
  const settings = buildRepositorySettings({
    customerRepository: required(args, 'customer-repository'),
    sellerRepository: required(args, 'seller-repository'),
  });
  const token = args['seller-token-stdin'] === 'true' ? readFileSync(0, 'utf8') : undefined;
  applyRepositorySettings(settings, token);
}

if (argv[1]?.endsWith('github-settings.ts')) main();
