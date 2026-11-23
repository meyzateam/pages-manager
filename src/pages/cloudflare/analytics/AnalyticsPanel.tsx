import { Activity, ArrowLeft, BarChart3, ChevronRight, Eye, ShieldCheck, Users, Zap } from "lucide-react";
import type { AnalyticsData, DailyPoint, RankedItem } from "../../../shared/types";

function formatNumber(value: number) { return new Intl.NumberFormat("id-ID").format(Number(value || 0)); }
function formatDateTime(value?: string) {
  if (!value) return "—";
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

function LineChart({ data, metric, colorClass }: { data: DailyPoint[]; metric: "visitors" | "clicks"; colorClass: string }) {
  const width = 760;
  const height = 230;
  const left = 38;
  const right = 16;
  const top = 18;
  const bottom = 34;
  const values = data.map((item) => Number(item[metric] || 0));
  const maxValue = Math.max(1, ...values);
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const coords = values.map((value, index) => ({
    x: left + (data.length <= 1 ? chartWidth / 2 : index * chartWidth / (data.length - 1)),
    y: top + chartHeight - (value / maxValue) * chartHeight,
    value
  }));
  const line = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  const area = coords.length ? `${line} L${coords[coords.length - 1].x},${top + chartHeight} L${coords[0].x},${top + chartHeight} Z` : "";
  const labels = data.length > 0 ? [data[0].day, data[Math.floor((data.length - 1) / 2)].day, data[data.length - 1].day] : [];
  return (
    <div className="chart-wrap">
      {data.length ? (
        <svg className={`line-chart ${colorClass}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Grafik ${metric}`}>
          {[0, 1, 2, 3].map((step) => {
            const y = top + (chartHeight / 3) * step;
            const label = Math.round(maxValue * (3 - step) / 3);
            return <g key={step}><line x1={left} x2={width - right} y1={y} y2={y} className="chart-grid"/><text x={left - 9} y={y + 4} textAnchor="end" className="chart-label">{label}</text></g>;
          })}
          <path d={area} className="chart-area" />
          <path d={line} className="chart-line" />
          {coords.filter((_, index) => index === 0 || index === coords.length - 1 || index % Math.max(1, Math.ceil(coords.length / 8)) === 0).map((point, index) => (
            <circle key={`${point.x}-${index}`} cx={point.x} cy={point.y} r="3.5" className="chart-point"><title>{formatNumber(point.value)}</title></circle>
          ))}
          {labels.map((label, index) => <text key={`${label}-${index}`} x={left + (labels.length <= 1 ? chartWidth / 2 : index * chartWidth / (labels.length - 1))} y={height - 9} textAnchor="middle" className="chart-label">{label.slice(5)}</text>)}
        </svg>
      ) : <div className="chart-empty"><BarChart3 size={24}/><span>Belum ada data pada rentang ini.</span></div>}
    </div>
  );
}

export function StatCard({ icon: Icon, label, value, helper }: { icon: any; label: string; value: string | number; helper: string }) {
  return <div className="stat-card"><div className="stat-label"><span className="stat-icon"><Icon size={17}/></span>{label}</div><strong>{value}</strong><small>{helper}</small></div>;
}

function RankedList({ title, items, empty }: { title: string; items: RankedItem[]; empty: string }) {
  const max = Math.max(1, ...items.map((item) => Number(item.count || 0)));
  return (
    <section className="panel">
      <div className="panel-heading"><div><h3>{title}</h3><p>Distribusi berdasarkan data kunjungan.</p></div></div>
      {items.length ? <div className="ranked-list">{items.map((item, index) => (
        <div className="ranked-item" key={`${item.label}-${index}`}>
          <div className="ranked-head"><span title={item.label}>{item.label || "Unknown"}</span><b>{formatNumber(item.count)}</b></div>
          <div className="ranked-track"><span style={{ width: `${Math.max(2, Number(item.count || 0) / max * 100)}%` }}/></div>
        </div>
      ))}</div> : <div className="muted-empty">{empty}</div>}
    </section>
  );
}

export function AnalyticsPanel({ data, days, setDays, recentPage, setRecentPage, recentPageSize, setRecentPageSize }: { data: AnalyticsData; days: number; setDays: (days: number) => void; recentPage: number; setRecentPage: (page: number) => void; recentPageSize: 10 | 50 | 100 | "all"; setRecentPageSize: (size: 10 | 50 | 100 | "all") => void }) {
  const recentPageCount = recentPageSize === "all" ? 1 : Math.max(1, Math.ceil(data.recent.length / recentPageSize));
  const visibleRecent = recentPageSize === "all" ? data.recent : data.recent.slice((recentPage - 1) * recentPageSize, recentPage * recentPageSize);
  return (
    <>
      <div className="page-heading analytics-heading">
        <div><span className="eyebrow">PROJECT / TRAFFIC INTELLIGENCE</span><h1>Visitor analytics</h1><p>Data dikirim dari Pages Worker dan dicatat di D1, bukan angka simulasi.</p></div>
        <select className="period-select" value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Rentang analytics">
          <option value={7}>7 hari terakhir</option><option value={30}>30 hari terakhir</option><option value={90}>90 hari terakhir</option>
        </select>
      </div>
      <div className="stats-grid four">
        <StatCard icon={Eye} label="Page views" value={formatNumber(data.summary.views)} helper="Total halaman dibuka"/>
        <StatCard icon={Users} label="Unique visitors" value={formatNumber(data.summary.visitors)} helper="Pengunjung unik pada periode"/>
        <StatCard icon={Activity} label="Clicks" value={formatNumber(data.summary.clicks)} helper="Klik tautan yang terdeteksi"/>
        <StatCard icon={Zap} label="Sessions" value={formatNumber(data.summary.sessions)} helper="Sesi browser yang terukur"/>
      </div>
      <div className="chart-grid">
        <section className="panel chart-panel"><div className="panel-heading"><div><h3>Unique visitors</h3><p>Pengunjung unik per hari.</p></div><span className="chart-legend visitors-legend">Visitors</span></div><LineChart data={data.daily} metric="visitors" colorClass="visitors-chart"/></section>
        <section className="panel chart-panel"><div className="panel-heading"><div><h3>Click activity</h3><p>Interaksi tautan per hari.</p></div><span className="chart-legend clicks-legend">Clicks</span></div><LineChart data={data.daily} metric="clicks" colorClass="clicks-chart"/></section>
      </div>
      <div className="three-panels">
        <RankedList title="Devices" items={data.devices} empty="Belum ada data perangkat."/>
        <RankedList title="Locations" items={data.countries} empty="Lokasi belum tersedia."/>
        <RankedList title="Referrers" items={data.referrers} empty="Belum ada referrer."/>
      </div>
      <section className="panel table-panel">
        <div className="panel-heading"><div><h3>Recent visitor activity</h3><p>Event terbaru, termasuk waktu, IP, lokasi, perangkat, dan referrer.</p></div><label className="page-size-control"><span>Show</span><select aria-label="Jumlah activity per halaman" value={recentPageSize} onChange={(event) => { setRecentPageSize(event.target.value === "all" ? "all" : Number(event.target.value) as 10 | 50 | 100); setRecentPage(1); }}><option value={10}>10</option><option value={50}>50</option><option value={100}>100</option><option value="all">All</option></select></label></div>
        {data.recent.length ? <div className="table-scroll"><table className="visitor-table"><thead><tr><th>Time</th><th>Type</th><th>IP address</th><th>Location</th><th>Device</th><th>Referrer / Target</th><th>Page</th></tr></thead><tbody>
          {visibleRecent.map((event) => <tr key={event.id}>
            <td className="nowrap">{formatDateTime(event.created_at)}</td>
            <td><span className={`event-pill ${event.event_type}`}>{event.event_type === "pageview" ? "Page view" : "Click"}</span></td>
            <td className="mono">{event.ip_address || "—"}</td>
            <td>{[event.city, event.region, event.country].filter(Boolean).join(", ") || "Unknown"}</td>
            <td>{[event.device_type, event.browser, event.operating_system].filter(Boolean).join(" · ") || "Unknown"}</td>
            <td className="url-cell" title={event.event_type === "click" ? event.target_url : event.referrer}>{event.event_type === "click" ? (event.target_url || "—") : (event.referrer || "Direct / None")}</td>
            <td className="url-cell" title={event.path}>{event.path || "/"}</td>
          </tr>)}
        </tbody></table></div> : <div className="empty-state"><Activity size={25}/><h3>Analytics belum menerima data</h3><p>Deploy ulang project melalui Pages Manager agar `_worker.js` dan tracker dipasang. Kunjungan setelah deployment akan mulai tercatat.</p></div>}
        {data.recent.length > 0 && <div className="pagination-bar"><span>Menampilkan {recentPageSize === "all" ? 1 : (recentPage - 1) * recentPageSize + 1}–{recentPageSize === "all" ? data.recent.length : Math.min(recentPage * recentPageSize, data.recent.length)} dari {formatNumber(data.recent.length)} activity</span><div className="pagination-controls"><button className="icon-button" aria-label="Halaman activity sebelumnya" disabled={recentPage <= 1} onClick={() => setRecentPage(Math.max(1, recentPage - 1))}><ArrowLeft size={15}/></button><span>Page <b>{recentPage}</b> / {recentPageCount}</span><button className="icon-button" aria-label="Halaman activity berikutnya" disabled={recentPage >= recentPageCount} onClick={() => setRecentPage(Math.min(recentPageCount, recentPage + 1))}><ChevronRight size={15}/></button></div></div>}
      </section>
      <p className="privacy-note"><ShieldCheck size={15}/> IP dan metadata lokasi diproses pada Cloudflare Worker lalu disimpan di database dashboard. Beri tahu pengunjung melalui kebijakan privasi situs Anda.</p>
    </>
  );
}

