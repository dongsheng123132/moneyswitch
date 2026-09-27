/**
 * Nansen x402 endpoint catalog. This is the ONLY set of URLs the agent is
 * allowed to buy from — the model can never pass an arbitrary URL to
 * `nansen_query`, only one of these `name`s plus a `params` object matching
 * its JSON schema (see tools.ts).
 *
 * Schemas verified 2026-09-27 against Nansen's authoritative OpenAPI spec
 * (`https://api.nansen.ai/openapi.json`, vendored read-only at
 * `.data/nansen-openapi.json`; $refs resolved by hand while writing this
 * file — see `scripts/vendor-nansen-spec.mjs` and
 * `test/fixtures/nansen-openapi.subset.json` for the trimmed, checked-in
 * subset a unit test validates this catalog against). This replaces an
 * earlier version of this file that guessed field names from rendered docs
 * pages and got two of them wrong, causing real mainnet 422s:
 * - POST /api/v1/smart-money/netflow does NOT accept `timeframe` (422
 *   unknown_field) — it sorts by `net_flow_24h_usd` etc. instead.
 * - POST /api/v1/tgm/flow-intelligence requires a single `chain` (string),
 *   not a `chains` array (422 missing_field), and its timeframe enum uses
 *   `1d`, not `24h`.
 *
 * Each entry only declares the subset of the real request body we expose to
 * the model: every field the spec marks required, plus a few useful
 * optional ones (pagination.per_page, order_by, and — where the endpoint
 * actually has them — filters.token_address / include_stablecoins /
 * only_smart_money). Prices follow the two documented tiers given in the
 * task brief: Basic $0.01 (token screener, flow intelligence, dex trades)
 * and Premium/Smart-money $0.05 (netflow, holdings). `monad` is confirmed
 * present in every endpoint's chain enum in the spec.
 */

export interface NansenCatalogEntry {
  name: string;
  path: string;
  price_usd: string;
  tier: "basic" | "premium";
  description: string;
  docs_url: string;
  params_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const NANSEN_BASE = "https://api.nansen.ai/api/v1";

// This catalog only ever lets the model target `monad`, regardless of how
// many chains a given endpoint's real enum supports — restricting the
// enum to a singleton is a deliberate scope choice for this agent, not a
// spec fact.
const CHAINS_PARAM = {
  type: "array",
  items: { type: "string", enum: ["monad"] },
  description: 'Chains to query. This catalog entry only allows ["monad"].',
};

const CHAIN_PARAM = {
  type: "string",
  enum: ["monad"],
  description: 'Single chain to query. This catalog entry only allows "monad".',
};

const PAGINATION_PARAM = {
  type: "object",
  properties: {
    per_page: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description: "Rows per page (max 1000, default 10).",
    },
  },
  description: "Optional pagination.",
};

function orderByParam(fieldEnum: string[], example: string): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        field: { type: "string", enum: fieldEnum },
        direction: { type: "string", enum: ["ASC", "DESC"] },
      },
      required: ["field", "direction"],
    },
    description: `Optional sort order, e.g. [{"field":"${example}","direction":"DESC"}].`,
  };
}

