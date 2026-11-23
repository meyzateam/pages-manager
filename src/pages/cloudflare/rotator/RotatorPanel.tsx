import type { Dispatch, SetStateAction } from "react";
import { Check, Cloud, Copy, ExternalLink, GripVertical, Link2, Plus, RefreshCw, ShieldCheck, Trash2, Upload, Zap } from "lucide-react";
import type { Deployment, Project, RotatorConfig, RotatorTarget, WebsiteFile } from "../../../shared/types";
import { FileDropzone, WebsiteSeoAudit } from "../deployments/UploadComponents";
import { deploymentStatus as getDeploymentStatus } from "../../../shared/project-utils";
import type { WorkspaceTab } from "../../../app/routes";

type Props = {
  selected: string;
  selectedProject?: Project;
  rotator: RotatorConfig;
  setRotator: Dispatch<SetStateAction<RotatorConfig>>;
  busy: boolean;
  replaceFunctions: boolean;
  setReplaceFunctions: Dispatch<SetStateAction<boolean>>;
  edgeBranch: string;
  setEdgeBranch: Dispatch<SetStateAction<string>>;
  edgeFiles: WebsiteFile[] | null;
  setEdgeFiles: Dispatch<SetStateAction<WebsiteFile[] | null>>;
  setError: (message: string) => void;
  deployEdge: () => void;
  generateEdgeName: () => void;
  directTargetUrl: string;
  setDirectTargetUrl: Dispatch<SetStateAction<string>>;
  directTargetLabel: string;
  setDirectTargetLabel: Dispatch<SetStateAction<string>>;
  addDirectTarget: () => void;
  deployments: Deployment[];
  draggingTargetIndex: number | null;
  setDraggingTargetIndex: Dispatch<SetStateAction<number | null>>;
  moveTarget: (fromIndex: number, toIndex: number) => void;
  updateTarget: (index: number, patch: Partial<RotatorTarget>) => void;
  copyValue: (value: string) => void;
  saveRotator: () => void;
  branchUrl: (projectName: string, branch: string) => string;
  projectUrl: (project: Project | { name: string }) => string;
  onNavigate: (tab: WorkspaceTab, projectNameOverride?: string, replace?: boolean) => void;
};

