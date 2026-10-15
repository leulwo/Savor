export function createChapaCustomization(txRef: string, restaurantName?: unknown) {
  const referenceSuffix = String(txRef || "").slice(-8).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const title = typeof restaurantName === "string"
    ? restaurantName.replace(/[^A-Za-z0-9_ .-]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return {
    title: title || "Restaurant",
    // Chapa rejects punctuation such as # in customization descriptions.
    description: `Order ${referenceSuffix}`
  };
}
