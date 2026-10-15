const MAX_IMAGE_SOURCE_LENGTH = 6 * 1024 * 1024;

/** Stored image sources are never executable HTML, SVG data, or credentials. */
export function isSafeImageSource(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string" || value.length > MAX_IMAGE_SOURCE_LENGTH || value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  }
  const match = value.match(/^data:image\/(png|jpeg|webp|gif);base64,/);
  if (!match) return false;
  const encoded = value.slice(match[0].length);
  if (!encoded || encoded.length % 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) return false;
  const header = Buffer.from(encoded.slice(0, 16), "base64");
  switch (match[1]) {
    case "png": return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "jpeg": return header[0] === 255 && header[1] === 216 && header[2] === 255;
    case "gif": return ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"));
    case "webp": return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
    default: return false;
  }
}

export function assertImageFields(data: Record<string, any>, collection: string) {
  const fields = ({ menu: ["image"], settings: ["logoUrl"], users: ["photoURL"], reviews: ["userPhoto"], chat_messages: ["image", "imageUrl"] } as Record<string, string[]>)[collection] || [];
  const protectedFields = new Set([...fields, ...(collection === "menu" ? ["galleryImages"] : [])]);
  const invalid = () => { throw Object.assign(new Error("Choose a valid HTTPS image, local image path, or supported raster image upload."), { status: 400, statusCode: 400, code: "INVALID_IMAGE_SOURCE" }); };
  for (const field of Object.keys(data)) if (field.includes(".") && protectedFields.has(field.split(".")[0])) invalid();
  for (const field of fields) if (!isSafeImageSource(data[field])) invalid();
  if (collection === "menu" && data.galleryImages !== undefined) {
    if (!Array.isArray(data.galleryImages) || data.galleryImages.length > 30 || data.galleryImages.some((value: any) => typeof value !== "string" || !value || !isSafeImageSource(value))) invalid();
  }
}
