const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;

export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Image by MIME type, falling back to the file extension when the type is missing or generic. */
export function isImageFile(name: string, mimeType?: string | null): boolean {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType.startsWith("image/");
  return IMAGE_EXT.test(name);
}
