import { blake3 } from "@noble/hashes/blake3.js";

type InputFile = { file: File; path: string };
type WorkerInput = { files: InputFile[] };

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function fileExtension(path: string) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1) : "";
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

self.addEventListener("message", (event: MessageEvent<WorkerInput>) => {
  void (async () => {
    try {
      const files = event.data?.files || [];
      const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
      let processedBytes = 0;
      const hashes: Array<{ path: string; hash: string }> = [];

      for (let index = 0; index < files.length; index += 1) {
        const { file, path } = files[index];
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Cloudflare Pages uses BLAKE3(base64(file bytes) + file extension).
        const digestInput = new TextEncoder().encode(bytesToBase64(bytes) + fileExtension(path));
        const hash = bytesToHex(blake3(digestInput)).slice(0, 32);
        hashes.push({ path, hash });
        processedBytes += file.size;
        self.postMessage({
          type: "progress",
          processedFiles: index + 1,
          totalFiles: files.length,
          processedBytes,
          totalBytes
        });
      }

      self.postMessage({ type: "complete", hashes });
    } catch (error) {
      self.postMessage({ type: "error", error: error instanceof Error ? error.message : "Gagal menghitung checksum file." });
    }
  })();
});

export {};
