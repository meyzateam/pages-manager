function invalidApiResponseMessage(status: number, raw: string, rayId = "") {
  const htmlResponse = /<!doctype\s+html|<html[\s>]/i.test(raw);
  const platformCode = raw.match(/Error\s+(10\d{2})/i)?.[1];
  const raySuffix = rayId ? ` Ray ID: ${rayId}.` : "";
  if (status === 503) {
    return `Layanan Cloudflare sementara tidak tersedia (HTTP 503). Ini biasanya gangguan sementara pada gateway atau runtime, bukan kesalahan file website. Tunggu sebentar lalu deploy ulang.${platformCode ? ` Kode Cloudflare: ${platformCode}.` : ""}${raySuffix}`;
  }
  if (status >= 500) {
    return `Server Cloudflare mengalami gangguan (HTTP ${status}). Coba ulangi deploy. Periksa Workers & Pages Logs menggunakan Ray ID bila masalah berulang.${platformCode ? ` Kode Cloudflare: ${platformCode}.` : ""}${raySuffix}`;
  }
  if (htmlResponse) return `Endpoint API mengirim halaman HTML, bukan JSON (HTTP ${status}). Periksa routing Pages Functions dan deployment dashboard.${raySuffix}`;
  return `Server mengirim respons yang tidak valid (HTTP ${status}).${raySuffix}`;
}

function parseApiJson(raw: string, status: number, rayId = "") {
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(invalidApiResponseMessage(status, raw, rayId)); }
}

export async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  const response = await fetch(`/api/${path.replace(/^\/+/, "")}`, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
  const raw = await response.text();
  const data = parseApiJson(raw, response.status, response.headers.get("cf-ray") || "");
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}: permintaan gagal.`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data;
}


export async function uploadApi(path: string, body: FormData, expectedBytes: number, onProgress: (loaded: number, total: number, complete?: boolean) => void) {
  return new Promise<any>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/${path.replace(/^\/+/, "")}`, true);
    xhr.withCredentials = true;
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });
    xhr.upload.addEventListener("load", () => {
      // Browser upload is complete; the Pages Function is now transferring
      // the already-hashed assets and submitting the deployment manifest.
      onProgress(expectedBytes, expectedBytes, true);
    });
    xhr.addEventListener("load", () => {
      let data: any = {};
      try { data = parseApiJson(String(xhr.responseText || ""), xhr.status, xhr.getResponseHeader("cf-ray") || ""); }
      catch (parseError) { reject(parseError instanceof Error ? parseError : new Error("Respons upload tidak valid.")); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = new Error(data.error || `HTTP ${xhr.status}: upload gagal.`) as Error & { status?: number };
        error.status = xhr.status;
        reject(error);
        return;
      }
      resolve(data);
    });
    xhr.addEventListener("error", () => reject(new Error("Koneksi upload terputus. Periksa jaringan lalu coba deploy kembali.")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload melewati batas waktu 5 menit. Kurangi ukuran folder atau coba koneksi yang lebih stabil.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload dibatalkan.")));
    xhr.send(body);
  });
}

