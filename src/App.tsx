import { useEffect, useMemo, useState } from "react";
import { api, uploadApi } from "./shared/api";
import { formatBytes, formatDate, formatDateTime, formatNumber } from "./shared/format";
import { branchUrl, deploymentStatus, normalizeUrl, projectUrl, randomBranchName } from "./shared/project-utils";
import {
  Activity, ArrowLeft, ArrowUpRight, BarChart3, Check, ChevronRight, Cloud,
  Code2, Copy, Database, ExternalLink, Eye, FileCode2, Globe, GripVertical, History,
  LayoutDashboard, Link2, LoaderCircle, Moon, Plus, RefreshCw, Search,
  Settings, ShieldCheck, Sun, Trash2, Upload, Users, X, Zap, List, LayoutGrid, FolderOpen, FileUp, ChevronLeft
} from "lucide-react";
import type { AnalyticsData, Deployment, GoogleAccount, GscListedProperty, GscPerformance, GscStatus, Project, RotatorConfig, RotatorTarget, UploadProgress, WebsiteFile } from "./shared/types";
import { parseAppRoute, pathForTab, writeAppPath, type WorkspaceTab } from "./app/routes";
import { computeWebsiteHashes, createSeoIndexFile, FileDropzone, WebsiteSeoAudit } from "./pages/cloudflare/deployments/UploadComponents";
import { AnalyticsPanel, StatCard } from "./pages/cloudflare/analytics/AnalyticsPanel";
import { GoogleSearchPanel } from "./pages/google-search/GoogleSearchPanel";
import { GooglePropertiesPage } from "./pages/google-search/GooglePropertiesPage";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { DeploymentsPanel } from "./pages/cloudflare/deployments/DeploymentsPanel";
import { RotatorPanel } from "./pages/cloudflare/rotator/RotatorPanel";


type DeploymentState = "success" | "failed" | "building" | "not_deployed";

function getDeploymentState(project: Project): DeploymentState {
  const status = deploymentStatus(project.canonical_deployment);
  if (status === "success") return "success";
  if (["failure", "failed", "canceled", "cancelled"].includes(status)) return "failed";
  if (["queued", "initializing", "building", "running", "uploading", "processing"].includes(status)) return "building";
  return "not_deployed";
}

function deploymentPillClass(status: DeploymentState) {
  return status === "success" ? "online" : status === "failed" ? "offline" : status === "building" ? "checking" : "not_checked";
}

function deploymentLabel(status: DeploymentState) {
  return status === "success" ? "Success" : status === "failed" ? "Failed" : status === "building" ? "Building" : "No deployment";
}

function supportsGoogleVerificationWorker(version?: string) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 7 || (minor === 7 && patch >= 0)));
}


