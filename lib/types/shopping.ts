// types/shopping.ts
export interface ShoppingItem {
  id: string;
  user_id: string; // BigInt no DB, string no JSON
  item: string;
  category: string;
  done: boolean;
  created_at: string;
}

export interface ShoppingMetadata {
  id: string;
  user_id: string;
  category: string;
  wallpaper_url: string | null;
  links: Array<{ url: string; title: string; id: number }>;
}