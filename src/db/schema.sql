-- x402-audit schema. One file, created once. No migrations (docs/NOT-BUILT.md).
-- All money amounts are TEXT holding the integer atomic-unit value (USDC: 6 dp)
-- to avoid floating point. Timestamps are INTEGER unix milliseconds.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  subcommand   TEXT NOT NULL,
  args_json    TEXT NOT NULL,
  config_hash  TEXT NOT NULL,
  network      TEXT NOT NULL,
  dry_run      INTEGER NOT NULL CHECK (dry_run IN (0,1)),
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT,
  notes        TEXT
);

-- ---------------------------------------------------------------- discover
CREATE TABLE IF NOT EXISTS sellers (
  id               INTEGER PRIMARY KEY,
  domain           TEXT NOT NULL UNIQUE,
  category         TEXT,                   -- inference|data|scraping|compute|other
  tier             TEXT,                   -- top|tail|null (assigned by sampler)
  volume_30d_atomic TEXT,                  -- USDC atomic units, from x402scan or chain
  volume_30d_source TEXT,                  -- x402scan|chain
  volume_30d_calls INTEGER,
  excluded         INTEGER NOT NULL DEFAULT 0,
  excluded_reason  TEXT,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  id                    INTEGER PRIMARY KEY,
  seller_id             INTEGER NOT NULL REFERENCES sellers(id),
  url                   TEXT NOT NULL,
  method                TEXT NOT NULL DEFAULT 'GET',
  source                TEXT NOT NULL,           -- bazaar|x402scan|manual
  x402_version          INTEGER,
  scheme                TEXT,
  network               TEXT,                    -- CAIP-2, e.g. eip155:8453
  asset                 TEXT,
  declared_price_atomic TEXT,
  pay_to                TEXT,
  description           TEXT,
  mime_type             TEXT,
  max_timeout_seconds   INTEGER,
  output_schema_json    TEXT,
  category              TEXT,
  raw_json              TEXT NOT NULL,
  first_seen_at         INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  UNIQUE (url, method, source)
);
CREATE INDEX IF NOT EXISTS resources_seller ON resources(seller_id);
CREATE INDEX IF NOT EXISTS resources_payto ON resources(pay_to);

-- ------------------------------------------------------------------- probe
CREATE TABLE IF NOT EXISTS probes (
  id                 INTEGER PRIMARY KEY,
  run_id             INTEGER REFERENCES runs(id),
  resource_id        INTEGER NOT NULL REFERENCES resources(id),
  client_identity    TEXT NOT NULL,            -- A|B
  ts                 INTEGER NOT NULL,
  status             INTEGER,
  headers_json       TEXT,
  body_text          TEXT,                     -- first 64 KB
  requirements_json  TEXT,                     -- parsed PaymentRequirements (the selected one)
  accepts_json       TEXT,                     -- full accepts[] array
  x402_version       INTEGER,
  amount_atomic      TEXT,
  asset              TEXT,
  network            TEXT,
  pay_to             TEXT,
  max_timeout_seconds INTEGER,
  latency_ms         INTEGER,
  outcome            TEXT,                     -- ok|overcharge|our_error
  flags_json         TEXT NOT NULL DEFAULT '[]',
  reference_price_atomic TEXT,
  reference_source   TEXT,
  error              TEXT
);
CREATE INDEX IF NOT EXISTS probes_resource_ts ON probes(resource_id, ts);

CREATE TABLE IF NOT EXISTS price_events (
  id           INTEGER PRIMARY KEY,
  resource_id  INTEGER NOT NULL REFERENCES resources(id),
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,                  -- quote_drift|payto_changed|price_discrimination
  old_value    TEXT,
  new_value    TEXT,
  probe_id     INTEGER REFERENCES probes(id),
  details_json TEXT
);

