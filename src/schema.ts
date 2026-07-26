import type { Env } from "./index";

const MIGRATION_NAME = "0003_build_provenance.sql";

const STATEMENTS = [
  "ALTER TABLE source ADD COLUMN sha256 TEXT",
  "ALTER TABLE source ADD COLUMN byte_size INTEGER",
  "ALTER TABLE build ADD COLUMN source_manifest_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE build ADD COLUMN params_content TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE build ADD COLUMN entry TEXT NOT NULL DEFAULT 'build.py'",
  "ALTER TABLE build ADD COLUMN timeout_s INTEGER NOT NULL DEFAULT 600 CHECK (timeout_s BETWEEN 30 AND 900)",
  "ALTER TABLE build ADD COLUMN printer_profile_json TEXT NOT NULL DEFAULT '{\"x\":180,\"y\":180,\"z\":180}'",
  "ALTER TABLE build ADD COLUMN started_at TEXT",
  "ALTER TABLE build ADD COLUMN heartbeat_at TEXT",
  "ALTER TABLE build ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE build ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'pending' CHECK (archive_status IN ('pending','archiving','verified','failed','legacy'))",
  "ALTER TABLE build ADD COLUMN archived_at TEXT",
  "ALTER TABLE build ADD COLUMN failure_code TEXT",
  "ALTER TABLE build ADD COLUMN idempotency_key TEXT",
  "ALTER TABLE build ADD COLUMN idempotency_fingerprint TEXT",
  "ALTER TABLE build ADD COLUMN retry_of TEXT REFERENCES build(id)",
  "ALTER TABLE build ADD COLUMN cancelled_at TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS build_project_idempotency ON build(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS build_active_global ON build(status, heartbeat_at, created_at)",
  "UPDATE build SET archive_status = 'legacy', archived_at = finished_at WHERE finished_at IS NOT NULL AND r2_prefix IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS build_input (
     build_id TEXT NOT NULL REFERENCES build(id) ON DELETE CASCADE,
     project_id TEXT NOT NULL,
     path TEXT NOT NULL,
     source_version INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     size INTEGER NOT NULL CHECK (size >= 0),
     PRIMARY KEY (build_id, path),
     FOREIGN KEY (project_id, path, source_version) REFERENCES source(project_id, path, version)
   )`,
  "CREATE INDEX IF NOT EXISTS build_input_source ON build_input(project_id, path, source_version)",
  `CREATE TABLE IF NOT EXISTS artifact (
     build_id TEXT NOT NULL REFERENCES build(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     size INTEGER NOT NULL CHECK (size >= 0),
     r2_key TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (build_id, path),
     UNIQUE (r2_key)
   )`,
  `CREATE TABLE IF NOT EXISTS rate_limit (
     identity_hash TEXT NOT NULL,
     bucket TEXT NOT NULL,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL CHECK (count > 0),
     expires_at INTEGER NOT NULL,
     PRIMARY KEY (identity_hash, bucket, window_start)
   )`,
  "CREATE INDEX IF NOT EXISTS rate_limit_expiry ON rate_limit(expires_at)",
] as const;

let ready: Promise<void> | undefined;

/**
 * Workers Builds deploys the Worker but does not run D1 migrations. Apply the
 * additive migration once at runtime and record it in Wrangler's migration
 * table so a later explicit `d1 migrations apply` remains consistent.
 */
export function ensureDatabaseSchema(env: Env): Promise<void> {
  ready ??= applyMigration(env).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

async function applyMigration(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
     )`,
  ).run();
  if (await migrationExists(env)) return;

  try {
    await env.DB.batch([
      ...STATEMENTS.map((statement) => env.DB.prepare(statement)),
      env.DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(MIGRATION_NAME),
    ]);
  } catch (error) {
    // Another isolate may have won the migration race. Only suppress the
    // duplicate-column/index failure when the complete migration is recorded.
    if (!await migrationExists(env)) throw error;
  }
}

async function migrationExists(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS applied FROM d1_migrations WHERE name = ?")
    .bind(MIGRATION_NAME)
    .first<{ applied: number }>();
  return row?.applied === 1;
}
