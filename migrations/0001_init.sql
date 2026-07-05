-- kiln schema v1 (PLAN.md §4): projects hold versioned CAD sources;
-- builds are immutable artifact sets in R2 keyed by r2_prefix.

CREATE TABLE project (
    id         TEXT PRIMARY KEY,           -- nanoid
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE source (
    project_id TEXT NOT NULL REFERENCES project(id),
    path       TEXT NOT NULL,              -- e.g. build.py
    version    INTEGER NOT NULL,           -- monotonic per project
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, path, version)
);

CREATE TABLE build (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES project(id),
    source_version INTEGER NOT NULL,
    params_json    TEXT NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','verified','failed')),
    report_json    TEXT,                   -- extents, watertight, asserts, support scan
    r2_prefix      TEXT,                   -- projects/<id>/builds/<n>/
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at    TEXT
);
CREATE INDEX build_project ON build (project_id, created_at DESC);

CREATE TABLE doc (
    project_id TEXT NOT NULL REFERENCES project(id),
    kind       TEXT NOT NULL CHECK (kind IN ('specification','instructions','bom','page')),
    build_id   TEXT REFERENCES build(id), -- build the doc describes
    markdown   TEXT NOT NULL,
    html       TEXT,                       -- rendered at write time
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, kind)
);
