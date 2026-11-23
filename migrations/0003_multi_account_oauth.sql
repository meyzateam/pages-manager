-- Multi-account Cloudflare OAuth sessions and per-account application data.
CREATE TABLE IF NOT EXISTS oauth_sessions (
  session_id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  token_expires_at INTEGER NOT NULL,
  accounts_json TEXT NOT NULL DEFAULT '[]',
  selected_account_id TEXT,
  selected_account_name TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expiry ON oauth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS managed_projects_v2 (
  account_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  site_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, project_name),
  UNIQUE (site_token_hash)
);
CREATE INDEX IF NOT EXISTS idx_managed_projects_token ON managed_projects_v2(project_name, site_token_hash);

CREATE TABLE IF NOT EXISTS rotator_configs_v2 (
  account_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'random',
  targets_json TEXT NOT NULL DEFAULT '[]',
  next_index INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, project_name)
);

ALTER TABLE activity_logs ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_activity_account_created ON activity_logs(account_id, created_at DESC);

ALTER TABLE analytics_events ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_analytics_account_project_created ON analytics_events(account_id, project_name, created_at DESC);



CREATE TABLE IF NOT EXISTS project_inventory_cache (
  account_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  checked_at TEXT NOT NULL
);


-- Short-lived cache for project-name availability checks (per Cloudflare account).
CREATE TABLE IF NOT EXISTS project_name_check_cache (
  account_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  project_exists INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (account_id, project_name)
);
