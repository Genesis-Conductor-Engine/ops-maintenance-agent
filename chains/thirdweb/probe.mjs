#!/usr/bin/env node
/**
 * Lightweight thirdweb-oriented chain registry probe (no secrets required).
 * Full thirdweb client needs THIRDWEB_CLIENT_ID / secret key in vault.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(
  readFileSync(join(__dirname, "..", "agentic-networks.json"), "utf8")
);

const chains = reg.networks.map((n) => ({
  id: n.id,
  chainId: n.chainId,
  hardhat: n.hardhat_network,
  cashflow_streams: n.cashflow_streams,
  rpc_env: n.rpc_env,
  role: n.role,
}));

console.log(
  JSON.stringify(
    {
      tooling: reg.tooling,
      aerodrome: reg.aerodrome,
      chains,
      thirdweb: {
        install: "cd chains/thirdweb && npm i",
        vault_keys: ["THIRDWEB_CLIENT_ID", "THIRDWEB_SECRET_KEY"],
        note: "Use thirdweb Engine / SDK wallets for agent ops; Ledger remains source of truth via hardhat-ledger",
      },
    },
    null,
    2
  )
);
