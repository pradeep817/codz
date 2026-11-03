export interface Order {
  id: number;
  total_price: number;
  /** ISO 8601 date string. */
  created_at: string;
  items: OrderItem[];
  address: Address;
}

export interface OrderItem {
  sku: string;
  qty: number;
}

export interface Address {
  line1: string;
  city: string;
}
