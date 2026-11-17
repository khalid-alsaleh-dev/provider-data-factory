export const sources = ['locations', 'restaurants', 'menus'] as const;
export type Source = (typeof sources)[number];

export const collections = [
  'locations',
  'restaurants',
  'service_areas',
  'categories',
  'items',
  'category_items',
] as const;
export type Collection = (typeof collections)[number];

export interface Context {
  source: Source;
  sourceId: string;
}
export interface Entity {
  provider: string;
  collection: Collection;
  key: string;
  version: string;
  data: Record<string, unknown>;
}
export interface Issue {
  path: string;
  reason: string;
}
export interface Result {
  entities: Entity[];
  issues: Issue[];
  duplicates: number;
}

export interface Adapter {
  readonly name: string;
  readonly sourceCollections: Record<Source, string>;
  extract(raw: unknown, context: Context): { candidates: Candidate[]; issues: Issue[] };
}

export interface Candidate {
  collection: Collection;
  path: string;
  value: Record<string, unknown>;
  version: string;
}
