import type { MenuItem, OrderItem } from "../types";

/** Compare saved cart choices with the current menu without rewriting the cart. */
export function getUnavailableCartItems(cart: OrderItem[], menu: MenuItem[]): OrderItem[] {
  const currentMenu = new Map(menu.map(item => [item.id, item]));
  return cart.filter(item => {
    const currentItem = currentMenu.get(item.menuItem.id);
    if (!currentItem || currentItem.isActive === false) return true;
    const selectedVariant = item.variationId ?? item.menuItem.variation?.id;
    if (selectedVariant == null || selectedVariant === "") return false;
    return !(Array.isArray(currentItem.variations) && currentItem.variations.some(variant =>
      variant && variant.id === selectedVariant && variant.isAvailable !== false));
  });
}
