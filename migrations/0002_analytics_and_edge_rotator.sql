-- Track known Pages projects so public server-to-server endpoints only accept
-- events for projects managed by this dashboard.
CREATE TABLE IF NOT EXISTS managed_projects (
  project_name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add an atomic counter for optional round-robin routing.
ALTER TABLE rotator_configs
ADD COLUMN next_index INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('pageview', 'click')),
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  page_title TEXT,
  referrer TEXT,
  target_url TEXT,
  ip_address TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  colo TEXT,
  device_type TEXT,
  browser TEXT,
  operating_system TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analytics_project_created
ON analytics_events(project_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_project_type_created
ON analytics_events(project_name, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_project_visitor
ON analytics_events(project_name, visitor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_project_country
ON analytics_events(project_name, country, created_at DESC);
