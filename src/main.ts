import { PublicKey } from "@solana/web3.js";
import { breakdown, PUMPSWAP_PROGRAM, type Swap } from "./breakdown.ts";
import { loadConfig, maskSecrets } from "./config.ts";
import { IdlCodec, loadIdl } from "./idl.ts";
import { formatBreakdown, formatPoolSummary, formatTiers, type FeeTierRow } from "./report.ts";
import { RpcClient } from "./rpc.ts";
import type { Breakdown } from "./breakdown.ts";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

const cfg = loadConfig();
const rpc = new RpcClient(cfg.rpcUrl, cfg.rpcMaxRps);
const amm = new IdlCodec(loadIdl("pump_amm"));
const [command, arg, ...rest] = process.argv.slice(2);

/** A pump.fun mint → its canonical PumpSwap pool; anything else is taken as a pool address. */
function poolAddress(input: string): string {
  if (!input.endsWith("pump")) return new PublicKey(input).toBase58();
  const mint = new PublicKey(input);
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM);
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.alloc(2), authority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()],
    new PublicKey(PUMPSWAP_PROGRAM),
  );
  return pool.toBase58();
}

async function explain(signature: string): Promise<void> {
  const tx = await rpc.getTransaction(signature);
  if (!tx) throw new Error("transaction not found");
  if (tx.meta?.err) console.log("Note: this transaction failed; only network fees were charged.\n");
  console.log(formatBreakdown(breakdown(tx, amm)));
}

async function pool(input: string, last: number): Promise<void> {
  const address = poolAddress(input);
  const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [address, { limit: last }]);
  const breakdowns: Breakdown[] = [];
  const swaps: Swap[] = [];
  for (const s of sigs.filter((x) => !x.err)) {
    const tx = await rpc.getTransaction(s.signature);
    if (!tx) continue;
    const b = breakdown(tx, amm);
    const mine = b.swaps.filter((w) => w.pool === address);
    if (mine.length === 0) continue;
    breakdowns.push(b);
    swaps.push(...mine);
  }
  console.log(formatPoolSummary({ pool: address, transactions: sigs.length, swaps, breakdowns }));
}

async function tiers(): Promise<void> {
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), new PublicKey(PUMPSWAP_PROGRAM).toBuffer()], FEE_PROGRAM);
  const [acc] = await rpc.getMultipleAccounts([config.toBase58()]);
  if (!acc) throw new Error(`fee config ${config.toBase58()} not found`);
  const decoded = new IdlCodec(loadIdl("pump_fees")).decodeAccount("FeeConfig", acc.data) as {
    fee_tiers: { market_cap_lamports_threshold: bigint; fees: { lp_fee_bps: bigint; protocol_fee_bps: bigint; creator_fee_bps: bigint } }[];
  };
  const rows: FeeTierRow[] = decoded.fee_tiers.map((t) => ({
    thresholdLamports: t.market_cap_lamports_threshold,
    lp: t.fees.lp_fee_bps,
    protocol: t.fees.protocol_fee_bps,
    creator: t.fees.creator_fee_bps,
  }));
  console.log(`PumpSwap fee tiers by market cap (fee config ${config.toBase58()}, read from chain):\n${formatTiers(rows)}`);
}

try {
  if (command === "explain" && arg) await explain(arg);
  else if (command === "pool" && arg) await pool(arg, Number(rest[rest.indexOf("--last") + 1] ?? 30) || 30);
  else if (command === "tiers") await tiers();
  else {
    console.error("usage:\n  npm run explain -- <signature>\n  npm run pool -- <pool or pump.fun mint> [--last 30]\n  npm run tiers");
    process.exit(2);
  }
} catch (e) {
  console.error(maskSecrets(String(e instanceof Error ? e.message : e)));
  process.exit(1);
}
