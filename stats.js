// 成績・苦手・学習時間の集計（仕様 5章）
const Stats = (() => {
  const dayKey = (d = new Date()) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };

  // 進捗の記録：不正解で苦手に入り、苦手の問題を2回連続で正解すると克服
  function record(map, parts) {
    const now = Date.now();
    const changed = [];
    for (const { key, qid, ok } of parts) {
      let p = map.get(key);
      if (!p) {
        p = { key, qid, correct: 0, wrong: 0, streak: 0, weak: false, mastered: false, lastAt: 0 };
        map.set(key, p);
      }
      if (ok) {
        p.correct++;
        p.streak++;
        if (p.weak && p.streak >= 2) { p.weak = false; p.mastered = true; }
      } else {
        p.wrong++;
        p.streak = 0;
        p.weak = true;
        p.mastered = false;
      }
      p.lastAt = now;
      changed.push(p);
    }
    return changed;
  }

  // 単元ごとの集計。正答率は 正解 ÷（正解＋不正解）
  function unitStats(C, map) {
    const res = new Map();
    for (const u of C.units) {
      res.set(u.id, { unit: u, qcount: 0, total: 0, attempted: 0, correct: 0, wrong: 0, weak: 0, lastAt: 0, accuracy: null });
    }
    for (const q of C.active) {
      const s = res.get(q.unitId);
      if (!s) continue;
      s.qcount++;
      let touched = false;
      for (const key of Pack.keysOf(q)) {
        s.total++;
        const p = map.get(key);
        if (!p) continue;
        if (p.correct + p.wrong > 0) touched = true;
        s.correct += p.correct;
        s.wrong += p.wrong;
        if (p.weak) s.weak++;
        s.lastAt = Math.max(s.lastAt, p.lastAt || 0);
      }
      if (touched) s.attempted++;
    }
    for (const s of res.values()) {
      const d = s.correct + s.wrong;
      s.accuracy = d ? s.correct / d : null;
    }
    return res;
  }

  // 進捗のキーから、問題文・正解・単元を取り出す（苦手一覧・書き出し用）
  function describeKey(C, key) {
    const [qid, no] = key.split('#');
    const q = C.byId.get(qid);
    if (!q) return null;
    const unit = C.unitMap.get(q.unitId);
    const base = { unitId: q.unitId, unitTitle: unit ? unit.title : '', page: q.page || '' };
    if (q.type === 'cloze') {
      const b = q.blanks.find(x => String(x.no) === no);
      if (!b) return null;
      return { ...base, question: Quiz.sentenceFor(q, b.no), answer: b.answer };
    }
    if (q.type === 'mc' || q.type === 'multi') {
      return { ...base, question: q.stem, answer: q.answer.map(i => q.choices[i]).join(' / ') };
    }
    if (q.type === 'tf') return { ...base, question: q.stem, answer: q.answer ? '○' : '×' };
    return { ...base, question: q.stem, answer: q.items.join(' → ') };
  }

  function weakCount(map) {
    let n = 0;
    for (const p of map.values()) if (p.weak) n++;
    return n;
  }

  // 試験日までの日数（今日が0、過ぎていれば負）
  function daysUntil(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((target - now) / 86400000);
  }

  // 「成績の書き出し（Claude用）」：パックの中身は含めず、弱点の分析に必要なものだけ
  function report(C, map, sessions, daily) {
    const us = unitStats(C, map);
    const units = [...us.values()].map(s => ({
      group: C.groupOf(s.unit.groupId).title,
      unit: s.unit.title,
      questions: s.qcount,
      attempted: s.attempted,
      accuracyPct: s.accuracy == null ? null : Math.round(s.accuracy * 100),
      wrongCount: s.wrong,
      weakCount: s.weak,
    }));
    const weakItems = [];
    for (const p of map.values()) {
      if (!p.weak) continue;
      const d = describeKey(C, p.key);
      if (!d) continue;
      weakItems.push({ id: p.key, unit: d.unitTitle, question: d.question, answer: d.answer, wrong: p.wrong, correct: p.correct });
    }
    const honbanScores = sessions.filter(s => s.mode === 'honban')
      .sort((a, b) => a.endedAt - b.endedAt)
      .map(s => ({ date: dayKey(new Date(s.endedAt)), points: s.points, correct: s.correct, total: s.total }));
    const days = Object.entries(daily || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14);
    const totalMs = Object.values(daily || {}).reduce((a, b) => a + b, 0);
    return {
      app: 'BAドリル',
      exportedAt: new Date().toISOString(),
      note: '問題文は問題パックからの抜粋（空欄は（　　）で表示）。この内容を分析用に使ってください。',
      studyMinutesTotal: Math.round(totalMs / 60000),
      studyMinutesLast14Days: days.map(([date, ms]) => ({ date, minutes: Math.round(ms / 60000) })),
      units,
      weakItems,
      honbanScores,
    };
  }

  return { dayKey, record, unitStats, describeKey, weakCount, daysUntil, report };
})();
