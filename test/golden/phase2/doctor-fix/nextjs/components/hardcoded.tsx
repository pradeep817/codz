'use client';
export async function load() {
  return fetch(`${process.env.NEXT_PUBLIC_API_URL}/v1/items`);
}
const other = 'https://elsewhere.io/api/x';
