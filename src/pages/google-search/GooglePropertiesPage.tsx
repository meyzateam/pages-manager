import { ExternalLink, Globe, RefreshCw, Search, ShieldCheck } from "lucide-react";
import type { GscListedProperty, Project } from "../../shared/types";
import { formatNumber } from "../../shared/format";

function permissionLabel(value: string) {
  if (value === "siteOwner") return "Owner";
  if (value === "siteFullUser") return "Full user";
  if (value === "siteRestrictedUser") return "Restricted user";
  return "Unverified";
}

export function GooglePropertiesPage({
  connected, email, properties, cloudflareProjects, busy, onRefresh, onSettings, onOpenProject
}: {
  connected: boolean;
  email: string;
  properties: GscListedProperty[];
  cloudflareProjects: Project[];
  busy: boolean;
  onRefresh: () => void;
  onSettings: () => void;
  onOpenProject: (projectName: string) => void;
}) {
  const owners = properties.filter((item) => item.permission_level === "siteOwner").length;
  const fullUsers = properties.filter((item) => item.permission_level === "siteFullUser").length;
  const urlPrefix = properties.filter((item) => item.property_type === "url-prefix").length;
  return <>
    <section className="page-heading">
      <div><span className="eyebrow">GOOGLE SEARCH / PROPERTY INVENTORY</span><h1>Google Search properties</h1><p>Daftar seluruh property yang dapat diakses oleh akun Google terpilih, termasuk property yang tidak dibuat melalui Pages Manager.</p></div>
      <div className="toolbar-actions"><button className="button secondary-button" onClick={onSettings}><ShieldCheck size={15}/> Account settings</button><button className="button primary-button" disabled={!connected || busy} onClick={onRefresh}><RefreshCw size={15}/> Refresh properties</button></div>
    </section>
    {connected ? <>
      <div className="info-banner"><Globe size={18}/><div><b>{email}</b><p>Property diambil langsung dari Google Search Console API. Akses dan peran ditampilkan sesuai akun yang dipilih di Settings.</p></div></div>
      <div className="stats-grid four">
        <div className="stat-card"><span>Total properties</span><strong>{formatNumber(properties.length)}</strong><small>Accessible in Search Console</small></div>
        <div className="stat-card"><span>Owner</span><strong>{formatNumber(owners)}</strong><small>Can manage ownership</small></div>
        <div className="stat-card"><span>Full user</span><strong>{formatNumber(fullUsers)}</strong><small>Full property access</small></div>
        <div className="stat-card"><span>URL-prefix</span><strong>{formatNumber(urlPrefix)}</strong><small>URL-prefix properties</small></div>
      </div>
      <section className="panel">
        <div className="panel-heading"><div><h3><Globe size={17}/> Property inventory</h3><p>Daftar disinkronkan saat halaman dibuka atau tombol refresh ditekan.</p></div><span className="subtle-tag">{properties.length} PROPERTIES</span></div>
        {properties.length ? <div className="table-scroll"><table className="visitor-table gsc-properties-table"><thead><tr><th>Property</th><th>Type</th><th>Permission</th><th>Pages Manager</th><th>Google Search Console</th><th>Action</th></tr></thead><tbody>{properties.map((property) => {
          const linkedProject = cloudflareProjects.find((project) => project.name === property.linked_project);
          return <tr key={property.site_url}>
          <td><b>{property.site_url}</b></td>
          <td>{property.property_type === "domain" ? "Domain" : "URL-prefix"}</td>
          <td><span className={`status-pill ${property.permission_level === "siteOwner" ? "success" : property.permission_level === "siteFullUser" ? "checking" : "unknown"}`}>{permissionLabel(property.permission_level)}</span></td>
          <td>{linkedProject ? <span className="status-pill success">{linkedProject.name}</span> : <span className="muted-empty compact">Not linked to selected Cloudflare account</span>}</td>
          <td>{property.search_console_status === "added" ? "Managed" : "Available"}{property.sitemap_status === "submitted" ? " · Sitemap submitted" : ""}</td>
          <td><div className="table-row-actions">{linkedProject && <button className="button secondary-button small-button" onClick={() => onOpenProject(linkedProject.name)}>Manage</button>}<a className="icon-button" title="Open in Google Search Console" href={`https://search.google.com/search-console?resource_id=${encodeURIComponent(property.site_url)}`} target="_blank" rel="noreferrer"><ExternalLink size={15}/></a></div></td>
        </tr>;
        })}</tbody></table></div> : <div className="empty-state"><Search size={25}/><h3>No properties found</h3><p>Akun Google ini belum mempunyai property yang bisa diakses atau Google mengembalikan daftar kosong.</p></div>}
      </section>
    </> : <section className="panel empty-state"><Globe size={28}/><h3>Connect a Google account</h3><p>Hubungkan akun Google melalui Settings untuk menarik semua property Search Console.</p><button className="button primary-button" onClick={onSettings}>Open Settings</button></section>}
  </>;
}
