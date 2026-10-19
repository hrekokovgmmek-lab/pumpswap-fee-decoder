import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { breakdown, WSOL } from "../src/breakdown.ts";
import { IdlCodec, loadIdl } from "../src/idl.ts";
import { formatBreakdown, formatTiers, pct, sol } from "../src/report.ts";
import type { ParsedTx } from "../src/tx.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ParsedTx;
const amm = new IdlCodec(loadIdl("pump_amm"));

// Real mainnet transactions, 19 Oct 2026.
test("buy: every lamport accounted for, fees paid straight to their recipients", () => {
  const b = breakdown(fixture("buy"), amm);
  const s = b.swaps[0]!;
  assert.equal(s.side, "buy");
  assert.equal(s.curveLamports, 12_222_221n);
  assert.equal(s.userLamports, 12_375_000n);
  assert.deepEqual([s.lpFee, s.protocolFee, s.creatorFee], [2_445n, 113_667n, 36_667n]);
  assert.deepEqual(s.bps, { lp: 2n, protocol: 93n, creator: 30n });
  assert.equal(s.eventReconciles, true);
  assert.equal(s.heldInPool, 0n);
  assert.equal(s.feesAccounted, true);
  assert.deepEqual(s.payouts.map((p) => p.lamports), [113_667n, 36_667n]);
  assert.deepEqual(b.networkFee, { base: 5_000n, priority: 5_000n });
});

test("sell: half the protocol fee goes to buyback now, the rest of the fees wait in the pool vault", () => {
  const b = breakdown(fixture("sell"), amm);
  const s = b.swaps[0]!;
  assert.equal(s.side, "sell");
  assert.equal(s.curveLamports, 2_127_916_440n);
  assert.equal(s.userLamports, 2_101_317_483n);
  assert.equal(s.buybackFee, 9_894_811n);
  assert.deepEqual(s.payouts, [{ to: "AktftA98kSWAxn6kVSoqBXBELUArjKu2H9WmKB48ULFY", lamports: 9_894_811n }]);
  assert.equal(s.heldInPool, 16_278_562n);
  assert.equal(s.heldInPool! + 9_894_811n, s.protocolFee + s.creatorFee);
  assert.equal(s.feesAccounted, true);
  assert.equal(b.networkFee.priority, 36_180n);
});

const JITO = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const transfer = (source: string, destination: string, lamports: number) => ({
  programId: "11111111111111111111111111111111",
  program: "system",
  parsed: { type: "transfer", info: { source, destination, lamports } },
});

test("tips, other transfers, SOL wrapping and rent are told apart", () => {
  const tx: ParsedTx = {
    slot: 1,
    blockTime: null,
    transaction: {
      signatures: ["S"],
      message: {
        accountKeys: [{ pubkey: "USER" }, { pubkey: "WSOL_ACC" }, { pubkey: "TOKEN_ACC" }, { pubkey: JITO }, { pubkey: "BOTFEE" }],
        instructions: [transfer("USER", "WSOL_ACC", 50_000_000), transfer("USER", JITO, 100_000), transfer("USER", "BOTFEE", 500_000)],
      },
    },
    meta: {
      err: null,
      fee: 25_000,
      preBalances: [1_000_000_000, 0, 0, 0, 0],
      postBalances: [0, 2_039_280 + 50_000_000, 2_039_280, 100_000, 500_000],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: WSOL, owner: "USER", uiTokenAmount: { amount: "50000000", decimals: 9 } },
        { accountIndex: 2, mint: "MINT", owner: "USER", uiTokenAmount: { amount: "0", decimals: 6 } },
      ],
      innerInstructions: [],
      logMessages: [],
    },
  };
  const b = breakdown(tx, amm);
  assert.deepEqual(b.jitoTips, [{ to: JITO, lamports: 100_000n }]);
  assert.deepEqual(b.otherTransfers, [{ to: "BOTFEE", lamports: 500_000n }]);
  assert.equal(b.rentLamports, 2n * 2_039_280n, "rent of both new token accounts, not the wrapped SOL");
  assert.deepEqual(b.networkFee, { base: 5_000n, priority: 20_000n });
  assert.match(formatBreakdown(b), /No PumpSwap buy or sell/);
});

test("formatting", () => {
  assert.equal(sol(12_375_000n), "0.012375 SOL");
  assert.equal(sol(-2_101_317_483n), "-2.101317 SOL");
  assert.equal(sol(0n, true), "—");
  assert.equal(pct(152_779n, 12_222_221n), "1.25%");
  const text = formatBreakdown(breakdown(fixture("sell"), amm));
  assert.match(text, /Fees held in the pool vault for later collection: 0\.016278 SOL/);
  assert.match(text, /✓ event adds up · ✓ fees = paid out \+ held in pool/);
  assert.match(formatTiers([{ thresholdLamports: 420_000_000_000n, lp: 20n, protocol: 5n, creator: 95n }]), /420 SOL\s+20\s+5\s+95\s+120 bps/);
});
