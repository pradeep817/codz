export interface Note {
  id: number;
  name: string;
  price: number;
  in_stock: boolean;
  tags: string[];
  discount?: number | null;
}
