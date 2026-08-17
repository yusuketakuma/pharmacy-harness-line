#!/usr/bin/env tsx

import {
  getD1Bookmark,
  getLatestDeployment,
  getLatestWorkerDeployment,
} from '../../packages/update-engine/src/index.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error('missing ' + name);
  return value;
};

const creds = {
  accountId: required('CLOUDFLARE_ACCOUNT_ID'),
  apiToken: required('CLOUDFLARE_API_TOKEN'),
};
Promise.all([
  getLatestWorkerDeployment({ creds, scriptName: required('WORKER_NAME') }),
  getLatestDeployment({ creds, projectName: required('PAGES_PROJECT_NAME') }),
  process.argv.includes('--with-bookmark')
    ? getD1Bookmark({ creds, databaseId: required('D1_DATABASE_ID') })
    : Promise.resolve(undefined),
]).then(([worker, admin, bookmark]) => {
  console.log(JSON.stringify({
    workerVersionId: worker.versions[0].version_id,
    adminDeploymentId: admin.id,
    ...(bookmark ? { d1Bookmark: bookmark } : {}),
  }));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
