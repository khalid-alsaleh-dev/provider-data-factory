import { Collection } from './contracts';

// The single definition of natural key formats. The core uses it to key entities,
// and adapters use it to build references (restaurantKey, itemKey, ...), so both always agree.
export function entityKey(
  provider: string,
  collection: Collection,
  value: Record<string, unknown>,
): string {
  return `${provider}/${collection}/${identity(collection, value)}`;
}

function identity(collection: Collection, value: Record<string, unknown>): string {
  switch (collection) {
    case 'categories':
    case 'items':
      // Provider IDs are only unique within a restaurant.
      return `${String(value.restaurantKey).split('/').at(-1)}/${String(value.providerId)}`;
    case 'service_areas':
      return `${String(value.restaurantKey)}/${String(value.locationKey)}`;
    case 'category_items':
      return `${String(value.categoryKey)}/${String(value.itemKey)}`;
    default:
      return String(value.providerId);
  }
}
