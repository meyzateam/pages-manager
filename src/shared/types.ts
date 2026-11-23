export type Project = {
  /** Stable Pages Manager identity; independent from Cloudflare's mutable project name. */
  project_uid?: string;
  name: string;
  subdomain?: string;
  created_on?: string;
  production_branch?: string;
  uses_functions?: boolean;
  manager_worker_installed?: boolean;
  manager_worker_version?: string;
  canonical_deployment?: { id?: string; url?: string; aliases?: string[]; latest_stage?: { status?: string } };
};

export type Deployment = {
  id: string;
  url?: string;
  environment?: string;
  created_on?: string;
  latest_stage?: { status?: string };
  deployment_trigger?: { metadata?: { branch?: string; commit_message?: string } };
  aliases?: string[];
};

export type RotatorTarget = {
  label: string;
  branch: string;
  weight: number;
  enabled: boolean;
  url: string;
  kind?: "branch" | "url";
};

export type RotatorConfig = {
  enabled: boolean;
  mode: "random" | "weighted" | "round-robin";
  targets: RotatorTarget[];
};

export type DailyPoint = { day: string; views: number; visitors: number; clicks: number };
export type RankedItem = { label: string; count: number };
export type RecentEvent = {
  id: number;
  event_type: "pageview" | "click";
  visitor_id: string;
  path: string;
  page_title?: string;
  referrer?: string;
  target_url?: string;
  ip_address?: string;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
  device_type?: string;
  browser?: string;
  operating_system?: string;
  user_agent?: string;
  created_at: string;
};

export type AnalyticsData = {
  days: number;
  summary: { views: number; visitors: number; clicks: number; sessions: number };
  daily: DailyPoint[];
  devices: RankedItem[];
  countries: RankedItem[];
  referrers: RankedItem[];
  recent: RecentEvent[];
};

export type GscProperty = {
  site_url: string;
  verification_file: string;
  verification_status: "pending" | "verified";
  search_console_status?: "not_added" | "added";
  verified_at?: string;
  sitemap_url: string;
  sitemap_status: string;
  sitemap_submitted_at?: string;
};
export type GscStatus = { connected: boolean; google_email?: string; property: GscProperty | null };
export type GscMetricRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };
export type GscPerformance = { days: number; start_date: string; end_date: string; totals: GscMetricRow; queries: GscMetricRow[]; pages: GscMetricRow[] };

export type UploadProgress = {
  phase: "preparing" | "uploading" | "processing" | "verifying";
  percent: number;
  loadedBytes: number;
  totalBytes: number;
  files: number;
  branch: string;
};

export type WebsiteFile = { file: File; path: string };

export type GoogleAccount = {
  google_email: string;
  token_expires_at: number;
  scope_text: string;
  created_at?: string;
  updated_at?: string;
};

export type GscListedProperty = {
  site_url: string;
  permission_level: "siteOwner" | "siteFullUser" | "siteRestrictedUser" | "siteUnverifiedUser" | string;
  property_type: "domain" | "url-prefix";
  linked_project: string;
  verification_status: string;
  search_console_status: string;
  sitemap_url: string;
  sitemap_status: string;
  updated_at: string;
};
