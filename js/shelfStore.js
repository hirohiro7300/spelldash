// ===== わたしの本棚の規則（純粋な関数だけ。DOM と localStorage は読まない） =====
//
// 本棚（js/bookshelf.js）が「いまの状態」を snap に組んで渡し、ここが「棚に何を保存し、何を並べるか」を決める。
// 単体の検査は scripts/test-shelf.mjs（node で直に import する。依存を持たない: コースの表などは snap で受け取る）。
// 仕様は Batch 61（docs/CHANGELOG.md）。言葉:
//   本 = 目録の 1 冊（キー "b:<id>"）・函 = コース 1 つ（"c:<id>"）・机の本 = spelldash_category（"all" は無し）
//   効いているコース = spelldash_course のうち、その巻に机の本が入っているもの（学習に効くのもこのときだけ。js/studyQueue.js sectionOf）
//   既定の印 = packs の中学英語 1年で、中学英語 2年が packs に無いもの（ensureDefaultCourse が敷いただけ。記録では見分けない）
//   既定のまま = 記録が空で、packs が空か中学英語 1年だけ（学んでいない・何も足していない端末）。このときの棚は仮の棚（prov）
//
// snap = {
//   packs: string[], course: string, desk: string, myCount: number, statsEmpty: boolean, best: { [id]: number },
//   courses: { [id]: { packs: string[] } }, defaultCourse: string,
//   freqCourseOf(id) → コース id | null（頻度順の巻 → その全集）, isBase(id) → bool（基本カテゴリ）,
//   known: Set<"b:id" | "c:id">（目録にあるキー）, hasRecords(bookIds) → bool（読み込まれた巻の語に記録があるか）,
//   baseRecordCounts() → [{ id, n }]（基本カテゴリごとの、自分の語で記録のある数。移行の M5' だけが呼ぶ）
// }
// Shelf = { v: 1, books: string[], courses: string[], seen: string[], prov: boolean }

export const SHELF_KEY = "spelldash_shelf";
const MY = "my";

const uniq = (list) => [...new Set(list)];
const strings = (list) => list.filter((x) => typeof x === "string");

// 文字列 → Shelf。壊れている（JSON でない・v が 1 でない・配列でない・prov が真偽値でない）なら null（＝移行し直す）
export function parseShelf(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== 1) return null;
  if (!Array.isArray(data.books) || !Array.isArray(data.courses) || !Array.isArray(data.seen)) return null;
  if (data.prov !== undefined && typeof data.prov !== "boolean") return null;
  return { v: 1, books: uniq(strings(data.books)), courses: uniq(strings(data.courses)), seen: uniq(strings(data.seen)), prov: data.prov === true };
}

// Shelf → 文字列。目録に無い id も残す（古い manifest を持つタブが新しいパックの id を消さないように）
export function serializeShelf(shelf) {
  return JSON.stringify({ v: 1, books: uniq(shelf.books), courses: uniq(shelf.courses), seen: uniq(shelf.seen), prov: !!shelf.prov });
}

// 2 つの棚が同じか（並びは問わない）
export function sameShelf(a, b) {
  if (!a || !b) return a === b;
  const set = (x) => JSON.stringify(uniq(x).sort());
  return !!a.prov === !!b.prov && set(a.books) === set(b.books) && set(a.courses) === set(b.courses) && set(a.seen) === set(b.seen);
}

const defaults = (snap) => {
  const packs = snap.courses[snap.defaultCourse]?.packs ?? [];
  return { first: packs[0] ?? "", second: packs[1] ?? "" };
};
const coursePacks = (snap, id) => snap.courses[id]?.packs ?? [];

export function effectiveCourse(snap) {
  return coursePacks(snap, snap.course).includes(snap.desk) ? snap.course : "";
}

export function isDefaultState(snap) {
  const { first } = defaults(snap);
  return !!snap.statsEmpty && snap.packs.every((id) => id === first);
}

export function isDefaultMark(id, snap) {
  const { first, second } = defaults(snap);
  return id === first && !snap.packs.includes(second);
}

