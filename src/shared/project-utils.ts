import type { Project } from "./types";


export function deploymentStatus(deployment?: any) {
  const direct = String(deployment?.latest_stage?.status || "").toLowerCase();
  if (direct) return direct;
  const stages = Array.isArray(deployment?.stages) ? deployment.stages : [];
  const deployStage = stages.find((stage: any) => String(stage?.name || "").toLowerCase() === "deploy");
  return String(deployStage?.status || stages[stages.length - 1]?.status || "").toLowerCase();
}

export function normalizeUrl(value?: string, fallback = "") {
  const raw = String(value || fallback || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function projectUrl(project: Project) {
  const productionAlias = project.canonical_deployment?.aliases?.find((value) => {
    try { return new URL(value).hostname.toLowerCase() === `${project.name}.pages.dev`; } catch { return false; }
  });
  // Prefer the production hostname. canonical_deployment.url can be a unique
  // deployment URL and would bypass the main-domain rotator entry point.
  return normalizeUrl(productionAlias || project.subdomain || `${project.name}.pages.dev`, `${project.name}.pages.dev`);
}

export function branchUrl(project: string, branch: string) {
  return `https://${branch}.${project}.pages.dev`;
}

export function randomBranchName() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(7);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  const suffix = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
  return suffix;
}

