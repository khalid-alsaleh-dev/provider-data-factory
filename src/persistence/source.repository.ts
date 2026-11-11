import { Inject, Injectable } from '@nestjs/common';
import { Collection, Document, ObjectId } from 'mongodb';
import { Adapter, Source, SourcePort } from '../core/contracts';
import { ADAPTER } from '../providers/providers.module';
import { MongoService } from './mongo.service';

/** Read-only access to the raw provider collections. */
@Injectable()
export class SourceRepository implements SourcePort {
  constructor(
    private readonly mongo: MongoService,
    @Inject(ADAPTER) private readonly adapter: Adapter,
  ) {}

  /** Highest _id in the source collection, or undefined when it is empty. */
  async upper(source: Source): Promise<string | undefined> {
    const doc = await this.collection(source)
      .find({}, { projection: { _id: 1 } })
      .sort({ _id: -1 })
      .limit(1)
      .next();
    return doc?._id.toHexString();
  }

  /** Up to `limit` ids in (after, upper], in ascending order. */
  async page(
    source: Source,
    after: string | undefined,
    upper: string,
    limit: number,
  ): Promise<string[]> {
    const idRange: { $gt?: ObjectId; $lte: ObjectId } = { $lte: new ObjectId(upper) };
    if (after) idRange.$gt = new ObjectId(after);

    const rows = await this.collection(source)
      .find({ _id: idRange }, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return rows.map((row) => row._id.toHexString());
  }

  get(source: Source, ids: string[]): Promise<Document[]> {
    const objectIds = ids.map((id) => new ObjectId(id));
    return this.collection(source)
      .find({ _id: { $in: objectIds } })
      .toArray();
  }

  private collection(source: Source): Collection<Document & { _id: ObjectId }> {
    return this.mongo.raw.collection(this.adapter.sourceCollections[source]);
  }
}
