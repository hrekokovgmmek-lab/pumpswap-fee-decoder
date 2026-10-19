/**
 * Save the fields the decoder reads from one transaction, as a test fixture:
 *
 *   npm run fixture -- <signature> > test/fixtures/name.json
 */
import { loadConfig } from "../src/config.ts";
import { RpcClient } from "../src/rpc.ts";
import type { Instruction, TokenBalance } from "../src/tx.ts";

const signature = process.argv[2];
if (!signature) {
  console.error("usage: npm run fixture -- <signature>");
  process.exit(2);
}
const cfg = loadConfig();
const tx = await new RpcClient(cfg.rpcUrl, cfg.rpcMaxRps).getTransaction(signature);
if (!tx || !tx.meta) {
  console.error("transaction not found");
  process.exit(1);
}
const balance = (b: TokenBalance) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: b.uiTokenAmount.amount, decimals: b.uiTokenAmount.decimals } });
const ix = (i: Instruction) => ({ programId: i.programId, program: i.program, data: i.data, parsed: i.parsed ? { type: i.parsed.type, info: i.parsed.info } : undefined });
console.log(
  JSON.stringify(
    {
      slot: tx.slot,
      blockTime: tx.blockTime,
      transaction: {
        signatures: tx.transaction.signatures,
        message: {
          accountKeys: tx.transaction.message.accountKeys.map((k) => ({ pubkey: k.pubkey, signer: k.signer })),
          instructions: tx.transaction.message.instructions.map(ix),
        },
      },
      meta: {
        err: tx.meta.err,
        fee: tx.meta.fee,
        preBalances: tx.meta.preBalances,
        postBalances: tx.meta.postBalances,
        preTokenBalances: (tx.meta.preTokenBalances ?? []).map(balance),
        postTokenBalances: (tx.meta.postTokenBalances ?? []).map(balance),
        innerInstructions: (tx.meta.innerInstructions ?? []).map((g) => ({ index: g.index, instructions: g.instructions.map(ix) })),
        logMessages: tx.meta.logMessages,
      },
    },
    null,
    1,
  ),
);
