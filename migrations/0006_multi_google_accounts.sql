-- Support multiple Google identities per Pages Manager user while preserving
-- existing OAuth credentials and all previously registered Search Console properties.
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id TEXT NOT NULL,
  google_email TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  scope_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, google_email)
);
CREATE INDEX IF NOT EXISTS idx_google_accounts_user_updated
  ON google_accounts(user_id, updated_at DESC);

INSERT OR IGNORE INTO google_accounts(
  user_id, google_email, access_token_ciphertext, refresh_token_ciphertext,
  token_expires_at, scope_text, created_at, updated_at
)
SELECT user_id, google_email, access_token_ciphertext, refresh_token_ciphertext,
  token_expires_at, scope_text, created_at, updated_at
FROM google_connections;

CREATE TABLE IF NOT EXISTS google_account_preferences (
  user_id TEXT PRIMARY KEY,
  selected_google_email TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO google_account_preferences(user_id, selected_google_email)
SELECT user_id, google_email FROM google_connections;
