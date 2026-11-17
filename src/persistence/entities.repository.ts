import { Injectable } from '@nestjs/common';
import { AnyBulkWriteOperation } from 'mongodb';
import { Collection, Entity } from '../core/contracts';
import { MongoService } from './mongo.service';

type StoredEntity = Record<string, unknown> & {
  _id: string;
  _version: string;
  provider: string;
};

/** Writes domain entities. Older observations never overwrite newer ones. */
@Injectable()
export class EntitiesRepository {
  constructor(private readonly mongo: MongoService) {}

  /**
   * One ordered bulkWrite per collection. Per entity: insert it if missing, then replace it only
   * when the stored version is lower (checked by MongoDB). A fresh insert never also counts as a
   * replace, because its stored version is not lower.
   *
   * @returns the number of entities inserted or replaced.
   */
  async save(entities: Entity[]): Promise<number> {
    const operations = new Map<Collection, AnyBulkWriteOperation<StoredEntity>[]>();
    for (const entity of entities) {
      const document: StoredEntity = {
        _id: entity.key,
        ...entity.data,
        provider: entity.provider,
        _version: entity.version,
      };
      const list = operations.get(entity.collection) ?? [];
      list.push(
        {
          updateOne: {
            filter: { _id: entity.key },
            update: { $setOnInsert: document },
            upsert: true,
          },
        },
        {
          replaceOne: {
            filter: { _id: entity.key, _version: { $lt: entity.version } },
            replacement: document,
          },
        },
      );
      operations.set(entity.collection, list);
    }

    const results = await Promise.all(
      [...operations].map(([collection, list]) =>
        this.mongo.target.collection<StoredEntity>(collection).bulkWrite(list, { ordered: true }),
      ),
    );
    return results.reduce((sum, result) => sum + result.upsertedCount + result.modifiedCount, 0);
  }
}
