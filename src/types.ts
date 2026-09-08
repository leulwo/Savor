/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Category {
  id: string;
  name: string;
  sortOrder?: number;
}

export interface MenuItemVariation {
  id: string;
  label: string;
  price: number;
  isAvailable?: boolean;
  isDefault?: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string; // Keep for backward compatibility
  categories?: string[];
  promoStickers?: string[];
  image: string;
  galleryImages?: string[];
  popular?: boolean;
  ingredients: string[];
  nutrition: {
    protein: string;
    carbs: string;
    fat: string;
  };
  basePrice?: number;
  isActive?: boolean;
  menuTiming?: string;
  timingFrom?: string;
  timingTo?: string;
  variations?: MenuItemVariation[];
}

export interface OrderMenuItem extends MenuItem {
  variation?: { id: string; label: string };
}

export interface OrderItem {
  menuItem: OrderMenuItem;
  quantity: number;
  variationId?: string | null;
}

export interface Order {
  id: string;
  items: OrderItem[];
  status: 'pending' | 'preparing' | 'ready' | 'dispatched' | 'delivered' | 'cancelled';
  total: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  blockNumber?: string;
  roomNumber?: string;
  googleMapsAddress?: string;
  specialInstructions?: string;
  paymentMethod: 'chapa' | 'cash';
  paymentStatus: 'pending' | 'completed' | 'failed' | 'reversed';
  fulfillmentType?: 'delivery' | 'pickup' | 'dineIn';
  scheduledFor?: string;
  transactionRef: string;
  createdAt: string;
  updatedAt?: string;
  statusHistory?: { status: string; at: string }[];
  paymentHistory?: { paymentStatus: string; at: string }[];
  deliveryMinutes?: number;
  userId?: string;
  serviceTax?: number;
  flatFee?: number;
  chapaCheckoutUrl?: string;
  shipdayOrderId?: string;
  shipdayStatus?: string;
  shipdayTrackingLink?: string | null;
  shipdayLastUpdate?: string;
  receipt?: {
    transactionId: string;
    reference: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    fullName: string;
    email: string;
    date: string;
    status: string;
    simulated?: boolean;
  };
  promoCode?: string;
  discountAmount?: number;
}

export interface VpsStats {
  cpuUsage: number;
  ramUsage: number;
  diskUsage: number;
  databaseConnected: boolean;
  dbType: string;
  uptime: string;
  activeConnections: number;
  totalOrders: number;
  revenue: number;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  savedAddresses: string[];
  favoriteItems: string[];
  createdAt: string;
}

export interface GlobalSettings {
  // General
  restaurantName?: string;
  logoUrl?: string;

  // Checkout
  serviceTaxPercent?: number;
  flatFeeETB?: number;
  enableCOD?: boolean;
  isOpen?: boolean;
  prepTimeMinutes?: number;
  scheduledStepsMinutes?: number;

  // Features
  enableMarketing?: boolean;
  enableReservations?: boolean;
  enableChatbot?: boolean;
  
  updatedAt?: string;
}

export interface PromoCode {
  id?: string;
  code: string;
  type: 'percentage' | 'fixed';
  value: number; // percentage (e.g. 10 for 10%) or fixed amount (e.g. 50 ETB)
  minOrderAmount?: number;
  maxDiscount?: number;
  active: boolean;
  expiresAt?: string;
  usageCount: number;
  maxUsages?: number;
  createdAt: string;
}

export interface Reservation {
  id?: string;
  userId?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  date: string;
  time: string;
  partySize: number;
  notes?: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  createdAt: string;
}

export interface Review {
  id?: string;
  menuItemId: string;
  userId: string;
  customerName: string;
  rating: number;
  comment: string;
  createdAt: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  thinking?: string;
}

export interface AuditLogEntry {
  id?: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  category: 'order' | 'menu' | 'settings' | 'team' | 'customer' | 'general';
  targetId?: string;
  details?: Record<string, any>;
  createdAt: any;
}
