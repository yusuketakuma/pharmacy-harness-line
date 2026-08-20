import { LineHarness } from "@line-harness/sdk";

let clientInstance: LineHarness | null = null;

export function getHarnessApiConfig() {
  const apiUrl = process.env.LINE_HARNESS_API_URL;
  const apiKey = process.env.LINE_HARNESS_API_KEY;
  const tenantId = process.env.LINE_HARNESS_TENANT_ID;
  const accountId = process.env.LINE_HARNESS_ACCOUNT_ID;
  if (!apiUrl) throw new Error("LINE_HARNESS_API_URL environment variable is required");
  if (!apiKey) throw new Error("LINE_HARNESS_API_KEY environment variable is required");
  if (!tenantId) throw new Error("LINE_HARNESS_TENANT_ID environment variable is required");
  return { apiUrl, apiKey, tenantId, accountId };
}

export function getHarnessApiHeaders(): Record<string, string> {
  const { apiKey, tenantId } = getHarnessApiConfig();
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Tenant-Id": tenantId,
  };
}

export function getClient(): LineHarness {
  if (clientInstance) return clientInstance;

  const { apiUrl, apiKey, tenantId, accountId } = getHarnessApiConfig();

  clientInstance = new LineHarness({
    apiUrl,
    apiKey,
    tenantId,
    lineAccountId: accountId,
  });

  return clientInstance;
}
