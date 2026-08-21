// Outbound webhook destination check: https only, no literal IPs / loopback / link-local names.
const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i;

export function validateHttpsUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) {
    return 'url is required';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url must be a valid absolute URL';
  }
  if (parsed.protocol !== 'https:') {
    return 'url must use https:// scheme';
  }
  if (parsed.username || parsed.password) {
    return 'url must not contain credentials';
  }
  if (BLOCKED_HOST.test(parsed.hostname) || !parsed.hostname.includes('.')) {
    return 'url host must be a public hostname';
  }
  return null;
}
