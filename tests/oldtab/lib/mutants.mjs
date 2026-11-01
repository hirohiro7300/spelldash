// 新しい木の写しに当てる変異（--mutant。カンマで重ねられる）。製品のファイルは変えず、写しの各ページの <head> の頭に classic script を 1 つ差し込むだけ。
// 目的は 2 つ:
//   (1) 検査が落ちることを見る（守りを外すと漏れを見つける）
//   (2) 守りの形が足りるかを、本物の旧いコードに当てて先に見る（製品の実装は役 areas。ここの試作は検査の側の近似で、製品には入れない）
// 一覧:
//   proto-defence      試作の守り: 人の記録の鍵 spelldash_* を sd2x.* へ移して読み替え（getItem・setItem・removeItem・key・length・storage イベント）、
//                      認証のセッションの鍵 sb-<ref>-auth-token* を sd2x-auth-token* へ移して読み替え、タブをまたぐ知らせ（BroadcastChannel）の名前も替える。
//                      最初の読み込みで旧い鍵の中身を新しい鍵へ写し、旧い鍵を消す（docs/SPEC_ACCOUNT_AREAS.md §1.1・§6 の 1 と 2 の近似）
//   proto-no-authkey   proto-defence から認証の鍵と知らせの名前の分離を外す（人の記録の鍵だけ分ける）→ 漏れるはず
//   proto-no-recordkey proto-defence から人の記録の鍵の分離を外す（認証の鍵と知らせだけ分ける）→ 漏れるはず
//   mirror-session     守りを破る変異（どの木にも当てられる）: 新しいコードが別の鍵に置いたセッションを旧い鍵 sb-<ref>-auth-token へ写し、
//                      別の名前の知らせを旧い名前の BroadcastChannel にも流す。認証の世代を分けた木（役 areas）に当てると漏れるはず。
//                      分けていない木（09077e1）では何も変えない
//   person-key-as-device 記録の分離を破る変異（js/areaGuard.js のある木だけ）: 人の記録の鍵 spelldash_streak を端末の鍵の一覧（DEVICE_NAMES）に足す
//                      （人ごとの領域に分けず、A の連続日数を B の領域からも読める）。認証の鍵の分離はそのまま。漏れを見つけるはず。
//                      js/areaGuard.js の無い木（分離の前）では何も変えない。一覧の形が変わって当てられなければ止まる（変異を直す）
//   orphan-into-area   旧い場所の片付けを破る変異（js/areaSwitch.js のある木だけ）: 移行の後に旧コードのタブが旧い鍵へ書いた値（sweepOrphans が見つけた物）を、
//                      orphans へ写すのに加えて、今の領域の鍵 sd2.<領域>.<名前> へも書く（A の旧いタブの答えが B の領域に入り、新しいコードが B として送る）。
//                      新しいコードが次の読み込みで旧い鍵を扱う道を通さないと見つからない（4 段の後と旧いタブを閉じた後の開き直し）。形が変わって当てられなければ止まる
//   proto-import       試作の取り込み（A へ戻る段の確かめが通ることを見る。製品の実装は役 areas。ここは検査の側の近似で、製品には入れない）:
//                      js/areaSwitch.js の切り替え（switchTo）で、切り替え先が移行で決めた領域（sd2.migrated の area。旧いタブの持ち主）のとき、
//                      切り替え先を localStorage に書いた後に、まだ取り込んでいない orphans の記録（area の無い物＝旧コードのタブが旧い鍵へ書いた値）の
//                      語の記録を、語ごとに回数を足して（最後に答えた時刻は新しい方）切り替え先の語の記録へ入れ、送る語の印に足し、取り込んだ記録の id を
//                      sd2.oldtab-imported に残す（2 度取り込まない）。orphans の値は移行の後の空の旧い場所に旧いタブが書いた物なので、値そのものが増えた分
//   proto-import-every proto-import から「取り込んだ記録の id を残す」を外す（A へ戻るたびに同じ記録を足す）→ DOUBLE のはず
//   proto-import-replace proto-import の「回数を足す」を「旧いタブの値で置き換える」にする（A の回数が旧いタブの値に戻る）→ NOT_IMPORTED（と LOSS）のはず
import fs from "fs";
import path from "path";
import { copyTree } from "./trees.mjs";

const OLD_AUTH_KEY = "sb-sujvgwozsnzjsjmkcrnk-auth-token";

