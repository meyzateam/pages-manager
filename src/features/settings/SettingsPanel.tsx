import { Check, Cloud, Moon, RefreshCw, ShieldCheck, Sun } from "lucide-react";
import type { GoogleAccount } from "../../shared/types";

type CloudflareAccount = { id: string; name: string };

export function SettingsPanel({
  userEmail, accounts, selectedAccountId, selectedAccountName, onSelectCloudflare,
  googleAccounts, selectedGoogleEmail, onSelectGoogle, onConnectGoogle, onDisconnectGoogle,
  theme, onSetTheme, busy
}: {
  userEmail: string;
  accounts: CloudflareAccount[];
  selectedAccountId: string;
  selectedAccountName: string;
  onSelectCloudflare: (id: string) => void;
  googleAccounts: GoogleAccount[];
  selectedGoogleEmail: string;
  onSelectGoogle: (email: string) => void;
  onConnectGoogle: () => void;
  onDisconnectGoogle: () => void;
  theme: "dark" | "light";
  onSetTheme: (theme: "dark" | "light") => void;
  busy: boolean;
}) {
  const selectedGoogle = googleAccounts.find((item) => item.google_email === selectedGoogleEmail);
  return <>
    <section className="page-heading"><div><span className="eyebrow">PLATFORM / PREFERENCES & SECURITY</span><h1>Settings</h1><p>Kelola koneksi Cloudflare, akun Google Search Console, preferensi tampilan, dan keamanan sesi dari satu tempat.</p></div><span className="status-pill success"><i/> Protected workspace</span></section>
    <section className="panel settings-section">
      <div className="panel-heading"><div><h3><Cloud size={17}/> Cloudflare account</h3><p>Pilih akun Cloudflare yang menjadi konteks seluruh project, deployment, rotator, dan analytics.</p></div><span className="status-pill success">Connected</span></div>
      <div className="form-grid"><div><label htmlFor="settings-cloudflare-account">Active Cloudflare account</label><select id="settings-cloudflare-account" value={selectedAccountId} onChange={(event) => onSelectCloudflare(event.target.value)} disabled={busy}><option value="">Select account</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></div><div><label>Account ID</label><input value={selectedAccountId} readOnly/><small>Cloudflare user: {userEmail || "—"} · Selected account: {selectedAccountName || "—"}</small></div></div>
      <div className="settings-info"><ShieldCheck size={17}/><div><b>Cloudflare API connection protected</b><p>API Token divalidasi di backend dan disimpan terenkripsi di D1. Token asli tidak dikirim kembali ke browser atau ditampilkan di halaman Settings.</p><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Manage API Tokens in Cloudflare</a></div></div>
    </section>
    <section className="panel settings-section">
      <div className="panel-heading"><div><h3><ShieldCheck size={17}/> Google Search Console accounts</h3><p>Hubungkan lebih dari satu akun Google dan pilih akun yang akan dipakai untuk daftar property, sitemap, URL Inspection, dan performa.</p></div><span className={`status-pill ${googleAccounts.length ? "success" : "unknown"}`}>{googleAccounts.length} connected</span></div>
      {googleAccounts.length ? <>
        <div className="form-grid"><div><label htmlFor="settings-google-account">Active Google account</label><select id="settings-google-account" value={selectedGoogleEmail} onChange={(event) => onSelectGoogle(event.target.value)} disabled={busy}>{googleAccounts.map((account) => <option value={account.google_email} key={account.google_email}>{account.google_email}</option>)}</select><small>Semua halaman Google Search menggunakan akun yang dipilih di sini.</small></div><div><label>Token status</label><input readOnly value={selectedGoogle ? (selectedGoogle.token_expires_at * 1000 > Date.now() ? "Access token stored securely · refresh enabled" : "Refresh on next request") : "No Google account selected"}/><small>OAuth scopes: Search Console read/write dan Site Verification.</small></div></div>
        <div className="settings-account-actions"><button className="button secondary-button" disabled={busy} onClick={onConnectGoogle}>Connect another Google account</button><button className="button danger-button" disabled={busy || !selectedGoogleEmail} onClick={onDisconnectGoogle}>Disconnect selected account</button></div>
      </> : <div className="empty-state compact-empty"><p>Belum ada akun Google yang terhubung.</p><button className="button primary-button" disabled={busy} onClick={onConnectGoogle}>Connect Google account</button></div>}
      <div className="settings-info"><ShieldCheck size={17}/><div><b>Google OAuth credentials protected</b><p>Access token dan refresh token setiap akun dienkripsi di D1. Pemilihan akun hanya mengubah konteks Google Search, bukan akun Cloudflare.</p><a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">Review third-party access in Google Account</a></div></div>
    </section>
    <section className="panel settings-section">
      <div className="panel-heading"><div><h3><Sun size={17}/> Appearance</h3><p>Preferensi mode tampilan disimpan di browser ini.</p></div></div>
      <div className="theme-options"><button className={`theme-option ${theme === "light" ? "active" : ""}`} onClick={() => onSetTheme("light")}><Sun size={18}/> Light mode{theme === "light" && <Check size={16}/>}</button><button className={`theme-option ${theme === "dark" ? "active" : ""}`} onClick={() => onSetTheme("dark")}><Moon size={18}/> Dark mode{theme === "dark" && <Check size={16}/>}</button></div>
    </section>
    <section className="panel settings-section">
      <div className="panel-heading"><div><h3><ShieldCheck size={17}/> Session & security</h3><p>Informasi keamanan sesi dan status koneksi dashboard.</p></div><span className="status-pill success">Active</span></div>
      <div className="settings-security-grid"><div><small>Authenticated user</small><b>{userEmail || "—"}</b></div><div><small>Session</small><b>HttpOnly · Secure · SameSite=Lax</b></div><div><small>Session lifetime</small><b>Up to 7 days</b></div><div><small>Backend storage</small><b>Cloudflare D1 · encrypted credentials</b></div></div>
      <p className="privacy-note"><RefreshCw size={14}/> Token Cloudflare dan Google hanya diproses di backend. Refresh credential dilakukan server-side saat diperlukan.</p>
    </section>
  </>;
}
