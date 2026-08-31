type E2EGlobal = typeof globalThis & { __LIFF_E2E_CALLS__?: string[] };

function record(call: string): void {
  const scope = globalThis as E2EGlobal;
  (scope.__LIFF_E2E_CALLS__ ??= []).push(call);
}

export default {
  async init({ liffId }: { liffId: string }) {
    record(`init:${liffId}`);
    const delay = Number(new URL(globalThis.location.href).searchParams.get('liffInitDelay'));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  },
  isLoggedIn() {
    record('isLoggedIn');
    return true;
  },
  async getProfile() {
    record('getProfile');
    return { userId: 'U-e2e', displayName: 'E2E Patient' };
  },
  getIDToken() {
    record('getIDToken');
    return 'e2e-id-token';
  },
  login() {
    record('login');
  },
  isInClient: () => true,
  sendMessages: async () => undefined,
  getAccessToken: () => 'e2e-access-token',
  openWindow: () => undefined,
};
