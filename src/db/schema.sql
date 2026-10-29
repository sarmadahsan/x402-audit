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
  volume_30d_computed_at INTEGER,
  calls_30d_bazaar INTEGER,                -- sum of quality.l30DaysTotalCalls over the seller's resources
  rank_30d         INTEGER,                -- 1 = highest 30-day USDC volume on Base
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
  input_json            TEXT,                    -- bazaar extension input info (method, query/body schema), if any
  transfer_method       TEXT,                    -- eip3009 (default) | permit2 (from accepts[].extra.assetTransferMethod)
  service_name          TEXT,
  tags_json             TEXT,
  curated               INTEGER,
  bazaar_calls_30d      INTEGER,                 -- quality.l30DaysTotalCalls at last discover
  bazaar_unique_payers_30d INTEGER,
  last_called_at        INTEGER,
  accepts_json          TEXT,                    -- every accepts[] entry, not only the selected one
  category              TEXT,
  category_reason       TEXT,                    -- which keyword/tag rule assigned the category
  raw_json              TEXT NOT NULL,
  first_seen_at         INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  UNIQUE (url, method, source)
);
CREATE INDEX IF NOT EXISTS resources_seller ON resources(seller_id);
CREATE INDEX IF NOT EXISTS resources_payto ON resources(pay_to);

