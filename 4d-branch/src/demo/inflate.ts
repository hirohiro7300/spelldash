// 小さな gzip の伸長（RFC 1951 の deflate と RFC 1952 の gzip の枠）。DecompressionStream の無い環境（古い Safari など）で、
// 同梱の地図（src/demo/impactBundle.ts の decodeBundle）を開くための代わり。設計: 作業メモ SPEC v1 §3.3（見直し gaps-3・perf-7）
// 速さより正しさ: ハフマン符号は表を引いて読み、壊れたデータ（長さ・距離・符号の表・CRC・長さの記録の食い違い）はどれも投げる（黙って続けない）。
// gzip の枠は 1 つだけ（後ろに余りがあれば投げる）

export class InflateError extends Error {
  override name = "InflateError";
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** 符号の長さの符号の長さが並ぶ順 */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** ハフマン符号の表: 次の bits ビット（読む順に下から）で引くと (記号 << 4) | 符号の長さ。−1 は無い符号 */
interface Table {
  t: Int32Array;
  bits: number;
}

/** 符号の長さの並びから表を作る（決まった順の符号。長さ 0 は使わない記号）。符号が多すぎる長さの並びは投げる */
function buildTable(lens: ArrayLike<number>, n: number): Table {
  const count = new Int32Array(16);
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const l = lens[i]!;
    if (l) {
      count[l]!++;
      if (l > maxLen) maxLen = l;
    }
  }
  const t = new Int32Array(1 << Math.max(1, maxLen)).fill(-1);
  if (maxLen === 0) return { t, bits: 1 };
  const next = new Int32Array(16);
  let code = 0;
  let left = 1;
  for (let b = 1; b <= 15; b++) {
    code = (code + count[b - 1]!) << 1;
    next[b] = code;
    left = (left << 1) - count[b]!;
    if (left < 0) throw new InflateError("gzip: 符号の長さが多すぎます");
  }
  next[0] = 0;
  for (let s = 0; s < n; s++) {
    const l = lens[s]!;
    if (!l) continue;
    const c = next[l]!++;
    // 読む順は符号の上の桁から（ビットは下から読む）ので、桁を逆にして表に置く
    let r = 0;
    for (let k = 0; k < l; k++) r |= ((c >> k) & 1) << (l - 1 - k);
    const step = 1 << l;
    for (let j = r; j < t.length; j += step) t[j] = (s << 4) | l;
  }
  return { t, bits: maxLen };
}

let FIXED: { lit: Table; dist: Table } | null = null;
function fixedTables(): { lit: Table; dist: Table } {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144);
    l.fill(9, 144, 256);
    l.fill(7, 256, 280);
    l.fill(8, 280, 288);
    FIXED = { lit: buildTable(l, 288), dist: buildTable(new Uint8Array(30).fill(5), 30) };
  }
  return FIXED;
}

let CRC: Int32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * deflate のデータ（src[start..end)）を out に伸ばす。out の大きさはちょうど伸ばした後の長さ（gzip の枠の記録から）。
 * 返す値は、deflate のデータの終わりの次のバイトの位置
 */
