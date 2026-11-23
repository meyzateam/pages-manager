export type WorkspaceTab = "overview" | "project" | "rotator" | "analytics" | "google" | "googleProperties" | "settings";

export type AppRoute = {
  tab: WorkspaceTab;
  projectKey: string;
  isLogin: boolean;
};

export function parseAppRoute(pathname: string): AppRoute {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/login") return { tab: "overview", projectKey: "", isLogin: true };
  if (path === "/app/settings") return { tab: "settings", projectKey: "", isLogin: false };
  if (path === "/app/google-search") return { tab: "googleProperties", projectKey: "", isLogin: false };
  if (path === "/" || path === "/app" || path === "/app/overview") {
    return { tab: "overview", projectKey: "", isLogin: false };
  }
  const match = path.match(/^\/app\/projects\/([^/]+)\/(deployments|rotator|analytics|google-search)$/);
  if (match) {
    let projectKey = match[1];
    try { projectKey = decodeURIComponent(projectKey); } catch { /* Keep raw route key for a clear not-found result. */ }
    const tab: WorkspaceTab = match[2] === "deployments" ? "project"
      : match[2] === "google-search" ? "google" : match[2] as WorkspaceTab;
    return { tab, projectKey, isLogin: false };
  }
  return { tab: "overview", projectKey: "", isLogin: false };
}

export function pathForTab(tab: WorkspaceTab, projectKey = "") {
  if (tab === "settings") return "/app/settings";
  if (tab === "googleProperties") return "/app/google-search";
  if (tab === "overview" || !projectKey) return "/app/overview";
  const section = tab === "project" ? "deployments" : tab === "google" ? "google-search" : tab;
  return `/app/projects/${encodeURIComponent(projectKey)}/${section}`;
}

export function writeAppPath(path: string, replace = false) {
  if (window.location.pathname === path && !window.location.search) return;
  if (replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
}
