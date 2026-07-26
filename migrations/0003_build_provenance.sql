-- Secure, reproducible build lifecycle. This migration is intentionally
-- additive: the original build.status CHECK remains valid for old databases.

ALTER TABLE source ADD COLUMN sha256 TEXT;
ALTER TABLE source ADD COLUMN byte_size INTEGER;

ALTER TABLE build ADD COLUMN source_manifest_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE build ADD COLUMN params_content TEXT NOT NULL DEFAULT '{}';
ALTER TABLE build ADD COLUMN entry TEXT NOT NULL DEFAULT 'build.py';
ALTER TABLE build ADD COLUMN timeout_s INTEGER NOT NULL DEFAULT 600
    CHECK (timeout_s BETWEEN 30 AND 900);
ALTER TABLE build ADD COLUMN printer_profile_json TEXT NOT NULL DEFAULT '{"x":180,"y":180,"z":180}';
ALTER TABLE build ADD COLUMN started_at TEXT;
ALTER TABLE build ADD COLUMN heartbeat_at TEXT;
ALTER TABLE build ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE build ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (archive_status IN ('pending','archiving','verified','failed','legacy'));
ALTER TABLE build ADD COLUMN archived_at TEXT;
ALTER TABLE build ADD COLUMN failure_code TEXT;
ALTER TABLE build ADD COLUMN idempotency_key TEXT;
ALTER TABLE build ADD COLUMN idempotency_fingerprint TEXT;
ALTER TABLE build ADD COLUMN retry_of TEXT REFERENCES build(id);
ALTER TABLE build ADD COLUMN cancelled_at TEXT;

CREATE UNIQUE INDEX build_project_idempotency
    ON build(project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX build_active_global ON build(status, heartbeat_at, created_at);

-- Preserve legacy artifact access without claiming provenance or digest checks
-- that did not exist when these archives were created.
UPDATE build SET archive_status = 'legacy', archived_at = finished_at
WHERE finished_at IS NOT NULL AND r2_prefix IS NOT NULL;

CREATE TABLE build_input (
    build_id       TEXT NOT NULL REFERENCES build(id) ON DELETE CASCADE,
    project_id     TEXT NOT NULL,
    path           TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    sha256         TEXT NOT NULL,
    size           INTEGER NOT NULL CHECK (size >= 0),
    PRIMARY KEY (build_id, path),
    FOREIGN KEY (project_id, path, source_version)
        REFERENCES source(project_id, path, version)
);
CREATE INDEX build_input_source
    ON build_input(project_id, path, source_version);

CREATE TABLE artifact (
    build_id  TEXT NOT NULL REFERENCES build(id) ON DELETE CASCADE,
    path      TEXT NOT NULL,
    sha256    TEXT NOT NULL,
    size      INTEGER NOT NULL CHECK (size >= 0),
    r2_key    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (build_id, path),
    UNIQUE (r2_key)
);

CREATE TABLE rate_limit (
    identity_hash TEXT NOT NULL,
    bucket        TEXT NOT NULL,
    window_start  INTEGER NOT NULL,
    count         INTEGER NOT NULL CHECK (count > 0),
    expires_at    INTEGER NOT NULL,
    PRIMARY KEY (identity_hash, bucket, window_start)
);
CREATE INDEX rate_limit_expiry ON rate_limit(expires_at);
