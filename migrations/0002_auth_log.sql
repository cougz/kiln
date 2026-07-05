-- debug: record rejected /mcp auth attempts (reason + unverified claims)
CREATE TABLE auth_log (
    ts      TEXT NOT NULL DEFAULT (datetime('now')),
    reason  TEXT NOT NULL,
    iss     TEXT,
    aud     TEXT,
    sub     TEXT,
    email   TEXT,
    ua      TEXT
);