const deskInCatalog = (snap) => !!snap.desk && snap.desk !== "all" && snap.known.has(`b:${snap.desk}`);

// 机の本を保存するときのキー（1 セット始めた・初回のスタート）
export function deskKey(snap) {
  if (!deskInCatalog(snap)) return null;
  const eff = effectiveCourse(snap);
  if (eff) return `c:${eff}`;
  const freq = snap.freqCourseOf(snap.desk);
  if (freq) return `c:${freq}`;
  return `b:${snap.desk}`;
}

const seenOf = (snap, prevSeen = []) => uniq([...snap.packs, ...(snap.myCount > 0 || prevSeen.includes(MY) ? [MY] : [])]);

// 移行（保存した棚が無い端末で 1 回。仮の棚は既定のままでなくなった照合でもう 1 回）。材料は明示の印だけ
export function migrateShelf(snap) {
  const courses = new Set();
  const books = new Set();
  const prov = isDefaultState(snap); // M0: M1〜M3 は飛ばし、M4〜M6 は通す
  const eff = effectiveCourse(snap);
  const inCourses = (id) => [...courses].some((c) => coursePacks(snap, c).includes(id));
  if (!prov) {
    // M1 函: ① 効いているコース ② 効いていない spelldash_course ③ 頻度順の巻の全集。
    //   ② 既定のコースは、2 巻目が packs にあるとき、または机が自分で選んだ分野パックでない（すべて・マイ単語帳・基本カテゴリ＝チップ）ときに 1 巻目の語に記録があれば。
    //      机をチップ・すべて・マイ単語帳にしている間に移行しても、既定のコースで学んだ人の函を落とさない（机が分野パックなら、旧版の初回でその本を選んだ人と見分けて入れない）。
    //      ほかのコースは記録で
    if (eff) courses.add(eff);
    if (!eff && snap.courses[snap.course]) {
      const { first, second } = defaults(snap);
      const deskIsChip = !snap.desk || snap.desk === "all" || snap.desk === MY || snap.isBase(snap.desk);
      const used = snap.course === snap.defaultCourse ? snap.packs.includes(second) || (deskIsChip && snap.hasRecords([first])) : snap.hasRecords(coursePacks(snap, snap.course));
      if (used) courses.add(snap.course);
    }
    for (const id of snap.packs) {
      const freq = snap.freqCourseOf(id);
      if (freq) courses.add(freq);
    }
    // M2 packs の本（函が持つ巻・既定の印は入れない。目録に無い id も保存には残す）
    for (const id of snap.packs) {
      if (snap.freqCourseOf(id)) continue;
      if (inCourses(id)) continue;
      if (eff && coursePacks(snap, eff).includes(id)) continue;
      if (isDefaultMark(id, snap)) continue;
      books.add(id);
    }
    // M3 机の本
    if (deskInCatalog(snap) && !(eff && coursePacks(snap, eff).includes(snap.desk)) && !snap.freqCourseOf(snap.desk)) books.add(snap.desk);
  }
  // M4 Challenge を遊んだ基本カテゴリ（"all"・"my"・パックは見ない）
  for (const [id, score] of Object.entries(snap.best ?? {})) {
    if (Number(score) >= 1 && snap.isBase(id) && !inCourses(id)) books.add(id);
  }
  // M5 マイ単語帳
  if (snap.myCount > 0) books.add(MY);
  // M5' 記録だけで学んできた人（机は「すべて」・コースも印も無い）の棚が空にならないように: 自分の語に記録の多い基本カテゴリを 1 冊（2 冊目は 1 冊目の半分以上なら）。
  //     記録の数で選ぶので、語の id の共有で付いた少ない記録の本は入らない
  if (!prov && books.size === 0 && courses.size === 0 && snap.desk === "all" && typeof snap.baseRecordCounts === "function") {
    const top = snap.baseRecordCounts().filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    if (top[0]) books.add(top[0].id);
    if (top[1] && top[1].n * 2 >= top[0].n) books.add(top[1].id);
  }
  // M6 控え
  return { v: 1, books: [...books], courses: [...courses], seen: seenOf(snap), prov };
}