-- --------------------------------------------------------------------- buy
-- Append-only ledger of every payment attempt, written BEFORE signing.
CREATE TABLE IF NOT EXISTS attempts (
  id             INTEGER PRIMARY KEY,
  intent_id      TEXT NOT NULL,
  run_id         INTEGER REFERENCES runs(id),
  source         TEXT NOT NULL,                -- buy|stress_duplicate|stress_timeout
  ts             INTEGER NOT NULL,
  resource_id    INTEGER NOT NULL REFERENCES resources(id),
  wallet         TEXT NOT NULL,
  pay_to         TEXT NOT NULL,
  network        TEXT NOT NULL,
  asset          TEXT NOT NULL,
  amount_atomic  TEXT NOT NULL,
  nonce          TEXT,                         -- filled by a second append row once known
  phase          TEXT NOT NULL                 -- planned|signed|sent
);
CREATE INDEX IF NOT EXISTS attempts_intent ON attempts(intent_id);
CREATE TRIGGER IF NOT EXISTS attempts_no_update BEFORE UPDATE ON attempts
  BEGIN SELECT RAISE(ABORT, 'attempts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS attempts_no_delete BEFORE DELETE ON attempts
  BEGIN SELECT RAISE(ABORT, 'attempts is append-only'); END;

CREATE TABLE IF NOT EXISTS calls (
  id                      INTEGER PRIMARY KEY,
  intent_id               TEXT NOT NULL,
  run_id                  INTEGER REFERENCES runs(id),
  source                  TEXT NOT NULL,       -- buy|stress_duplicate|stress_timeout
  resource_id             INTEGER NOT NULL REFERENCES resources(id),
  seller_id               INTEGER NOT NULL REFERENCES sellers(id),
  ts                      INTEGER NOT NULL,
  wallet                  TEXT,
  client_identity         TEXT,
  x402_version            INTEGER,
  quote_amount_atomic     TEXT,
  quote_asset             TEXT,
  quote_network           TEXT,
  quote_pay_to            TEXT,
  quote_requirements_json TEXT,
  reference_price_atomic  TEXT,
  reference_source        TEXT,
  paid                    INTEGER NOT NULL DEFAULT 0,
  amount_paid_atomic      TEXT,
  request_json            TEXT NOT NULL,
  nonce                   TEXT,
  valid_after             INTEGER,
  valid_before            INTEGER,
  response_status         INTEGER,
  response_headers_json   TEXT,
  response_body           BLOB,
  response_body_sha256    TEXT,
  response_body_bytes     INTEGER,
  response_truncated_by_us INTEGER NOT NULL DEFAULT 0,
  response_incomplete     INTEGER NOT NULL DEFAULT 0,
  settlement_header_json  TEXT,
  settlement_tx_hash      TEXT,
  settlement_block        INTEGER,
  settlement_confirmed_at INTEGER,
  settlement_count        INTEGER NOT NULL DEFAULT 0,
  latency_ms              INTEGER,
  outcome                 TEXT,
  flags_json              TEXT NOT NULL DEFAULT '[]',
  our_error_reason        TEXT,
  classified_at           INTEGER,
  resolve_until           INTEGER,             -- for indeterminate: poll deadline
  error                   TEXT
);
CREATE INDEX IF NOT EXISTS calls_intent ON calls(intent_id);
CREATE INDEX IF NOT EXISTS calls_source_outcome ON calls(source, outcome);
CREATE INDEX IF NOT EXISTS calls_seller ON calls(seller_id);
CREATE INDEX IF NOT EXISTS calls_resource_ts ON calls(resource_id, ts);

CREATE TABLE IF NOT EXISTS validator_results (
  id             INTEGER PRIMARY KEY,
  call_id        INTEGER NOT NULL REFERENCES calls(id),
  validator      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pass','fail','skipped')),
  reason         TEXT,
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  UNIQUE (call_id, validator)
);

-- On-chain (or facilitator-reported) settlements matched to intents.
CREATE TABLE IF NOT EXISTS settlements (
  id            INTEGER PRIMARY KEY,
  call_id       INTEGER REFERENCES calls(id),
  intent_id     TEXT,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER,
  block_number  INTEGER,
  block_ts      INTEGER,
  from_addr     TEXT NOT NULL,
  to_addr       TEXT NOT NULL,
  value_atomic  TEXT NOT NULL,
  nonce         TEXT,
  source        TEXT NOT NULL,                 -- chain|facilitator_header|x402scan
  found_at      INTEGER NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS settlements_intent ON settlements(intent_id);

CREATE TABLE IF NOT EXISTS halts (
  id        INTEGER PRIMARY KEY,
  run_id    INTEGER REFERENCES runs(id),
  ts        INTEGER NOT NULL,
  reason    TEXT NOT NULL,
  details_json TEXT
);

-- ------------------------------------------------------------------- chain
CREATE TABLE IF NOT EXISTS chain_transfers (
  id            INTEGER PRIMARY KEY,
  network       TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  block_ts      INTEGER NOT NULL,
  from_addr     TEXT NOT NULL,
  to_addr       TEXT NOT NULL,
  value_atomic  TEXT NOT NULL,
  nonce         TEXT,                          -- from AuthorizationUsed in the same tx, if any
  via_authorization INTEGER NOT NULL DEFAULT 0,
  UNIQUE (network, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_transfers_to_ts ON chain_transfers(to_addr, block_ts);
CREATE INDEX IF NOT EXISTS chain_transfers_from_to ON chain_transfers(from_addr, to_addr, block_ts);

CREATE TABLE IF NOT EXISTS chain_scan_progress (
  network     TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  from_block  INTEGER NOT NULL,
  to_block    INTEGER NOT NULL,
  PRIMARY KEY (network, to_addr)
);

-- --------------------------------------------------------------- telemetry
CREATE TABLE IF NOT EXISTS telemetry_sources (
  id          INTEGER PRIMARY KEY,
  source_id   TEXT NOT NULL UNIQUE,
  label       TEXT,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_calls (
  id              INTEGER PRIMARY KEY,
  source_id       TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  client_ts       INTEGER,
  resource_hash   TEXT NOT NULL,
  seller_domain   TEXT NOT NULL,
  network         TEXT,
  outcome         TEXT NOT NULL,
  flags_json      TEXT NOT NULL DEFAULT '[]',
  amount_atomic   TEXT,
  latency_ms      INTEGER,
  wallet          TEXT,                        -- only if operator opted in
  client_version  TEXT,
  raw_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_calls_source ON telemetry_calls(source_id, received_at);
