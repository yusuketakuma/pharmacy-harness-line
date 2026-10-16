/** Public API paths keep their own route-level identity/signature checks. */
export function isPublicApiRequest(method: string, path: string): boolean {
  if (method === 'GET' && /^\/api\/forms\/[^/]+$/.test(path)) return true;
  // These LIFF actions perform their own LINE ID-token verification inside
  // the route. They cannot use the admin auth gate because their Bearer token
  // is a LINE ID token, not a Harness staff API key.
  const isPublicFormAction =
    method === 'POST' &&
    (/^\/api\/forms\/[^/]+\/submit$/.test(path) ||
      /^\/api\/forms\/[^/]+\/opened$/.test(path) ||
      /^\/api\/forms\/[^/]+\/partial$/.test(path));
  if (isPublicFormAction) return true;

  // custom:pharmacy-prescriptions — these routes verify the LINE ID token
  // themselves. Keep the exception method-aware so adding another route under
  // this namespace cannot silently bypass staff authentication.
  const isPrescriptionPatientAction =
    (method === 'POST' && path === '/api/liff/pharmacy/prescriptions') ||
    (method === 'GET' &&
      (path === '/api/liff/pharmacy/prescriptions/me' || path === '/api/liff/pharmacy/prescriptions/recovery')) ||
    (method === 'PUT' && /^\/api\/liff\/pharmacy\/prescriptions\/[^/]+\/files\/[^/]+$/.test(path)) ||
    (method === 'POST' &&
      /^\/api\/liff\/pharmacy\/prescriptions\/[^/]+\/(submit|cancel|resubmission|arrival)$/.test(path));
  if (isPrescriptionPatientAction) return true;

  // custom:pharmacy-patient-timeline — read-only projection with its own
  // LINE ID-token and account/owner resolution.
  if (method === 'GET' && path === '/api/liff/pharmacy/timeline') return true;

  // custom:pharmacy-intake — patient profiles and intake revisions verify the
  // LINE ID token in their route middleware, just like prescription uploads.
  const isPharmacyIntakePatientAction =
    (path === '/api/liff/pharmacy/patients' && (method === 'GET' || method === 'POST')) ||
    (/^\/api\/liff\/pharmacy\/patients\/[^/]+(\/intake|\/archive)?$/.test(path) &&
      (method === 'GET' || method === 'POST' || method === 'PATCH')) ||
    (method === 'GET' && /^\/api\/liff\/pharmacy\/patients\/[^/]+\/access$/.test(path)) ||
    (method === 'POST' &&
      /^\/api\/liff\/pharmacy\/patients\/[^/]+\/(privacy-consent|notification-preference)$/.test(path)) ||
    (method === 'DELETE' && /^\/api\/liff\/pharmacy\/patients\/[^/]+\/proxy-grant$/.test(path));
  if (isPharmacyIntakePatientAction) return true;

  // custom:pharmacy-myna — the handoff and self-report routes verify the
  // LINE ID token in their own middleware; admin verification remains staff-authenticated.
  const isMynaPatientAction =
    (method === 'POST' && path === '/api/liff/pharmacy/myna-handoffs') ||
    (method === 'GET' && path === '/api/liff/pharmacy/myna-handoffs/active') ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/myna-handoffs\/[^/]+\/(launch|patient-report)$/.test(path));
  if (isMynaPatientAction) return true;

  // custom:pharmacy-continuity — the patient view verifies the LINE ID token
  // in its route middleware; the admin collection remains staff-authenticated.
  const isContinuityPatientAction =
    (method === 'GET' && path === '/api/liff/pharmacy/continuity') ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/continuity\/[^/]+\/pause$/.test(path)) ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/continuity\/expectations\/[^/]+\/respond$/.test(path));
  if (isContinuityPatientAction) return true;

  // custom:pharmacy-follow-up/emergency-contraception — patient actions use
  // the same route-level LINE identity verification as the LIFF routes above.
  const isMedicationFollowUpPatientAction =
    (method === 'GET' &&
      (path === '/api/liff/pharmacy/medication-followups' ||
        path === '/api/liff/pharmacy/medication-followups/outlook')) ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/medication-followups\/[^/]+\/respond$/.test(path));
  const isEmergencyContraceptionPatientAction =
    (method === 'GET' && path === '/api/liff/pharmacy/emergency-contraception') ||
    (method === 'POST' && path === '/api/liff/pharmacy/emergency-contraception/intakes') ||
    (method === 'POST' && /^\/api\/liff\/pharmacy\/emergency-contraception\/intakes\/[^/]+\/cancel$/.test(path));
  const isPublicProfilePatientAction =
    method === 'GET' &&
    (path === '/api/liff/pharmacy/public-profile' ||
      path === '/api/liff/pharmacy/privacy-policy' ||
      path === '/api/liff/pharmacy/feature-access');
  if (isMedicationFollowUpPatientAction || isEmergencyContraceptionPatientAction || isPublicProfilePatientAction)
    return true;

  if (
    path === '/webhook' ||
    path === '/docs' ||
    path === '/openapi.json' ||
    path === '/api/affiliates/click' ||
    path.startsWith('/t/') ||
    path.startsWith('/r/') ||
    path.startsWith('/pool/') ||
    path.startsWith('/images/') ||
    (path.startsWith('/api/liff/') && !path.startsWith('/api/liff/pharmacy/')) ||
    // Admin login/logout — issue/clear the session cookie before auth exists.
    path === '/api/auth/login' ||
    path === '/api/auth/logout' ||
    // Platform CLI provisioning authenticates with PLATFORM_ADMIN_KEY in-route.
    (path === '/api/platform/pharmacy/tenants' && method === 'POST') ||
    (path === '/api/platform/pharmacy/platform-admins' && method === 'POST') ||
    (method === 'POST' && /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/admin-bootstrap$/.test(path)) ||
    (method === 'POST' && /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/cli-sessions(?:\/[^/]+\/revoke)?$/.test(path)) ||
    (method === 'POST' &&
      /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/line-accounts\/[^/]+\/credentials\/(?:backfill|scrub|restore)$/.test(
        path,
      )) ||
    (method === 'POST' &&
      /^\/api\/platform\/pharmacy\/tenants\/[^/]+\/line-accounts\/[^/]+\/intake-encryption\/(?:coverage|backfill|freeze|scrub|restore)$/.test(
        path,
      )) ||
    path.startsWith('/auth/') ||
    path === '/setup' ||
    path === '/api/integrations/stripe/webhook' ||
    path.match(/^\/api\/webhooks\/incoming\/[^/]+\/receive$/) ||
    // Google OAuth redirects without admin headers. Route verifies a signed, expiring state.
    (path === '/api/booking/google-calendar/oauth/callback' && method === 'GET') ||
    path === '/api/qr' || // Public QR proxy — used by desktop landing pages
    path === '/api/health' || // Liveness probe (update CLI / self-update verify)
    // Public lead form. Origin validation and field validation happen in-route.
    (path === '/api/public/media-inquiries' && method === 'POST') ||
    // Platform-admin routes authenticate against their own, entirely
    // separate session cookie/table via platformAdminAuthMiddleware — see
    // custom/pharmacy/platform-admin/auth.ts. A tenant-admin session must
    // never grant access here, so this is a blanket prefix skip, not a
    // method-aware exception like the PHI patient routes above.
    path.startsWith('/api/platform-admin/')
  ) {
    return true;
  }

  return false;
}
