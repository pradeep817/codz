import type { Address } from './address';
import type { OrderItem } from './order-item';

export interface Order {
  id: number;
  total_price: number;
  /** ISO 8601 date string. */
  created_at: string;
  items: OrderItem[];
  address: Address;
}
