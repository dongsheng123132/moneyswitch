# @moneyswitch/qwen-agent

A demo "research analyst" agent, powered by Qwen (OpenAI-compatible tool
calling via Alibaba DashScope), that answers questions about Monad on-chain
activity by **buying** Nansen data through MoneySwitch — planning within a
hard USDC budget rather than dumping a raw API response.

Loop: plan (short, stated up front) → `money_status` (check budget) →
`nansen_query` (buy the cheapest endpoint that can answer the question, from
a fixed catalog) → maybe buy one more → final answer citing which endpoints
were bought, total USDC spent, and every tx hash as an explorer link.

## Run

```bash
MONEYSWITCH_URL=http://127.0.0.1:4020 \
MONEYKEY=mk_live_xxx \
QWEN_API_KEY=sk-xxx \
node apps/qwen-agent/dist/cli.js "What's hot on Monad in the last 24h and is smart money buying it?"
```

Or via the root script:

```bash
pnpm agent:qwen "What's hot on Monad in the last 24h and is smart money buying it?"
```

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `MONEYSWITCH_URL` | no | `http://127.0.0.1:4020` | Base URL of your running MoneySwitch server |
| `MONEYKEY` | yes | — | `mk_live_...` MoneyKey with a USDC budget |
| `QWEN_API_KEY` | yes (or `DASHSCOPE_API_KEY`) | — | DashScope API key |
| `QWEN_BASE_URL` | no | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI-compatible endpoint |
| `QWEN_MODEL` | no | `qwen3.8-max` | Model id |
| `AGENT_MAX_STEPS` | no | `8` | Hard stop on model turns, regardless of tool-call outcome |

## Nansen catalog

The Nansen endpoint catalog (name, price, JSON-schema params) lives in
`src/catalog.ts` and is placed in the **system prompt**, not behind a
separate tool call — it's small (5 entries), static per run, and the model
needs it before it can plan its first move. `nansen_query` validates the
model's chosen endpoint name against this catalog and only ever builds a
request to that catalog entry's fixed `path`; the model can never pass an
arbitrary URL.

## Output

- Terminal trace with emoji markers: 🧠 plan, 🔧 tool call, 💸 payment, 📊 data
  rows, ✅ final answer (colors only on a TTY).
- A JSON transcript per run at `.data/agent-runs/<timestamp>.json`
  (`.data` is gitignored). Both the terminal output and the transcript are
  redacted so `MONEYKEY` and `QWEN_API_KEY` never appear in them.

## Safety

- Hard stop at `AGENT_MAX_STEPS`.
- `nansen_query` args are validated against the catalog entry's own schema;
  unknown keys are dropped before the request is built.
- Non-`ok` MoneySwitch envelopes (`denied`, `payment_failed`,
  `approval_required`) are returned to the model as information so it can
  adapt, not thrown as errors that abort the run.

## Tests

```bash
pnpm --filter @moneyswitch/qwen-agent test
```

Fully offline: a fake OpenAI-compatible HTTP server scripts the model's tool
calls, and a fake MoneySwitch server returns canned `/v1/fetch` envelopes
(including `payment_failed`/`PAYMENT_REJECTED` and `denied`/budget-exceeded).
