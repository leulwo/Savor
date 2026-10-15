export function getRestaurantName(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "Restaurant";
}

export function getBusinessFilename(value: unknown): string {
  return getRestaurantName(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, "_").replace(/[. ]+$/g, "") || "Restaurant";
}
