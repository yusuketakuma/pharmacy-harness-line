import { getHarnessApiConfig, getHarnessApiHeaders } from './client.js';

export interface ApiCallResult {
  ok: boolean;
  status: number;
  data: unknown;
  hint?: string;
}

function isMissingRoute(
  response: Response,
  path: string,
  data: unknown,
): boolean {
  if (response.status !== 404 || typeof data !== 'object' || data === null) {
    return false;
  }
  if (response.headers.get('X-Line-Harness-Error') === 'route_not_found') {
    return true;
  }
  // Older bundles do not send the header. A top-level collection cannot be
  // a missing resource, so its exact fallback body is still unambiguous.
  return /^\/api\/[^/]+$/.test(path)
    && (data as { error?: unknown }).error === 'Not found';
}

export async function apiCall(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<ApiCallResult> {
  const { apiUrl } = getHarnessApiConfig();
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: getHarnessApiHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown;
  let parsedJson = true;
  try {
    data = JSON.parse(text);
  } catch {
    parsedJson = false;
    data = { success: false, error: `API ${response.status} returned a non-JSON response` };
  }

  const missingRoute = isMissingRoute(response, path, data);
  if (!response.ok && parsedJson) {
    data = { success: false, error: `API request failed (${response.status})` };
  }

  const result: ApiCallResult = {
    ok: response.ok,
    status: response.status,
    data,
  };
  if (missingRoute) {
    result.hint =
      `${method} ${path} はこの環境に存在しません。ID の問題ではなく、` +
      '稼働中 bundle がこの機能を含まない可能性があります。';
  } else if (response.status === 401 || response.status === 403) {
    result.hint = `認証または tenant 権限を確認してください（${response.status}）。`;
  }
  return result;
}

export function toToolResult(result: ApiCallResult) {
  const data = result.hint && typeof result.data === 'object' && result.data !== null
    ? { ...result.data, _hint: result.hint }
    : result.data;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    ...(result.ok ? {} : { isError: true as const }),
  };
}
