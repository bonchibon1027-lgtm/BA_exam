// 出題：問題の組み立て、穴埋めの選択肢、模試の抽選、採点（仕様 4章）
const Quiz = (() => {
  let C = null;          // 単元・問題のカタログ（Pack.buildCatalog の結果）
  let blankPool = [];    // 穴埋めの正解の候補（不正解の作成に使う）
  const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  const circ = n => CIRC[n - 1] || `(${n})`;

  const shuffle = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  function setCatalog(cat) {
    C = cat;
    blankPool = [];
    for (const q of cat.active) {
      if (q.type !== 'cloze') continue;
      for (const b of q.blanks) {
        blankPool.push({ answer: b.answer, kind: b.kind || '', unitId: q.unitId, groupId: groupOf(q.unitId) });
      }
    }
  }

  function groupOf(unitId) {
    const u = C.unitMap.get(unitId);
    return u ? u.groupId : '';
  }

  // 年号・数字の不正解を、正解の近くから作る
  function numericCands(kind, ans, want, cands) {
    const m = /\d+(\.\d+)?/.exec(ans);
    if (!m) return;
    const v = Number(m[0]);
    const dec = (m[0].split('.')[1] || '').length;
    for (let t = 0; t < 300 && cands.length < want; t++) {
      const nv = kind === '年号'
        ? v + (Math.floor(Math.random() * 10) + 1) * (Math.random() < 0.5 ? -1 : 1)
        : v * (0.5 + Math.random() * 1.5);
      const s = dec ? nv.toFixed(dec) : String(Math.round(nv));
      const cand = ans.replace(m[0], s);
      if (cand !== ans && !cands.includes(cand) && Number(s) >= 0) cands.push(cand);
    }
  }

  // 空欄の選択肢（正解を含む）。仕様 4-2 の順で不正解を集める
  function choicesFor(q, b) {
    if (Array.isArray(b.options) && b.options.length >= 2) return shuffle([...new Set(b.options)]);
    const ans = b.answer, want = 3, cands = [];
    const add = list => {
      for (const s of shuffle(list)) {
        if (cands.length >= want) return;
        if (s !== ans && !cands.includes(s)) cands.push(s);
      }
    };
    const kind = b.kind || '';
    const gid = groupOf(q.unitId);
    add(Array.isArray(b.distractors) ? b.distractors : []);
    if (kind) add(blankPool.filter(x => x.unitId === q.unitId && x.kind === kind).map(x => x.answer));
    if (kind) add(blankPool.filter(x => x.groupId === gid && x.kind === kind).map(x => x.answer));
    add(blankPool.filter(x => x.unitId === q.unitId).map(x => x.answer));
    if (cands.length < want && (kind === '年号' || kind === '数字')) numericCands(kind, ans, want, cands);
    return shuffle([ans, ...cands]);
  }

  // 空欄1つだけを「（　　）」にした文章
  function sentenceFor(q, target) {
    const ans = {};
    q.blanks.forEach(x => { ans[x.no] = x.answer; });
    return q.text.replace(/\{\{(\d+)\}\}/g, (_, n) => (Number(n) === target ? '（　　）' : (ans[n] ?? '')));
  }

  function clozeItem(q, method) {
    const flip = method === 'flip';
    return {
      kind: 'cloze', mode: flip ? 'flip' : 'choose', qid: q.id, key: null, q, text: q.text,
      blanks: q.blanks.slice().sort((a, b) => a.no - b.no).map(b => ({
        no: b.no, answer: b.answer, key: `${q.id}#${b.no}`, choices: flip ? null : choicesFor(q, b),
      })),
    };
  }

  function convItem(q, b) {
    return {
      kind: 'choice', multi: false, conv: true, qid: q.id, key: `${q.id}#${b.no}`, q,
      stem: sentenceFor(q, b.no),
      choices: choicesFor(q, b).map(t => ({ text: t, ok: t === b.answer })),
    };
  }

  function choiceItem(q) {
    const idx = q.choices.map((_, i) => i);
    const order = q.fixedOrder ? idx : shuffle(idx);
    return {
      kind: 'choice', multi: q.type === 'multi', conv: false, qid: q.id, key: q.id, q, stem: q.stem,
      choices: order.map(i => ({ text: q.choices[i], ok: q.answer.includes(i) })),
    };
  }

  function tfItem(q) {
    return { kind: 'tf', qid: q.id, key: q.id, q, stem: q.stem, answer: q.answer };
  }

  function orderItem(q) {
    let pool = shuffle(q.items);
    for (let t = 0; t < 20 && pool.join('\u0000') === q.items.join('\u0000'); t++) pool = shuffle(q.items);
    return { kind: 'order', qid: q.id, key: q.id, q, stem: q.stem, correct: q.items.slice(), pool };
  }

  function makeItem(q, method) {
    if (q.type === 'cloze') return clozeItem(q, method);
    if (q.type === 'mc' || q.type === 'multi') return choiceItem(q);
    if (q.type === 'tf') return tfItem(q);
    return orderItem(q);
  }

  // 単元で解く：選んだ単元の問題を、テキスト順かランダムで
  function unitItems(unitIds, opt) {
    let qs = C.active.filter(q => unitIds.has(q.unitId));
    if (opt.format === 'cloze') qs = qs.filter(q => q.type === 'cloze');
    qs = opt.order === 'random'
      ? shuffle(qs)
      : qs.slice().sort((a, b) => (C.unitIndex.get(a.unitId) - C.unitIndex.get(b.unitId)) || (a.order - b.order));
    return qs.map(q => makeItem(q, opt.method));
  }

  // 模試：形式ごとに抽選する。同じ問題（同じ cloze の別の空欄も含む）は1回の模試で2回出さない
  // cfg: { unitIds, cats: {single,multi,tf,order,conv}, weighted, fallback }
  function mockItems(cfg, progress) {
    const act = C.active.filter(q => cfg.unitIds.has(q.unitId));
    const P = { single: [], multi: [], tf: [], order: [], conv: [] };
    const entry = (q, key, mk) => ({ qid: q.id, key, imp: !!q.important, mk });
    for (const q of act) {
      if (q.type === 'mc') P.single.push(entry(q, q.id, () => choiceItem(q)));
      else if (q.type === 'multi') P.multi.push(entry(q, q.id, () => choiceItem(q)));
      else if (q.type === 'tf') P.tf.push(entry(q, q.id, () => tfItem(q)));
      else if (q.type === 'order') P.order.push(entry(q, q.id, () => orderItem(q)));
      else if (q.type === 'cloze') {
        for (const b of q.blanks) P.conv.push(entry(q, `${q.id}#${b.no}`, () => convItem(q, b)));
      }
    }
    const weight = e => {
      if (!cfg.weighted) return 1;
      const p = progress.get(e.key);
      let w = 1 + (p ? p.wrong * 2 : 0) + (p && p.weak ? 3 : 0);
      if (e.imp) w *= 2;
      return w;
    };
    const used = new Set();
    const take = (list, n) => {
      const got = [];
      while (got.length < n) {
        const pool = list.filter(e => !used.has(e.qid));
        if (!pool.length) break;
        const ws = pool.map(weight);
        const total = ws.reduce((a, b) => a + b, 0);
        let r = Math.random() * total, k = 0;
        for (; k < pool.length - 1; k++) {
          r -= ws[k];
          if (r < 0) break;
        }
        used.add(pool[k].qid);
        got.push(pool[k].mk());
      }
      return got;
    };
    const label = { multi: '複数選択', tf: '○×', order: '並べ替え', conv: '変換問題' };
    const want = cfg.cats;
    const items = [], notes = [];
    if (want.single > 0) {
      let got = take(P.single, want.single);
      // 本番のみ：択一が足りない分は「穴埋め→4択変換」で補う
      if (got.length < want.single && cfg.fallback) got = got.concat(take(P.conv, want.single - got.length));
      if (got.length < want.single) notes.push(`択一は${got.length}問（${want.single}問の予定）`);
      items.push(...got);
    }
    for (const k of ['multi', 'tf', 'order', 'conv']) {
      if (!(want[k] > 0)) continue;
      const got = take(P[k], want[k]);
      if (got.length < want[k]) notes.push(`${label[k]}は${got.length}問（${want[k]}問の予定）`);
      items.push(...got);
    }
    return { items: shuffle(items), notes };
  }

  // 苦手復習：苦手リストの問題を、元の形式で（穴埋めの空欄は変換問題で）
  function weakItems(progress) {
    const out = [];
    for (const p of progress.values()) {
      if (!p.weak) continue;
      const [qid, no] = p.key.split('#');
      const q = C.byId.get(qid);
      if (!q || q.retired || !C.unitMap.has(q.unitId)) continue;
      if (q.type === 'cloze') {
        const b = q.blanks.find(x => String(x.no) === no);
        if (b) out.push(convItem(q, b));
      } else {
        out.push(makeItem(q, 'choose'));
      }
    }
    return shuffle(out);
  }

  // 範囲内の出題候補の数
  function counts(unitIds) {
    const c = { single: 0, multi: 0, tf: 0, order: 0, conv: 0 };
    for (const q of C.active) {
      if (!unitIds.has(q.unitId)) continue;
      if (q.type === 'mc') c.single++;
      else if (q.type === 'multi') c.multi++;
      else if (q.type === 'tf') c.tf++;
      else if (q.type === 'order') c.order++;
      else if (q.type === 'cloze') c.conv += q.blanks.length;
    }
    return c;
  }

  // 採点。parts は進捗を記録する単位（空欄ごと、または問題ごと）
  function evaluate(item, ui) {
    if (item.kind === 'cloze') {
      const parts = item.blanks.map(b => {
        const v = ui.sel ? ui.sel[b.no] : undefined;
        const ok = item.mode === 'flip' ? v === 'ok' : v === b.answer;
        return { key: b.key, qid: item.qid, ok: !!ok };
      });
      return { ok: parts.every(p => p.ok), parts };
    }
    let ok = false;
    if (item.kind === 'choice') {
      const sel = (ui.sel || []).slice().sort((a, b) => a - b);
      const cor = item.choices.map((c, i) => (c.ok ? i : -1)).filter(i => i >= 0);
      ok = sel.length === cor.length && sel.every((v, i) => v === cor[i]);
    } else if (item.kind === 'tf') {
      ok = ui.sel === item.answer;
    } else if (item.kind === 'order') {
      const seq = (ui.seq || []).map(i => item.pool[i]);
      ok = seq.length === item.correct.length && seq.every((t, i) => t === item.correct[i]);
    }
    return { ok, parts: [{ key: item.key, qid: item.qid, ok }] };
  }

  // 回答の文字列（成績の記録用）
  function userText(item, ui) {
    if (item.kind === 'cloze') {
      return item.blanks.map(b => {
        const v = ui.sel ? ui.sel[b.no] : undefined;
        const t = item.mode === 'flip' ? (v === 'ok' ? '覚えてた' : '覚えてない') : (v ?? '未回答');
        return `${b.no}:${t}`;
      }).join(' / ');
    }
    if (item.kind === 'choice') return (ui.sel || []).map(i => item.choices[i].text).join(' / ') || '未回答';
    if (item.kind === 'tf') return ui.sel === undefined ? '未回答' : (ui.sel ? '○' : '×');
    return (ui.seq || []).map(i => item.pool[i]).join(' → ') || '未回答';
  }

  function itemTitle(item) {
    const raw = item.kind === 'cloze' ? item.q.text.replace(/\{\{\d+\}\}/g, '（　）') : item.stem;
    return raw.length > 36 ? `${raw.slice(0, 36)}…` : raw;
  }

  return {
    setCatalog, unitItems, mockItems, weakItems, counts, evaluate, userText, itemTitle, sentenceFor, circ,
  };
})();
