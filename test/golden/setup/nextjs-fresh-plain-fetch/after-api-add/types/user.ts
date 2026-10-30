export interface User {
  id: number;
  name: string;
  email: string;
  /** ISO 8601 date string. */
  created_at: string;
}