function withKey(shelf, key) {
  if (!key) return shelf;
  const id = key.slice(2);
  if (key.startsWith("c:")) return shelf.courses.includes(id) ? shelf : { ...shelf, courses: [...shelf.courses, id] };
  return shelf.books.includes(id) ? shelf : { ...shelf, books: [...shelf.books, id] };
}

// 初回のスタートの棚（下見の棚も保存する棚もこれ。js/bookshelf.js drawWelcome・startShelf）: 机の本のキーを足す（仮の棚にしない）。
//   保存した棚が無い（普通の初回）: その時の状態での移行＋机の本のキー
//   保存した棚がある（深いリンクで来て本を足してから、初回の画面でスタートした）: その棚を照合したもの＋机の本のキー（足した本・函を消さない）
export function shelfAtStart(snap, saved = null) {
  const base = saved ? reconcileShelf(saved, snap).shelf : migrateShelf(snap);
  return withKey({ ...base, prov: false }, deskKey(snap));
}

// 初回のスタートが状態をどう替えるか（下見の棚はこの結果で描き、js/main.js の onStart は startChanges でこの結果を書く。規則はここだけ）
//   函を選んだ: コースの鍵を回し、選んだ巻（無ければ最初の巻）を読み込んで机に
//   既定の本（既定のコースの 1 巻目）以外の本: 分野パックなら packs に足し、机に出す
export function applyStartChoice(snap, { bookId = "", courseId = "" } = {}) {
  let { packs, course, desk } = snap;
  const isPack = (id) => snap.known.has(`b:${id}`) && !snap.isBase(id) && id !== MY;
  if (courseId && snap.courses[courseId]) {
    const list = coursePacks(snap, courseId);
    const start = bookId && list.includes(bookId) ? bookId : list[0];
    course = courseId;
    if (!snap.isBase(start) && !packs.includes(start)) packs = [...packs, start];
    desk = start;
  }
  if (bookId && bookId !== defaults(snap).first) {
    if (isPack(bookId) && !packs.includes(bookId)) packs = [...packs, bookId];
    desk = bookId;
  }
  return { ...snap, packs, course, desk };
}

// applyStartChoice が替える欄だけ（js/main.js の onStart がこのとおりに書く）: { course, desk, packs }。替わらない欄は ""、packs は足す物だけ
export function startChanges(snap, choice) {
  const next = applyStartChoice(snap, choice);
  return { course: next.course !== snap.course ? next.course : "", desk: next.desk !== snap.desk ? next.desk : "", packs: next.packs.filter((id) => !snap.packs.includes(id)) };
}

// 照合（描くたびに 1 回）: 仮の棚の移行し直し → 新しく届いたパック（P3）→ 外したパック → 控え
export function reconcileShelf(shelf, snap) {
  if (shelf.prov && !isDefaultState(snap)) {
    const next = migrateShelf(snap);
    return { shelf: next, changed: !sameShelf(shelf, next) };
  }
  const books = new Set(shelf.books);
  const courses = new Set(shelf.courses);
  const eff = effectiveCourse(snap);
  const cand = seenOf(snap, shelf.seen);
  const removed = shelf.seen.filter((id) => id !== MY && !snap.packs.includes(id));
  for (const id of cand) {
    if (shelf.seen.includes(id) || books.has(id)) continue;
    if (id === MY) {
      books.add(id);
      continue;
    }
    const freq = snap.freqCourseOf(id);
    if (freq) {
      courses.add(freq);
      continue;
    }
    if (eff && coursePacks(snap, eff).includes(id)) {
      courses.add(eff);
      continue;
    }
    if (isDefaultMark(id, snap)) continue;
    books.add(id);
  }
  for (const id of removed) books.delete(id);
  const next = { v: 1, books: [...books], courses: [...courses], seen: cand, prov: !!shelf.prov };
  return { shelf: next, changed: !sameShelf(shelf, next) };
}

// 机の本で 1 セット始めた（spelldash:game-start の study）: 机の本のキーを保存する
export function noteStudyStart(shelf, snap) {
  const base = shelf.prov && !isDefaultState(snap) ? migrateShelf(snap) : shelf;
  const next = { ...withKey(base, deskKey(snap)), prov: false };
  return { shelf: next, changed: !sameShelf(shelf, next) };
}