function protoScript({ records, auth }) {
  return `(function(){try{
var FL={records:${records},auth:${auth}},PO="spelldash_",PN="sd2x.",AO="${OLD_AUTH_KEY}",AN="sd2x-auth-token",MK="sd2x-migrated";
var S=Storage.prototype,g=S.getItem,s=S.setItem,r=S.removeItem,k=S.key,L=Object.getOwnPropertyDescriptor(S,"length").get;
var ls=window.localStorage;
function isLS(x){try{return x===ls}catch(e){return false}}
function hid(n){n=String(n);return (FL.records&&n.indexOf(PO)===0)||(FL.auth&&n.indexOf(AO)===0)}
function map(n){n=String(n);if(FL.records&&n.indexOf(PO)===0)return PN+n.slice(PO.length);if(FL.auth&&n.indexOf(AO)===0)return AN+n.slice(AO.length);return n}
function unmap(n){if(FL.records&&n.indexOf(PN)===0)return PO+n.slice(PN.length);if(FL.auth&&n.indexOf(AN)===0)return AO+n.slice(AN.length);return n}
function isNew(n){return n!==null&&((FL.records&&n.indexOf(PN)===0)||(FL.auth&&n.indexOf(AN)===0))}
if(g.call(ls,MK)===null){var all=[],i;for(i=0;i<L.call(ls);i++)all.push(k.call(ls,i));
for(i=0;i<all.length;i++)if(hid(all[i]))s.call(ls,map(all[i]),g.call(ls,all[i]));
for(i=0;i<all.length;i++)if(hid(all[i]))r.call(ls,all[i]);s.call(ls,MK,"1")}
function view(x){var o=[],i,n;for(i=0;i<L.call(x);i++){n=k.call(x,i);if(!hid(n)&&n!==MK)o.push(unmap(n))}return o}
S.getItem=function(n){return isLS(this)?g.call(this,map(n)):g.call(this,n)};
S.setItem=function(n,v){return isLS(this)?s.call(this,map(n),v):s.call(this,n,v)};
S.removeItem=function(n){return isLS(this)?r.call(this,map(n)):r.call(this,n)};
S.key=function(i){if(!isLS(this))return k.call(this,i);var v=view(this)[i];return v===undefined?null:v};
Object.defineProperty(S,"length",{configurable:true,get:function(){return isLS(this)?view(this).length:L.call(this)}});
var RE=false;window.addEventListener("storage",function(e){if(RE||e.storageArea!==ls)return;if(e.key!==null&&hid(e.key)){e.stopImmediatePropagation();return}
if(isNew(e.key)){e.stopImmediatePropagation();RE=true;try{window.dispatchEvent(new StorageEvent("storage",{key:unmap(e.key),oldValue:e.oldValue,newValue:e.newValue,url:e.url,storageArea:ls}))}finally{RE=false}}},true);
if(FL.auth&&window.BroadcastChannel){var BC=window.BroadcastChannel;window.BroadcastChannel=function(n){return new BC(n===AO?AN:n)};window.BroadcastChannel.prototype=BC.prototype}
}catch(e){console.error("proto-defence",e)}})();`;
}

function mirrorScript() {
  return `(function(){try{
var AO="${OLD_AUTH_KEY}",S=Storage.prototype,g=S.getItem,s=S.setItem,k=S.key,L=Object.getOwnPropertyDescriptor(S,"length").get,ls=window.localStorage;
function looks(v){try{var j=JSON.parse(v);return j&&typeof j==="object"&&j.access_token&&j.refresh_token&&j.user}catch(e){return false}}
function copy(){var i,n,v;for(i=0;i<L.call(ls);i++){n=k.call(ls,i);if(n===AO)continue;v=g.call(ls,n);if(v&&looks(v)&&g.call(ls,AO)!==v)s.call(ls,AO,v)}}
setInterval(copy,300);
if(window.BroadcastChannel){var BC=window.BroadcastChannel,relay=null;window.BroadcastChannel=function(n){var c=new BC(n);if(n!==AO){var p=c.postMessage.bind(c);c.postMessage=function(m){try{if(m&&m.event){relay=relay||new BC(AO);relay.postMessage(m);copy()}}catch(e){}return p(m)}}return c};window.BroadcastChannel.prototype=BC.prototype}
}catch(e){console.error("mirror-session",e)}})();`;
}

