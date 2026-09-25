---
summary: Module extension-point interfaces, ModuleDefinition, design-quality principles, the seven planned modules, and the source layout
read_when: Creating or changing a module, connector, provider, strategy, or executor interface, or deciding where code belongs
---

# Module contract

Formerly `PLAN.md` §4. The binding rules (no cross-module imports, the framework rule) are in `AGENTS.md`.

The extensibility mechanism. A module is a directory under `src/modules/` that may contribute through the following explicit extension points:

```ts
interface ReadConnector {
  readonly id: string;
  readonly capabilities: ReadCapability[]; // 'balances' | 'transactions' | 'positions'
  discover(ctx: ConnectorContext): Promise<DiscoveredAccount[]>;
  observe(ctx: SyncContext): AsyncIterable<ConnectorObservation>;
}

interface MarketDataProvider {
  id: string;
  supports: AssetClass[];
  fetchPrices(symbols: string[], range: DateRange): Promise<PriceObservation[]>;
  fetchCorporateActions?(
    symbols: string[],
    range: DateRange,
  ): Promise<CorporateAction[]>;
}

interface NewsSource {
  id: string;
  poll(since: Date): AsyncIterable<RawArticle>;
}

interface Strategy {
  id: string;
  configSchema: ZodSchema;
  evaluate(ctx: StrategyContext): Promise<Intent[]>; // PURE. No I/O. No news.
}

interface Executor {
  id: string;
  supports(intent: Intent): boolean;
  place(intent: Intent, idempotencyKey: string): Promise<OrderRef>;
  poll(ref: OrderRef): Promise<OrderStatus>;
}
```

```ts
interface ModuleDefinition {
  id: string;
  schema?: DrizzleSchema; // own tables, prefixed with module id
  routes?: RouteDefinition[];
  widgets?: WidgetDefinition[]; // dashboard contributions
  jobs?: JobDefinition[]; // pg-boss handlers
  connectors?: Connector[];
  marketData?: MarketDataProvider[];
  newsSources?: NewsSource[];
  strategies?: Strategy[];
  executors?: Executor[];
}
```

Modules register into a central registry at boot. **Modules may not import from each other.** Cross-module needs go through the ledger or through `src/core/`. This is the rule that keeps the system extensible rather than a ball of mud by month four.

`capabilities` on the connector is load-bearing: most institutions are read-only. Read connectors yield validated observations, not ledger events; only a separately accepted source-authority service may turn an observation into financial facts. The UI must degrade gracefully when an account cannot trade rather than assuming execution is universal.

## Design quality

The modular monolith succeeds only if its internal design stays consistent. Each domain concept has one canonical model and one clear owner. Shared policy and value objects belong in `src/core/`; provider-specific behavior stays in its module; framework adapters translate at the edge and do not contain business rules.

Prefer established boundaries and small, explicit interfaces to one-off feature plumbing. Add an abstraction when it captures a stable domain concept or removes genuine duplication—not in anticipation of hypothetical reuse. Names, types, database constraints, validation, and tests should tell the same story. Architectural decisions and intentional best-practice exceptions are documented when made so later work extends the design instead of inventing a competing one.

Each unit of work should be cohesive, independently reviewable, and leave the system easier to reason about. When a feature does not fit the current ownership model, resolve that design question before implementation.

## The seven modules

| Module         | Owns                                                               | Plane |
| -------------- | ------------------------------------------------------------------ | ----- |
| `accounts`     | institutions, connections, sync orchestration, net worth           | A     |
| `transactions` | unified feed, categorization, transfer pairing, spending analytics | A     |
| `positions`    | holdings, tax lots, cost basis, performance attribution            | A     |
| `market`       | price ingestion, corporate actions, valuation                      | B     |
| `news`         | ingestion, dedup, embedding, tagging, instrument linkage           | B     |
| `strategies`   | strategy definitions, evaluation, backtesting, intents             | A     |
| `execution`    | approval queue, broker adapters, order lifecycle, reconciliation   | A     |

## Source layout

- `src/app` is the thin Next.js presentation layer.
- `src/core` holds framework-independent shared domain and service code, including canonical ledger values and validation.
- `src/infrastructure` holds adapters such as the PostgreSQL/Drizzle clients, protected-data keyrings, ledger stores, and operational connection store.
- `src/modules` holds isolated feature modules, currently including YNAB parsing and import review. Modules may use core, but may not import from one another.