-- ------------------------------------------------------------------- probe
-- The fixed set of resources `probe` visits each round. Rebuilt only by `probe plan`.
CREATE TABLE IF NOT EXISTS probe_set (
  id           INTEGER PRIMARY KEY,
  resource_id  INTEGER NOT NULL UNIQUE REFERENCES resources(id),
  stratum      TEXT NOT NULL,                  -- top|tail
  seed         INTEGER NOT NULL,
  selected_at  INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS probes (
  id                 INTEGER PRIMARY KEY,
  run_id             INTEGER REFERENCES runs(id),
  resource_id        INTEGER NOT NULL REFERENCES resources(id),
  client_identity    TEXT NOT NULL,            -- A|B
  round_id           TEXT,                     -- same for both identities in one round
  ts                 INTEGER NOT NULL,
  method             TEXT,
  request_headers_json TEXT,
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
CREATE INDEX IF NOT EXISTS attempts_nonce ON attempts(nonce);
CREATE INDEX IF NOT EXISTS attempts_ts ON attempts(ts);
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
CREATE INDEX IF NOT EXISTS calls_nonce ON calls(nonce);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE INDEX IF NOT EXISTS calls_seller_ts ON calls(seller_id, ts);

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
  via_authorization INTEGER,                   -- NULL = not checked yet; 1 = AuthorizationUsed in same tx; 0 = plain transfer
  UNIQUE (network, tx_hash, log_index)
);

-- Per pay-to aggregates over a scanned window (what ranks sellers). Raw rows are in chain_transfers.
CREATE TABLE IF NOT EXISTS payto_volume (
  id              INTEGER PRIMARY KEY,
  network         TEXT NOT NULL,
  pay_to          TEXT NOT NULL,
  from_block      INTEGER NOT NULL,
  to_block        INTEGER NOT NULL,
  from_ts         INTEGER NOT NULL,
  to_ts           INTEGER NOT NULL,
  transfer_count  INTEGER NOT NULL,
  sum_atomic      TEXT NOT NULL,
  dust_count      INTEGER NOT NULL,            -- transfers below the dust floor, excluded from sum/count
  dust_floor_atomic TEXT NOT NULL,
  unique_payers   INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL,
  UNIQUE (network, pay_to, from_block, to_block)
);
CREATE INDEX IF NOT EXISTS chain_transfers_to_ts ON chain_transfers(to_addr, block_ts);
CREATE INDEX IF NOT EXISTS chain_transfers_from_to ON chain_transfers(from_addr, to_addr, block_ts);
-- Covering index for the proxy report's window functions (partition by to/from/value, order by block_ts).
CREATE INDEX IF NOT EXISTS chain_transfers_proxy ON chain_transfers(network, to_addr, from_addr, value_atomic, block_ts, via_authorization);

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

-- Audit trail for re-running validators/classification on stored rows (buy reclassify).
CREATE TABLE IF NOT EXISTS reclassifications (
  id            INTEGER PRIMARY KEY,
  call_id       INTEGER NOT NULL REFERENCES calls(id),
  ts            INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  old_outcome   TEXT,
  new_outcome   TEXT,
  old_flags_json TEXT,
  new_flags_json TEXT,
  code_commit   TEXT
);

-- ------------------------------------------------------------------ audits
-- Every audit-trigger decision with its inputs, written BEFORE any audit spend (docs/PLAN.md "Audits").
CREATE TABLE IF NOT EXISTS audit_triggers (
  id              INTEGER PRIMARY KEY,
  evaluated_at    INTEGER NOT NULL,
  run_id          INTEGER REFERENCES runs(id),
  host            TEXT NOT NULL,
  seller_id       INTEGER REFERENCES sellers(id),
  reasons_json    TEXT NOT NULL,                -- every condition that held: disagreement|thin_measured|reported_above_ok|demand
  source          TEXT NOT NULL,                -- audit_disagreement|audit_demand
  priority        INTEGER NOT NULL,             -- 0 first
  inputs_json     TEXT NOT NULL,                -- reported, measured and demand figures the decision used
  decision        TEXT NOT NULL,                -- planned|dry_run|disabled|refused
  decision_reason TEXT,
  planned_calls   INTEGER NOT NULL DEFAULT 0,
  planned_atomic  TEXT NOT NULL DEFAULT '0'
);
CREATE INDEX IF NOT EXISTS audit_triggers_ts ON audit_triggers(evaluated_at);

-- One row per completed audit (the result posted back to the index).
CREATE TABLE IF NOT EXISTS audit_results (
  id            INTEGER PRIMARY KEY,
  trigger_id    INTEGER NOT NULL REFERENCES audit_triggers(id),
  run_id        INTEGER REFERENCES runs(id),
  host          TEXT NOT NULL,
  source        TEXT NOT NULL,
  finished_at   INTEGER NOT NULL,
  calls         INTEGER NOT NULL,              -- paid-denominator calls in this audit
  failures      INTEGER NOT NULL,
  rate          REAL,
  wilson_low    REAL,
  wilson_high   REAL,
  post_status   TEXT,                          -- posted|skipped_no_secret|failed:<status>
  posted_at     INTEGER
);

-- -------------------------------------------------------------- candidates
-- Resources users checked or paid that we had never measured (index GET /v1/candidates), and what probing found.
CREATE TABLE IF NOT EXISTS candidates (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,          -- scheme, host, path; never a query string
  host          TEXT NOT NULL,
  checks        INTEGER NOT NULL DEFAULT 0,
  payments      INTEGER NOT NULL DEFAULT 0,
  first_seen    TEXT,
  last_seen     TEXT,
  imported_at   INTEGER NOT NULL,
  seller_id     INTEGER REFERENCES sellers(id),
  resource_id   INTEGER REFERENCES resources(id),
  seller_new    INTEGER NOT NULL DEFAULT 0,    -- 1 = the seller entered the database through this import
  state         TEXT,                          -- NULL until probed; queued|too_expensive|not_x402|measuring
  quoted_atomic TEXT,
  probed_at     INTEGER,
  note          TEXT
);

-- Resources that quote above their applicable per-call cap: recorded and exported, never bought, never silently skipped.
CREATE TABLE IF NOT EXISTS resource_states (
  resource_id   INTEGER PRIMARY KEY REFERENCES resources(id),
  state         TEXT NOT NULL,                 -- too_expensive
  quoted_atomic TEXT,
  cap_atomic    TEXT,
  basis         TEXT,                          -- probe|declared|quote
  updated_at    INTEGER NOT NULL
);