const emptyAnalytics: AnalyticsData = {
  days: 30,
  summary: { views: 0, visitors: 0, clicks: 0, sessions: 0 },
  daily: [], devices: [], countries: [], referrers: [], recent: []
};

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null>(null);
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [pendingAccountId, setPendingAccountId] = useState("");
  const [selectedAccountName, setSelectedAccountName] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [tokenLoginBusy, setTokenLoginBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const initialRoute = parseAppRoute(window.location.pathname);
  const [tab, setTabState] = useState<WorkspaceTab>(initialRoute.tab);
  const [routeProjectKey, setRouteProjectKey] = useState(initialRoute.projectKey);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const setTab = (nextTab: WorkspaceTab, projectNameOverride?: string, replace = false) => {
    if (["overview", "settings", "googleProperties"].includes(nextTab)) {
      setSelected("");
      setRouteProjectKey("");
      setTabState(nextTab);
      writeAppPath(pathForTab(nextTab), replace);
      return;
    }
    const projectName = projectNameOverride ?? selected;
    if (!projectName) {
      setSelected("");
      setRouteProjectKey("");
      setTabState("overview");
      writeAppPath(pathForTab("overview"), replace);
      return;
    }
    const project = projects.find((item) => item.name === projectName);
    const projectKey = project?.project_uid || projectName;
    setSelected(projectName);
    setRouteProjectKey(projectKey);
    setTabState(nextTab);
    writeAppPath(pathForTab(nextTab, projectKey), replace);
  };
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createFiles, setCreateFiles] = useState<WebsiteFile[] | null>(null);
  const [nameCheck, setNameCheck] = useState<"idle" | "checking" | "available" | "taken" | "invalid" | "error">("idle");
  const [nameCheckMessage, setNameCheckMessage] = useState("");
  const [files, setFiles] = useState<WebsiteFile[] | null>(null);
  const [branch, setBranch] = useState("main");
  const [replaceFunctions, setReplaceFunctions] = useState(false);
  const [message, setMessage] = useState("Deploy from Pages Manager");
  const [edgeBranch, setEdgeBranch] = useState("");
  const [edgeFiles, setEdgeFiles] = useState<WebsiteFile[] | null>(null);
  const [rotator, setRotator] = useState<RotatorConfig>({ enabled: false, mode: "random", targets: [] });
  const [directTargetUrl, setDirectTargetUrl] = useState("");
  const [directTargetLabel, setDirectTargetLabel] = useState("");
  const [analytics, setAnalytics] = useState<AnalyticsData>(emptyAnalytics);
  const [gscStatus, setGscStatus] = useState<GscStatus>({ connected: false, property: null });
  const [googleAccounts, setGoogleAccounts] = useState<GoogleAccount[]>([]);
  const [selectedGoogleEmail, setSelectedGoogleEmail] = useState("");
  const [googleProperties, setGoogleProperties] = useState<GscListedProperty[]>([]);
  const [autoAddGsc, setAutoAddGsc] = useState(() => localStorage.getItem("pm_auto_add_gsc") !== "false");
  const [gscPerformance, setGscPerformance] = useState<GscPerformance | null>(null);
  const [gscInspectionUrl, setGscInspectionUrl] = useState("");
  const [gscInspection, setGscInspection] = useState<any>(null);
  const [analyticsDays, setAnalyticsDays] = useState(30);
  const [projectPageSize, setProjectPageSize] = useState<10 | 50 | 100 | "all">(10);
  const [projectPage, setProjectPage] = useState(1);
  const [projectView, setProjectView] = useState<"cards" | "list">("cards");
  const [projectSort, setProjectSort] = useState<"default" | "alphabetical" | "created" | "status">("default");
  const [projectSortDirection, setProjectSortDirection] = useState<"default" | "asc" | "desc">("default");
  const [recentPageSize, setRecentPageSize] = useState<10 | 50 | 100 | "all">(10);
  const [recentPage, setRecentPage] = useState(1);
  const [draggingTargetIndex, setDraggingTargetIndex] = useState<number | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("pm_sidebar_collapsed") === "true");

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("oauth_error");
    const googleOauthError = params.get("google_oauth_error");
    const googleOauth = params.get("google_oauth");
    if (oauthError && active) setError(oauthError);
    if (googleOauthError && active) setError(googleOauthError);
    if (googleOauth === "connected" && active) setNotice("Akun Google berhasil dihubungkan.");
    if ((oauthError || googleOauthError || googleOauth) && active) window.history.replaceState({}, "", window.location.pathname);
    void api("auth/check")
      .then((result) => {
        if (!active) return;
        setAuthed(true);
        setAuthUser(result.user || null);
        setAccounts(Array.isArray(result.accounts) ? result.accounts : []);
        setSelectedAccountId(result.selected_account_id || "");
        setSelectedAccountName(result.selected_account_name || "");
      })
      .catch(() => { if (active) { setAuthed(false); setAuthUser(null); setAccounts([]); setSelectedAccountId(""); setPendingAccountId(""); } })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("pm_theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem("pm_sidebar_collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pm_theme", theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem("pm_auto_add_gsc", autoAddGsc ? "true" : "false"); }, [autoAddGsc]);

  useEffect(() => {
    if (!showCreate) return;
    const candidate = newName.trim().toLowerCase();
    if (!candidate) {
      setNameCheck("idle");
      setNameCheckMessage("Masukkan nama project untuk memeriksa ketersediaan.");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(candidate)) {
      setNameCheck("invalid");
      setNameCheckMessage("Gunakan 1–32 karakter: huruf kecil, angka, dan tanda hubung; karakter pertama harus huruf/angka.");
      return;
    }
    setNameCheck("checking");
    setNameCheckMessage("Memeriksa nama pada akun Cloudflare…");
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api(`project-name-check?name=${encodeURIComponent(candidate)}`, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          setNameCheck(result.available ? "available" : "taken");
          setNameCheckMessage(result.message || (result.available ? "Nama tersedia." : "Nama sudah digunakan."));
        })
        .catch((caught: any) => {
          if (cancelled || controller.signal.aborted) return;
          setNameCheck("error");
          setNameCheckMessage(caught?.message || "Gagal memeriksa nama project.");
        });
    }, 1100);
    return () => { cancelled = true; window.clearTimeout(timer); controller.abort(); };
  }, [newName, showCreate, selectedAccountId]);

  const filteredProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    // Cloudflare's API order is preserved when Sort is set to Default.
    const filtered = keyword ? projects.filter((project) => project.name.toLowerCase().includes(keyword)) : [...projects];
    if (projectSort === "default") return filtered;

    const direction = projectSortDirection === "default"
      ? (projectSort === "created" ? "desc" : "asc")
      : projectSortDirection;
    const statusRank = (project: Project) => {
      const status = getDeploymentState(project);
      return status === "success" ? 0 : status === "building" ? 1 : status === "failed" ? 2 : 3;
    };

    filtered.sort((a, b) => {
      let comparison = 0;
      if (projectSort === "alphabetical") {
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      } else if (projectSort === "created") {
        const aTime = a.created_on ? new Date(a.created_on).getTime() : Number.NaN;
        const bTime = b.created_on ? new Date(b.created_on).getTime() : Number.NaN;
        // Keep projects with an unknown creation date at the bottom in either direction.
        if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) comparison = 0;
        else if (!Number.isFinite(aTime)) return 1;
        else if (!Number.isFinite(bTime)) return -1;
        else comparison = aTime - bTime;
      } else if (projectSort === "status") {
        comparison = statusRank(a) - statusRank(b);
      }
      return direction === "asc" ? comparison : -comparison;
    });
    return filtered;
  }, [projects, search, projectSort, projectSortDirection]);

  const projectPageCount = projectPageSize === "all"
    ? 1
    : Math.max(1, Math.ceil(filteredProjects.length / projectPageSize));
  const visibleProjects = useMemo(() => {
    if (projectPageSize === "all") return filteredProjects;
    const start = (projectPage - 1) * projectPageSize;
    return filteredProjects.slice(start, start + projectPageSize);
  }, [filteredProjects, projectPage, projectPageSize]);

  useEffect(() => { setProjectPage(1); }, [search, projectPageSize, projectSort, projectSortDirection]);
  useEffect(() => { setRecentPage(1); }, [analyticsDays, selected, analytics.recent.length, recentPageSize]);
  useEffect(() => { if (recentPage > (recentPageSize === "all" ? 1 : Math.max(1, Math.ceil(analytics.recent.length / recentPageSize)))) setRecentPage(1); }, [recentPage, recentPageSize, analytics.recent.length]);
  useEffect(() => {
    if (projectPage > projectPageCount) setProjectPage(projectPageCount);
  }, [projectPage, projectPageCount]);

  // Project status is derived from Cloudflare Pages deployment metadata already
  // present in the inventory response. Never probe *.pages.dev automatically:
  // a HEAD/GET request can invoke each site's Pages Worker and consume quota.

  const loadProjects = async (showLoader = true, forceRefresh = false): Promise<Project[]> => {
    if (showLoader) setBusy(true);
    setError("");
    try {
      const result = await api(`projects${forceRefresh ? "?force=1" : ""}`);
      const nextProjects = Array.isArray(result.projects) ? result.projects : [];
      setProjects(nextProjects);
      if (selected && !nextProjects.some((item: Project) => item.name === selected)) {
        setTab("overview");
      }
      return nextProjects;
    } catch (caught: any) {
      setError(caught?.message || "Gagal memuat project.");
      if (caught?.status === 401) {
        setAuthed(false);
        setAuthUser(null);
        setAccounts([]);
        setSelectedAccountId("");
        setPendingAccountId("");
        setGoogleAccounts([]);
        setSelectedGoogleEmail("");
        setGoogleProperties([]);
        setGscStatus({ connected: false, property: null });
      }
      return [];
    } finally {
      if (showLoader) setBusy(false);
    }
  };

  const loadProjectData = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      const [deployResult, rotatorResult] = await Promise.all([
        api(`projects/${encodeURIComponent(name)}/deployments`, {}),
        api(`projects/${encodeURIComponent(name)}/rotator`, {})
      ]);
      setDeployments(Array.isArray(deployResult.deployments) ? deployResult.deployments : []);
      setRotator(rotatorResult.config || { enabled: false, mode: "random", targets: [] });
    } catch (caught: any) {
      setError(caught?.message || "Gagal memuat detail project.");
    } finally {
      setBusy(false);
    }
  };

  const loadGscStatus = async (name = selected) => {
    if (!name) return;
    const result = await api(`google/status?project=${encodeURIComponent(name)}`);
    setGscStatus({ connected: Boolean(result.connected), google_email: result.google_email || "", property: result.property || null });
    if (result.property?.site_url) setGscInspectionUrl(`${result.property.site_url}`);
    return result;
  };

  const loadGoogleAccounts = async () => {
    const result = await api("google/accounts");
    setGoogleAccounts(Array.isArray(result.accounts) ? result.accounts : []);
    setSelectedGoogleEmail(String(result.selected_google_email || ""));
    return result;
  };

  const loadGoogleProperties = async () => {
    const result = await api("google/properties");
    setGoogleProperties(Array.isArray(result.properties) ? result.properties : []);
    return result;
  };

  const connectGoogle = () => {
    const current = window.location.pathname;
    const returnTo = current.startsWith("/app/") ? current : "/app/settings";
    window.location.href = `/api/google/connect?return_to=${encodeURIComponent(returnTo)}`;
  };

  const changeGoogleAccount = (email: string) => run(async () => {
    if (!email || email === selectedGoogleEmail) return;
    await api("google/select-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ google_email: email }) });
    setSelectedGoogleEmail(email);
    setGscPerformance(null);
    setGscInspection(null);
    await Promise.all([loadGoogleProperties(), selected ? loadGscStatus(selected) : Promise.resolve()]);
    setNotice(`Akun Google aktif diubah ke ${email}.`);
  });

  const disconnectGoogle = async () => run(async () => {
    const result = await api("google/disconnect", { method: "POST" });
    await loadGoogleAccounts();
    setGscPerformance(null);
    setGscInspection(null);
    if (selected) await loadGscStatus(selected);
    setNotice(result.selected_google_email
      ? `Akun Google sebelumnya diputus. Akun aktif sekarang ${result.selected_google_email}.`
      : "Akun Google diputus dari Pages Manager. Property yang sudah terdaftar tetap berada di akun Google.");
  });

  const prepareGscProperty = async () => run(async () => {
    const result = await api("google/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: selected }) });
    setNotice(result.already_registered
      ? "Property sudah ada di akun Google ini. Pages Manager melewati verifikasi ulang dan siap mengirim sitemap."
      : `Token verifikasi Google disiapkan: ${result.verification_file}.`);
    await loadGscStatus(selected);
  });

  const verifyGscProperty = async () => run(async () => {
    const result = await api("google/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: selected }) });
    if (!result.property_added) {
      setNotice(`Kepemilikan terverifikasi, tetapi property belum tersinkron ke Search Console: ${result.property_warning || "coba ulangi sinkronisasi"}`);
    } else if (result.sitemap_submitted) {
      setNotice("Property terverifikasi, terdaftar di Search Console, dan sitemap berhasil dikirim.");
    } else {
      setNotice(`Property sudah terdaftar. Sitemap belum berhasil dikirim: ${result.sitemap_warning || "coba kirim ulang"}`);
    }
    await loadGscStatus(selected);
  });

  const submitGscSitemap = async () => run(async () => {
    const result = await api("google/sitemap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: selected }) });
    setNotice(`Sitemap dikirim ke Google: ${result.sitemap_url}`);
    await loadGscStatus(selected);
  });

  const loadGscPerformance = async () => run(async () => {
    const result = await api(`google/performance?project=${encodeURIComponent(selected)}&days=28`);
    setGscPerformance(result);
  });

  const inspectGscUrl = async () => run(async () => {
    const result = await api("google/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: selected, url: gscInspectionUrl }) });
    setGscInspection(result.inspection || null);
  });

  const loadAnalytics = async (name = selected, days = analyticsDays) => {
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(`projects/${encodeURIComponent(name)}/analytics?days=${days}`, {});
      setAnalytics({ ...emptyAnalytics, ...result, summary: { ...emptyAnalytics.summary, ...(result.summary || {}) } });
    } catch (caught: any) {
      setError(caught?.message || "Gagal memuat analytics.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!authed || !selectedAccountId) return;
    setProjects([]);
    const parsedRoute = parseAppRoute(window.location.pathname);
    // Keep the originally requested deep link while an unauthenticated visitor
    // is temporarily shown the /login screen.
    const requestedRoute = parsedRoute.isLogin && routeProjectKey
      ? { ...parsedRoute, tab, projectKey: routeProjectKey, isLogin: false }
      : parsedRoute;
    setTabState(requestedRoute.tab);
    setRouteProjectKey(requestedRoute.projectKey);
    void (async () => {
      const inventory = await loadProjects();
      if (!authed) return;
      if (requestedRoute.projectKey) {
        const match = inventory.find((item) => item.project_uid === requestedRoute.projectKey || item.name === requestedRoute.projectKey);
        if (!match) {
          setSelected("");
          setTab("overview", undefined, true);
          if (inventory.length) setNotice("Project pada URL tidak ditemukan di akun Cloudflare yang sedang dipilih.");
          return;
        }
        setSelected(match.name);
        setBranch(String(match.production_branch || "main").toLowerCase());
        setRouteProjectKey(match.project_uid || match.name);
        setTabState(requestedRoute.tab);
        writeAppPath(pathForTab(requestedRoute.tab, match.project_uid || match.name), true);
        if (requestedRoute.tab !== "overview") {
          await loadProjectData(match.name);
          if (requestedRoute.tab === "analytics") await loadAnalytics(match.name, analyticsDays);
          if (requestedRoute.tab === "google") {
            try { await loadGscStatus(match.name); }
            catch (caught: any) { setError(caught?.message || "Gagal memuat Google Search Console."); }
          }
        }
      } else {
        setSelected("");
        setTabState(requestedRoute.tab);
        writeAppPath(pathForTab(requestedRoute.tab), true);
        if (requestedRoute.tab === "googleProperties") {
          try { await loadGoogleProperties(); } catch (caught: any) { setError(caught?.message || "Gagal memuat property Google."); }
        }
      }
    })();
    // Bootstrap only when the authenticated Cloudflare account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, selectedAccountId]);

  useEffect(() => {
    if (!authed || !selectedAccountId) return;
    void loadGoogleAccounts().catch((caught: any) => setError(caught?.message || "Gagal memuat akun Google."));
  }, [authed, selectedAccountId]);

  useEffect(() => {
    if (!authed || !selectedAccountId || !["overview", "googleProperties"].includes(tab)) return;
    void loadGoogleProperties().catch((caught: any) => setError(caught?.message || "Gagal memuat daftar property Google."));
  }, [authed, selectedAccountId, selectedGoogleEmail, tab]);

  // Keep URLs canonical as soon as the account-scoped project inventory returns UUIDs.
  useEffect(() => {
    if (!selected || ["overview", "settings", "googleProperties"].includes(tab)) return;
    const project = projects.find((item) => item.name === selected);
    if (!project?.project_uid) return;
    const current = parseAppRoute(window.location.pathname);
    if (current.projectKey !== project.project_uid) {
      const path = pathForTab(tab, project.project_uid);
      writeAppPath(path, true);
      setRouteProjectKey(project.project_uid);
    }
  }, [projects, selected, tab]);

  // Browser Back/Forward restores the correct project module without a full reload.
  useEffect(() => {
    const handlePopState = () => {
      if (!authed) return;
      const route = parseAppRoute(window.location.pathname);
      setTabState(route.tab);
      setRouteProjectKey(route.projectKey);
      if (!route.projectKey) {
        setSelected("");
        if (route.tab === "googleProperties") void loadGoogleProperties().catch((caught: any) => setError(caught?.message || "Gagal memuat daftar property Google."));
        if (route.tab === "settings") void loadGoogleAccounts().catch((caught: any) => setError(caught?.message || "Gagal memuat akun Google."));
        return;
      }
      const project = projects.find((item) => item.project_uid === route.projectKey || item.name === route.projectKey);
      if (!project) {
        setSelected("");
        setTab("overview", undefined, true);
        return;
      }
      setSelected(project.name);
      setBranch(String(project.production_branch || "main").toLowerCase());
      void loadProjectData(project.name);
      if (route.tab === "analytics") void loadAnalytics(project.name, analyticsDays);
      if (route.tab === "google") void loadGscStatus(project.name).catch((caught: any) => setError(caught?.message || "Gagal memuat Google Search Console."));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [authed, projects, analyticsDays]);

  useEffect(() => {
    if (!checkingSession && !authed && window.location.pathname !== "/login") {
      writeAppPath("/login", true);
    }
  }, [authed, checkingSession]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (caught: any) {
      setError(caught?.message || "Terjadi kesalahan.");
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  const sendDeployment = async (
    projectName: string,
    selectedFiles: WebsiteFile[],
    deployBranch: string,
    commitMessage = "Deploy from Pages Manager",
    allowReplacingFunctions = false
  ) => {
    // The private route index powers generated sitemap.xml and AMP/canonical pairing.
    // It is hashed in the browser with the same BLAKE3 pipeline as every other asset.
    const selectedItems = [...selectedFiles, await createSeoIndexFile(selectedFiles)];
    const totalBytes = selectedItems.reduce((sum, item) => sum + item.file.size, 0);
    if (totalBytes > 90 * 1024 * 1024) throw new Error("Ukuran file ditambah indeks SEO internal melebihi batas 90 MiB. Kurangi ukuran file website sedikit lalu coba lagi.");
    setUploadProgress({ phase: "preparing", percent: 0, loadedBytes: 0, totalBytes, files: selectedFiles.length, branch: deployBranch });
    // BLAKE3 hashing runs in the user's browser, not inside the Pages Function.
    // This keeps CPU-heavy file processing away from the Cloudflare Worker budget.
    const hashes = await computeWebsiteHashes(selectedItems, (processedFiles, totalFiles, processedBytes, bytesTotal) => {
      setUploadProgress((current) => current ? {
        ...current,
        phase: "preparing",
        percent: totalFiles ? Math.round((processedFiles / totalFiles) * 100) : 100,
        loadedBytes: Math.min(processedBytes, bytesTotal)
      } : current);
    });
    const form = new FormData();
    form.set("branch", deployBranch);
    form.set("message", commitMessage);
    form.set("replace_functions", allowReplacingFunctions ? "true" : "false");
    form.set("_pm_hash_manifest", JSON.stringify(hashes));
    selectedItems.forEach(({ file, path }) => form.append("files", file, path));
    setUploadProgress({ phase: "uploading", percent: 0, loadedBytes: 0, totalBytes, files: selectedFiles.length, branch: deployBranch });
    const result = await uploadApi(`projects/${encodeURIComponent(projectName)}/deploy`, form, totalBytes, (loaded, total, complete) => {
      setUploadProgress((current) => current ? {
        ...current,
        phase: complete ? "processing" : "uploading",
        percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
        loadedBytes: Math.min(loaded, totalBytes || loaded),
      } : current);
    });
    setUploadProgress((current) => current ? { ...current, phase: "processing", percent: 100, loadedBytes: totalBytes } : current);
    return result;
  };

  const waitForDeployment = async (projectName: string, deploymentId?: string, expectedBranch?: string, startedAtMs = Date.now()) => {
    setUploadProgress((current) => current ? { ...current, phase: "verifying", percent: 0 } : current);
    // Poll the exact deployment with bounded exponential backoff. At most twelve
    // Cloudflare status requests are made over ~165 seconds; never probe pages.dev.
    const delays = [2000, 3000, 5000, 8000, 12000, 15000, 20000, 20000, 20000, 20000, 20000, 20000];
    let resolvedDeploymentId = deploymentId || "";
    const branchName = expectedBranch || "main";
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, delays[attempt]));
      setUploadProgress((current) => current ? { ...current, phase: "verifying", percent: Math.min(96, Math.round(((attempt + 1) / delays.length) * 96)) } : current);

      // Rare fallback: if Cloudflare accepted the upload but omitted its ID in
      // the create response, resolve the newest deployment for the target branch.
      if (!resolvedDeploymentId) {
        const list = await api(`projects/${encodeURIComponent(projectName)}/deployments`, {});
        const candidates = Array.isArray(list.deployments) ? list.deployments : [];
        const match = candidates.find((item: any) => {
          const metadataBranch = String(item?.deployment_trigger?.metadata?.branch || "").toLowerCase();
          const environment = String(item?.environment || "").toLowerCase();
          const branchMatches = metadataBranch === branchName.toLowerCase() || (!metadataBranch && environment === "production" && branchName.toLowerCase() === "main");
          const createdAt = Date.parse(String(item?.created_on || ""));
          return branchMatches && Boolean(item?.id) && Number.isFinite(createdAt) && createdAt >= startedAtMs - 60000;
        });
        resolvedDeploymentId = String(match?.id || "");
        if (!resolvedDeploymentId) continue;
      }

      let result: any;
      try {
        result = await api(`projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(resolvedDeploymentId)}`, {});
      } catch (caught: any) {
        // Cloudflare may briefly return 404 while the deployment record is
        // propagating. Treat only this transient state as pending.
        if (caught?.status === 404 || caught?.status === 409) continue;
        throw caught;
      }
      const deployment = result.deployment;
      const status = deploymentStatus(deployment);
      if (status === "success") {
        setUploadProgress((current) => current ? { ...current, phase: "verifying", percent: 100 } : current);
        return "success" as const;
      }
      if (["failure", "failed", "canceled", "cancelled"].includes(status)) {
        throw new Error(`Cloudflare melaporkan deployment ${status}. Periksa detail deployment di dashboard Cloudflare.`);
      }
    }
    return "pending" as const;
  };

  type AutoGscPreparation = { state: "disabled" | "preview" | "not_connected" | "prepared" | "failed"; message?: string };

  const prepareAutoGsc = async (projectName: string, deployBranch: string, productionBranch = "main"): Promise<AutoGscPreparation> => {
    if (!autoAddGsc) return { state: "disabled" };
    if (deployBranch !== productionBranch) return { state: "preview", message: "Auto-add Google dilewati karena deployment bukan production branch." };
    try {
      const accountsResult = await api("google/accounts");
      if (!accountsResult.selected_google_email) return { state: "not_connected", message: "Google Search Console belum terhubung. Deploy tetap berjalan; hubungkan akun Google di Settings untuk mendaftarkan property." };
      await api("google/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: projectName }) });
      return { state: "prepared" };
    } catch (caught: any) {
      return { state: "failed", message: caught?.message || "Persiapan Google Search Console gagal." };
    }
  };

  const finishAutoGsc = async (projectName: string, preparation: AutoGscPreparation) => {
    if (preparation.state === "disabled") return "Google property tidak ditambahkan karena opsi dimatikan.";
    if (preparation.state !== "prepared") return preparation.message || "Google property belum diproses otomatis.";
    try {
      const result = await api("google/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_name: projectName }) });
      await loadGoogleAccounts();
      await loadGoogleProperties();
      if (selected === projectName) await loadGscStatus(projectName);
      if (result.property_added && result.sitemap_submitted) return "Google Search Console: property terdaftar dan sitemap berhasil dikirim.";
      if (result.property_added) return `Google Search Console: property sudah terdaftar, tetapi sitemap belum terkirim (${result.sitemap_warning || "coba submit ulang"}).`;
      return `Google Search Console: verifikasi selesai, tetapi pendaftaran property gagal (${result.property_warning || "coba ulang dari Google Search"}).`;
    } catch (caught: any) {
      return `Website berhasil di-deploy, tetapi verifikasi Google belum selesai: ${caught?.message || "coba ulang dari Google Search"}.`;
    }
  };

  const loginWithApiToken = async () => {
    if (!apiTokenInput.trim() || tokenLoginBusy) return;
    setTokenLoginBusy(true);
    setError("");
    try {
      const result = await api("auth/token-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: apiTokenInput.trim() })
      });
      setAuthed(true);
      setAuthUser(result.user || null);
      setAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setSelectedAccountId(result.selected_account_id || "");
      setSelectedAccountName(result.selected_account_name || "");
      setPendingAccountId("");
      setApiTokenInput("");
      setSelected("");
      const rememberedRoute = ["settings", "googleProperties"].includes(tab) ? pathForTab(tab)
        : routeProjectKey ? pathForTab(tab, routeProjectKey) : pathForTab("overview");
      writeAppPath(rememberedRoute, true);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Gagal memvalidasi API Token.");
    } finally {
      setTokenLoginBusy(false);
    }
  };

  const changeCloudflareAccount = (accountId: string) => run(async () => {
    if (!accountId || accountId === selectedAccountId) return;
    await api("auth/select-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId })
    });
    const account = accounts.find((item) => item.id === accountId);
    setSelectedAccountId(accountId);
    setSelectedAccountName(account?.name || "Cloudflare account");
    setProjects([]);
    setSelected("");
    setTab("overview");
    setAnalytics(emptyAnalytics);
    setNotice(`Beralih ke akun Cloudflare ${account?.name || accountId}.`);
  });

  const logout = async () => {
    try { await api("auth/logout", { method: "POST" }); } catch { /* Local sign-out still proceeds. */ }
    setAuthed(false);
    setAuthUser(null);
    setAccounts([]);
    setSelectedAccountId("");
    setPendingAccountId("");
    setSelectedAccountName("");
    setGoogleAccounts([]);
    setSelectedGoogleEmail("");
    setGoogleProperties([]);
    setGscStatus({ connected: false, property: null });
    setProjects([]);
    setUploadProgress(null);
    setSelected("");
    setTabState("overview");
    setRouteProjectKey("");
    writeAppPath("/login", true);
  };

  const selectProject = async (name: string) => {
    const project = projects.find((item) => item.name === name);
    setSelected(name);
    setBranch(String(project?.production_branch || "main").toLowerCase());
    setTab("project", name);
    setReplaceFunctions(false);
    setAnalytics(emptyAnalytics);
    setEdgeFiles(null);
    setEdgeBranch("");
    await loadProjectData(name);
  };

  const openGooglePropertyProject = async (name: string) => {
    if (!projects.some((project) => project.name === name)) {
      setNotice(`Property ${name} belum terhubung dengan project pada akun Cloudflare yang sedang dipilih.`);
      return;
    }
    await selectProject(name);
    setTab("google", name);
    try { await loadGscStatus(name); } catch (caught: any) { setError(caught?.message || "Gagal membuka Google Search project."); }
  };

  const createProject = () => run(async () => {
    const projectName = newName.trim().toLowerCase();
    if (!createFiles?.length) throw new Error("Pilih folder website yang berisi index.html sebelum membuat project.");
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(projectName)) throw new Error("Nama project tidak valid.");

    const availability = await api(`project-name-check?name=${encodeURIComponent(projectName)}`, {});
    if (!availability.available) throw new Error(availability.message || `Nama project ${projectName} sudah digunakan.`);

    let result: any;
    try {
      result = await api("projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName })
      });
    } catch (caught: any) {
      if (caught?.status === 409) {
        setNameCheck("taken");
        setNameCheckMessage("Nama project tidak bisa dipakai. Cloudflare mendeteksi nama tersebut sudah terdaftar; silakan pilih nama lain.");
      }
      throw caught;
    }
    const createdName = result.project?.name || projectName;
    setShowCreate(false);
    setNewName("");
    setCreateFiles(null);
    setSelected(createdName);
    setTab("project", createdName);
    await loadProjects(false);

    try {
      const googlePreparation = await prepareAutoGsc(createdName, "main", "main");
      const deploymentStartedAt = Date.now();
      const deploymentResult = await sendDeployment(createdName, createFiles, "main", "Initial website deployment from Pages Manager", false);
      const deploymentStatus = await waitForDeployment(createdName, deploymentResult.deployment?.id, "main", deploymentStartedAt);
      await loadProjects(false, true);
      await loadProjectData(createdName);
      const googleResult = deploymentStatus === "success" ? await finishAutoGsc(createdName, googlePreparation) : "Google property belum diproses karena deployment production belum mencapai Success.";
      const warningText = Array.isArray(deploymentResult.warnings) && deploymentResult.warnings.length ? ` Catatan: ${deploymentResult.warnings.join(" ")}` : "";
      setNotice((deploymentStatus === "success"
        ? `Project ${createdName} berhasil dibuat dan deployment produksi sudah aktif: https://${createdName}.pages.dev. ${googleResult}`
        : `Project ${createdName} sudah dibuat. Deployment sedang diproses Cloudflare; Google property belum diverifikasi.`) + warningText);
    } catch (caught: any) {
      await loadProjectData(createdName);
      throw new Error(`Project ${createdName} berhasil dibuat, tetapi deployment website gagal: ${caught?.message || "kesalahan tidak diketahui"}. Project tetap tersimpan; buka tab Deployments lalu coba deploy kembali.`);
    }
  });

  const removeProject = (name: string) => {
    if (!window.confirm(`Hapus project ${name} secara permanen dari Cloudflare? Tindakan ini tidak dapat dibatalkan.`)) return;
    void run(async () => {
      await api(`projects/${encodeURIComponent(name)}`, { method: "DELETE" });
      setSelected("");
      setTab("overview");
      setNotice(`Project ${name} dihapus dari Cloudflare.`);
      await loadProjects(false);
    });
  };

  const deploy = () => run(async () => {
    if (!selected) throw new Error("Pilih project terlebih dahulu.");
    if (!files?.length) throw new Error("Pilih folder atau file website terlebih dahulu.");
    const cleanBranch = branch.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,50}$/.test(cleanBranch)) throw new Error("Nama branch tidak valid.");
    const productionBranch = String(selectedProject?.production_branch || "main").toLowerCase();
    const googlePreparation = await prepareAutoGsc(selected, cleanBranch, productionBranch);
    const deploymentStartedAt = Date.now();
    const result = await sendDeployment(selected, files, cleanBranch, message, replaceFunctions);
    const status = await waitForDeployment(selected, result.deployment?.id, cleanBranch, deploymentStartedAt);
    setFiles(null);
    await loadProjects(false, true);
    await loadProjectData(selected);
    const googleResult = status === "success" ? await finishAutoGsc(selected, googlePreparation) : "Google property belum didaftarkan karena deployment belum mencapai Success.";
    if (status === "success" && cleanBranch === productionBranch) await loadProjects(false, true);
    const warningText = Array.isArray(result.warnings) && result.warnings.length ? ` Catatan: ${result.warnings.join(" ")}` : "";
    setNotice((status === "success"
      ? `Deployment branch ${cleanBranch} berhasil. ${cleanBranch === productionBranch ? `Website produksi siap dibuka: https://${selected}.pages.dev` : `Preview branch: ${result.deployment?.url || branchUrl(selected, cleanBranch)}`}. ${googleResult}`
      : `Deployment branch ${cleanBranch} sudah diterima Cloudflare tetapi belum mencapai Success dalam jendela pemeriksaan otomatis. Anda dapat memeriksa ulang dari halaman Deployments; Google belum didaftarkan sampai deployment sukses. ${googleResult}`) + warningText);
  });

  const saveRotator = () => run(async () => {
    if (!selected) throw new Error("Pilih project terlebih dahulu.");
    const result = await api(`projects/${encodeURIComponent(selected)}/rotator`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rotator)
    });
    setNotice(result.edge_ready
      ? `Rotator ${selected}.pages.dev tersimpan. Request halaman produksi sekarang akan diarahkan ke salah satu edge aktif secara ${rotator.mode === "random" ? "acak" : rotator.mode === "weighted" ? "acak berbobot" : "bergiliran"}.`
      : "Konfigurasi rotator tersimpan.");
  });

  const addDirectTarget = () => {
    let parsed: URL;
    try { parsed = new URL(directTargetUrl.trim()); } catch { setError("URL tujuan harus berupa URL HTTPS yang valid."); return; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      setError("URL tujuan harus menggunakan HTTPS dan tidak boleh memuat username/password."); return;
    }
    if (parsed.hostname.toLowerCase() === `${selected}.pages.dev`) {
      setError("URL tujuan tidak boleh kembali ke hostname produksi project ini."); return;
    }
    const normalized = parsed.toString();
    if (rotator.targets.some((target) => target.url === normalized)) { setError("URL tersebut sudah ada di daftar rotator."); return; }
    const label = directTargetLabel.trim() || parsed.hostname;
    setRotator((current) => ({ ...current, targets: [...current.targets, { label, branch: "", weight: 100, enabled: true, url: normalized, kind: "url" }] }));
    setDirectTargetUrl(""); setDirectTargetLabel(""); setError("");
    setNotice(`Target URL ${normalized} ditambahkan. Simpan konfigurasi rotator untuk menerapkannya.`);
  };

  const generateEdgeName = () => {
    const used = new Set(rotator.targets.map((target) => target.branch));
    // Bound collision retries instead of relying on an open-ended loop.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = randomBranchName();
      if (!used.has(candidate)) {
        setEdgeBranch(candidate);
        setError("");
        return;
      }
    }
    setError("Gagal membuat nama edge unik setelah 32 percobaan. Coba generate ulang.");
  };

  const deployEdge = () => run(async () => {
    if (!selected) throw new Error("Pilih project terlebih dahulu.");
    if (!edgeFiles?.length) throw new Error("Pilih folder output landing page terlebih dahulu.");
    const cleanBranch = edgeBranch.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,50}$/.test(cleanBranch)) {
      throw new Error("Nama edge tidak valid. Gunakan huruf kecil, angka, dan tanda hubung.");
    }
    const productionBranch = String(selectedProject?.production_branch || "main").toLowerCase();
    if (cleanBranch === productionBranch) {
      throw new Error(`Nama ${cleanBranch} adalah production branch. Gunakan nama branch lain.`);
    }

    const deploymentStartedAt = Date.now();
    const result = await sendDeployment(selected, edgeFiles, cleanBranch, `Create edge subdomain ${cleanBranch}`, replaceFunctions);
    const status = await waitForDeployment(selected, result.deployment?.id, cleanBranch, deploymentStartedAt);
    if (status !== "success") {
      await loadProjectData(selected);
      throw new Error(`Deployment ${cleanBranch} sudah dikirim, tetapi belum berstatus Success. Refresh deployments, tunggu selesai, lalu aktifkan sebagai target rotator.`);
    }

    const newTarget: RotatorTarget = { label: cleanBranch, branch: cleanBranch, weight: 100, enabled: true, url: "" };
    const existingIndex = rotator.targets.findIndex((target) => target.branch === cleanBranch);
    const nextTargets = existingIndex < 0
      ? [...rotator.targets, newTarget]
      : rotator.targets.map((target, index) => index === existingIndex ? { ...target, ...newTarget } : target);
    const nextConfig: RotatorConfig = { ...rotator, targets: nextTargets };
    setRotator(nextConfig);
    try {
      await api(`projects/${encodeURIComponent(selected)}/rotator`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig)
      });
    } catch (caught: any) {
      await loadProjectData(selected);
      throw new Error(`Edge sudah berhasil di-deploy di ${branchUrl(selected, cleanBranch)}, tetapi belum berhasil dimasukkan ke konfigurasi rotator: ${caught?.message || "gagal menyimpan konfigurasi"}. Periksa deployment dan simpan konfigurasi rotator lagi.`);
    }
    await loadProjectData(selected);
    setEdgeBranch("");
    const warningText = Array.isArray(result.warnings) && result.warnings.length ? ` Catatan: ${result.warnings.join(" ")}` : "";
    setNotice(`Edge siap dan sudah tersimpan di rotator: ${branchUrl(selected, cleanBranch)}. ${rotator.enabled ? "Domain utama akan mulai mengacak pengunjung ke edge ini dan target aktif lainnya." : "Rotator masih nonaktif; aktifkan sakelar rotator untuk mulai mengalihkan pengunjung."}${warningText}`);
  });

  const updateTarget = (index: number, patch: Partial<RotatorTarget>) => {
    setRotator((current) => ({
      ...current,
      targets: current.targets.map((target, targetIndex) => targetIndex === index ? { ...target, ...patch } : target)
    }));
  };

  const moveTarget = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setRotator((current) => {
      if (fromIndex >= current.targets.length || toIndex >= current.targets.length) return current;
      const targets = [...current.targets];
      const [moved] = targets.splice(fromIndex, 1);
      targets.splice(toIndex, 0, moved);
      return { ...current, targets };
    });
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Alamat berhasil disalin.");
    } catch {
      setError("Browser tidak mengizinkan clipboard. Salin alamat secara manual.");
    }
  };

  const openProjectTab = (nextTab: "project" | "rotator" | "analytics" | "google") => {
    if (!selected) {
      setTab("overview");
      setNotice("Pilih salah satu project di Overview terlebih dahulu untuk membuka menu Project Management.");
      return;
    }
    setTab(nextTab);
    if (nextTab === "analytics") void loadAnalytics(selected, analyticsDays);
    if (nextTab === "google") void loadGscStatus(selected).catch((caught: any) => setError(caught?.message || "Gagal membaca konfigurasi Google."));
  };

  const selectedProject = projects.find((project) => project.name === selected);
  const selectedProductionStatus = deploymentStatus(selectedProject?.canonical_deployment);
  const selectedProjectIsLive = Boolean(selectedProject?.canonical_deployment?.id) && selectedProductionStatus === "success";

  if (!authed && checkingSession) {
    return <main className="login-screen"><div className="login-card session-loading"><div className="brand-mark"><Cloud size={24}/></div><h1>Restoring session</h1><p>Memeriksa sesi Pages Manager…</p><LoaderCircle className="spin session-spinner" size={22}/></div></main>;
  }

  if (!authed) {
    return (
      <main className="login-screen">
        <div className="login-card">
          <div className="brand-mark"><Cloud size={24}/></div>
          <span className="eyebrow">CLOUDFLARE CONTROL PLANE</span>
          <h1>Pages Manager</h1>
          <p>Hubungkan akun Cloudflare Anda menggunakan API Token pribadi. Setiap pengguna memakai token dan akun miliknya sendiri.</p>
          {error && <div className="alert error-alert">{error}</div>}
          <label htmlFor="cloudflare-api-token">Cloudflare API Token</label>
          <input id="cloudflare-api-token" type="password" autoComplete="off" spellCheck={false} value={apiTokenInput} onChange={(event) => setApiTokenInput(event.target.value)} placeholder="Paste API Token di sini" onKeyDown={(event) => { if (event.key === "Enter") void loginWithApiToken(); }}/>
          <button className="button primary-button full-width" disabled={!apiTokenInput.trim() || tokenLoginBusy} onClick={() => void loginWithApiToken()}><Cloud size={17}/>{tokenLoginBusy ? "Memvalidasi token…" : "Connect Cloudflare account"}</button>
          <small>Buat token di Cloudflare Dashboard → My Profile → API Tokens. Gunakan permission User Details: Read, Account: Read, dan Cloudflare Pages: Read serta Edit. API Token digunakan untuk menghubungkan akun Cloudflare. Simpan token secara pribadi dan jangan bagikan kepada orang lain.</small>
          <small><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Buka halaman API Tokens Cloudflare</a></small>
        </div>
      </main>
    );
  }


  if (authed && !selectedAccountId) {
    return (
      <main className="login-screen">
        <div className="login-card">
          <div className="brand-mark"><Cloud size={24}/></div>
          <span className="eyebrow">CLOUDFLARE ACCOUNT</span>
          <h1>Select an account</h1>
          <p>Login sebagai <b>{authUser?.email || "Cloudflare user"}</b>. Pilih akun Cloudflare yang ingin dikelola.</p>
          <label htmlFor="cloudflare-account">Cloudflare account</label>
          <select id="cloudflare-account" value={pendingAccountId} onChange={(event) => setPendingAccountId(event.target.value)}>
            <option value="">Pilih akun…</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          {error && <div className="alert error-alert">{error}</div>}
          <button className="button primary-button full-width" disabled={!pendingAccountId || busy} onClick={() => void changeCloudflareAccount(pendingAccountId)}>Continue to dashboard <ChevronRight size={17}/></button>
          <button className="button secondary-button full-width" onClick={logout}>Sign out</button>
        </div>
      </main>
    );
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-block"><div className="brand-mark"><Cloud size={21}/></div><div className="brand-copy"><b>Pages Manager</b><small>CONTROL CENTER</small></div><button className="sidebar-toggle" type="button" title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <ChevronRight size={17}/> : <ChevronLeft size={17}/>}</button></div>
        <div className="nav-caption">WORKSPACE</div>
        <button className={`nav-item ${tab === "overview" ? "active" : ""}`} title="Overview" aria-label="Overview" onClick={() => setTab("overview")}><LayoutDashboard size={17}/> Overview</button>
        <div className="nav-caption">CLOUDFLARE</div>
        {selected && <>
          <div className="nav-project" title={selected}><i className="project-dot"/><span>{selected}</span></div>
          <button className={`nav-item ${tab === "project" ? "active" : ""}`} title="Deployments" aria-label="Deployments" onClick={() => openProjectTab("project")}><FileCode2 size={17}/> Deployments</button>
          <button className={`nav-item ${tab === "rotator" ? "active" : ""}`} title="Traffic Rotator" aria-label="Traffic Rotator" onClick={() => openProjectTab("rotator")}><Zap size={17}/> Traffic Rotator</button>
          <button className={`nav-item ${tab === "analytics" ? "active" : ""}`} title="Analytics" aria-label="Analytics" onClick={() => openProjectTab("analytics")}><BarChart3 size={17}/> Analytics</button>
          <button className={`nav-item ${tab === "google" ? "active" : ""}`} title="Project Google Search" aria-label="Project Google Search" onClick={() => openProjectTab("google")}><Globe size={17}/> Project Search</button>
        </>}
        <div className="nav-caption">GOOGLE SEARCH</div>
        <button className={`nav-item ${tab === "googleProperties" ? "active" : ""}`} title="Google properties" aria-label="Google properties" onClick={() => setTab("googleProperties")}><Globe size={17}/> Properties</button>
        <div className="sidebar-bottom">
          <button className={`nav-item ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")} title="Settings" aria-label="Settings"><Settings size={17}/> Settings</button>
          <button className="nav-item" onClick={logout} title="Sign out" aria-label="Sign out"><ShieldCheck size={17}/> Sign out</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-breadcrumbs"><span className="eyebrow">PAGES MANAGER / CONTROL PLANE</span><div className="breadcrumb-path"><button className={`breadcrumb-link ${tab === "overview" ? "current" : ""}`} onClick={() => setTab("overview")}>Overview</button>{selected && ["project", "rotator", "analytics", "google"].includes(tab) && <><ChevronRight size={14}/><button className="breadcrumb-link" onClick={() => setTab("project")}>{selected}</button><ChevronRight size={14}/><span className="breadcrumb-current">{tab === "project" ? "Deployments" : tab === "rotator" ? "Traffic Rotator" : tab === "google" ? "Google Search" : "Analytics"}</span></>}{!selected && tab !== "overview" && <><ChevronRight size={14}/><span className="breadcrumb-current">{tab === "settings" ? "Settings" : "Google Search properties"}</span></>}</div></div>
          <div className="topbar-actions"><span className="account-user-email" title={authUser?.email || ""}>{authUser?.email || "Workspace"}</span><button className="icon-button" title="Refresh current page" onClick={() => { if (tab === "analytics") void loadAnalytics(); else if (tab === "project" || tab === "rotator") void loadProjectData(selected); else if (tab === "google") void loadGscStatus(selected).catch((caught: any) => setError(caught?.message || "Gagal memuat Google Search Console.")); else if (tab === "googleProperties") void loadGoogleProperties().catch((caught: any) => setError(caught?.message || "Gagal memuat property Google.")); else if (tab === "settings") void loadGoogleAccounts().catch((caught: any) => setError(caught?.message || "Gagal memuat akun Google.")); else { void loadProjects(true, true); void loadGoogleProperties().catch(() => {}); } }}><RefreshCw size={16}/></button></div>
        </header>

        <div className="content-area">
          {uploadProgress && <section className={`upload-progress-panel ${uploadProgress.phase}`} aria-live="polite">
            <div className="upload-progress-heading">
              <div className="upload-progress-icon"><LoaderCircle className="spin" size={18}/></div>
              <div className="upload-progress-copy">
                <b>{uploadProgress.phase === "preparing" ? "Memeriksa & menghitung checksum file" : uploadProgress.phase === "uploading" ? "Mengunggah file ke Pages Manager" : uploadProgress.phase === "processing" ? "File diterima · Cloudflare sedang memproses" : "Memverifikasi deployment Cloudflare"}</b>
                <small>{formatNumber(uploadProgress.files)} file · {formatBytes(uploadProgress.totalBytes)} · branch <strong>{uploadProgress.branch}</strong>{uploadProgress.phase === "verifying" ? " · pengecekan status bertahap, maksimal sekitar 3 menit" : ""}</small>
              </div>
              <strong className="upload-progress-percent">{uploadProgress.phase === "processing" ? "…" : `${Math.round(uploadProgress.percent)}%`}</strong>
            </div>
            <div className="upload-progress-track"><span style={{ width: uploadProgress.phase === "processing" ? "38%" : `${Math.max(2, Math.min(100, uploadProgress.percent))}%` }}/></div>
            <div className="upload-progress-foot"><span>{uploadProgress.phase === "preparing" ? "Memvalidasi struktur dan menghitung checksum BLAKE3 di browser…" : uploadProgress.phase === "uploading" ? `${formatBytes(uploadProgress.loadedBytes)} dari ${formatBytes(uploadProgress.totalBytes)} dikirim` : uploadProgress.phase === "processing" ? "Menghitung checksum, mengirim manifest, dan menyiapkan asset…" : "Menunggu status Success dan alias domain aktif…"}</span><span className="upload-progress-pulse"><i/> {uploadProgress.phase === "uploading" ? "UPLOAD" : uploadProgress.phase === "verifying" ? "VERIFY" : "PROCESSING"}</span></div>
          </section>}
          {error && <div className="alert error-alert">{error}<button onClick={() => setError("")}><X size={15}/></button></div>}
          {notice && <div className="alert success-alert"><Check size={15}/><span>{notice}</span><button onClick={() => setNotice("")}><X size={15}/></button></div>}

          {tab === "overview" && <>
            <section className="page-heading">
              <div><span className="eyebrow">CONTROL PLANE / LIVE INVENTORY</span><h1>Manage every Pages project.</h1><p>Inventaris project Cloudflare, deployment, routing, dan traffic analytics dalam satu panel.</p></div>
              <button className="button primary-button" onClick={() => setShowCreate(true)}><Plus size={17}/> New project</button>
            </section>
            <div className="stats-grid three">
              <StatCard icon={Globe} label="Cloudflare projects" value={formatNumber(projects.length)} helper={`Account: ${selectedAccountName || "Selected account"}`}/>
              <StatCard icon={Activity} label="Google properties" value={formatNumber(googleProperties.length)} helper={selectedGoogleEmail || "Connect Google in Settings"}/>
              <StatCard icon={Database} label="Connected services" value={`${accounts.length} Cloudflare · ${googleAccounts.length} Google`} helper="Account connections in this workspace"/>
            </div>
            <section className="panel overview-google-panel">
              <div className="panel-heading"><div><h3><Globe size={17}/> Google Search Console overview</h3><p>{selectedGoogleEmail ? `Property portfolio for ${selectedGoogleEmail}` : "Hubungkan akun Google untuk menampilkan property Search Console yang Anda kelola."}</p></div><div className="toolbar-actions"><button className="button secondary-button" onClick={() => setTab("settings")}><Settings size={15}/> Settings</button><button className="button primary-button" onClick={() => setTab("googleProperties")}><Globe size={15}/> View properties</button></div></div>
              {selectedGoogleEmail ? <>
                <div className="stats-grid three compact-stats"><StatCard icon={Globe} label="Accessible properties" value={formatNumber(googleProperties.length)} helper="From Google Search Console API"/><StatCard icon={ShieldCheck} label="Owner access" value={formatNumber(googleProperties.filter((item) => item.permission_level === "siteOwner").length)} helper="Properties with owner permission"/><StatCard icon={Link2} label="Linked Pages projects" value={formatNumber(googleProperties.filter((item) => projects.some((project) => project.name === item.linked_project)).length)} helper="Matched to this Cloudflare account"/></div>
                {googleProperties.length ? <div className="overview-property-list">{googleProperties.slice(0, 5).map((property) => { const linkedProject = projects.find((project) => project.name === property.linked_project); return <div className="overview-property-row" key={property.site_url}><div><b>{property.site_url}</b><small>{property.property_type === "domain" ? "Domain property" : "URL-prefix property"} · {property.permission_level === "siteOwner" ? "Owner" : property.permission_level === "siteFullUser" ? "Full user" : property.permission_level === "siteRestrictedUser" ? "Restricted user" : "Unverified"}</small></div>{linkedProject && <button className="button secondary-button small-button" onClick={() => void openGooglePropertyProject(linkedProject.name)}>Open project</button>}</div>; })}</div> : <div className="muted-empty">Google belum mengembalikan property pada akun ini.</div>}
              </> : <div className="settings-info"><ShieldCheck size={17}/><div><b>Google account not connected</b><p>Hubungkan Google melalui Settings untuk menggabungkan inventaris Search Console dengan Cloudflare Pages.</p></div></div>}
            </section>
            <div className="section-toolbar"><div><h3>Pages projects</h3><p>Urutan Default mengikuti susunan asli Cloudflare Pages. Status deployment berasal dari metadata Cloudflare Pages API; dashboard tidak melakukan HEAD/GET otomatis ke domain sehingga tidak memicu Workers situs hanya untuk pemeriksaan.</p></div><div className="toolbar-actions"><div className="search-box"><Search size={16}/><input placeholder="Cari project..." value={search} onChange={(event) => setSearch(event.target.value)}/></div><label className="page-size-control"><span>Sort</span><select aria-label="Sort project by" value={projectSort} onChange={(event) => setProjectSort(event.target.value as "default" | "alphabetical" | "created" | "status")}><option value="default">Default</option><option value="alphabetical">Alphabetical</option><option value="created">Created Date</option><option value="status">Status</option></select><select aria-label="Sort direction" value={projectSortDirection} onChange={(event) => setProjectSortDirection(event.target.value as "default" | "asc" | "desc")}><option value="default">Default</option><option value="asc">Ascending</option><option value="desc">Descending</option></select></label><label className="page-size-control"><span>Show</span><select aria-label="Jumlah project per halaman" value={projectPageSize} onChange={(event) => setProjectPageSize(event.target.value === "all" ? "all" : Number(event.target.value) as 10 | 50 | 100)}><option value={10}>10</option><option value={50}>50</option><option value={100}>100</option><option value="all">All</option></select></label><div className="view-switch" aria-label="Project display mode"><button className={projectView === "cards" ? "active" : ""} title="Card view" aria-label="Card view" onClick={() => setProjectView("cards")}><LayoutGrid size={15}/></button><button className={projectView === "list" ? "active" : ""} title="List view" aria-label="List view" onClick={() => setProjectView("list")}><List size={15}/></button></div><button className="button secondary-button" onClick={() => { void loadProjects(true, true); }}><RefreshCw size={15}/> Refresh</button></div></div>
            {visibleProjects.length ? projectView === "list" ? <div className="project-list-table-wrap"><table className="project-list-table"><colgroup><col className="col-project-name"/><col className="col-project-url"/><col className="col-project-branch"/><col className="col-project-created"/><col className="col-project-status"/><col className="col-project-code"/><col className="col-project-action"/></colgroup><thead><tr><th>Name</th><th>URL</th><th>Destination Branch</th><th>Created</th><th>Deployment</th><th>Deploy ID</th><th>Action</th></tr></thead><tbody>{visibleProjects.map((project) => {
              const liveUrl = projectUrl(project);
              const deploymentState = getDeploymentState(project);
              const statusClass = deploymentPillClass(deploymentState);
              return <tr key={project.name}><td className="list-project-name" title={project.name}>{project.name}</td><td className="list-project-url"><a className="project-domain" href={liveUrl} target="_blank" rel="noreferrer" title={`Open ${liveUrl}`}>{new URL(liveUrl).host}<ExternalLink size={12}/></a></td><td title={project.production_branch || "main"}>{project.production_branch || "main"}</td><td className="nowrap">{formatDate(project.created_on)}</td><td><span className={`status-pill health-pill ${statusClass}`}><i/>{deploymentLabel(deploymentState)}</span></td><td className="list-project-code" title={project.canonical_deployment?.id || "No deployment ID"}>{project.canonical_deployment?.id ? project.canonical_deployment.id.slice(0, 8) : "—"}</td><td><button className="button primary-button list-manage-button" onClick={() => void selectProject(project.name)}>Manage</button></td></tr>;
            })}</tbody></table></div> : <div className="project-grid">{visibleProjects.map((project) => {
              const liveUrl = projectUrl(project);
              const deploymentState = getDeploymentState(project);
              const statusClass = deploymentPillClass(deploymentState);
              return <article className="project-card" key={project.name}>
                <div className="project-card-top"><div className="project-icon"><Globe size={19}/></div><span className={`status-pill health-pill ${statusClass}`}><i/>{deploymentLabel(deploymentState).toUpperCase()}</span></div>
                <h3>{project.name}</h3>
                <a className="project-domain" href={liveUrl} target="_blank" rel="noreferrer" title={`Open ${liveUrl}`}>{new URL(liveUrl).host} <ExternalLink size={13}/></a>
                <div className="project-meta"><span>Production branch<b>{project.production_branch || "main"}</b></span><span>Created<b>{formatDate(project.created_on)}</b></span></div>
                <div className="health-detail">{deploymentState === "success" ? "Latest deployment berhasil menurut Cloudflare Pages" : deploymentState === "failed" ? "Latest deployment gagal atau dibatalkan" : deploymentState === "building" ? "Cloudflare sedang memproses deployment" : "Belum ada status deployment produksi"}</div>
                <div className="project-card-actions"><button className="button primary-button" onClick={() => void selectProject(project.name)}>Manage <ChevronRight size={15}/></button></div>
              </article>;
            })}</div> : <div className="empty-state"><Globe size={27}/><h3>{busy ? "Loading projects…" : "No projects found"}</h3><p>{search ? "Tidak ada project yang sesuai dengan pencarian." : "Buat project Pages baru atau refresh inventaris."}</p></div>}
            {filteredProjects.length > 0 && <div className="pagination-bar"><span>Menampilkan {projectPageSize === "all" ? 1 : (projectPage - 1) * projectPageSize + 1}–{projectPageSize === "all" ? filteredProjects.length : Math.min(projectPage * projectPageSize, filteredProjects.length)} dari {formatNumber(filteredProjects.length)} project</span><div className="pagination-controls"><button className="icon-button" aria-label="Halaman sebelumnya" disabled={projectPage <= 1} onClick={() => setProjectPage((page) => Math.max(1, page - 1))}><ArrowLeft size={15}/></button><span>Page <b>{projectPage}</b> / {projectPageCount}</span><button className="icon-button" aria-label="Halaman berikutnya" disabled={projectPage >= projectPageCount} onClick={() => setProjectPage((page) => Math.min(projectPageCount, page + 1))}><ChevronRight size={15}/></button></div></div>}
          </>}

          {tab === "googleProperties" && <GooglePropertiesPage
            connected={Boolean(selectedGoogleEmail)}
            email={selectedGoogleEmail}
            properties={googleProperties}
            cloudflareProjects={projects}
            busy={busy}
            onRefresh={() => void run(async () => { await loadGoogleProperties(); setNotice("Daftar property Google berhasil diperbarui."); })}
            onSettings={() => setTab("settings")}
            onOpenProject={(projectName) => void openGooglePropertyProject(projectName)}
          />}

          {tab === "settings" && <SettingsPanel
            userEmail={authUser?.email || ""}
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            selectedAccountName={selectedAccountName}
            onSelectCloudflare={(accountId) => void changeCloudflareAccount(accountId)}
            googleAccounts={googleAccounts}
            selectedGoogleEmail={selectedGoogleEmail}
            onSelectGoogle={(email) => void changeGoogleAccount(email)}
            onConnectGoogle={connectGoogle}
            onDisconnectGoogle={disconnectGoogle}
            theme={theme}
            onSetTheme={setTheme}
            busy={busy}
          />}

          {tab === "project" && selected && <DeploymentsPanel
            selected={selected}
            selectedProject={selectedProject}
            selectedProjectIsLive={selectedProjectIsLive}
            rotatorEnabled={rotator.enabled}
            removeProject={removeProject}
            replaceFunctions={replaceFunctions}
            setReplaceFunctions={setReplaceFunctions}
            files={files}
            setFiles={setFiles}
            setError={setError}
            busy={busy}
            branch={branch}
            setBranch={setBranch}
            message={message}
            setMessage={setMessage}
            deploy={deploy}
            deployments={deployments}
            normalizeUrl={normalizeUrl}
            formatNumber={formatNumber}
            formatDateTime={formatDateTime}
            loadProjectData={loadProjectData}
            autoAddGsc={autoAddGsc}
            setAutoAddGsc={setAutoAddGsc}
            googleConnected={Boolean(selectedGoogleEmail)}
            googleEmail={selectedGoogleEmail}
            onOpenSettings={() => setTab("settings")}
          />}

          {tab === "rotator" && selected && <RotatorPanel
            selected={selected}
            selectedProject={selectedProject}
            rotator={rotator}
            setRotator={setRotator}
            busy={busy}
            replaceFunctions={replaceFunctions}
            setReplaceFunctions={setReplaceFunctions}
            edgeBranch={edgeBranch}
            setEdgeBranch={setEdgeBranch}
            edgeFiles={edgeFiles}
            setEdgeFiles={setEdgeFiles}
            setError={setError}
            deployEdge={deployEdge}
            generateEdgeName={generateEdgeName}
            directTargetUrl={directTargetUrl}
            setDirectTargetUrl={setDirectTargetUrl}
            directTargetLabel={directTargetLabel}
            setDirectTargetLabel={setDirectTargetLabel}
            addDirectTarget={addDirectTarget}
            deployments={deployments}
            draggingTargetIndex={draggingTargetIndex}
            setDraggingTargetIndex={setDraggingTargetIndex}
            moveTarget={moveTarget}
            updateTarget={updateTarget}
            copyValue={copyValue}
            saveRotator={saveRotator}
            branchUrl={branchUrl}
            projectUrl={projectUrl}
            onNavigate={setTab}
          />}

          {tab === "analytics" && selected && <>
            <AnalyticsPanel data={analytics} days={analyticsDays} setDays={(nextDays) => { setAnalyticsDays(nextDays); setRecentPage(1); void loadAnalytics(selected, nextDays); }} recentPage={recentPage} setRecentPage={setRecentPage} recentPageSize={recentPageSize} setRecentPageSize={setRecentPageSize}/>
          </>}
          {tab === "google" && selected && <GoogleSearchPanel
            project={selected}
            status={gscStatus}
            performance={gscPerformance}
            inspectionUrl={gscInspectionUrl}
            setInspectionUrl={setGscInspectionUrl}
            inspection={gscInspection}
            busy={busy}
            workerInstalled={Boolean(selectedProject?.manager_worker_installed) && supportsGoogleVerificationWorker(selectedProject?.manager_worker_version)}
            onSettings={() => setTab("settings")}
            onPrepare={prepareGscProperty}
            onVerify={verifyGscProperty}
            onSubmitSitemap={submitGscSitemap}
            onLoadPerformance={loadGscPerformance}
            onInspect={inspectGscUrl}
          />}

          <footer className="app-footer">Pages Manager <span>•</span> Cloudflare Pages control plane <span>•</span> v2.8.3</footer>
        </div>
      </main>

      {showCreate && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowCreate(false); setCreateFiles(null); } }}>
        <div className="modal-card create-deploy-modal" role="dialog" aria-modal="true" aria-labelledby="create-deploy-title">
          <div className="modal-heading modal-sticky-heading">
            <div><span className="eyebrow">CLOUDFLARE PAGES</span><h3 id="create-deploy-title">Create & deploy website</h3></div>
            <button className="icon-button" aria-label="Close create project" onClick={() => { setShowCreate(false); setCreateFiles(null); }}><X size={17}/></button>
          </div>
          <div className="modal-scroll-content">
            <p>Nama akan diperiksa ke akun Cloudflare. Setelah tersedia, project dibuat dan folder website langsung di-deploy ke branch produksi <b>main</b>.</p>
            <label htmlFor="new-project-name">Project name</label>
            <input id="new-project-name" autoFocus maxLength={32} value={newName} onChange={(event) => setNewName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-/, "").slice(0, 32))} onKeyDown={(event) => event.key === "Enter" && nameCheck === "available" && Boolean(createFiles?.length) && createProject()} placeholder="my-new-website"/>
            <small className={`name-check ${nameCheck}`}>{nameCheckMessage || "1–32 karakter, huruf kecil, angka, dan tanda hubung."}</small>
            <div className="google-deploy-option create-google-deploy-option">
              <label className="google-deploy-toggle"><input type="checkbox" checked={autoAddGsc} onChange={(event) => setAutoAddGsc(event.target.checked)}/><span><b><Globe size={16}/> Add property to Google Search Console</b><small>Aktif secara default. Setelah deploy production berhasil, Pages Manager menyiapkan verifikasi property dan mengirim sitemap otomatis.</small></span></label>
              <div className="google-deploy-state">{selectedGoogleEmail ? <span className="status-pill success">{selectedGoogleEmail}</span> : <><span className="status-pill unknown">Google not connected</span><button type="button" className="text-button" onClick={() => { setShowCreate(false); setTab("settings"); }}>Connect in Settings</button></>}</div>
            </div>
            <label>Website files / folder</label>
            <small>Pilih file atau folder hasil build yang memiliki index.html di root. Project kosong tidak dibuat.</small>
            <FileDropzone id="create-website-files" files={createFiles} onChange={setCreateFiles} onError={setError} disabled={busy} hint="Drop file atau folder hasil build di sini."/>
            <WebsiteSeoAudit files={createFiles}/>
          </div>
          <div className="modal-actions modal-sticky-actions">
            <button className="button secondary-button" disabled={busy} onClick={() => { setShowCreate(false); setCreateFiles(null); }}>Cancel</button>
            <button className="button primary-button" disabled={!newName || nameCheck !== "available" || !createFiles?.length || busy} onClick={createProject}><Plus size={15}/> Create & deploy</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
