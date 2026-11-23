import { useEffect, useState, type DragEvent } from "react";
import { FileUp, FolderOpen, LoaderCircle, Search, ShieldCheck, X } from "lucide-react";
import type { WebsiteFile } from "../../../shared/types";

function formatNumber(value: number) { return new Intl.NumberFormat("id-ID").format(Number(value || 0)); }
function formatBytes(value: number) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"]; let size = bytes / 1024; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}



type WebsiteFileInput = FileList | WebsiteFile[];

function normalizeWebsiteFiles(fileList: WebsiteFileInput): WebsiteFile[] {
  const candidates = Array.from(fileList as ArrayLike<File | WebsiteFile>).map((item) => {
    if ("file" in item && "path" in item) return { file: item.file, path: item.path.replace(/\\/g, "/") };
    const file = item as File & { webkitRelativePath?: string };
    return { file, path: (file.webkitRelativePath || file.name).replace(/\\/g, "/") };
  });
  if (!candidates.length) throw new Error("Pilih file website atau folder terlebih dahulu.");

  // Remove one common wrapper folder (e.g. dist/) so index.html lands at root.
  let wrapper = "";
  const firstSegments = candidates.map((item) => item.path.split("/")[0]);
  const commonRoot = firstSegments[0];
  const allHaveFolderPrefix = candidates.every((item) => item.path.includes("/") && item.path.startsWith(`${commonRoot}/`));
  if (commonRoot && allHaveFolderPrefix) wrapper = commonRoot;

  const normalized = candidates.map(({ file, path: original }) => ({
    file,
    path: (wrapper && original.startsWith(`${wrapper}/`) ? original.slice(wrapper.length + 1) : original).replace(/^\/+/, "")
  }));

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const item of normalized) {
    if (!item.path || item.path.length > 1500 || item.path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Path file tidak valid: ${item.path || item.file.name}`);
    }
    if (item.path.toLowerCase() === "__pm-seo-index.json" || item.path.toLowerCase().startsWith("__pm/")) {
      throw new Error(`${item.path} adalah path internal yang dikelola Pages Manager.`);
    }
    if (paths.has(item.path)) throw new Error(`Path file duplikat: ${item.path}`);
    paths.add(item.path);
    if (item.file.size > 25 * 1024 * 1024) throw new Error(`File ${item.path} melebihi batas 25 MiB per file.`);
    totalBytes += item.file.size;
  }
  if (normalized.length > 19999) throw new Error("Maksimal 19.999 file website per deployment. Satu slot file dipakai indeks SEO internal Pages Manager.");
  if (totalBytes > 90 * 1024 * 1024) throw new Error("Total file melebihi batas 90 MiB per deployment (termasuk ruang aman untuk overhead upload).");
  if (!paths.has("index.html")) {
    throw new Error("index.html tidak ditemukan di root website. Pilih folder hasil build yang langsung berisi index.html (misalnya dist atau build), atau drop file-file website dengan struktur folder yang benar.");
  }
  return normalized;
}

function readDroppedFile(entry: any): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(entry: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader();
    const collected: any[] = [];
    const readNext = () => reader.readEntries((batch: any[]) => {
      if (!batch.length) resolve(collected);
      else { collected.push(...batch); readNext(); }
    }, reject);
    readNext();
  });
}

async function readDroppedEntry(entry: any, prefix = ""): Promise<WebsiteFile[]> {
  if (entry.isFile) {
    const file = await readDroppedFile(entry);
    return [{ file, path: `${prefix}${file.name}` }];
  }
  if (entry.isDirectory) {
    const nestedPrefix = `${prefix}${entry.name}/`;
    const children = await readDirectoryEntries(entry);
    const files: WebsiteFile[] = [];
    for (const child of children) files.push(...await readDroppedEntry(child, nestedPrefix));
    return files;
  }
  return [];
}

async function collectDroppedWebsiteFiles(dataTransfer: DataTransfer): Promise<WebsiteFile[]> {
  const collected: WebsiteFile[] = [];
  const items = Array.from(dataTransfer.items || []);
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => any }).webkitGetAsEntry?.();
    if (entry) collected.push(...await readDroppedEntry(entry));
    else {
      const file = item.getAsFile();
      if (file) collected.push({ file, path: file.name });
    }
  }
  if (!collected.length) {
    collected.push(...Array.from(dataTransfer.files || []).map((file) => ({ file, path: file.name })));
  }
  return normalizeWebsiteFiles(collected);
}

export function FileDropzone({
  id, files, onChange, onError, disabled = false, hint
}: {
  id: string;
  files: WebsiteFile[] | null;
  onChange: (files: WebsiteFile[] | null) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  hint: string;
}) {
  const [dragActive, setDragActive] = useState(false);
  const [readingDrop, setReadingDrop] = useState(false);
  const fileInputId = `${id}-files`;
  const folderInputId = `${id}-folder`;
  const selectFiles = (list: FileList | null) => {
    if (!list?.length) return;
    try { onChange(normalizeWebsiteFiles(list)); onError(""); }
    catch (error) { onChange(null); onError(error instanceof Error ? error.message : "File website tidak valid."); }
  };
  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (disabled || readingDrop) return;
    setReadingDrop(true);
    try { onChange(await collectDroppedWebsiteFiles(event.dataTransfer)); onError(""); }
    catch (error) { onChange(null); onError(error instanceof Error ? error.message : "Tidak dapat membaca file/folder yang dijatuhkan."); }
    finally { setReadingDrop(false); }
  };
  const totalBytes = files?.reduce((sum, item) => sum + item.file.size, 0) || 0;
  return <div
    className={`file-dropzone ${dragActive ? "drag-active" : ""} ${files?.length ? "has-files" : ""} ${disabled ? "disabled" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragActive(true); }}
    onDragOver={(event) => { event.preventDefault(); if (!disabled) event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
    onDrop={(event) => { void handleDrop(event); }}
    aria-label="Area drag and drop file website"
  >
    <input id={fileInputId} className="dropzone-input" type="file" multiple disabled={disabled} onChange={(event) => { selectFiles(event.currentTarget.files); event.currentTarget.value = ""; }}/>
    <input id={folderInputId} className="dropzone-input" type="file" multiple disabled={disabled} onChange={(event) => { selectFiles(event.currentTarget.files); event.currentTarget.value = ""; }} {...({ webkitdirectory: "", directory: "" } as any)}/>
    <div className="dropzone-main">
      <div className="dropzone-icon">{readingDrop ? <LoaderCircle className="spin" size={22}/> : <FolderOpen size={23}/>}</div>
      <div className="dropzone-copy">
        <b>{readingDrop ? "Membaca isi folder…" : files?.length ? `${files.length.toLocaleString("id-ID")} file siap di-deploy` : "Drag & drop file atau folder website"}</b>
        <small>{files?.length ? `${formatBytes(totalBytes)} · index.html terdeteksi di root · struktur folder dipertahankan` : hint}</small>
      </div>
    </div>
    <div className="dropzone-actions">
      <label htmlFor={fileInputId} className="button secondary-button"><FileUp size={14}/> Pilih file</label>
      <label htmlFor={folderInputId} className="button secondary-button"><FolderOpen size={14}/> Pilih folder</label>
      {files?.length ? <button type="button" className="text-button" disabled={disabled} onClick={() => onChange(null)}><X size={13}/> Hapus pilihan</button> : <span className="dropzone-format">Maks. 25 MiB/file · 90 MiB total</span>}
    </div>
    {files?.length ? <div className="dropzone-file-preview">{files.slice(0, 3).map((item) => <span key={item.path}>{item.path}</span>)}{files.length > 3 && <span>+ {files.length - 3} file lainnya</span>}</div> : null}
  </div>;
}

type SeoAuditIssue = { level: "critical" | "warning"; title: string; detail: string };
type SeoAuditReport = {
  score: number;
  scanned: number;
  totalPages: number;
  ampPages: number;
  missingTitles: number;
  missingDescriptions: number;
  missingH1: number;
  imagesWithoutAlt: number;
  duplicateTitles: number;
  customAmpScripts: number;
  brokenInternalLinks: number;
  missingOpenGraph: number;
  invalidJsonLd: number;
  noindexPages: number;
  issues: SeoAuditIssue[];
};

function routeForWebsiteFile(path: string) {
  const clean = `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`.replace(/\/+/g, "/");
  const route = /\/(?:index)\.html?$/i.test(clean) ? clean.replace(/index\.html?$/i, "") : clean;
  // Keep path separators but encode special characters in each file-name segment
  // so audit routes match URL.pathname and the generated sitemap is valid.
  return route.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export async function createSeoIndexFile(files: WebsiteFile[]): Promise<WebsiteFile> {
  const routes = new Set<string>();
  const ampRoutes = new Set<string>();
  for (const item of files) {
    if (!/\.html?$/i.test(item.path) || /^(?:404|500)\.html?$/i.test(item.path)) continue;
    // Do not advertise intentionally noindexed pages in the generated sitemap.
    const head = await item.file.slice(0, 256 * 1024).text();
    const doc = new DOMParser().parseFromString(head, "text/html");
    const noindex = Array.from(doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]'))
      .some((meta) => /(?:noindex|none)/i.test(meta.getAttribute("content") || ""));
    if (noindex) continue;
    const route = routeForWebsiteFile(item.path) || "/";
    if (/^\/amp(?:\/|$)/i.test(route)) ampRoutes.add(route);
    else routes.add(route);
  }
  const content = JSON.stringify({ version: 1, routes: [...routes], ampRoutes: [...ampRoutes] });
  const file = new File([content], "__pm-seo-index.json", { type: "application/json" });
  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Indeks SEO internal melebihi 5 MiB. Sertakan sitemap.xml sendiri dan kurangi jumlah/path HTML yang terlalu panjang.");
  }
  return { file, path: "__pm-seo-index.json" };
}

async function inspectWebsiteSeo(files: WebsiteFile[]): Promise<SeoAuditReport> {
  const htmlFiles = files.filter((item) => /\.html?$/i.test(item.path));
  const limit = 100;
  const toScan = htmlFiles.slice(0, limit);
  const knownRoutes = new Set<string>();
  for (const item of htmlFiles) {
    const route = routeForWebsiteFile(item.path);
    knownRoutes.add(route || "/");
    knownRoutes.add(route.replace(/\/$/, "") || "/");
  }

  let missingTitles = 0;
  let missingDescriptions = 0;
  let missingH1 = 0;
  let imagesWithoutAlt = 0;
  let duplicateTitles = 0;
  let customAmpScripts = 0;
  let brokenInternalLinks = 0;
  let missingOpenGraph = 0;
  let invalidJsonLd = 0;
  let noindexPages = 0;
  let ampPages = 0;
  let points = 0;
  let earned = 0;
  const titleCounts = new Map<string, number>();
  const issues: SeoAuditIssue[] = [];
  const addIssue = (level: SeoAuditIssue["level"], title: string, detail: string) => {
    if (!issues.some((item) => item.title === title)) issues.push({ level, title, detail });
  };

  for (const item of toScan) {
    if (item.file.size > 2 * 1024 * 1024) {
      addIssue("warning", "File HTML besar", `${item.path} melebihi 2 MiB; audit konten file ini dilewati untuk menjaga performa browser.`);
      continue;
    }
    const html = await item.file.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const path = routeForWebsiteFile(item.path) || "/";
    const isAmp = doc.documentElement.hasAttribute("amp") || doc.documentElement.hasAttribute("⚡") || doc.documentElement.hasAttribute("amp4email") || /<html\b[^>]*(?:\samp(?:\s|=|>)|⚡)/i.test(html);
    if (isAmp) ampPages += 1;

    const title = (doc.querySelector("title")?.textContent || "").trim().replace(/\s+/g, " ");
    points += 1;
    if (title) {
      earned += 1;
      const key = title.toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    } else {
      missingTitles += 1;
      addIssue("critical", "Title belum tersedia", `Tambahkan <title> yang unik dan menjelaskan isi halaman. Contoh: ${item.path}`);
    }

    const description = doc.querySelector('meta[name="description" i]')?.getAttribute("content")?.trim() || "";
    points += 1;
    if (description.length >= 40 && description.length <= 180) earned += 1;
    else {
      missingDescriptions += 1;
      addIssue("warning", "Meta description perlu dilengkapi", `${item.path}: gunakan ringkasan unik yang benar-benar menjelaskan isi halaman (sekitar 40–180 karakter sebagai panduan audit, bukan batas Google).`);
    }

    const h1Count = doc.querySelectorAll("h1").length;
    points += 1;
    if (h1Count === 1) earned += 1;
    else {
      if (h1Count === 0) missingH1 += 1;
      addIssue("warning", h1Count === 0 ? "H1 tidak ditemukan" : "Lebih dari satu H1", `${item.path}: gunakan heading utama yang jelas dan susun heading berikutnya secara logis.`);
    }

    points += 1;
    if (doc.documentElement.getAttribute("lang")?.trim()) earned += 1;
    else addIssue("warning", "Bahasa dokumen belum ditentukan", `${item.path}: tambahkan atribut bahasa yang sesuai, misalnya lang="id".`);

    points += 1;
    if (doc.querySelector('meta[name="viewport" i]')) earned += 1;
    else addIssue("warning", "Viewport mobile belum ditemukan", `${item.path}: tambahkan meta viewport agar layout mobile menyesuaikan lebar perangkat.`);

    const ogTitle = doc.querySelector('meta[property="og:title" i]')?.getAttribute("content")?.trim();
    const ogDescription = doc.querySelector('meta[property="og:description" i]')?.getAttribute("content")?.trim();
    const ogImage = doc.querySelector('meta[property="og:image" i]')?.getAttribute("content")?.trim();
    points += 1;
    if (ogTitle && ogDescription && ogImage) earned += 1;
    else {
      missingOpenGraph += 1;
      addIssue("warning", "Open Graph belum lengkap", `${item.path}: lengkapi og:title, og:description, dan og:image yang sesuai untuk pratinjau tautan sosial. Ini membantu tampilan share, bukan jaminan ranking.`);
    }

    const jsonLdScripts = Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'));
    if (jsonLdScripts.length) {
      let pageJsonLdValid = true;
      for (const script of jsonLdScripts) {
        try { JSON.parse(script.textContent || ""); }
        catch { pageJsonLdValid = false; invalidJsonLd += 1; }
      }
      if (pageJsonLdValid) earned += 1;
      else addIssue("critical", "JSON-LD tidak valid", `${item.path}: ada structured data JSON-LD yang tidak bisa diparse. Perbaiki sintaks; Pages Manager tidak akan mengarang data schema.`);
      points += 1;
    } else {
      addIssue("warning", "Structured data belum ada (opsional)", `${item.path}: pertimbangkan schema yang benar-benar sesuai, misalnya Article, Product, Organization, atau LocalBusiness. Jangan menambahkan rating, harga, atau detail yang tidak nyata.`);
    }

    const robotsContent = doc.querySelector('meta[name="robots" i]')?.getAttribute("content") || "";
    if (/(?:noindex|none)/i.test(robotsContent)) {
      noindexPages += 1;
      addIssue("warning", "Halaman memiliki noindex", `${item.path}: meta robots meminta mesin pencari tidak mengindeks halaman ini. Pastikan ini memang disengaja.`);
    }

    const canonical = doc.querySelector('link[rel~="canonical" i]');
    if (canonical?.getAttribute("href")) earned += 1;
    else addIssue("warning", "Canonical akan dilengkapi saat deploy", `${item.path}: Pages Manager akan menambahkan canonical hanya jika tag tersebut belum ada.`);
    points += 1;

    const images = Array.from(doc.querySelectorAll("img, amp-img"));
    const badImages = images.filter((image) => !image.getAttribute("alt")?.trim()).length;
    imagesWithoutAlt += badImages;
    if (images.length) {
      points += 1;
      if (badImages === 0) earned += 1;
      else addIssue("warning", "Gambar belum memiliki alt text", `${item.path}: ${badImages} gambar tidak memiliki alt yang deskriptif. Isi sesuai gambar sebenarnya; jangan menjejalkan keyword.`);
    }

    if (isAmp) {
      const invalidScripts = Array.from(doc.querySelectorAll("script:not([type='application/ld+json']):not([type='application/json'])"))
        .filter((script) => {
          const src = script.getAttribute("src") || "";
          const customElement = script.getAttribute("custom-element") || "";
          const customTemplate = script.getAttribute("custom-template") || "";
          return !(src.includes("cdn.ampproject.org/v0.js") || (src.includes("cdn.ampproject.org/v0/") && Boolean(customElement || customTemplate)));
        });
      if (invalidScripts.length) {
        customAmpScripts += invalidScripts.length;
        addIssue("critical", "JavaScript non-AMP ditemukan", `${item.path}: AMP tidak mengizinkan JavaScript buatan sendiri melalui script biasa. Gunakan komponen AMP resmi atau pindahkan interaksi ke komponen AMP.`);
      }
      if (!doc.querySelector('style[amp-boilerplate]') || !doc.querySelector('noscript style[amp-boilerplate]')) {
        addIssue("critical", "AMP boilerplate belum lengkap", `${item.path}: AMP memerlukan style amp-boilerplate dan pasangan noscript. Pages Manager tidak menulis ulang CSS AMP karena dapat mengubah tampilan halaman.`);
      }
      if (!doc.querySelector("script[custom-element='amp-analytics']")) {
        // Pages Manager adds its AMP-compliant analytics component on deploy.
      }
    }

    for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
      const href = anchor.getAttribute("href") || "";
      if (!href || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
      try {
        const resolved = new URL(href, `https://seo-audit.invalid${path}`);
        if (resolved.origin !== "https://seo-audit.invalid") continue;
        const target = resolved.pathname;
        const found = knownRoutes.has(target) || knownRoutes.has(target.endsWith("/") ? target.slice(0, -1) : `${target}/`) || knownRoutes.has(`${target.replace(/\/$/, "")}/index.html`) || knownRoutes.has(`${target}.html`);
        if (!found && !/\.(?:xml|pdf|png|jpe?g|webp|svg|gif|css|js|woff2?|ico)$/i.test(target)) brokenInternalLinks += 1;
      } catch { /* Ignore malformed URLs in this advisory check. */ }
    }
  }

  for (const count of titleCounts.values()) if (count > 1) duplicateTitles += count - 1;
  if (duplicateTitles) addIssue("warning", "Judul halaman duplikat", `${duplicateTitles} halaman menggunakan title yang sama. Buat title berbeda dan spesifik untuk tiap halaman.`);
  if (brokenInternalLinks) addIssue("warning", "Periksa tautan internal", `Ditemukan sekitar ${brokenInternalLinks} tautan lokal yang targetnya tidak ditemukan di daftar file upload. Beberapa rute dinamis mungkin memang valid.`);
  if (!files.some((item) => item.path.toLowerCase() === "robots.txt")) addIssue("warning", "robots.txt akan dibuat otomatis", "Saat file robots.txt tidak disediakan, Pages Manager membuat aturan crawl dasar dan menunjuk ke sitemap.");
  if (!files.some((item) => item.path.toLowerCase() === "sitemap.xml")) addIssue("warning", "Sitemap akan dibuat otomatis", "Saat sitemap.xml tidak disediakan, Pages Manager membuat sitemap dari file HTML non-AMP yang diunggah.");
  if (htmlFiles.length > limit) addIssue("warning", "Audit dibatasi", `Diperiksa ${limit} dari ${htmlFiles.length} file HTML untuk menjaga responsivitas browser.`);
  if (ampPages) addIssue("warning", "AMP terdeteksi", `${ampPages} halaman AMP terdeteksi. Tracker khusus AMP akan digunakan; JavaScript tracker biasa tidak disisipkan ke halaman AMP.`);

  const score = points ? Math.round((earned / points) * 100) : 0;
  return {
    score, scanned: toScan.length, totalPages: htmlFiles.length, ampPages,
    missingTitles, missingDescriptions, missingH1, imagesWithoutAlt, duplicateTitles,
    customAmpScripts, brokenInternalLinks, missingOpenGraph, invalidJsonLd, noindexPages, issues: issues.slice(0, 9)
  };
}

export function WebsiteSeoAudit({ files, rotatorEnabled = false }: { files: WebsiteFile[] | null; rotatorEnabled?: boolean }) {
  const [report, setReport] = useState<SeoAuditReport | null>(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    let active = true;
    if (!files?.length) { setReport(null); return; }
    setScanning(true);
    void inspectWebsiteSeo(files).then((result) => { if (active) setReport(result); })
      .catch(() => { if (active) setReport(null); })
      .finally(() => { if (active) setScanning(false); });
    return () => { active = false; };
  }, [files]);
  if (!files?.length) return null;
  return <section className="seo-audit-panel" aria-live="polite">
    <div className="seo-audit-top">
      <div className="seo-audit-mark"><Search size={17}/></div>
      <div className="seo-audit-heading"><b>SEO Expert · Pre-deploy audit</b><small>{scanning ? "Memeriksa metadata, schema JSON-LD, heading, gambar, link internal, dan AMP…" : report ? `${report.scanned} dari ${report.totalPages} halaman HTML diperiksa` : "Audit belum dapat diselesaikan. Anda tetap bisa deploy."}</small></div>
      <div className="seo-score"><strong>{scanning ? "…" : report ? report.score : "—"}</strong><span>Technical check</span></div>
    </div>
    {report && <>
      <div className="seo-metrics">
        <span><b>{report.totalPages}</b><small>HTML pages</small></span>
        <span><b>{report.ampPages}</b><small>AMP pages</small></span>
        <span><b>{report.missingTitles}</b><small>Missing titles</small></span>
        <span><b>{report.missingDescriptions}</b><small>Missing descriptions</small></span>
        <span><b>{report.missingOpenGraph}</b><small>Open Graph gaps</small></span>
        <span><b>{report.invalidJsonLd}</b><small>Invalid JSON-LD</small></span>
        <span><b>{report.noindexPages}</b><small>Intentional noindex</small></span>
      </div>
      <div className="seo-managed-note"><ShieldCheck size={14}/><span>Deploy otomatis: canonical yang belum ada, sitemap.xml, robots.txt, pasangan AMP/canonical, analytics AMP, dan noindex untuk preview branch.</span></div>
      {rotatorEnabled && <div className="seo-rotator-warning"><b>Perhatian SEO: Traffic Rotator sedang aktif</b><span>Domain produksi mengirim HTTP 302 ke target yang dapat berubah. Branch alias preview diberi X-Robots-Tag: noindex agar tidak menjadi salinan pesaing. Kombinasi ini tidak ideal untuk ranking organik karena Google dapat mengikuti redirect menuju halaman noindex. Untuk domain yang ingin tumbuh di Google, nonaktifkan rotator di domain utama dan sajikan konten SEO stabil dari production branch. Rotator tetap bisa dipakai untuk campaign atau eksperimen pada domain terpisah.</span></div>}
      {report.issues.length > 0 && <div className="seo-issues">{report.issues.map((issue) => <div className={`seo-issue ${issue.level}`} key={issue.title}><b>{issue.title}</b><small>{issue.detail}</small></div>)}</div>}
      <p className="seo-disclaimer">Skor ini adalah audit teknis lokal, bukan skor Google atau prediksi ranking. Halaman noindex yang disengaja ditandai sebagai peringatan. Title, deskripsi, schema, isi konten, dan alt gambar harus sesuai fakta; Pages Manager tidak membuat klaim bisnis atau ulasan palsu.</p>
    </>}
  </section>;
}

export function computeWebsiteHashes(
  files: WebsiteFile[],
  onProgress: (processedFiles: number, totalFiles: number, processedBytes: number, totalBytes: number) => void
): Promise<Array<{ path: string; hash: string }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../../asset-hash.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === "progress") onProgress(message.processedFiles, message.totalFiles, message.processedBytes, message.totalBytes);
      if (message?.type === "complete") { worker.terminate(); resolve(message.hashes as Array<{ path: string; hash: string }>); }
      if (message?.type === "error") { worker.terminate(); reject(new Error(message.error || "Gagal menghitung checksum file.")); }
    };
    worker.onerror = () => { worker.terminate(); reject(new Error("Worker checksum gagal dijalankan. Muat ulang dashboard lalu coba kembali.")); };
    worker.postMessage({ files: files.map(({ file, path }) => ({ file, path })) });
  });
}