// 保存した棚にそのキー（"b:id" | "c:id"）があるか（窓の「棚にある」・整理の「戻す」）
export function savedHas(shelf, key) {
  const id = key.slice(2);
  return key.startsWith("c:") ? shelf.courses.includes(id) : shelf.books.includes(id);
}

export function addKey(shelf, key) {
  return { ...withKey(shelf, key), prov: false };
}

export function dropKey(shelf, key) {
  const id = key.slice(2);
  return key.startsWith("c:")
    ? { ...shelf, courses: shelf.courses.filter((x) => x !== id), prov: false }
    : { ...shelf, books: shelf.books.filter((x) => x !== id), prov: false };
}

// 並べる物: （足した函 ∪ 効いているコースの函）＋（足した本 ∪ 机の本）。目録の順。机の本は空き（いまのコースの巻なら函の直後）。
// order = [{ key, group }]（目録の表示順。group は群: 函は "course"、本は棚割り）。目録に無いキーは飛ばす
export function displayItems(shelf, snap, order) {
  const eff = effectiveCourse(snap);
  const courseSet = new Set([...shelf.courses, ...(eff ? [eff] : [])]);
  const desk = deskInCatalog(snap) ? snap.desk : "";
  const bookSet = new Set([...shelf.books, ...(desk ? [desk] : [])]);
  const deskInEff = !!desk && !!eff && coursePacks(snap, eff).includes(desk);
  const items = [];
  for (const { key, group } of order) {
    const id = key.slice(2);
    if (key.startsWith("c:")) {
      if (!courseSet.has(id)) continue;
      const current = id === eff;
      items.push({ key, id, kind: "box", current, droppable: !current, group });
      if (current && deskInEff) items.push({ key: `b:${desk}`, id: desk, kind: "slot", current: false, droppable: false, group });
      continue;
    }
    if (!bookSet.has(id)) continue;
    if (id === desk) {
      if (!deskInEff) items.push({ key, id, kind: "slot", current: false, droppable: false, group });
      continue;
    }
    items.push({ key, id, kind: "book", current: false, droppable: true, group });
  }
  return items;
}

// 段の割り付け（貪欲）。items = [{ w, group }]、inner = 段の中の幅。
// 物と物の間は 2、群の境目は 10（段の頭は 0）。本立て（end）は最後の段の残りが 2 + end 以上のときだけ。
// 一文（hint）は、空の段があれば最初の空の段の中央、無ければ本立ての後の残りが 2 + hintMin 以上のときだけ最後の段の残りに。新しい段は作らない。
// → { rows: [{ items: [{ i, gap }], used }], total, end, hint: null | { row, left, width, center } }
export function packRows(items, inner, { minRows = 1, end = 32, hintMin = 96, hint = false } = {}) {
  const rows = [];
  let row = null;
  items.forEach((item, i) => {
    const prev = row?.items.length ? items[row.items[row.items.length - 1].i] : null;
    const gap = prev ? (prev.group !== item.group ? 10 : 2) : 0;
    if (row && row.items.length && row.used + gap + item.w > inner) row = null;
    if (!row) {
      row = { items: [], used: 0 };
      rows.push(row);
    }
    const g = row.items.length ? gap : 0;
    row.items.push({ i, gap: g });
    row.used += g + item.w;
  });
  const total = Math.max(rows.length, minRows, 1);
  const last = rows[rows.length - 1];
  const showEnd = !!last && inner - last.used >= 2 + end;
  let place = null;
  if (hint) {
    if (rows.length === 0) place = { row: 0, left: 0, width: inner, center: true };
    else if (total > rows.length) place = { row: rows.length, left: 0, width: inner, center: true };
    else {
      const usedEnd = last.used + (showEnd ? 2 + end : 0);
      if (inner - usedEnd >= 2 + hintMin) place = { row: rows.length - 1, left: usedEnd + 2, width: inner - usedEnd - 2, center: false };
    }
  }
  return { rows, total, end: showEnd, hint: place };
}
