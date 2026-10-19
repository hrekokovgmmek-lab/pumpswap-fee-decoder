import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

/**
 * Just enough of Anchor's IDL format and Borsh to decode events and accounts
 * straight from a program's own IDL — no generated client, so a program
 * upgrade only needs `npm run idl`.
 */
export type IdlType =
  | string
  | { option: IdlType }
  | { vec: IdlType }
  | { array: [IdlType, number] }
  | { defined: string | { name: string } };

export interface IdlField {
  name: string;
  type: IdlType;
}

export interface IdlTypeDef {
  name: string;
  type: { kind: "struct"; fields?: IdlField[] } | { kind: "enum"; variants: { name: string; fields?: IdlField[] }[] };
}

export interface Idl {
  address?: string;
  events?: { name: string; discriminator?: number[] }[];
  accounts?: { name: string; discriminator?: number[] }[];
  types?: IdlTypeDef[];
}

export function loadIdl(name: string): Idl {
  return JSON.parse(readFileSync(new URL(`../idl/${name}.json`, import.meta.url), "utf8")) as Idl;
}

export class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.offset;
  }
  private take(n: number): Buffer {
    if (this.offset + n > this.buf.length) throw new RangeError(`read past end (${n} bytes at ${this.offset} of ${this.buf.length})`);
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8 = () => this.take(1).readUInt8(0);
  u16 = () => this.take(2).readUInt16LE(0);
  u32 = () => this.take(4).readUInt32LE(0);
  u64 = () => this.take(8).readBigUInt64LE(0);
  i64 = () => this.take(8).readBigInt64LE(0);
  u128 = () => {
    const b = this.take(16);
    return (b.readBigUInt64LE(8) << 64n) + b.readBigUInt64LE(0);
  };
  i128 = () => {
    const b = this.take(16);
    return (b.readBigInt64LE(8) << 64n) + b.readBigUInt64LE(0);
  };
  bool = () => this.u8() !== 0;
  pubkey = () => new PublicKey(this.take(32)).toBase58();
  string = () => this.take(this.u32()).toString("utf8");
}

const definedName = (d: string | { name: string }) => (typeof d === "string" ? d : d.name);

export function decodeType(r: Reader, t: IdlType, types: Map<string, IdlTypeDef>): unknown {
  if (typeof t === "string") {
    switch (t) {
      case "u8":
        return r.u8();
      case "u16":
        return r.u16();
      case "u32":
        return r.u32();
      case "u64":
        return r.u64();
      case "i64":
        return r.i64();
      case "u128":
        return r.u128();
      case "i128":
        return r.i128();
      case "bool":
        return r.bool();
      case "pubkey":
      case "publicKey":
        return r.pubkey();
      case "string":
        return r.string();
      default:
        throw new Error(`unsupported IDL type ${t}`);
    }
  }
  if ("option" in t) return r.u8() ? decodeType(r, t.option, types) : null;
  if ("vec" in t) return Array.from({ length: r.u32() }, () => decodeType(r, t.vec, types));
  if ("array" in t) return Array.from({ length: t.array[1] }, () => decodeType(r, t.array[0], types));
  const def = types.get(definedName(t.defined));
  if (!def) throw new Error(`unknown IDL type ${definedName(t.defined)}`);
  if (def.type.kind === "struct") return decodeFields(r, def.type.fields ?? [], types).value;
  const variant = def.type.variants[r.u8()];
  if (!variant) throw new Error(`bad enum variant for ${def.name}`);
  return variant.fields ? { [variant.name]: decodeFields(r, variant.fields, types).value } : variant.name;
}

/**
 * Fields in order. Bytes left over are ignored (a newer program may append
 * fields); running out of bytes stops early and says so (an older event).
 */
export function decodeFields(r: Reader, fields: IdlField[], types: Map<string, IdlTypeDef>): { value: Record<string, unknown>; truncated: boolean } {
  const value: Record<string, unknown> = {};
  for (const f of fields) {
    try {
      value[f.name] = decodeType(r, f.type, types);
    } catch (e) {
      if (e instanceof RangeError) return { value, truncated: true };
      throw e;
    }
  }
  return { value, truncated: false };
}

const sha8 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8);

/** Anchor's tag in front of events emitted through a self-CPI (`emit_cpi!`). */
export const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
  truncated: boolean;
}

export class IdlCodec {
  private readonly types: Map<string, IdlTypeDef>;
  private readonly events: { name: string; disc: Buffer }[];
  private readonly accounts: { name: string; disc: Buffer }[];

  constructor(readonly idl: Idl) {
    this.types = new Map((idl.types ?? []).map((t) => [t.name, t]));
    this.events = (idl.events ?? []).map((e) => ({ name: e.name, disc: e.discriminator ? Buffer.from(e.discriminator) : sha8(`event:${e.name}`) }));
    this.accounts = (idl.accounts ?? []).map((a) => ({ name: a.name, disc: a.discriminator ? Buffer.from(a.discriminator) : sha8(`account:${a.name}`) }));
  }

  private decodeStruct(name: string, payload: Buffer): { data: Record<string, unknown>; truncated: boolean } {
    const def = this.types.get(name);
    if (!def || def.type.kind !== "struct") throw new Error(`no struct ${name} in the IDL`);
    const { value, truncated } = decodeFields(new Reader(payload), def.type.fields ?? [], this.types);
    return { data: value, truncated };
  }

  /** `bytes` = 8-byte event discriminator + Borsh payload. */
  decodeEvent(bytes: Buffer): DecodedEvent | null {
    const hit = this.events.find((e) => bytes.subarray(0, 8).equals(e.disc));
    if (!hit) return null;
    return { name: hit.name, ...this.decodeStruct(hit.name, bytes.subarray(8)) };
  }

  /** Account data = 8-byte account discriminator + Borsh struct. */
  decodeAccount(name: string, data: Buffer): Record<string, unknown> {
    const hit = this.accounts.find((a) => a.name === name);
    if (!hit) throw new Error(`no account ${name} in the IDL`);
    if (!data.subarray(0, 8).equals(hit.disc)) throw new Error(`account data is not a ${name}`);
    return this.decodeStruct(name, data.subarray(8)).data;
  }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}
