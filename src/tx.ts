/** The part of a `getTransaction` (jsonParsed) result the decoder reads. */
export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** A parsed instruction (system transfers, token ops) or a raw one (base58 `data`) for programs the node cannot parse. */
export interface Instruction {
  programId: string;
  data?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
  program?: string;
}

export interface ParsedTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: { pubkey: string; signer?: boolean }[]; instructions: Instruction[] };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { index: number; instructions: Instruction[] }[];
    logMessages?: string[];
  } | null;
}
