import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { base58Decode, decodeFields, IdlCodec, loadIdl, Reader, type IdlTypeDef } from "../src/idl.ts";
import { pumpswapEvents } from "../src/breakdown.ts";
import type { ParsedTx } from "../src/tx.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ParsedTx;
const amm = new IdlCodec(loadIdl("pump_amm"));

test("base58 decoding, including leading zero bytes", () => {
  assert.deepEqual([...base58Decode("1")], [0]);
  assert.deepEqual([...base58Decode("11")], [0, 0]);
  assert.deepEqual([...base58Decode("2")], [1]);
  const key = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  assert.ok(base58Decode(key).equals(new PublicKey(key).toBuffer()));
  assert.throws(() => base58Decode("0OIl"));
});

test("Borsh reader: signed and unsigned 128-bit, strings, options, vectors", () => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt.asUintN(64, -5n), 0);
  b.writeBigInt64LE(-1n, 8);
  assert.equal(new Reader(b).i128(), -5n);
  assert.equal(new Reader(Buffer.alloc(16, 0xff)).u128(), 2n ** 128n - 1n);
  const types = new Map<string, IdlTypeDef>();
  const data = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("buy"), Buffer.from([1, 7]), Buffer.from([2, 0, 0, 0, 1, 0]), Buffer.from([0])]);
  const { value, truncated } = decodeFields(
    new Reader(data),
    [
      { name: "s", type: "string" },
      { name: "o", type: { option: "u8" } },
      { name: "v", type: { vec: "bool" } },
      { name: "none", type: { option: "u64" } },
    ],
    types,
  );
  assert.deepEqual(value, { s: "buy", o: 7, v: [true, false], none: null });
  assert.equal(truncated, false);
});

test("an event shorter than the IDL decodes what it has and says so", () => {
  const r = decodeFields(new Reader(Buffer.alloc(8, 1)), [{ name: "a", type: "u64" }, { name: "b", type: "u64" }], new Map());
  assert.equal(r.truncated, true);
  assert.deepEqual(Object.keys(r.value), ["a"]);
});

test("unknown event discriminators are ignored", () => {
  assert.equal(amm.decodeEvent(Buffer.alloc(40)), null);
});

test("real BuyEvent and SellEvent decode from self-CPI event instructions", () => {
  const [buy] = pumpswapEvents(fixture("buy"), amm);
  assert.equal(buy?.name, "BuyEvent");
  assert.equal(buy?.truncated, false);
  assert.equal(buy?.data.ix_name, "buy_exact_quote_in");
  assert.equal(buy?.data.lp_fee, 2_445n);
  const [sell] = pumpswapEvents(fixture("sell"), amm);
  assert.equal(sell?.name, "SellEvent");
  assert.equal(sell?.data.buyback_fee_basis_points, 5_000n);
  assert.equal(sell?.data.protocol_fee_recipient, "11111111111111111111111111111111");
});
