import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findMatchingTransferLog,
  rpcUrlForChain,
  USDC_CONTRACTS,
} from "./x402-monetize-server.mjs";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_BASE = USDC_CONTRACTS[8453];
const PAY_TO = "0x9545e2439c5c75d3aA723AcaC1AA6B0fa1DB6956";
const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function topicFromAddress(addr) {
  return `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function transferLog({
  address = USDC_BASE,
  from = PAYER,
  to = PAY_TO,
  amountAtomic = "2500000",
} = {}) {
  return {
    address,
    topics: [TRANSFER_TOPIC, topicFromAddress(from), topicFromAddress(to)],
    data: `0x${BigInt(amountAtomic).toString(16).padStart(64, "0")}`,
  };
}

test("matches a real Transfer log to the expected recipient for the exact amount", () => {
  const result = findMatchingTransferLog([transferLog()], {
    usdcAddress: USDC_BASE,
    expectedTo: PAY_TO,
    minAmountAtomic: "2500000",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, "2500000");
  assert.equal(result.from.toLowerCase(), PAYER.toLowerCase());
});

test("matches when overpaid (value greater than the minimum required)", () => {
  const result = findMatchingTransferLog(
    [transferLog({ amountAtomic: "5000000" })],
    { usdcAddress: USDC_BASE, expectedTo: PAY_TO, minAmountAtomic: "2500000" },
  );
  assert.equal(result.ok, true);
});

test("rejects underpayment", () => {
  const result = findMatchingTransferLog([transferLog({ amountAtomic: "100" })], {
    usdcAddress: USDC_BASE,
    expectedTo: PAY_TO,
    minAmountAtomic: "2500000",
  });
  assert.equal(result.ok, false);
});

test("rejects a transfer logged by a different token contract", () => {
  const result = findMatchingTransferLog([transferLog({ address: OTHER })], {
    usdcAddress: USDC_BASE,
    expectedTo: PAY_TO,
    minAmountAtomic: "2500000",
  });
  assert.equal(result.ok, false);
});

test("rejects a transfer to a different recipient", () => {
  const result = findMatchingTransferLog([transferLog({ to: OTHER })], {
    usdcAddress: USDC_BASE,
    expectedTo: PAY_TO,
    minAmountAtomic: "2500000",
  });
  assert.equal(result.ok, false);
});

test("enforces expectedFrom when the caller supplies a payerAddress", () => {
  const result = findMatchingTransferLog([transferLog({ from: PAYER })], {
    usdcAddress: USDC_BASE,
    expectedTo: PAY_TO,
    minAmountAtomic: "2500000",
    expectedFrom: OTHER,
  });
  assert.equal(result.ok, false);
});

test("ignores unrelated logs and non-Transfer events, still finds the real one", () => {
  const logs = [
    { address: USDC_BASE, topics: ["0xdeadbeef"], data: "0x0" },
    transferLog(),
  ];
  const result = findMatchingTransferLog(logs, {
    usdcAddress: USDC_BASE,
    expectedTo: PAY_TO,
    minAmountAtomic: "2500000",
  });
  assert.equal(result.ok, true);
});

test("rpcUrlForChain resolves known mainnets and returns null for unknown chains", () => {
  assert.ok(rpcUrlForChain(8453).includes("base"));
  assert.ok(rpcUrlForChain(1).length > 0);
  assert.equal(rpcUrlForChain(999999), null);
});