function inflateRaw(src: Uint8Array, start: number, end: number, out: Uint8Array): number {
  let pos = start;
  let buf = 0;
  let cnt = 0;
  let o = 0;
  /** 少なくとも k ビット（k ≤ 24）を読める所まで入れる。データの終わりの先は 0 で埋め、後で読み過ぎを見る */
  const need = (k: number) => {
    while (cnt < k) {
      buf |= (pos < end ? src[pos]! : 0) << cnt;
      pos++;
      cnt += 8;
    }
  };
  const bits = (k: number): number => {
    if (k === 0) return 0;
    need(k);
    const v = buf & ((1 << k) - 1);
    buf >>>= k;
    cnt -= k;
    return v;
  };
  const sym = (tb: Table): number => {
    need(tb.bits);
    const e = tb.t[buf & ((1 << tb.bits) - 1)]!;
    if (e < 0) throw new InflateError("gzip: 表に無い符号です");
    const l = e & 15;
    buf >>>= l;
    cnt -= l;
    return e >> 4;
  };
  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // そのまま入れた塊: バイトの区切りまで捨て、読み込んだ分のバイトを戻す
      buf >>>= cnt & 7;
      cnt -= cnt & 7;
      pos -= cnt >> 3;
      buf = 0;
      cnt = 0;
      if (pos + 4 > end) throw new InflateError("gzip: データが途中で切れています");
      const len = src[pos]! | (src[pos + 1]! << 8);
      const nlen = src[pos + 2]! | (src[pos + 3]! << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new InflateError("gzip: そのまま入れた塊の長さが合いません");
      if (pos + len > end) throw new InflateError("gzip: データが途中で切れています");
      if (o + len > out.length) throw new InflateError("gzip: 伸ばした長さが記録より長くなります");
      out.set(src.subarray(pos, pos + len), o);
      o += len;
      pos += len;
    } else if (type === 1 || type === 2) {
      let lit: Table;
      let dist: Table;
      if (type === 1) ({ lit, dist } = fixedTables());
      else {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        if (hlit > 286 || hdist > 30) throw new InflateError("gzip: 符号の数が多すぎます");
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3);
        const clt = buildTable(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist; ) {
          const s = sym(clt);
          if (s < 16) lens[i++] = s;
          else {
            let rep: number;
            let v = 0;
            if (s === 16) {
              if (i === 0) throw new InflateError("gzip: 繰り返す前の長さがありません");
              v = lens[i - 1]!;
              rep = 3 + bits(2);
            } else if (s === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > hlit + hdist) throw new InflateError("gzip: 符号の長さの繰り返しが多すぎます");
            lens.fill(v, i, i + rep);
            i += rep;
          }
        }
        if (lens[256] === 0) throw new InflateError("gzip: 塊の終わりの符号がありません");
        lit = buildTable(lens.subarray(0, hlit), hlit);
        dist = buildTable(lens.subarray(hlit), hdist);
      }
      for (;;) {
        const s = sym(lit);
        if (s < 256) {
          if (o >= out.length) throw new InflateError("gzip: 伸ばした長さが記録より長くなります");
          out[o++] = s;
        } else if (s === 256) break;
        else {
          const li = s - 257;
          if (li >= 29) throw new InflateError("gzip: 長さの符号が範囲の外です");
          const len = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
          const di = sym(dist);
          if (di >= 30) throw new InflateError("gzip: 距離の符号が範囲の外です");
          const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
          if (d > o) throw new InflateError("gzip: 距離が伸ばした分より遠くを指しています");
          if (o + len > out.length) throw new InflateError("gzip: 伸ばした長さが記録より長くなります");
          for (let k = 0; k < len; k++, o++) out[o] = out[o - d]!;
        }
      }
    } else throw new InflateError("gzip: 知らない塊の種類です");
    if (pos - (cnt >> 3) > end) throw new InflateError("gzip: データが途中で切れています");
    if (last) break;
  }
  if (o !== out.length) throw new InflateError(`gzip: 伸ばした長さ ${o} が記録 ${out.length} と違います`);
  // 最後の塊の後: バイトの区切りまで捨て、先に読み込んだバイトを戻す
  return pos - (cnt >> 3);
}

/** 伸ばした後の長さの上限（256 MB） */
const MAX_OUT = 1 << 28;

/** gzip（枠 1 つ）を伸ばす。枠・CRC・長さの記録を確かめ、合わなければ InflateError を投げる */
export function gunzipSync(src: Uint8Array): Uint8Array {
  if (src.length < 18 || src[0] !== 0x1f || src[1] !== 0x8b) throw new InflateError("gzip: gzip のデータではありません");
  if (src[2] !== 8) throw new InflateError("gzip: deflate でない圧縮です");
  const flg = src[3]!;
  if (flg & 0xe0) throw new InflateError("gzip: 知らない印があります");
  let pos = 10;
  const end = src.length - 8;
  if (flg & 4) {
    if (pos + 2 > end) throw new InflateError("gzip: 枠が途中で切れています");
    pos += 2 + (src[pos]! | (src[pos + 1]! << 8));
  }
  const skipZ = () => {
    while (pos < end && src[pos] !== 0) pos++;
    pos++;
  };
  if (flg & 8) skipZ();
  if (flg & 16) skipZ();
  if (flg & 2) pos += 2;
  if (pos > end) throw new InflateError("gzip: 枠が途中で切れています");
  const isize = (src[end + 4]! | (src[end + 5]! << 8) | (src[end + 6]! << 16) | (src[end + 7]! << 24)) >>> 0;
  const crc = (src[end]! | (src[end + 1]! << 8) | (src[end + 2]! << 16) | (src[end + 3]! << 24)) >>> 0;
  // 伸ばした後の長さの記録が大きすぎる物は、壊れたデータとみる（同梱の地図は数 MB）
  if (isize > MAX_OUT) throw new InflateError(`gzip: 伸ばした長さの記録 ${isize} が大きすぎます`);
  const out = new Uint8Array(isize);
  const stop = inflateRaw(src, pos, end, out);
  if (stop !== end) throw new InflateError("gzip: deflate のデータの後ろに余りがあります（枠が 2 つ以上・壊れたデータ）");
  if (crc32(out) !== crc) throw new InflateError("gzip: CRC が合いません");
  return out;
}
