-- Stable internal project identities. Cloudflare account + project name remain
-- the compatibility key for existing APIs and stored data; the UUID is the
-- permanent dashboard identity used by routes and cross-module navigation.
CREATE TABLE IF NOT EXISTS project_registry (
  project_uid TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, project_name)
);

CREATE INDEX IF NOT EXISTS idx_project_registry_account
ON project_registry(account_id, project_name);

-- Preserve the originating project route across the Google OAuth round-trip.
ALTER TABLE google_oauth_states ADD COLUMN return_path TEXT NOT NULL DEFAULT '/app/overview';
