import type { Product } from '@/types/product';
import { apiFetch } from './client';

/** GET /products */
export async function getProducts(params?: { category?: string; page?: number }): Promise<Product[]> {
  const searchParams = new URLSearchParams();
  if (params?.category !== undefined) searchParams.set('category', String(params.category));
  if (params?.page !== undefined) searchParams.set('page', String(params.page));
  const queryString = searchParams.toString();
  return apiFetch<Product[]>(`/products${queryString ? `?${queryString}` : ''}`);
}
