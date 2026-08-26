import { readFile } from "node:fs/promises";

// Same fallback logo Bruno's own X bot uses when a launch has no attached image.
export const DEFAULT_LOGO_URL = "https://www.hoodbrunos.xyz/assets/logo.png";

/** Accepts a local file path or an http(s) URL; falls back to DEFAULT_LOGO_URL if omitted.
 * Returns {buffer, contentType}. */
export async function loadImage(source) {
  const target = source && source.trim() ? source.trim() : DEFAULT_LOGO_URL;
  if (/^https?:\/\//i.test(target)) {
    const res = await fetch(target);
    if (!res.ok) throw new Error(`Failed to fetch image from ${target}: ${res.status}`);
    const contentType = res.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  }
  const buffer = await readFile(target);
  const ext = target.split(".").pop()?.toLowerCase();
  const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
  return { buffer, contentType };
}
