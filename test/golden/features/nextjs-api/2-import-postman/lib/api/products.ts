import type { Product } from '@/types/product';
import { apiFetch } from './client';
import type { CreateReviewRequest } from '@/types/create-review-request';

/** GET /v1/products */
export async function listProducts(params?: { category?: string }): Promise<Product[]> {
  const searchParams = new URLSearchParams();
  if (params?.category !== undefined) searchParams.set('category', String(params.category));
  const queryString = searchParams.toString();
  return apiFetch<Product[]>(`/v1/products${queryString ? `?${queryString}` : ''}`);
}

/** GET /v1/products/{id} */
export function getProduct(id: string): Promise<Product> {
  return apiFetch<Product>(`/v1/products/${id}`);
}

/** POST /v1/products/{productId}/reviews */
export function createReview(productId: string, body: CreateReviewRequest): Promise<unknown> {
  return apiFetch<unknown>(`/v1/products/${productId}/reviews`, { method: 'POST', body: JSON.stringify(body) });
}
