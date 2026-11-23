-- Google OAuth connection and Search Console properties, isolated per Cloudflare user/account.
CREATE TABLE IF NOT EXISTS google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_id_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_states_expiry ON google_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS google_connections (
  user_id TEXT PRIMARY KEY,
  google_email TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  scope_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gsc_properties (
  account_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  google_email TEXT NOT NULL DEFAULT '',
  site_url TEXT NOT NULL,
  verification_file TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  search_console_status TEXT NOT NULL DEFAULT 'not_added',
  search_console_added_at TEXT,
  verified_at TEXT,
  sitemap_url TEXT NOT NULL,
  sitemap_status TEXT NOT NULL DEFAULT 'not_submitted',
  sitemap_submitted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, project_name, user_id, site_url)
);
CREATE INDEX IF NOT EXISTS idx_gsc_properties_user ON gsc_properties(user_id, updated_at DESC);
