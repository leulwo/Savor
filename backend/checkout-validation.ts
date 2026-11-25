import { CHECKOUT_PHONE_ERROR, chapaPhoneNumber } from "./chapa-phone";

/** Customer messages are controlled here; never forward arbitrary Error.message. */
const checkoutMessages = {
  CHECKOUT_INVALID_PHONE: CHECKOUT_PHONE_ERROR,
  CHECKOUT_INVALID_FIELDS: "Enter a valid email address and keep each name to 35 characters and the email address to 50 characters or fewer.",
  CHECKOUT_CART_EMPTY: "Your cart is empty. Add an item before checking out.",
  CHECKOUT_CART_TOO_LARGE: "Your cart has too many line items. Keep it to 50 or fewer and try again.",
  CHECKOUT_INVALID_ITEM: "An item in your cart could not be identified. Remove it and add it again from the menu.",
  CHECKOUT_RESTAURANT_CLOSED: "The restaurant is currently not accepting orders. Please try again during opening hours.",
  CHECKOUT_ITEM_UNAVAILABLE: "An item in your cart is no longer available. Review your cart and choose another item.",
  CHECKOUT_INVALID_QUANTITY: "Each item quantity must be a whole number from 1 to 99. Review your cart quantities.",
  CHECKOUT_VARIANT_UNAVAILABLE: "A selected option is no longer available. Review your cart and choose another option.",
  CHECKOUT_INVALID_PRICE: "An item price could not be confirmed. Refresh the menu and add that item again, or contact the restaurant.",
  CHECKOUT_PROMO_LIMIT_REACHED: "This promo code has reached its usage limit. Remove it or use another code, then try again.",
  CHECKOUT_PROMO_CHANGED: "This promo code changed or is no longer available. Review your cart and try again.",
  CHECKOUT_INVALID_TOTAL: "The order total must be greater than zero. Review your cart and try again.",
  CHECKOUT_SETTINGS_UNAVAILABLE: "Checkout settings are temporarily unavailable. Please try again shortly.",
  CHAPA_INVALID_AMOUNT: "This order total is outside Chapa's accepted amount range. Review your cart or contact the restaurant.",
  PAYMENT_NOT_FOUND: "Payment attempt not found. Start checkout again from your account.",
  PAYMENT_REQUEST_CHANGED: "Your checkout details changed. Start a new payment attempt.",
  PAYMENT_PREVIOUS_ATTEMPT_OPEN: "Your previous checkout is still open. Resume or cancel it in My Orders before changing these details.",
  PAYMENT_RECONCILIATION_REQUIRED: "Your payment needs verification. Do not pay again while we check it.",
  CHECKOUT_ACTIVE_ATTEMPT_LIMIT: "You already have open payment requests. Resume or cancel them in My Orders before starting another checkout.",
  ACTIVE_PENDING_ORDER_EXISTS: "You already have an order pending payment. Please complete or cancel it before placing a new one.",
  PAYMENT_ATTEMPT_ENDED: "This payment attempt has ended. Start a new payment attempt.",
  PAYMENT_ATTEMPT_CHANGED: "Your payment attempt changed while Chapa was responding. Tap Pay Online again to safely resume."
} as const;

export type CheckoutValidationCode = keyof typeof checkoutMessages;

export function checkoutValidationError(code: CheckoutValidationCode, statusCode = 400) {
  return Object.assign(new Error(checkoutMessages[code]), { code, statusCode });
}

export function safeCheckoutFailure(error: unknown): { code: string; error: string } {
  const failure = error as { code?: unknown; statusCode?: unknown } | undefined;
  const candidateCode = typeof failure?.code === "string" ? failure.code : "";
  if (Object.hasOwn(checkoutMessages, candidateCode)) {
    return { code: candidateCode, error: checkoutMessages[candidateCode as CheckoutValidationCode] };
  }
  if (failure?.statusCode === 400) {
    return { code: "CHECKOUT_INVALID_REQUEST", error: "Review your checkout details and try again." };
  }
  return { code: "CHAPA_INITIALIZE_ERROR", error: "Payment initialization failed. Please retry safely." };
}

function optionalBoundedString(value: unknown, max: number, allowNewlines = false): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw checkoutValidationError("CHECKOUT_INVALID_FIELDS");
  const control = allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (control.test(value)) throw checkoutValidationError("CHECKOUT_INVALID_FIELDS");
  const trimmed = value.trim();
  if (trimmed.length > max || value.length > max + 64) throw checkoutValidationError("CHECKOUT_INVALID_FIELDS");
  return trimmed;
}

export function validateOrderCustomerFields(input: any, options: { chapa?: boolean; fulfillmentType: string }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw checkoutValidationError("CHECKOUT_INVALID_FIELDS");
  const delivery = options.fulfillmentType === "delivery";
  const blockNumber = optionalBoundedString(input.blockNumber, 120);
  const roomNumber = optionalBoundedString(input.roomNumber, 120);
  const googleMapsAddress = optionalBoundedString(input.googleMapsAddress, 1000);
  const specialInstructions = optionalBoundedString(input.specialInstructions, 2000, true);

  let firstName = "";
  let lastName = "";
  let customerName = "";
  let customerEmail = "";
  let customerPhone = "";

  if (options.chapa) {
    firstName = optionalBoundedString(input.first_name, 35);
    lastName = optionalBoundedString(input.last_name, 35);
    customerEmail = optionalBoundedString(input.email, 50);
    if (!firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || customerEmail.toLowerCase().endsWith("@example.com")) {
      throw checkoutValidationError("CHECKOUT_INVALID_FIELDS");
    }
    customerName = `${firstName} ${lastName}`.trim();
    customerPhone = chapaPhoneNumber(input.phone_number) || "";
  } else {
    customerName = optionalBoundedString(input.customerName, 120);
    customerEmail = optionalBoundedString(input.customerEmail, 254);
    if (!customerName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || customerEmail.toLowerCase().endsWith("@example.com")) {
      throw checkoutValidationError("CHECKOUT_INVALID_FIELDS");
    }
    customerPhone = chapaPhoneNumber(input.customerPhone) || "";
  }

  return {
    firstName,
    lastName,
    customerName,
    customerEmail,
    customerPhone,
    blockNumber: delivery ? blockNumber : "",
    roomNumber: delivery ? roomNumber : "",
    googleMapsAddress: delivery ? googleMapsAddress : "",
    specialInstructions
  };
}
