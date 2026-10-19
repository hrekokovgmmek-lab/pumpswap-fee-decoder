/**
 * Download the programs' own IDLs from chain into idl/.
 *
 * Anchor stores a program's IDL at createWithSeed(PDA([], program), "anchor:idl", program):
 * 8 bytes discriminator, 32 bytes authority, u32 length, then zlib-compressed JSON.
 *
 *   npm run idl
 */
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";
import { RpcClient } from "../src/rpc.ts";

const PROGRAMS: [string, string][] = [
  ["pump_amm", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"],
  ["pump_fees", "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"],
];

const rpc = new RpcClient(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", Number(process.env.RPC_MAX_RPS ?? 1));
for (const [name, id] of PROGRAMS) {
  const program = new PublicKey(id);
  const [base] = PublicKey.findProgramAddressSync([], program);
  const address = await PublicKey.createWithSeed(base, "anchor:idl", program);
  const [acc] = await rpc.getMultipleAccounts([address.toBase58()]);
  if (!acc) throw new Error(`${name}: no IDL account at ${address.toBase58()}`);
  const length = acc.data.readUInt32LE(40);
  const idl = JSON.parse(inflateSync(acc.data.subarray(44, 44 + length)).toString("utf8"));
  writeFileSync(new URL(`../idl/${name}.json`, import.meta.url), JSON.stringify(idl, null, 1) + "\n");
  console.log(`${name}: ${idl.instructions.length} instructions, ${(idl.events ?? []).length} events → idl/${name}.json`);
}
