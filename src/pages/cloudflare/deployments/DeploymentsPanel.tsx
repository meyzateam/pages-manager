import type { Dispatch, SetStateAction } from "react";
import { ArrowUpRight, Cloud, ExternalLink, Globe, History, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import type { Deployment, Project, WebsiteFile } from "../../../shared/types";
import { deploymentStatus, projectUrl } from "../../../shared/project-utils";
import { FileDropzone, WebsiteSeoAudit } from "./UploadComponents";

type Props = {
  selected: string;
  selectedProject?: Project;
  selectedProjectIsLive: boolean;
  rotatorEnabled: boolean;
  removeProject: (name: string) => void;
  replaceFunctions: boolean;
  setReplaceFunctions: Dispatch<SetStateAction<boolean>>;
  files: WebsiteFile[] | null;
  setFiles: Dispatch<SetStateAction<WebsiteFile[] | null>>;
  setError: (message: string) => void;
  busy: boolean;
  branch: string;
  setBranch: Dispatch<SetStateAction<string>>;
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  deploy: () => void;
  deployments: Deployment[];
  normalizeUrl: (value?: string) => string;
  formatNumber: (value: number) => string;
  formatDateTime: (value?: string) => string;
  loadProjectData: (name: string) => Promise<void> | void;
  autoAddGsc: boolean;
  setAutoAddGsc: (value: boolean) => void;
  googleConnected: boolean;
  googleEmail: string;
  onOpenSettings: () => void;
};

export function DeploymentsPanel({
  selected, selectedProject, selectedProjectIsLive, rotatorEnabled, removeProject,
  replaceFunctions, setReplaceFunctions, files, setFiles, setError, busy,
  branch, setBranch, message, setMessage, deploy, deployments,
  normalizeUrl: normalizeDeploymentUrl, formatNumber: formatCount,
  formatDateTime: formatDeploymentDate, loadProjectData,
  autoAddGsc, setAutoAddGsc, googleConnected, googleEmail, onOpenSettings
}: Props) {
  return (
    <>
            <section className="project-hero">
              <div><span className="eyebrow">PROJECT / DIRECT UPLOAD</span><h1>{selected}</h1><p>Deploy folder hasil build. Pages Worker, dual analytics HTML/AMP, dan SEO technical layer otomatis disertakan.</p>{selectedProjectIsLive && selectedProject ? <a href={projectUrl(selectedProject)} target="_blank" rel="noreferrer">{projectUrl(selectedProject)} <ArrowUpRight size={15}/></a> : <span className="project-domain">Belum ada URL produksi aktif — deploy folder website terlebih dahulu.</span>}</div>
              <div className="hero-actions">{selectedProjectIsLive && selectedProject && <a className="button secondary-button" href={projectUrl(selectedProject)} target="_blank" rel="noreferrer"><ExternalLink size={15}/> Open production</a>}<button className="button danger-button" onClick={() => removeProject(selected)}><Trash2 size={15}/> Delete project</button></div>
            </section>
            {!selectedProjectIsLive && <div className="info-banner"><Cloud size={18}/><div><b>Website belum memiliki deployment produksi</b><p>Alamat https://{selected}.pages.dev belum akan menampilkan website sebelum file website berhasil di-deploy ke branch produksi <b>{selectedProject?.production_branch || "main"}</b>. Pilih folder hasil build yang langsung berisi <b>index.html</b>, lalu jalankan Deploy files.</p></div></div>}
            <section className="panel deploy-panel">
              <div className="panel-heading"><div><h3><Upload size={17}/> Deploy website files</h3><p>Pilih folder hasil build yang berisi index.html di root. File HTML akan diproses SEO technical layer dan analytics yang sesuai (HTML biasa atau AMP); `_worker.js` dipasang untuk rotator edge.</p></div><span className="subtle-tag">DIRECT UPLOAD</span></div>
              {selectedProject?.uses_functions && !selectedProject?.manager_worker_installed && <div className="info-banner function-warning"><ShieldCheck size={18}/><div><b>Project ini memakai Pages Functions</b><p>Advanced mode `_worker.js` akan mengambil alih routing dan mengabaikan folder `/functions`. Jangan lanjutkan kecuali Anda memang ingin mengganti fungsi yang ada.</p><label className="replace-functions"><input type="checkbox" checked={replaceFunctions} onChange={(event) => setReplaceFunctions(event.target.checked)}/> Saya paham dan mengizinkan Pages Manager mengganti Pages Functions yang ada.</label></div></div>}
              <label>Website files / folder</label>
              <small>Pilih file website satu per satu atau folder output yang langsung berisi `index.html` (misalnya `dist` atau `build`). Nama folder pembungkus dilepas otomatis.</small>
              <FileDropzone id="website-files" files={files} onChange={setFiles} onError={setError} disabled={busy} hint="Lepaskan file-file website atau satu folder di area ini. index.html harus berada di root."/>
              <WebsiteSeoAudit files={files} rotatorEnabled={rotatorEnabled}/>
              <div className="google-deploy-option">
                <label className="google-deploy-toggle"><input type="checkbox" checked={autoAddGsc} onChange={(event) => setAutoAddGsc(event.target.checked)}/><span><b><Globe size={16}/> Add property to Google Search Console</b><small>Default aktif. Setelah deployment production berhasil, Pages Manager menyiapkan verifikasi property dan mengirim sitemap secara otomatis.</small></span></label>
                <div className="google-deploy-state">{googleConnected ? <span className="status-pill success">{googleEmail}</span> : <><span className="status-pill unknown">Google not connected</span><button type="button" className="text-button" onClick={onOpenSettings}>Connect in Settings</button></>}</div>
              </div>
              <div className="form-grid"><div><label htmlFor="deploy-branch">Deploy branch</label><input id="deploy-branch" value={branch} onChange={(event) => setBranch(event.target.value.toLowerCase())} placeholder="main"/><small>Gunakan `main` untuk produksi atau branch acak/custom untuk subdomain preview.</small></div><div><label htmlFor="deploy-message">Deployment message</label><input id="deploy-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Update website"/><small>{files?.length ? `${formatCount(files.length)} file dipilih` : "Maksimal 20.000 file; 25 MiB per file dan 90 MiB total."}</small></div></div>
              <div className="deploy-actions"><button className="button primary-button" disabled={busy || !files?.length || (selectedProject?.uses_functions && !selectedProject?.manager_worker_installed && !replaceFunctions)} onClick={deploy}>{busy ? <LoaderCircle className="spin" size={16}/> : <Upload size={16}/>} Deploy files</button><span className="helper-inline"><ShieldCheck size={14}/> Pages Worker included automatically</span></div>
            </section>
            <section className="panel">
              <div className="panel-heading"><div><h3><History size={17}/> Recent deployments</h3><p>Alamat deployment yang diberikan Cloudflare Pages.</p></div><button className="button secondary-button" onClick={() => void loadProjectData(selected)}><RefreshCw size={15}/> Refresh</button></div>
              {deployments.length ? <div className="deployment-list">{deployments.map((deployment) => {
                const deploymentUrl = normalizeDeploymentUrl(deployment.url || deployment.aliases?.[0]);
                const deploymentBranch = deployment.deployment_trigger?.metadata?.branch || deployment.environment || "Deployment";
                const currentStatus = deploymentStatus(deployment);
                const deploymentOk = currentStatus === "success";
                return <div className="deployment-row" key={deployment.id}>
                  <div className="deployment-icon"><Cloud size={17}/></div>
                  <div className="deployment-info"><b>{deploymentBranch}</b><small>{deployment.id}</small><small>{formatDeploymentDate(deployment.created_on)}</small></div>
                  <span className={`status-pill ${currentStatus || "unknown"}`}>{currentStatus || "unknown"}</span>
                  {deploymentOk && deploymentUrl ? <a className="icon-button" href={deploymentUrl} target="_blank" rel="noreferrer" title="Open deployment"><ExternalLink size={16}/></a> : <span className="icon-button" title="Deployment belum berhasil" aria-disabled="true"><ExternalLink size={16}/></span>}
                </div>;
              })}</div> : <div className="muted-empty">Belum ada deployment yang dikembalikan oleh Cloudflare.</div>}
            </section>

    </>
  );
}
