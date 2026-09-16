import type { CfApiCreds } from '../types.js';
import { authHeader, pagesProjectApiBase, throwHttpError } from './_shared.js';

/** Snapshot the currently serving production Pages deployment for rollback. */
export async function getRollbackPagesDeployment(opts: {
  creds: CfApiCreds;
  projectName: string;
}): Promise<{ id: string }> {
  const res = await fetch(pagesProjectApiBase(opts.creds.accountId, opts.projectName), {
    method: 'GET',
    headers: authHeader(opts.creds.apiToken),
  });
  if (!res.ok) await throwHttpError('GET pages project failed', res);
  const body = (await res.json()) as {
    success?: boolean;
    result?: {
      canonical_deployment?: {
        id?: unknown;
        environment?: unknown;
        is_skipped?: unknown;
        latest_stage?: { name?: unknown; status?: unknown };
      } | null;
    };
  };
  const deployment = body.result?.canonical_deployment;
  if (body.success !== true || typeof deployment?.id !== 'string' || !deployment.id ||
      deployment.environment !== 'production' || deployment.is_skipped !== false ||
      deployment.latest_stage?.name !== 'deploy' || deployment.latest_stage.status !== 'success') {
    throw new Error('Pages production rollback target is unavailable or unhealthy');
  }
  return { id: deployment.id };
}