// js/areaGuard.js の端末の鍵の一覧に人の記録の鍵を 1 つ足す（写しの中だけ）
function personKeyAsDevice(root) {
  const file = path.join(root, "js", "areaGuard.js");
  if (!fs.existsSync(file)) return "js/areaGuard.js が無い木（分離の前）: 何も変えない";
  const src = fs.readFileSync(file, "utf8");
  const re = /const DEVICE_NAMES = Object\.freeze\(\[\s*/;
  if (!re.test(src)) throw new Error("person-key-as-device: js/areaGuard.js に「const DEVICE_NAMES = Object.freeze([」が無い（変異を今の形に合わせて直す）");
  if (/DEVICE_NAMES = Object\.freeze\(\[[^\]]*"streak"/.test(src)) throw new Error("person-key-as-device: streak はもう端末の鍵（変異が意味を持たない）");
  fs.writeFileSync(file, src.replace(re, (m) => m + '"streak", '));
  return "js/areaGuard.js の DEVICE_NAMES に streak を足した";
}

// js/areaSwitch.js の sweepOrphans の頭（見つけた旧い鍵の一覧を作った所）に、今の領域の鍵へ写す 1 行を足す（写しの中だけ）
function orphanIntoArea(root) {
  const file = path.join(root, "js", "areaSwitch.js");
  if (!fs.existsSync(file)) return "js/areaSwitch.js が無い木（分離の前）: 何も変えない";
  const src = fs.readFileSync(file, "utf8");
  const re = /(async function sweepOrphans\(store\) \{\s*const found = \{\};\s*for \(const key of legacyKeys\(\)\) found\[key\] = ls\.get\(key\);\s*const names = Object\.keys\(found\);)/;
  if (!re.test(src)) throw new Error("orphan-into-area: js/areaSwitch.js の sweepOrphans の頭（found・legacyKeys・names）の形が違う（変異を今の形に合わせて直す）");
  if (!/const markerNow = /.test(src) || !/physicalKey/.test(fs.readFileSync(path.join(root, "js", "areaGuard.js"), "utf8"))) throw new Error("orphan-into-area: markerNow か K.physicalKey が無い（変異を今の形に合わせて直す）");
  const line = `\n    try { const area = markerNow()?.area; if (area) for (const key of names) ls.set(K.physicalKey(area, key), found[key]); } catch {} // oldtab の変異 orphan-into-area`;
  fs.writeFileSync(file, src.replace(re, (m) => m + line));
  return "js/areaSwitch.js の sweepOrphans で、旧い鍵の値を今の領域の鍵へも書く";
}

// js/areaSwitch.js の switchTo の手順 8（index[T] = ls）の直前に、試作の取り込みを差し込む（写しの中だけ）
function protoImport(root, { remember = true, mode = "add" } = {}) {
  const file = path.join(root, "js", "areaSwitch.js");
  if (!fs.existsSync(file)) return "js/areaSwitch.js が無い木（分離の前）: 何も変えない";
  const src = fs.readFileSync(file, "utf8");
  const re = /\n(\s*)\/\/ 8\. index\[T\] = ls/;
  if (!re.test(src)) throw new Error("proto-import: js/areaSwitch.js の switchTo に「// 8. index[T] = ls」が無い（変異を今の形に合わせて直す）");
  if (!/const readJson = K\.readJson;/.test(src) || !/MIGRATED_KEY/.test(src) || !/store\.list\(/.test(src)) throw new Error("proto-import: readJson・K.MIGRATED_KEY・store.list の形が違う（変異を今の形に合わせて直す）");
  const merge = mode === "replace"
    ? "{ ...a, ...v }"
    : "{ ...a, playCount: n(a.playCount) + n(v.playCount), correctCount: n(a.correctCount) + n(v.correctCount), recallFail: n(a.recallFail) + n(v.recallFail), lastPlayed: !a.lastPlayed || (v.lastPlayed && Date.parse(v.lastPlayed) > Date.parse(a.lastPlayed)) ? v.lastPlayed ?? a.lastPlayed ?? null : a.lastPlayed }";
  const code = `
      try { // oldtab の変異 proto-import（検査の側の近似。製品には入れない）
        const mig = readJson(ls.get(K.MIGRATED_KEY));
        if (mig && mig.area === target) {
          const MARK = "sd2.oldtab-imported";
          const done = new Set(${remember ? "readJson(ls.get(MARK)) ?? []" : "[]"});
          const recs = (await store.list("orphans")).filter((r) => r && !r.area && !done.has(r.id)).sort((x, y) => String(x.savedAt).localeCompare(String(y.savedAt)));
          const wkey = K.physicalKey(target, K.PREFIX + "word_stats");
          const dkey = K.physicalKey(target, K.PREFIX + "dirty_words");
          const stats = readJson(ls.get(wkey)) ?? {};
          const dirty = new Set(readJson(ls.get(dkey)) ?? []);
          const n = (x) => Number(x) || 0;
          for (const r of recs) {
            const w = readJson(r.keys?.[K.PREFIX + "word_stats"] ?? null);
            if (w && typeof w === "object") for (const [wid, v] of Object.entries(w)) {
              if (!v || typeof v !== "object") continue;
              const a = stats[wid] ?? {};
              stats[wid] = ${merge};
              dirty.add(wid);
            }
            done.add(r.id);
          }
          ls.set(wkey, JSON.stringify(stats));
          ls.set(dkey, JSON.stringify([...dirty]));
          ${remember ? "ls.set(MARK, JSON.stringify([...done]));" : ""}
        }
      } catch (e) { console.error("proto-import", e); }`;
  fs.writeFileSync(file, src.replace(re, (m) => code + m));
  return `js/areaSwitch.js の switchTo（手順 8 の前）に試作の取り込み（${mode === "replace" ? "置き換え" : "回数を足す"}・${remember ? "取り込んだ記録を覚える" : "覚えない"}）`;
}

export const MUTANTS = {
  "proto-defence": { script: () => protoScript({ records: true, auth: true }), note: "試作の守り（人の記録の鍵と認証の鍵の世代を分ける・知らせの名前を替える）" },
  "proto-no-authkey": { script: () => protoScript({ records: true, auth: false }), note: "試作の守りから認証の鍵の分離を外した" },
  "proto-no-recordkey": { script: () => protoScript({ records: false, auth: true }), note: "試作の守りから人の記録の鍵の分離を外した" },
  "mirror-session": { script: mirrorScript, note: "別の鍵のセッションを旧い鍵へ写し、知らせを旧い名前にも流す（認証の世代の分離を破る）" },
  "person-key-as-device": { edit: personKeyAsDevice, note: "人の記録の鍵 spelldash_streak を端末の鍵として扱う（記録の領域の分離を破る）" },
  "orphan-into-area": { edit: orphanIntoArea, note: "移行の後に旧いタブが旧い鍵へ書いた値を、片付けの時に今の領域の鍵へも書く（旧い場所の片付けを破る）" },
  "proto-import": { edit: (root) => protoImport(root, { remember: true, mode: "add" }), note: "試作の取り込み: 移行で決めた領域へ切り替えたとき、まだ取り込んでいない orphans の語の記録の回数を足して送る語の印に足す（A へ戻る段の確かめが通るか）" },
  "proto-import-every": { edit: (root) => protoImport(root, { remember: false, mode: "add" }), note: "試作の取り込みから「取り込んだ記録を覚える」を外す（A へ戻るたびに足す → DOUBLE のはず）" },
  "proto-import-replace": { edit: (root) => protoImport(root, { remember: true, mode: "replace" }), note: "試作の取り込みで回数を足さずに旧いタブの値で置き換える（→ NOT_IMPORTED のはず）" }
};

// 写しを作り、各ページの <head> の頭に変異の script を差し込む（先に書いた物が先に動く）
export function applyMutant(spec, srcRoot, dstRoot) {
  // mirror-session は生の localStorage と BroadcastChannel を握る必要があるので、いつもいちばん先に差し込む
  const names = spec.split(",").map((s) => s.trim()).filter(Boolean).sort((a, b) => (a === "mirror-session" ? -1 : b === "mirror-session" ? 1 : 0));
  for (const n of names) if (!MUTANTS[n]) throw new Error(`知らない変異: ${n}`);
  copyTree(srcRoot, dstRoot);
  const edits = names.filter((n) => MUTANTS[n].edit).map((n) => `${n}: ${MUTANTS[n].edit(dstRoot)}`);
  const scripts = names.filter((n) => MUTANTS[n].script).map((n) => `<script data-oldtab-mutant="${n}">${MUTANTS[n].script()}</script>`).join("");
  const pages = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", ".git", "data", "assets"].includes(e.name)) walk(p);
      } else if (scripts && e.name.endsWith(".html")) {
        const html = fs.readFileSync(p, "utf8");
        const m = html.match(/<head[^>]*>/i);
        if (!m) continue;
        fs.writeFileSync(p, html.replace(m[0], m[0] + scripts));
        pages.push(path.relative(dstRoot, p));
      }
    }
  };
  walk(dstRoot);
  return { root: dstRoot, names, pages, edits, note: names.map((n) => `${n}: ${MUTANTS[n].note}`).concat(edits).join(" / ") };
}
