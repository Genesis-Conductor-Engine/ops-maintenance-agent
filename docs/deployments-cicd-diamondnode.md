# Deployments & CI/CD — diamondnode fleet

**Skill:** `deployments-cicd` · **Stream:** R10 · **Agent:** yennefer  
**Host:** diamondnode (192.168.1.228)

## Surfaces

| Layer | Count | Control |
|-------|------:|---------|
| Vercel projects (2 teams) | 11 | Git integration + optional prebuilt GHA |
| Cloudflare Workers (on disk) | 23 | `wrangler deploy` + CF GHA |
| Local systemd production | 11 | ops timers + post-boot heal |
| Public probes | 6 | `deployments-audit.mjs` |

Registry: `config/deploy-registry.json`  
Audit: `node scripts/deployments-audit.mjs` → `reports/deployments-latest.json`  
HTTP: `GET http://127.0.0.1:8791/ops/deployments`

## Vercel teams

| Team | Slug | ID |
|------|------|-----|
| Genesis Conductor | `igors-projects-2dc0c445` | `team_6rZHKfzSFyuOCZVa6EQQGSjo` |
| Instinct | `instinct-c38ff2c4` | `team_5piZ5dwpvq275dgTrPOcv5B7` |

## Standard prebuilt CI pattern

```bash
npm install -g vercel@48.12.1
vercel pull --yes --environment=production --token=$VERCEL_TOKEN
vercel build --prod --token=$VERCEL_TOKEN
vercel deploy --prebuilt --prod --token=$VERCEL_TOKEN --yes
```

Template workflow: `.github/workflows/vercel-deploy.yml`

Required secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

## Promote vs redeploy

- **Preview validated → prod:** `vercel promote <url>` (instant, no rebuild)
- **Fresh production build:** `vercel deploy --prod` or prebuilt path above
- **Rollback:** `vercel rollback` or `vercel rollback <url>`

## Known P0 (2026-07-10)

| Project | Issue | Fix |
|---------|-------|-----|
| `genesis-conductor-site` | `npm install` ERESOLVE: `@opennextjs/cloudflare@latest` needs `next>=15.5.18`, package has Next 14 | Bump Next 15.5+ **or** pin OpenNext + `.npmrc` `legacy-peer-deps=true` |
| Local `VERCEL_TOKEN` | unset on diamondnode | Add to `~/.vault/env/agent.env` for live audit + CLI deploys |

Live apex:

- `https://genesisconductor.io` — Vercel cache HIT (stale production still serving)
- `https://www.genesisconductor.io` — Cloudflare / Notion surface

## Local production services (zero-downtime invariant)

openclaw-gateway, ollama, nginx, redis-server, qmem-llama-server, qmem-sync, genesis-ops-stream, ops-maintenance-http, cloudflared

## Dual-path apps

| App | Vercel | Cloudflare |
|-----|--------|------------|
| genesis-conductor-site | Git auto-deploy (currently ERROR) | GHA `cloudflare-deploy.yml` + OpenNext |
| ops-maintenance-agent | Workflow API scaffold | wrangler DO scaffold |

Prefer **one primary edge** per public hostname to avoid split-brain deploys.

## Enable live Vercel audit

```bash
# append token (never commit)
echo 'VERCEL_TOKEN=…' >> /root/.vault/env/agent.env
# if systemd units source the vault:
systemctl restart ops-maintenance-http
node /root/ops-maintenance-agent/scripts/deployments-audit.mjs
```
