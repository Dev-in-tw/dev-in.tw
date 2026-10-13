/**
 * RFC 1035 DNS 訊息的最小編碼／解碼（DoH RFC 8484 wire format 用）。
 * 只解析傳播檢查需要的類型；所有讀取都做邊界檢查，壓縮指標有次數上限，不會無窮迴圈。
 */

export const TYPE_CODES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41,
  CAA: 257,
} as const;

export type WireType = keyof typeof TYPE_CODES;

const CODE_TO_TYPE = new Map<number, string>(
  Object.entries(TYPE_CODES).map(([name, code]) => [code, name]),
);

export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, REFUSED: 5 } as const;

export class DnsWireError extends Error {
  override name = "DnsWireError";
}

export type AnswerData = Record<string, string | number>;

export interface WireAnswer {
  name: string;
  /** 已知類型用名稱（"A"、"CNAME"…），未知類型用 "TYPE<n>" */
  type: string;
  ttl: number;
  data: AnswerData;
}

export interface WireResponse {
  id: number;
  rcode: number;
  answers: WireAnswer[];
}

function encodeName(name: string): number[] {
  const trimmed = name.replace(/\.$/, "");
  const out: number[] = [];
  if (trimmed.length > 0) {
    for (const label of trimmed.split(".")) {
      const bytes = new TextEncoder().encode(label);
      if (bytes.length === 0 || bytes.length > 63)
        throw new DnsWireError(`invalid label: ${label}`);
      out.push(bytes.length, ...bytes);
    }
  }
  out.push(0);
  if (out.length > 255) throw new DnsWireError("name too long");
  return out;
}

/** 建立查詢（RD=1；edns=true 時附上 EDNS0 OPT，UDP payload 1232） */
export function encodeQuery(
  name: string,
  type: WireType | number,
  id = 0,
  edns = true,
): Uint8Array {
  const qtype = typeof type === "number" ? type : TYPE_CODES[type];
  const header = [id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, edns ? 1 : 0];
  const question = [...encodeName(name), qtype >> 8, qtype & 0xff, 0, 1];
  const opt = edns ? [0, 0, TYPE_CODES.OPT, 0x04, 0xd0, 0, 0, 0, 0, 0, 0] : [];
  return Uint8Array.from([...header, ...question, ...opt]);
}

class Reader {
  readonly buf: Uint8Array;
  offset = 0;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  need(n: number, at = this.offset): void {
    if (at + n > this.buf.length) throw new DnsWireError("truncated message");
  }
  u8(): number {
    this.need(1);
    return this.buf[this.offset++] as number;
  }
  u16(): number {
    this.need(2);
    const v = ((this.buf[this.offset] as number) << 8) | (this.buf[this.offset + 1] as number);
    this.offset += 2;
    return v;
  }
  u32(): number {
    return this.u16() * 0x10000 + this.u16();
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  /** 讀取（可能壓縮的）名稱 */
  name(): string {
    const labels: string[] = [];
    let pos = this.offset;
    let jumped = false;
    let jumps = 0;
    let length = 0;
    for (;;) {
      this.need(1, pos);
      const len = this.buf[pos] as number;
      if ((len & 0xc0) === 0xc0) {
        this.need(2, pos);
        const target = ((len & 0x3f) << 8) | (this.buf[pos + 1] as number);
        if (++jumps > 32) throw new DnsWireError("compression pointer loop");
        if (!jumped) this.offset = pos + 2;
        jumped = true;
        pos = target;
        continue;
      }
      if ((len & 0xc0) !== 0) throw new DnsWireError("invalid label type");
      if (len === 0) {
        if (!jumped) this.offset = pos + 1;
        break;
      }
      this.need(len + 1, pos);
      length += len + 1;
      if (length > 255) throw new DnsWireError("name too long");
      labels.push(new TextDecoder().decode(this.buf.subarray(pos + 1, pos + 1 + len)));
      pos += len + 1;
    }
    return labels.join(".").toLowerCase();
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function ipv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  // RFC 5952：最長（≥2）的連續 0 壓縮成 ::
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const parts = groups.map((g) => g.toString(16));
  if (bestStart < 0) return parts.join(":");
  const head = parts.slice(0, bestStart).join(":");
  const tail = parts.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

function parseRdata(r: Reader, type: string, length: number): AnswerData {
  const end = r.offset + length;
  r.need(length);
  let data: AnswerData;
  switch (type) {
    case "A": {
      if (length !== 4) throw new DnsWireError("invalid A rdata");
      data = { address: Array.from(r.bytes(4)).join(".") };
      break;
    }
    case "AAAA": {
      if (length !== 16) throw new DnsWireError("invalid AAAA rdata");
      data = { address: ipv6(r.bytes(16)) };
      break;
    }
    case "CNAME":
    case "NS":
      data = { target: r.name() };
      break;
    case "MX":
      data = { priority: r.u16(), exchange: r.name() };
      break;
    case "SRV":
      data = { priority: r.u16(), weight: r.u16(), port: r.u16(), target: r.name() };
      break;
    case "TXT": {
      let value = "";
      while (r.offset < end) {
        const len = r.u8();
        if (r.offset + len > end) throw new DnsWireError("invalid TXT rdata");
        value += new TextDecoder().decode(r.bytes(len));
      }
      data = { value };
      break;
    }
    case "CAA": {
      const flags = r.u8();
      const tagLen = r.u8();
      if (r.offset + tagLen > end) throw new DnsWireError("invalid CAA rdata");
      const tag = new TextDecoder().decode(r.bytes(tagLen));
      const value = new TextDecoder().decode(r.bytes(end - r.offset));
      data = { flags, tag, value };
      break;
    }
    default:
      data = { hex: hex(r.bytes(length)) };
  }
  if (r.offset !== end) {
    // 名稱壓縮可能讓讀取位置不等於 rdata 尾端，直接跳到尾端
    if (r.offset > end) throw new DnsWireError("rdata overrun");
    r.offset = end;
  }
  return data;
}

export function decodeResponse(input: Uint8Array | ArrayBuffer): WireResponse {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(buf);
  const id = r.u16();
  const flags = r.u16();
  if ((flags & 0x8000) === 0) throw new DnsWireError("not a response");
  const rcode = flags & 0x000f;
  const qd = r.u16();
  const an = r.u16();
  r.u16(); // NSCOUNT
  r.u16(); // ARCOUNT
  for (let i = 0; i < qd; i++) {
    r.name();
    r.u16();
    r.u16();
  }
  const answers: WireAnswer[] = [];
  for (let i = 0; i < an; i++) {
    const name = r.name();
    const typeCode = r.u16();
    r.u16(); // class
    const ttl = r.u32();
    const rdlength = r.u16();
    const type = CODE_TO_TYPE.get(typeCode) ?? `TYPE${typeCode}`;
    answers.push({ name, type, ttl, data: parseRdata(r, type, rdlength) });
  }
  return { id, rcode, answers };
}
