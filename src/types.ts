/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Category {
  id: string;
  name: string;
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
  prepTime: string;
  ingredients: string[];
  nutrition: {
    protein: string;
    carbs: string;
    fat: string;
  };
  basePrice?: number;
  taxRate?: string;
  taxRatePercent?: number;
  isActive?: boolean;
  menuTiming?: string;
}

export interface OrderItem {
  menuItem: MenuItem;
  quantity: number;
}

export interface Order {
  id: string;
  items: OrderItem[];
  status: 'pending' | 'preparing' | 'ready' | 'delivered' | 'cancelled';
  total: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  blockNumber?: string;
  roomNumber?: string;
  googleMapsAddress?: string;
  specialInstructions?: string;
  paymentMethod: 'chapa' | 'cash';
  paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded';
  transactionRef: string;
  createdAt: string;
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

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  thinking?: string;
}
