// 問題パックの読み込み・検証・取り込み・単元の合体（仕様 3章・6章）
const Pack = (() => {
  const SCHEMA = 1;
  const TYPES = ['cloze', 'mc', 'multi', 'tf', 'order'];
  const SOURCES = ['text', 'internal', 'external'];
  const PACK_ID_RE = /^[A-Za-z0-9-]+$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const strArr = v => Array.isArray(v) && v.every(s => typeof s === 'string');
  const isBool = v => typeof v === 'boolean';
  const isStr = v => typeof v === 'string';
  const opt = (v, test) => v === undefined || test(v);

  // 貼り付け・ファイルの文字列を読む。壊れていれば行と列を日本語で返す
  function parseText(text) {
    const t = (text || '').trim();
    if (!t) return { error: 'テキストが空です。JSONを貼り付けるかファイルを選んでください' };
    try {
      const data = JSON.parse(t);
      return { packs: Array.isArray(data) ? data : [data] };
    } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      let where = '';
      if (m) {
        const pos = Number(m[1]);
        const before = t.slice(0, pos);
        const line = before.split('\n').length;
        const col = pos - before.lastIndexOf('\n');
        where = `（${line}行目・${col}文字目付近）`;
      }
      return { error: `JSONの書式が正しくありません${where}。${e.message}` };
    }
  }

  function checkCloze(q, bad) {
    if (!isStr(q.text) || !q.text) return bad('text', 'text が必要です');
    if (!Array.isArray(q.blanks) || q.blanks.length === 0) return bad('blanks', 'blanks が必要です（1つ以上）');
    const nos = new Set();
    q.blanks.forEach((b, j) => {
      const f = `blanks[${j}]`;
      if (!isObj(b) || !Number.isInteger(b.no) || b.no < 1) return bad(f, 'no は1以上の整数にしてください');
      if (nos.has(b.no)) bad(f, `no ${b.no} が重複しています`);
      nos.add(b.no);
      if (!isStr(b.answer) || !b.answer.trim()) bad(`${f}.answer`, 'answer が必要です');
      if (!opt(b.kind, isStr)) bad(`${f}.kind`, '文字列にしてください');
      if (!opt(b.alts, strArr)) bad(`${f}.alts`, '文字列の配列にしてください');
      if (!opt(b.distractors, strArr)) bad(`${f}.distractors`, '文字列の配列にしてください');
      if (b.options !== undefined) {
        if (!strArr(b.options) || b.options.length < 2) bad(`${f}.options`, '2つ以上の文字列の配列にしてください');
        else if (isStr(b.answer) && !b.options.includes(b.answer)) bad(`${f}.options`, 'options に answer が含まれていません');
      }
    });
    const ph = [...q.text.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
    const phSet = new Set(ph);
    if (ph.length !== phSet.size) bad('text', '同じ番号の空欄 {{n}} が2つ以上あります');
    for (const n of phSet) if (!nos.has(n)) bad('text', `{{${n}}} に対応する blanks がありません`);
    for (const n of nos) if (!phSet.has(n)) bad('blanks', `no ${n} に対応する {{${n}}} が text にありません`);
  }

  function checkChoice(q, bad) {
    if (!isStr(q.stem) || !q.stem) bad('stem', 'stem が必要です');
    if (!strArr(q.choices) || q.choices.length < 2) return bad('choices', '2つ以上の文字列の配列にしてください');
    if (!Array.isArray(q.answer) || !q.answer.every(Number.isInteger)) return bad('answer', 'answer は番号（整数）の配列にしてください');
    if (!q.answer.every(n => n >= 0 && n < q.choices.length)) bad('answer', 'answer が選択肢の範囲外です');
    if (new Set(q.answer).size !== q.answer.length) bad('answer', '同じ番号が重複しています');
    if (q.type === 'mc' && q.answer.length !== 1) bad('answer', 'mc の answer は1つだけにしてください');
    if (q.type === 'multi' && q.answer.length < 1) bad('answer', 'multi の answer は1つ以上にしてください');
    if (!opt(q.fixedOrder, isBool)) bad('fixedOrder', 'true か false にしてください');
  }

  function checkTF(q, bad) {
    if (!isStr(q.stem) || !q.stem) bad('stem', 'stem が必要です');
    if (!isBool(q.answer)) bad('answer', 'answer は true か false にしてください');
  }

  function checkOrder(q, bad) {
    if (!isStr(q.stem) || !q.stem) bad('stem', 'stem が必要です');
    if (!strArr(q.items) || q.items.length < 2) return bad('items', '2つ以上の文字列の配列（正しい順番）にしてください');
    if (new Set(q.items).size !== q.items.length) bad('items', '同じ項目があります');
  }

  // 1つのパックを検証する。fatal はパックごと取り込めない問題、errors は問題ごとのエラー
  function validateOne(p, ctx) {
    const res = {
      packId: '', packVersion: 0, title: '', updatedAt: '',
      fatal: [], errors: [], questions: [], units: [], groups: [], status: '', existing: null,
    };
    if (!isObj(p)) { res.fatal.push('パックがオブジェクトではありません'); return res; }
    res.packId = isStr(p.packId) ? p.packId : '';
    res.packVersion = p.packVersion;
    res.title = isStr(p.title) ? p.title : '';
    res.updatedAt = isStr(p.updatedAt) ? p.updatedAt : '';
    const f = res.fatal;
    if (p.schema !== SCHEMA) f.push(`schema が ${JSON.stringify(p.schema)} です。このアプリは schema: ${SCHEMA} だけに対応しています`);
    if (!PACK_ID_RE.test(res.packId)) f.push('packId は英数字とハイフンだけの文字列にしてください');
    if (!Number.isInteger(p.packVersion) || p.packVersion < 1) f.push('packVersion は1以上の整数にしてください');
    if (!res.title.trim()) f.push('title がありません');
    if (!DATE_RE.test(res.updatedAt)) f.push('updatedAt は YYYY-MM-DD 形式にしてください');
    if (!Array.isArray(p.groups)) f.push('groups は配列にしてください');
    if (!Array.isArray(p.units)) f.push('units は配列にしてください');
    if (!Array.isArray(p.questions)) f.push('questions は配列にしてください');
    if (f.length) return res;

    // 大単元
    const groupIds = new Set();
    p.groups.forEach((g, i) => {
      if (!isObj(g) || !isStr(g.id) || !g.id || !isStr(g.title) || !Number.isInteger(g.order)) {
        f.push(`groups[${i}]: id・title・order（整数）が必要です`);
        return;
      }
      if (groupIds.has(g.id)) f.push(`groups[${i}]: group id「${g.id}」が重複しています`);
      groupIds.add(g.id);
      res.groups.push({ id: g.id, title: g.title, order: g.order });
    });

    // 単元
    const unitIds = new Set();
    p.units.forEach((u, i) => {
      if (!isObj(u) || !isStr(u.id) || !u.id || !isStr(u.title) || !isStr(u.groupId) || !Number.isInteger(u.order)) {
        f.push(`units[${i}]: id・groupId・title・order（整数）が必要です`);
        return;
      }
      if (!opt(u.source, v => SOURCES.includes(v))) f.push(`units[${i}]: source は text / internal / external のどれかです`);
      if (!opt(u.pages, isStr)) f.push(`units[${i}]: pages は文字列にしてください`);
      if (unitIds.has(u.id)) f.push(`units[${i}]: unit id「${u.id}」が重複しています`);
      if (!groupIds.has(u.groupId) && !ctx.groupIds.has(u.groupId)) f.push(`units[${i}]: groupId「${u.groupId}」が見つかりません`);
      unitIds.add(u.id);
      res.units.push({ id: u.id, groupId: u.groupId, title: u.title, order: u.order, source: u.source || 'text', pages: u.pages || '' });
    });
    if (f.length) return res;

    // 問題
    const seen = new Set();
    p.questions.forEach((q, i) => {
      if (!isObj(q)) { res.errors.push({ label: `#${i + 1}`, field: '(全体)', message: '問題がオブジェクトではありません' }); return; }
      const qe = [];
      const bad = (field, message) => qe.push({ label: `#${i + 1}${isStr(q.id) ? ' ' + q.id : ''}`, field, message });
      if (!isStr(q.id) || !q.id) bad('id', 'id が必要です');
      else {
        if (seen.has(q.id)) bad('id', 'このパック内で id が重複しています');
        const owner = ctx.questionIds.get(q.id);
        if (owner !== undefined && owner !== res.packId) bad('id', `id が別のパック（${owner}）と重複しています`);
        seen.add(q.id);
      }
      if (!isStr(q.unitId) || !(unitIds.has(q.unitId) || ctx.unitIds.has(q.unitId))) bad('unitId', `単元「${q.unitId}」が見つかりません`);
      if (!TYPES.includes(q.type)) bad('type', `type は ${TYPES.join(' / ')} のどれかです`);
      if (!Number.isInteger(q.order)) bad('order', 'order は整数にしてください');
      if (!opt(q.explanation, isStr)) bad('explanation', '文字列にしてください');
      if (!opt(q.memo, isStr)) bad('memo', '文字列にしてください');
      if (!opt(q.page, isStr)) bad('page', '文字列にしてください');
      if (!opt(q.tags, strArr)) bad('tags', '文字列の配列にしてください');
      if (!opt(q.important, isBool)) bad('important', 'true か false にしてください');
      if (!opt(q.retired, isBool)) bad('retired', 'true か false にしてください');
      if (!opt(q.refs, v => strArr(v) && v.every(u => /^https?:\/\//.test(u)))) bad('refs', 'https:// で始まるURLの配列にしてください');
      if (q.type === 'cloze') checkCloze(q, bad);
      else if (q.type === 'mc' || q.type === 'multi') checkChoice(q, bad);
      else if (q.type === 'tf') checkTF(q, bad);
      else if (q.type === 'order') checkOrder(q, bad);
      if (qe.length) res.errors.push(...qe);
      else res.questions.push({ ...q, tags: q.tags || [], important: !!q.important, retired: !!q.retired, refs: q.refs || [] });
    });
    return res;
  }

  // 複数パックをまとめて検証する。先のパックの単元・IDを後のパックの検証に使う
  function validateBatch(list, existing) {
    const ctx = { unitIds: new Set(), groupIds: new Set(), questionIds: new Map() };
    const oldById = new Map();
    for (const r of existing) {
      oldById.set(r.packId, r);
      (r.groups || []).forEach(g => ctx.groupIds.add(g.id));
      (r.units || []).forEach(u => ctx.unitIds.add(u.id));
      (r.questions || []).forEach(q => ctx.questionIds.set(q.id, r.packId));
    }
    return list.map(raw => {
      const res = validateOne(raw, ctx);
      const old = res.packId ? oldById.get(res.packId) : null;
      res.existing = old ? old.packVersion : null;
      if (res.fatal.length) res.status = 'error';
      else if (!old) res.status = 'new';
      else res.status = res.packVersion > old.packVersion ? 'upgrade' : 'same';
      if (!res.fatal.length) {
        res.groups.forEach(g => ctx.groupIds.add(g.id));
        res.units.forEach(u => ctx.unitIds.add(u.id));
        res.questions.forEach(q => ctx.questionIds.set(q.id, res.packId));
      }
      return res;
    });
  }

  // 検証済みのパックを保存する（同じ packId は丸ごと置き換え。成績は progress に残る）
  async function save(results) {
    const recs = results.filter(r => !r.fatal.length).map(r => ({
      packId: r.packId, schema: SCHEMA, packVersion: r.packVersion, title: r.title, updatedAt: r.updatedAt,
      groups: r.groups, units: r.units, questions: r.questions, importedAt: new Date().toISOString(),
    }));
    if (recs.length) await DB.putMany('packs', recs);
    return recs;
  }

  // 穴埋めの空欄IDは「問題ID#空欄番号」、それ以外は問題ID
  function keysOf(q) {
    return q.type === 'cloze' ? q.blanks.map(b => `${q.id}#${b.no}`) : [q.id];
  }

  // 保存済みのパックから、単元・問題の一覧を組み立てる（同じ単元IDは合体する）
  function buildCatalog(records) {
    const groups = new Map(), unitMap = new Map(), byId = new Map(), questions = [];
    records.forEach(r => (r.groups || []).forEach(g => groups.set(g.id, g)));
    records.forEach(r => (r.units || []).forEach(u => unitMap.set(u.id, { ...u })));
    records.forEach(r => (r.questions || []).forEach(q => {
      const item = { ...q, pack: r.packId };
      questions.push(item);
      byId.set(item.id, item);
    }));
    const groupOf = gid => groups.get(gid) || { id: gid, title: 'その他', order: 9999 };
    const units = [...unitMap.values()].sort((a, b) =>
      (groupOf(a.groupId).order - groupOf(b.groupId).order) || (a.order - b.order));
    const unitIndex = new Map(units.map((u, i) => [u.id, i]));
    const active = questions.filter(q => !q.retired && unitMap.has(q.unitId));
    const isExtra = u => u.source === 'internal' || u.source === 'external';
    return {
      groups: [...groups.values()].sort((a, b) => a.order - b.order),
      groupOf, units, unitMap, unitIndex, questions, byId, active, isExtra,
    };
  }

  return { parseText, validateBatch, save, buildCatalog, keysOf };
})();