export const NANSEN_CATALOG: NansenCatalogEntry[] = [
  {
    name: "token-screener",
    path: `${NANSEN_BASE}/token-screener`,
    price_usd: "0.01",
    tier: "basic",
    description:
      "What's trading on a chain right now: top tokens by volume/price movement in the given timeframe. Best first call to find 'what's hot'.",
    docs_url: "https://docs.nansen.ai/api/token-god-mode/token-screener",
    params_schema: {
      type: "object",
      properties: {
        chains: CHAINS_PARAM,
        timeframe: {
          type: "string",
          enum: ["5m", "10m", "1h", "6h", "24h", "7d", "30d"],
          description: "Lookback window for the screener.",
        },
        filters: {
          type: "object",
          properties: {
            token_address: { type: "string", description: "Restrict to a specific token address or symbol." },
            only_smart_money: { type: "boolean", description: "Only include smart-money-traded tokens." },
            include_stablecoins: { type: "boolean", description: "Include stablecoins in results (default false)." },
          },
          description: "Optional result filters.",
        },
        pagination: PAGINATION_PARAM,
        order_by: orderByParam(
          [
            "chain",
            "token_address",
            "token_symbol",
            "market_cap_usd",
            "volume",
            "liquidity",
            "nof_traders",
            "nof_buyers",
            "nof_sellers",
            "nof_buys",
            "nof_sells",
            "price_change",
            "price_usd",
            "netflow",
            "buy_volume",
            "sell_volume",
            "fdv",
            "fdv_mc_ratio",
            "inflow_fdv_ratio",
            "outflow_fdv_ratio",
            "token_age_days",
          ],
          "volume"
        ),
      },
      required: ["chains"],
      additionalProperties: false,
    },
  },
  {
    name: "flow-intelligence",
    path: `${NANSEN_BASE}/tgm/flow-intelligence`,
    price_usd: "0.01",
    tier: "basic",
    description:
      "Token God Mode flow intelligence for a specific token: net inflow/outflow signal over a timeframe. Use after token-screener narrows to a candidate token. NOTE: unlike the other endpoints this one takes a single `chain` string (not `chains`), and its timeframe enum uses `1d` for one day, not `24h`.",
    docs_url: "https://docs.nansen.ai/api/token-god-mode/flow-intelligence",
    params_schema: {
      type: "object",
      properties: {
        chain: CHAIN_PARAM,
        token_address: { type: "string", description: "Contract address of the token on the given chain." },
        timeframe: {
          type: "string",
          enum: ["5m", "1h", "6h", "12h", "1d", "7d"],
          description: "Lookback window. Use '1d' for one day, not '24h'.",
        },
      },
      required: ["chain", "token_address"],
      additionalProperties: false,
    },
  },
  {
    name: "dex-trades",
    path: `${NANSEN_BASE}/tgm/dex-trades`,
    price_usd: "0.01",
    tier: "basic",
    description:
      "Recent DEX trades for a specific token. Use to see raw buy/sell activity for a candidate token. `date` is required: an ISO-8601 {from, to} range.",
    docs_url: "https://docs.nansen.ai/api/token-god-mode/dex-trades",
    params_schema: {
      type: "object",
      properties: {
        chain: CHAIN_PARAM,
        token_address: { type: "string", description: "Contract address of the token on the given chain." },
        date: {
          type: "object",
          properties: {
            from: { type: "string", description: "Start of range, ISO-8601, e.g. '2025-01-01T00:00:00Z'." },
            to: { type: "string", description: "End of range, ISO-8601, e.g. '2025-01-31T23:59:59Z'." },
          },
          required: ["from", "to"],
          description: "Required date range for the trades.",
        },
        only_smart_money: { type: "boolean", description: "Only include trades by smart-money wallets." },
        pagination: PAGINATION_PARAM,
        order_by: orderByParam(
          [
            "block_timestamp",
            "transaction_hash",
            "trader_address",
            "trader_address_label",
            "token_address",
            "action",
            "token_name",
            "token_amount",
            "traded_token_address",
            "traded_token_name",
            "traded_token_amount",
            "estimated_swap_price_usd",
            "estimated_value_usd",
          ],
          "block_timestamp"
        ),
      },
      required: ["chain", "token_address", "date"],
      additionalProperties: false,
    },
  },
  {
    name: "smart-money-netflow",
    path: `${NANSEN_BASE}/smart-money/netflow`,
    price_usd: "0.05",
    tier: "premium",
    description:
      "Premium: whether Nansen's labeled 'smart money' wallets are net buying or net selling a token over recent windows (1h/24h/7d/30d net flow fields). Directly answers 'is smart money buying it'. NOTE: this endpoint has NO `timeframe` field — sort by e.g. `net_flow_24h_usd` in `order_by` instead.",
    docs_url: "https://docs.nansen.ai/api/smart-money/netflows",
    params_schema: {
      type: "object",
      properties: {
        chains: CHAINS_PARAM,
        filters: {
          type: "object",
          properties: {
            token_address: { type: "string", description: "Restrict to a specific token address or symbol." },
            include_stablecoins: { type: "boolean", description: "Include stablecoins in results (default false)." },
            include_native_tokens: {
              type: "boolean",
              description: "Include native tokens like ETH/SOL in results (default false).",
            },
          },
          description: "Optional result filters.",
        },
        pagination: PAGINATION_PARAM,
        order_by: orderByParam(
          [
            "chain",
            "token_address",
            "token_symbol",
            "net_flow_1h_usd",
            "net_flow_24h_usd",
            "net_flow_7d_usd",
            "net_flow_30d_usd",
            "token_sectors",
            "trader_count",
            "token_age_days",
            "market_cap_usd",
          ],
          "net_flow_24h_usd"
        ),
      },
      required: ["chains"],
      additionalProperties: false,
    },
  },
  {
    name: "smart-money-holdings",
    path: `${NANSEN_BASE}/smart-money/holdings`,
    price_usd: "0.05",
    tier: "premium",
    description:
      "Premium: current holdings of Nansen's labeled 'smart money' wallets on a chain, ranked by value. Use to see which tokens smart money already holds, not just net flow.",
    docs_url: "https://docs.nansen.ai/api/smart-money/holdings",
    params_schema: {
      type: "object",
      properties: {
        chains: CHAINS_PARAM,
        filters: {
          type: "object",
          properties: {
            token_address: { type: "string", description: "Restrict to a specific token address." },
            token_symbol: { type: "string", description: "Restrict to a specific token symbol." },
            include_stablecoins: { type: "boolean", description: "Include stablecoins in results (default false)." },
          },
          description: "Optional result filters.",
        },
        pagination: PAGINATION_PARAM,
        order_by: orderByParam(
          [
            "chain",
            "token_address",
            "token_symbol",
            "value_usd",
            "balance_24h_percent_change",
            "holders_count",
            "share_of_holdings_percent",
            "token_age_days",
            "market_cap_usd",
          ],
          "value_usd"
        ),
      },
      required: ["chains"],
      additionalProperties: false,
    },
  },
];

export function findCatalogEntry(name: string): NansenCatalogEntry | undefined {
  return NANSEN_CATALOG.find((e) => e.name === name);
}
