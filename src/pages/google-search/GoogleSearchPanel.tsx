import { Activity, BarChart3, Check, ExternalLink, Eye, Globe, Link2, Plus, RefreshCw, Search, Settings, ShieldCheck } from "lucide-react";
import type { GscPerformance, GscStatus } from "../../shared/types";
import { StatCard } from "../cloudflare/analytics/AnalyticsPanel";

function formatNumber(value: number) { return new Intl.NumberFormat("id-ID").format(Number(value || 0)); }
function formatDateTime(value?: string) {
  if (!value) return "—";
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

export function GoogleSearchPanel({
  project, status, performance, inspectionUrl, setInspectionUrl, inspection,
  busy, workerInstalled, onSettings, onPrepare, onVerify, onSubmitSitemap,
  onLoadPerformance, onInspect
}: {
  project: string;
  status: GscStatus;
  performance: GscPerformance | null;
  inspectionUrl: string;
  setInspectionUrl: (value: string) => void;
  inspection: any;
  busy: boolean;
  workerInstalled: boolean;
  onSettings: () => void;
  onPrepare: () => void;
  onVerify: () => void;
  onSubmitSitemap: () => void;
  onLoadPerformance: () => void;
  onInspect: () => void;
}) {
  const property = status.property;
  const indexResult = inspection?.indexStatusResult || {};
  const total = performance?.totals || {};
  return <>
    <div className="page-heading analytics-heading">
      <div><span className="eyebrow">PROJECT / GOOGLE SEARCH</span><h1>Google Search Console</h1><p>Property website, verifikasi kepemilikan, sitemap, dan performa Google Search untuk project ini.</p></div>
      <a className="button secondary-button" href="https://search.google.com/search-console" target="_blank" rel="noreferrer"><ExternalLink size={15}/> Open Search Console</a>
    </div>
    <section className="panel">
      <div className="panel-heading"><div><h3><Globe size={17}/> Active Google account</h3><p>Akun aktif dipilih secara terpusat melalui Settings dan digunakan oleh semua fitur Google Search.</p></div><div className="gsc-account-actions"><span className={`status-pill ${status.connected ? "success" : "unknown"}`}>{status.connected ? "Connected" : "Not connected"}</span><button className="button secondary-button" disabled={busy} onClick={onSettings}><Settings size={15}/> Google account settings</button></div></div>
      {status.connected ? <div className="info-banner"><ShieldCheck size={18}/><div><b>{status.google_email || "Google account connected"}</b><p>Akun aktif dikelola secara terpusat melalui Settings. Untuk mengganti atau menambahkan akun, buka Settings → Google Search Console accounts.</p></div></div> : <div className="empty-state"><Globe size={26}/><h3>Google account not connected</h3><p>Hubungkan akun Google melalui Settings untuk menyiapkan property dan sitemap.</p><button className="button primary-button" disabled={busy} onClick={onSettings}><Settings size={15}/> Open Settings</button></div>}
    </section>
    {status.connected && <>
      <section className="panel">
        <div className="panel-heading"><div><h3><ShieldCheck size={17}/> Website property</h3><p>Property URL-prefix dibuat dan diverifikasi otomatis memakai Google Site Verification FILE method.</p></div><span className={`status-pill ${property?.verification_status === "verified" ? "success" : property ? "checking" : "unknown"}`}>{property?.verification_status === "verified" ? "Verified" : property ? "Pending verification" : "Not registered"}</span></div>
        {!property ? <>
          <div className="info-banner"><Globe size={18}/><div><b>Property yang akan didaftarkan</b><p>https://{project}.pages.dev/</p><p>Versi awal mengelola URL-prefix property untuk domain production Pages. Property Domain `sc-domain:` memerlukan verifikasi DNS di domain yang benar-benar Anda miliki.</p></div></div>
          <button className="button primary-button" disabled={busy} onClick={onPrepare}><Plus size={15}/> Prepare Google property</button>
        </> : <>
          <div className="gsc-property-summary"><b>{property.site_url}</b>{property.verification_file && <small>Verification file: <a href={new URL(property.verification_file, property.site_url).toString()} target="_blank" rel="noreferrer">{property.verification_file}</a></small>}<small>Sitemap: {property.sitemap_url}</small></div>
          {property.verification_status !== "verified" ? <>
            {!workerInstalled && <div className="info-banner function-warning"><ShieldCheck size={18}/><div><b>Perlu satu kali deploy melalui Pages Manager v2.7.0 atau lebih baru</b><p>Worker pada website ini belum memiliki handler untuk file verifikasi Google. Deploy project melalui dashboard v2.7.0 atau lebih baru, lalu klik Verify property.</p></div></div>}
            {workerInstalled && <div className="info-banner"><Check size={18}/><div><b>Verification file sudah disiapkan</b><p>Pages Worker akan menyajikan file verifikasi hanya ketika Google meminta URL file tersebut. Tidak ada fetch tambahan pada kunjungan halaman biasa.</p></div></div>}
            <button className="button primary-button" disabled={busy || !workerInstalled} onClick={onVerify}><ShieldCheck size={15}/> Verify property & submit sitemap</button>
          </> : property.search_console_status !== "added" ? <>
            <div className="info-banner function-warning"><ShieldCheck size={18}/><div><b>Kepemilikan terverifikasi, property belum tersinkron ke Search Console</b><p>Verifikasi Google berhasil, tetapi pendaftaran property Search Console belum selesai. Tekan tombol di bawah untuk mencoba sinkronisasi ulang tanpa mengulang verifikasi.</p></div></div>
            <button className="button primary-button" disabled={busy} onClick={onVerify}><RefreshCw size={15}/> Sync property & submit sitemap</button>
          </> : <>
            <div className="info-banner"><Check size={18}/><div><b>Property terverifikasi dan terdaftar di Search Console</b><p>Sitemap terakhir: {property.sitemap_status === "submitted" ? formatDateTime(property.sitemap_submitted_at) : "belum dikirim"}. Pengiriman sitemap meminta Google menemukan URL, bukan menjamin crawl atau indexing.</p></div></div>
            <div className="deploy-actions"><button className="button secondary-button" disabled={busy} onClick={onSubmitSitemap}><RefreshCw size={15}/> Submit sitemap again</button><a className="button secondary-button" href={`https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(property.site_url)}`} target="_blank" rel="noreferrer"><ExternalLink size={15}/> View sitemap status</a></div>
          </>}
        </>}
      </section>
      {property?.verification_status === "verified" && <>
        <section className="panel">
          <div className="panel-heading"><div><h3><Search size={17}/> URL Inspection</h3><p>Memeriksa status URL pada indeks Google. Ini bukan permintaan indexing ulang.</p></div></div>
          <div className="form-grid"><div><label htmlFor="gsc-inspect-url">Full page URL</label><input id="gsc-inspect-url" type="url" value={inspectionUrl} onChange={(event) => setInspectionUrl(event.target.value)} placeholder={`https://${project}.pages.dev/halaman/`}/></div><div className="deploy-actions"><button className="button primary-button" disabled={busy || !inspectionUrl.trim()} onClick={onInspect}><Search size={15}/> Inspect URL</button><a className="button secondary-button" href={`https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(property.site_url)}&id=${encodeURIComponent(inspectionUrl)}`} target="_blank" rel="noreferrer"><ExternalLink size={15}/> Open Google inspection</a></div></div>
          {inspection && <div className="gsc-inspection-results"><b>Index verdict: {indexResult.verdict || "Unknown"}</b><div className="gsc-metadata-grid"><span>Indexing state<strong>{indexResult.indexingState || "—"}</strong></span><span>Coverage<strong>{indexResult.coverageState || "—"}</strong></span><span>Robots.txt<strong>{indexResult.robotsTxtState || "—"}</strong></span><span>Page fetch<strong>{indexResult.pageFetchState || "—"}</strong></span><span>Google canonical<strong>{indexResult.googleCanonical || "—"}</strong></span><span>User canonical<strong>{indexResult.userCanonical || "—"}</strong></span></div></div>}
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h3><BarChart3 size={17}/> Google Search performance</h3><p>Data klik, impressions, CTR, posisi rata-rata, dan query dari Search Console API. Google biasanya menerbitkan data dengan jeda beberapa hari.</p></div><button className="button secondary-button" disabled={busy} onClick={onLoadPerformance}><RefreshCw size={15}/> Refresh performance</button></div>
          {performance ? <>
            <div className="stats-grid four">
              <StatCard icon={Link2} label="Clicks" value={formatNumber(total.clicks || 0)} helper="Organic clicks"/>
              <StatCard icon={Eye} label="Impressions" value={formatNumber(total.impressions || 0)} helper="Search result impressions"/>
              <StatCard icon={Activity} label="CTR" value={`${((Number(total.ctr || 0)) * 100).toFixed(2)}%`} helper="Clicks / impressions"/>
              <StatCard icon={BarChart3} label="Avg. position" value={Number(total.position || 0).toFixed(1)} helper="Lower number is better"/>
            </div>
            <div className="gsc-date-note">Data period: {performance.start_date} – {performance.end_date}</div>
            <div className="table-scroll"><table className="visitor-table"><thead><tr><th>Search query</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th></tr></thead><tbody>{performance.queries.map((row, i) => <tr key={`${row.keys?.[0] || "query"}-${i}`}><td>{row.keys?.[0] || "—"}</td><td>{formatNumber(row.clicks || 0)}</td><td>{formatNumber(row.impressions || 0)}</td><td>{((Number(row.ctr || 0)) * 100).toFixed(2)}%</td><td>{Number(row.position || 0).toFixed(1)}</td></tr>)}</tbody></table>{!performance.queries.length && <div className="muted-empty">Belum ada data query pada periode ini. Pastikan Google sudah memproses data website.</div>}</div>
          </> : <div className="muted-empty">Klik Refresh performance untuk mengambil data organik dari Google.</div>}
        </section>
      </>}
    </>}
    <p className="privacy-note"><ShieldCheck size={15}/> Informasi koneksi, pengelolaan akun, dan keamanan kredensial tersedia di Settings.</p>
  </>;
}

