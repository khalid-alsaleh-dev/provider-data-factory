# Architecture

```mermaid
flowchart LR
  API[POST /runs] --> R[(Mongo run record)]
  API --> DQ[BullMQ dispatcher queue]
  RAW[(Raw Mongo)] --> D[Dispatcher]
  DQ --> D
  D --> B[(Mongo batch records)]
  D --> BQ[BullMQ batch queue]
  BQ --> W[Batch processor]
  W --> A[Xbyte adapter and mapping]
  A --> P[Pure transformation stages]
  P --> DB[(Target Mongo: output, quarantine, receipts, counters)]
  BQ -->|exhausted attempts| DLQ[Dead-letter queue]
```

## Modules

```text
AppModule
├── ConfigModule (global)   env validated by config/environment.ts (class-validator)
├── BullModule.forRootAsync Redis connection and default job options
├── ThrottlerModule
├── MongoModule (global)    MongoService: client, raw and target databases, indexes
├── RunsModule              HTTP API: RunsController, RunsService, DTOs, ApiKeyGuard
├── ProcessingModule        BullMQ processors and the services they run
└── HealthModule            Terminus health check
Shared: PersistenceModule (repositories), QueuesModule (registered queues), ProvidersModule (ADAPTER)
```

## Responsibilities

| File                                        | Responsibility                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `scripts/seed-raw.ts`                       | Stream downloaded files into raw collections                            |
| `src/app.setup.ts`                          | Global ValidationPipe, shutdown hooks, OpenAPI; shared by main.ts/tests |
| `src/config/environment.ts`                 | Environment variables, defaults and validation                          |
| `src/runs/runs.controller.ts`               | HTTP routes, status codes, guards, OpenAPI annotations                  |
| `src/runs/dto/*`                            | Request DTOs (validated) and response shapes for OpenAPI                |
| `src/runs/runs.service.ts`                  | Create runs and read their status and errors                            |
| `src/queues/*`                              | Queue names, job payload types, queue registration                      |
| `src/processing/dispatch.processor.ts`      | Dispatcher worker: graceful interruption and terminal failure           |
| `src/processing/dispatcher.service.ts`      | Read source IDs in pages; save and enqueue batches                      |
| `src/processing/batch.processor.ts`         | Batch worker: concurrency, terminal failure                             |
| `src/processing/batch.service.ts`           | Transform batch documents; dead-letter exhausted batches                |
| `src/processing/document-writer.service.ts` | Save one document's entities, issues, counters and receipt              |
| `src/processing/run-finalizer.service.ts`   | Decide when a run is finished and with which status                     |
| `src/persistence/*.repository.ts`           | One repository per MongoDB collection                                   |
| `src/providers/xbyte/adapter.ts`            | Expand provider envelopes and apply its field mapping                   |
| `src/providers/xbyte/mapping.ts`            | Plain field-name mapping and provider conversions                       |
| `src/core/pipeline.ts`                      | Validate, normalize, map, project and deduplicate                       |
| `src/core/schemas.ts`                       | Allowed fields and validation rules for target entities (zod)           |
| `src/core/helpers.ts`                       | Small text/number conversions and deterministic hashing                 |

HTTP input is validated with class-validator DTOs. Provider data is validated with zod schemas in `core/` and `providers/`: it is untrusted, deeply nested and dynamic, and those schemas stay independent of Nest.

A new provider implements `Adapter`, its raw collection map and declarative field mapping, then replaces the `ADAPTER` binding. The core pipeline does not need provider-specific changes. This submission selects one provider per deployment.

## Target model

Keys begin with provider `p` (currently `xbyte-talabat`). `_id` indexes enforce uniqueness.

| Collection     | Natural key / data                                                                    | Lookup indexes                  |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| locations      | `p/locations/{locationId}`; name, slug                                                | `_id`                           |
| restaurants    | `p/restaurants/{outletId}`; name, canonical URL, profile, separate sourceRestaurantId | `_id`                           |
| service_areas  | Provider + restaurantKey + locationKey                                                | locationKey, restaurantKey      |
| categories     | `p/categories/{outletId}/{categoryId}`; name, restaurantKey                           | restaurantKey                   |
| items          | `p/items/{outletId}/{itemId}`; name, description, integer priceMinor, AED, image      | restaurantKey                   |
| category_items | Provider + categoryKey + itemKey                                                      | categoryKey/itemKey and itemKey |

Embed small scalar profiles. Reference categories, items and memberships because these arrays grow independently. Incomplete sample exports may reference locations absent from the downloaded locations file; preserve their natural keys rather than inventing records.

## Deterministic writes

The adapter assigns a version ordered by profile authority, source timestamp and source envelope ID. The core adds a content digest as a final tie-break. Menu profiles outrank sparse listings.

For each entity, `EntitiesRepository.save()` inserts missing keys and replaces existing records only when the stored `_version` is lower. Older observations cannot overwrite newer ones.

## Progress and basic recovery

1. Save the run and enqueue its dispatcher job directly.
2. For each page, save a batch, enqueue it with a stable job ID, then advance the source checkpoint. A dispatcher retry can repeat a page safely: the same page produces the same batch and job ID, finished jobs are kept for 24 hours for deduplication, and a batch that is no longer pending is skipped.
3. Check receipt key `{run}/{source}/{sourceId}`. If it exists, skip that document. Otherwise save its entities, upsert quarantine issues, update counters, then save the receipt.
4. Mark the batch completed after all its documents finish. Finish the run only after scheduling is done and no pending batches remain.
5. Dependency errors fail BullMQ jobs. Configurable attempts and exponential backoff apply. On the final attempt, the processor itself quarantines documents without receipts, marks the batch dead and publishes a DLQ reference before failing the job. Because this runs inside the job, a crash part-way leaves the job stalled and BullMQ runs it again; every step is idempotent.
6. On shutdown, processors close their workers in `beforeApplicationShutdown`, before MongoDB and Redis close. An active dispatch stops after its current page and moves itself back to the delayed set without using a retry attempt; it resumes from its checkpoint on the next start.

These operations are separate. A crash before the receipt is saved can leave partial output or inaccurate counters. A standalone MongoDB server is sufficient; transactions would require a replica set.

BullMQ handles ordinary worker stalls and retries while Redis retains its jobs. There is no reconciler or transactional outbox: a crash between run creation and enqueueing, or loss of Redis jobs, needs manual intervention or a new run. Source data must stay immutable. Run one application instance.
