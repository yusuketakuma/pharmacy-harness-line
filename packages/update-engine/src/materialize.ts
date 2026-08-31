/**
 * Install-time materialization of release-bundle artifacts.
 *
 * The release pipeline bakes a placeholder origin
 * (`https://__LH_WORKER_URL__`) into the admin bundle because the real
 * Worker URL only exists once a customer installs. Every deploy path that
 * ships bundle admin files to Pages (CLI setup, CLI update, worker-side
 * self-update) MUST rewrite that placeholder to the install's Worker URL
 * first — deploying the files verbatim produces an admin UI that calls
 * `https://__LH_WORKER_URL__/api/...` and breaks on arrival.
 */

/** Placeholder origin baked into release admin builds by release.yml. */
export const ADMIN_URL_PLACEHOLDER = 'https://__LH_WORKER_URL__';

/**
 * Extensions we treat as text for placeholder substitution. Everything else
 * (images, fonts, wasm) is passed through byte-for-byte — running a string
 * replace over binary content would corrupt it.
 */
const TEXT_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'css',
  'html',
  'htm',
  'json',
  'map',
  'svg',
  'txt',
  'webmanifest',
  'xml',
]);

export function isTextAssetPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Rewrite the admin bundle for a concrete install: replaces every
 * occurrence of {@link ADMIN_URL_PLACEHOLDER} with the install's Worker
 * origin. Returns a NEW map; input buffers are never mutated.
 *
 * `workerUrl` is normalized to a bare origin (no trailing slash) because
 * the admin client concatenates paths as `${API_URL}${path}`.
 */
export function materializeAdminFiles(
  files: Map<string, Buffer>,
  workerUrl: string,
): Map<string, Buffer> {
  const origin = workerUrl.replace(/\/+$/, '');
  const out = new Map<string, Buffer>();
  for (const [path, buf] of files) {
    if (!isTextAssetPath(path)) {
      out.set(path, buf);
      continue;
    }
    const text = buf.toString('utf8');
    if (!text.includes(ADMIN_URL_PLACEHOLDER)) {
      out.set(path, buf);
      continue;
    }
    out.set(path, Buffer.from(text.split(ADMIN_URL_PLACEHOLDER).join(origin), 'utf8'));
  }
  return out;
}

/**
 * Post-materialization safety net: list text files that still contain a
 * `__LH_` marker (an unknown placeholder this version of the tooling does
 * not know how to fill). Callers surface these as warnings — the deploy
 * still proceeds, but the operator learns which files may misbehave.
 */
export function findResidualPlaceholders(files: Map<string, Buffer>): string[] {
  const residual: string[] = [];
  for (const [path, buf] of files) {
    if (!isTextAssetPath(path)) continue;
    if (buf.toString('utf8').includes('__LH_')) {
      residual.push(path);
    }
  }
  return residual.sort();
}

/**
 * Classify a D1 / SQLite error message as "schema object already exists".
 *
 * LINE Harness migrations are additive-only (enforced by
 * scripts/check-migrations.ts) and use INSERT OR IGNORE for seed data, so
 * re-applying a migration against a database that already has it fails ONLY
 * with duplicate-object errors. Setup has always swallowed these
 * (`packages/create-line-harness/src/steps/database.ts`); the update and
 * adoption flows reuse the same policy via this predicate.
 *
 * A duplicate CREATE TABLE / CREATE INDEX is genuinely benign: the object
 * name carries the whole definition an additive migration cares about.
 * A duplicate CREATE TRIGGER is NOT — same name, different body is a real
 * divergence — so `applyD1Migrations` compares the live trigger definition
 * (see {@link createTriggerName} / {@link normalizeTriggerSql}) instead of
 * trusting this predicate alone.
 *
 * Matches both wrangler CLI stderr and the D1 REST API error text.
 */
export function isBenignSchemaErrorText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('duplicate column') ||
    t.includes('already exists') ||
    (t.includes('table') && t.includes('already'))
  );
}

/** Comment-free `CREATE TRIGGER` head, capturing the trigger name. */
const CREATE_TRIGGER_HEAD =
  /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/i;

/**
 * Name of the trigger a statement creates, or null when the statement is not
 * a CREATE TRIGGER. Input must already be comment-free.
 */
export function createTriggerName(statement: string): string | null {
  const match = CREATE_TRIGGER_HEAD.exec(statement);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * Normalize a CREATE TRIGGER statement so a migration's own text can be
 * compared with what SQLite stored in `sqlite_master.sql`. SQLite keeps the
 * original text but drops `IF NOT EXISTS` and the trailing semicolon, and
 * whitespace/keyword case never change a trigger's meaning. Quoted content is
 * copied byte-for-byte because case and whitespace inside literals do matter.
 */
export function normalizeTriggerSql(sql: string): string {
  let normalized = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  let pendingSpace = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      normalized += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) normalized += sql[++i];
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      if (pendingSpace && normalized) normalized += ' ';
      pendingSpace = false;
      quote = ch === '[' ? ']' : ch;
      normalized += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && normalized) normalized += ' ';
    pendingSpace = false;
    normalized += ch.toLowerCase();
  }
  return normalized
    .trim()
    .replace(/;$/, '')
    .trim()
    .replace(/^create (temp(?:orary)? )?trigger if not exists /, 'create $1trigger ')
    .trim();
}
