# Liquidity maximization plan (2026-07-21)

## Assessment
| Metric | Value |
|--------|--------|
| Pool | Aerodrome wQFLOP/WETH `0x4aBC…C53e` Base |
| TVL | ~$0.42 vs **$127.55** target |
| Owner LP share | **97.51%** (3605 LP tokens) |
| HOT ETH | **~0.00004** (insufficient) |
| SAFE ETH | **~0.0097** |
| Pool state | **DEGENERATE** (dust WETH reserve) |
| Workflow decision | **HOLD** (`no_weth_available` / `pool_degenerate`) |

Unattended maximizers (`lp_autoscale`, `zap`, `gas_keeper`) are **retired** by design. Live path is armed workflow only.

## What ran this session
1. Restarted agentic PM2: backfill, backfill-v2, swarm, orchestrator
2. **qflop-swarm** completed a wrap cycle (multiple `wrap_complete` on Base)
3. `workflow.sh --status` + `--dry-run --force-seed` → HOLD (no WETH)
4. `asset_transmute` position scan (read-only)
5. Cashflow R07 pipeline set to recovery remainder

## Required next action (single live fund step)
Fund HOT `0x60C4…77d9` with ≥ **0.003 ETH**, then:

```bash
cd ~/Yennefer/aerodrome-lp
bash workflow.sh --dry-run --force-seed --max-weth 0.002
# if ok:
bash workflow.sh --live --force-seed --max-weth 0.002
```

Options to fund:
- Transfer from SAFE `0x2AD5…30eB` (~0.0097 ETH) via signed cast/keystore
- L1→Base: `node scripts/bridge_eth_to_base.mjs --amount 0.007 --dry-run` then `--live`

## Agentic sessions to keep online
- qflop-swarm (wrap propulsion)
- qflop-backfill / v2 (after gas funded)
- lp-dashboard + qflop-here-realtime (telemetry → here.now)
- cdp-wallet-manager + fleet-coordinator

## Do not
- Force proportional ADD without `--force-seed` (donates value into degenerate pool)
- Start more heavy PM2 processes while CPU/RAM ~99%
- Use retired unattended zap/autoscale paths