export function RotatorPanel({
  selected, selectedProject, rotator, setRotator, busy, replaceFunctions,
  setReplaceFunctions, edgeBranch, setEdgeBranch, edgeFiles, setEdgeFiles,
  setError, deployEdge, generateEdgeName, directTargetUrl, setDirectTargetUrl,
  directTargetLabel, setDirectTargetLabel, addDirectTarget, deployments,
  draggingTargetIndex, setDraggingTargetIndex, moveTarget, updateTarget,
  copyValue, saveRotator, branchUrl, projectUrl, onNavigate
}: Props) {
  return (
    <>
            <section className="page-heading">
              <div><span className="eyebrow">PROJECT / EDGE ROUTING</span><h1>Traffic URL rotator</h1><p>Domain utama menjadi pintu masuk. Pages Worker memilih branch alias dari project ini atau URL HTTPS dari project Pages/domain lain, lalu mengirim HTTP 302.</p><a className="branch-link" href={projectUrl(selectedProject || { name: selected })} target="_blank" rel="noreferrer">https://{selected}.pages.dev <ExternalLink size={12}/></a></div>
              <label className="toggle-control"><input type="checkbox" checked={rotator.enabled} onChange={(event) => setRotator({ ...rotator, enabled: event.target.checked })}/><span className="toggle-ui"/><b>{rotator.enabled ? "Enabled" : "Disabled"}</b></label>
            </section>
            {rotator.enabled && <div className="seo-rotator-warning"><b>SEO warning · Production redirects are not stable</b><span>Setiap request HTML pada domain utama dapat diarahkan ke edge/URL berbeda dengan HTTP 302. Edge branch preview dikirim dengan noindex. Jangan aktifkan pola ini pada domain yang menjadi target ranking organik utama. Gunakan rotator untuk distribusi campaign/eksperimen dan domain produksi SEO yang stabil untuk Google.</span></div>}

            <section className="panel edge-create-panel">
              <div className="panel-heading"><div><h3><Plus size={17}/> Create edge subdomain</h3><p>Buat alias branch seperti <b>namabranch.{selected}.pages.dev</b> dengan men-deploy landing page ke preview branch project yang sama.</p></div><span className="subtle-tag">SAME PAGES PROJECT</span></div>
              <div className="edge-create-grid">
                <div>
                  <label htmlFor="edge-branch-name">Edge name / branch alias</label>
                  <div className="edge-name-row"><input id="edge-branch-name" value={edgeBranch} onChange={(event) => setEdgeBranch(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 51))} placeholder="Masukkan nama branch atau klik Random"/><button className="button secondary-button" type="button" onClick={generateEdgeName}><RefreshCw size={14}/> Random</button></div>
                  <small>{edgeBranch ? <>Hasil alamat: <b>https://{edgeBranch}.{selected}.pages.dev</b>. Ini adalah preview branch di dalam project yang sama.</> : "Isi nama branch sesuai keinginan, atau klik Random untuk membuat nama acak."}</small>
                </div>
                <div>
                  <label>Landing page files / folder</label>
                  <FileDropzone id="edge-website-files" files={edgeFiles} onChange={setEdgeFiles} onError={setError} disabled={busy} hint="Drop file atau satu folder landing page. index.html harus berada di root."/>
                  <WebsiteSeoAudit files={edgeFiles} rotatorEnabled={rotator.enabled}/>
                </div>
              </div>
              {selectedProject?.uses_functions && !selectedProject?.manager_worker_installed && <div className="info-banner function-warning"><ShieldCheck size={18}/><div><b>Project ini memakai Pages Functions yang belum dikelola Pages Manager</b><p>Deploy rotator memakai Advanced Mode `_worker.js`, yang akan mengambil alih routing dan mengabaikan folder `/functions`. Setujui hanya bila fungsi tersebut memang ingin diganti.</p><label className="replace-functions"><input type="checkbox" checked={replaceFunctions} onChange={(event) => setReplaceFunctions(event.target.checked)}/> Saya paham dan mengizinkan migrasi Pages Functions ke Worker Pages Manager.</label></div></div>}
              <div className="deploy-actions"><button className="button primary-button" disabled={busy || !edgeBranch.trim() || !edgeFiles?.length || (selectedProject?.uses_functions && !selectedProject?.manager_worker_installed && !replaceFunctions)} onClick={deployEdge}><Upload size={16}/> Deploy edge & add to rotator</button><span className="helper-inline"><ShieldCheck size={14}/> Akan dibuat sebagai preview branch, bukan project baru.</span></div>
            </section>

            <section className="panel">
              <div className="panel-heading"><div><h3><Link2 size={17}/> Add direct URL target</h3><p>Tambahkan project Pages lain (misalnya project-name.pages.dev), custom domain, atau URL HTTPS lain yang Anda kelola.</p></div><span className="subtle-tag">DIRECT URL</span></div>
              <div className="edge-create-grid"><div><label htmlFor="direct-target-url">Destination URL</label><input id="direct-target-url" type="url" value={directTargetUrl} onChange={(event) => setDirectTargetUrl(event.target.value)} placeholder="https://halamanutamasatu.pages.dev"/></div><div><label htmlFor="direct-target-label">Label (optional)</label><input id="direct-target-label" value={directTargetLabel} onChange={(event) => setDirectTargetLabel(event.target.value)} placeholder="Project pendamping 1"/></div></div>
              <div className="deploy-actions"><button className="button secondary-button" type="button" disabled={!directTargetUrl.trim()} onClick={addDirectTarget}><Plus size={16}/> Add URL target</button><span className="helper-inline">HTTPS required. Pastikan Anda memiliki otorisasi untuk target.</span></div>
            </section>
            <section className="panel">
              <div className="panel-heading"><div><h3><RefreshCw size={17}/> Rotator configuration</h3><p>Setiap kunjungan ke domain produksi dapat diarahkan ke salah satu target aktif di bawah.</p></div></div>
              <label htmlFor="rotator-mode">Distribution mode</label>
              <select id="rotator-mode" className="mode-select" value={rotator.mode} onChange={(event) => setRotator({ ...rotator, mode: event.target.value as RotatorConfig["mode"] })}>
                <option value="random">Random — pilih edge secara acak</option><option value="weighted">Weighted random — acak mengikuti bobot</option><option value="round-robin">Round robin — bergiliran</option>
              </select>
              <div className="section-toolbar target-toolbar"><div><h3>Rotator destinations / Targets</h3><p>Tarik kartu dengan handle grip untuk mengatur urutan target. Simpan konfigurasi setelah selesai.</p></div><span className="subtle-tag">{rotator.targets.length} EDGE(S)</span></div>
              {rotator.targets.length ? <div className="target-list">{rotator.targets.map((target, index) => {
                const isDirectUrl = target.kind === "url" || Boolean(target.url);
                const destination = isDirectUrl ? target.url : branchUrl(selected, target.branch);
                const branchHost = `${target.branch}.${selected}.pages.dev`;
                const latestDeployment = deployments.filter((deployment) => (deployment.aliases || []).some((alias) => {
                  try { return new URL(alias.startsWith("http") ? alias : `https://${alias}`).hostname.toLowerCase() === branchHost; } catch { return false; }
                })).sort((a, b) => String(b.created_on || "").localeCompare(String(a.created_on || "")))[0];
                const deploymentStatus = isDirectUrl ? "external-url" : (getDeploymentStatus(latestDeployment) || "alias-not-published");
                const ready = isDirectUrl || deploymentStatus === "success";
                return <div className={`target-card ${draggingTargetIndex === index ? "dragging" : ""}`} key={`${target.url || target.branch}-${index}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); const from = Number(event.dataTransfer.getData("text/plain")); if (Number.isInteger(from)) moveTarget(from, index); setDraggingTargetIndex(null); }}>
                  <div className="target-card-top"><span className="drag-handle" title="Drag untuk mengubah urutan" draggable onDragStart={(event) => { setDraggingTargetIndex(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }} onDragEnd={() => setDraggingTargetIndex(null)}><GripVertical size={18}/></span><div className="target-symbol"><Link2 size={17}/></div><div className="target-label">{target.label || (isDirectUrl ? new URL(destination).hostname : target.branch)}<small>{destination.replace(/^https:\/\//, "")} · {isDirectUrl ? "Direct HTTPS destination" : ready ? "Cloudflare branch alias verified" : `Deployment ${deploymentStatus}`}</small></div><span className={`status-pill ${ready ? "success" : "unknown"}`}>{ready ? "Ready" : "Check"}</span><label className="target-enable"><input type="checkbox" checked={target.enabled} onChange={(event) => updateTarget(index, { enabled: event.target.checked })}/> Active</label><button className="icon-button delete-target" onClick={() => setRotator({ ...rotator, targets: rotator.targets.filter((_, targetIndex) => targetIndex !== index) })} title="Remove target"><Trash2 size={16}/></button></div>
                  <div className="target-fields edge-target-fields"><div><label>{isDirectUrl ? "Destination URL" : "Branch alias"}</label><input value={isDirectUrl ? target.url : target.branch} readOnly aria-readonly="true"/></div><div className="weight-field"><label>Weight</label><input type="number" min="0" max="1000" value={target.weight} onChange={(event) => updateTarget(index, { weight: Number(event.target.value) })}/></div><div className="edge-status-note"><small>{isDirectUrl ? "Direct HTTPS URL target; can be a separate Pages project or another website." : "Alias dari deployment branch pada project Cloudflare Pages ini."}</small></div></div>
                  <div className="target-footer"><a href={destination} target="_blank" rel="noreferrer" className="branch-link">{destination} <ExternalLink size={12}/></a><div className="target-actions"><button className="text-button" onClick={() => copyValue(destination)}><Copy size={13}/> Copy URL</button>{!isDirectUrl && <button className="text-button" onClick={() => { setEdgeBranch(target.branch); onNavigate("rotator", selected); }}><RefreshCw size={13}/> Redeploy branch</button>}</div></div>
                </div>;
              })}</div> : <div className="empty-targets"><Link2 size={24}/><b>Belum ada rotator target</b><span>Deploy branch alias dari panel atau tambahkan direct HTTPS URL project lain.</span></div>}
              <div className="rotator-footer"><button className="button primary-button" disabled={busy} onClick={saveRotator}><Check size={16}/> Save rotator configuration</button><span className="helper-inline">{rotator.targets.filter((target) => target.enabled).length} active target(s)</span></div>
            </section>
            <div className="info-banner"><Zap size={18}/><div><b>Alur traffic yang dimaksud</b><p><b>https://{selected}.pages.dev</b> adalah domain induk. Worker pada production branch (`{selectedProject?.production_branch || "main"}`) memilih target secara random, lalu mengirim HTTP 302 menuju <b>https://namabranch.{selected}.pages.dev</b> atau branch alias lain yang aktif. Semua edge tetap berada di project Cloudflare Pages yang sama.</p><p>Setiap edge harus dibuat sebagai preview branch dan memiliki deployment berstatus <b>Success</b>. Setelah semua edge siap, simpan konfigurasi. Jika production branch belum pernah di-deploy melalui Pages Manager, deploy branch produksi sekali agar Worker router terpasang.</p></div></div>

    </>
  );
}
