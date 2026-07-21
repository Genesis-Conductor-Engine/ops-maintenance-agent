# Ops Maintenance Dashboard (Axiom)

Audience: oncall / diamondnode operator  
Refresh: `oncall` (60s)  
Dataset: `ops-maintenance` (create when Axiom token available)

## At-a-Glance
| Panel | Type | Question |
|-------|------|----------|
| error-rate | Statistic | Errors last 5m? |
| p95-cycle | Statistic | Cycle duration p95? |
| service-active-pct | Statistic | % services active? |
| open-prs | Statistic | Open PR count? |

## Trends
| Panel | Type | Question |
|-------|------|----------|
| traffic-over-time | TimeSeries | Verification events/min |
| error-rate-over-time | TimeSeries | Error rate trend |
| cycle-latency | TimeSeries | Cycle duration percentiles |

## Breakdowns
| Panel | Type | Question |
|-------|------|----------|
| top-blocked | Table | Top blocked boundaries |
| pr-status | Table | PR babysit statuses |

## Evidence
| Panel | Type | Question |
|-------|------|----------|
| error-logstream | LogStream | Raw error events |

## Deploy (when `~/.axiom.toml` present)

```bash
# From Axiom skill scripts directory:
# scripts/chart-add --type Statistic --id error-rate --name "Error rate (5m)" \
#   --apl "['ops-maintenance'] | where level == 'error' | summarize count()"
# scripts/layout-pack error-rate:Statistic ...
# scripts/dashboard-assemble --name "Ops Maintenance" --datasets ops-maintenance \
#   --layout layout.json --refresh oncall chart-*.json
# scripts/dashboard-validate dashboard.json
# scripts/dashboard-create prod dashboard.json
```

**BLOCKED until:** Axiom API token + org_id in `~/.axiom.toml`.
