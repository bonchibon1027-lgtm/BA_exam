// BAドリル：画面の切り替え、イベント、出題セッションの進行
const APP_VERSION = '1.0.0';
const CAT_KEYS = ['single', 'multi', 'tf', 'order', 'conv'];
const CAT_LABEL = { single: '択一（4択）', multi: '複数選択', tf: '○×', order: '並べ替え', conv: '穴埋め→4択変換' };

const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const circ = n => Quiz.circ(n);
const accText = s => (s.accuracy == null ? '未学習' : `${Math.round(s.accuracy * 100)}%`);
const fmtMS = ms => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const fmtHM = ms => `${Math.floor(ms / 3600000)}時間${Math.floor((ms % 3600000) / 60000)}分`;
const clampN = (v, min = 0, max = 200) => {
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : min;
};
const linkHtml = u => (/^https?:\/\//.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : esc(u));
const compactDay = () => Stats.dayKey().replace(/-/g, '');

const S = {
  packs: [], catalog: null, progress: new Map(), settings: {},
  stack: [], session: null, lastResult: null, draft: null,
  selUnits: new Set(), mock: null,
  lastAct: Date.now(), studyPending: 0, waitingSW: null, hadController: false,
};

// ---------- 設定・データ ----------
const getSet = (k, d) => (k in S.settings ? S.settings[k] : d);
const setSet = (k, v) => {
  S.settings[k] = v;
  return DB.putMany('settings', [{ key: k, value: v }]);
};

async function loadAll() {
  const [packs, progress, settings] = await Promise.all([
    DB.getAll('packs'), DB.getAll('progress'), DB.getAll('settings'),
  ]);
  S.packs = packs;
  S.progress = new Map(progress.map(p => [p.key, p]));
  S.settings = Object.fromEntries(settings.map(r => [r.key, r.value]));
  S.catalog = Pack.buildCatalog(S.packs);
  Quiz.setCatalog(S.catalog);
  S.mock = null;
}

async function reloadPacks() {
  S.packs = await DB.getAll('packs');
  S.catalog = Pack.buildCatalog(S.packs);
  Quiz.setCatalog(S.catalog);
}

function applyTheme() {
  const root = document.documentElement;
  const t = getSet('theme', 'auto');
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = t;
  root.className = `fs-${getSet('fontSize', 'm')}`;
}

function totalStudyMs() {
  return Object.values(getSet('studyDaily', {})).reduce((a, b) => a + b, 0) + S.studyPending;
}

// 学習時間は、問題画面で60秒以内に操作があった時だけ数える
async function flushStudy() {
  if (!S.studyPending) return;
  const daily = getSet('studyDaily', {});
  const key = Stats.dayKey();
  daily[key] = (daily[key] || 0) + S.studyPending;
  S.studyPending = 0;
  await setSet('studyDaily', daily);
}

// ---------- 画面の切り替え ----------
function render(html, title) {
  $('#app').innerHTML = html;
  $('#screenTitle').textContent = title;
}

function topName() {
  const t = S.stack[S.stack.length - 1];
  return t ? t.name : '';
}

function paint() {
  const top = S.stack[S.stack.length - 1];
  if (!top) return;
  VIEWS[top.name](top.params || {});
  $('#btnBack').hidden = S.stack.length <= 1;
}

function show(name, params = {}, reset = false) {
  if (reset) S.stack = [];
  S.stack.push({ name, params });
  paint();
  window.scrollTo(0, 0);
}

function back() {
  if (topName() === 'question') { quitSession(); return; }
  if (S.stack.length > 1) S.stack.pop();
  paint();
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function confirmBox(message, okText = 'OK', danger = false) {
  return new Promise(resolve => {
    const root = $('#dialogRoot');
    root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">
      <p>${esc(message)}</p>
      <div class="modal-actions"><button type="button" data-m="0">キャンセル</button>
      <button type="button" data-m="1" class="${danger ? 'danger' : 'accent'}">${esc(okText)}</button></div>
    </div></div>`;
    root.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
      root.innerHTML = '';
      resolve(b.dataset.m === '1');
    }));
  });
}

function saveFile(name, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// 単元を大単元ごとに折りたたんで並べる
function groupBlocks(filterFn, rowFn, openFn) {
  const C = S.catalog;
  const gids = [...new Set(C.units.map(u => u.groupId))];
  return gids.map(gid => {
    const us = C.units.filter(u => u.groupId === gid && filterFn(u));
    if (!us.length) return '';
    return `<details class="grp"${openFn(us) ? ' open' : ''}>
      <summary>${esc(C.groupOf(gid).title)}<small class="sumnum">${us.length}単元</small></summary>
      ${us.map(rowFn).join('')}</details>`;
  }).join('');
}

// ---------- 画面 ----------
const VIEWS = {
  home: vHome,
  units: vUnits,
  unitSetup: vUnitSetup,
  mock: vMock,
  question: vQuestion,
  result: vResult,
  review: vReview,
  stats: vStats,
  weakList: vWeakList,
  settings: vSettings,
};

function vHome() {
  const exam = getSet('examDate', '');
  const days = exam ? Stats.daysUntil(exam) : null;
  const ms = totalStudyMs();
  const target = getSet('targetHours', 20);
  const pct = Math.min(100, Math.round((ms / (target * 3600000)) * 100));
  const weak = Stats.weakCount(S.progress);
  render(`
    <section class="card">
      ${exam
        ? (days >= 0
          ? `<div class="days"><span class="muted">試験まで</span> <strong>${days}</strong> <span>日</span></div>`
          : '<p class="muted">試験日を過ぎています</p>')
        : '<p class="muted">設定で試験日を入れると、ここに残り日数が出ます</p>'}
      <div class="row-sb"><span>累計 ${fmtHM(ms)}</span><small>目標 ${target}時間</small></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </section>
    <div class="menu">
      <button class="big" data-act="goUnits">単元で解く</button>
      <button class="big" data-act="goMock">ランダム・模試</button>
      <button class="big accent" data-act="honban">本番モード</button>
      <button class="big" data-act="weak" ${weak ? '' : 'disabled'}>苦手復習（${weak}問）</button>
      <button class="big" data-act="goStats">成績</button>
      <button class="big" data-act="goSettings">設定</button>
    </div>`, 'BAドリル');
}

function vUnits() {
  const C = S.catalog, sel = S.selUnits;
  const st = Stats.unitStats(C, S.progress);
  const row = u => {
    const s = st.get(u.id);
    const last = s.lastAt ? ` ・最終 ${Stats.dayKey(new Date(s.lastAt))}` : '';
    return `<label class="urow">
      <input type="checkbox" data-change="unit" data-id="${esc(u.id)}" ${sel.has(u.id) ? 'checked' : ''}>
      <span class="ut"><b>${esc(u.title)}${C.isExtra(u) ? ' <em class="badge ext">番外編</em>' : ''}</b>
      <small>${esc(u.pages)} ・ ${s.qcount}問 ・ 正答率 ${accText(s)}${last}</small></span></label>`;
  };
  const open = us => us.some(u => sel.has(u.id));
  const text = groupBlocks(u => !C.isExtra(u), row, open);
  const extra = groupBlocks(u => C.isExtra(u), row, open);
  render(`
    ${text || '<p class="muted">単元がありません。設定から問題パックを取り込んでください</p>'}
    ${extra ? `<h2 class="sec">番外編</h2>${extra}` : ''}
    <div class="sticky">
      <span id="selInfo">${sel.size}単元 選択中</span>
      <button class="accent" id="btnSetup" data-act="unitSetup" ${sel.size ? '' : 'disabled'}>この単元で解く</button>
    </div>`, '単元で解く');
}

function countSel(unitIds) {
  return S.catalog.active.filter(q => unitIds.has(q.unitId)).length;
}

function vUnitSetup() {
  const n = S.selUnits.size;
  const titles = [...S.selUnits].map(id => S.catalog.unitMap.get(id)).filter(Boolean);
  render(`
    <p class="muted">選んだ単元：${n}単元（${titles.slice(0, 3).map(u => esc(u.title)).join('、')}${n > 3 ? ' ほか' : ''}）<br>候補の問題数：${countSel(S.selUnits)}問</p>
    <h3>形式</h3>
    <label class="radio"><input type="radio" name="fmt" value="cloze" checked> テキストそのまま（穴埋め）</label>
    <label class="radio"><input type="radio" name="fmt" value="all"> 単元の全問題</label>
    <h3>順番</h3>
    <label class="radio"><input type="radio" name="ord" value="text" checked> テキスト順</label>
    <label class="radio"><input type="radio" name="ord" value="random"> ランダム</label>
    <h3>答え方（穴埋めのみ）</h3>
    <label class="radio"><input type="radio" name="met" value="choose" checked> 4択で選ぶ</label>
    <label class="radio"><input type="radio" name="met" value="flip"> めくって自己採点</label>
    <button class="big accent" data-act="startUnit">はじめる</button>`, '出題設定');
}

function getMock() {
  if (S.mock) return S.mock;
  const all = S.catalog.units.map(u => u.id);
  const saved = getSet('mockPrefs', null) || {};
  const cats = {};
  CAT_KEYS.forEach(k => { cats[k] = { on: k === 'single' || k === 'multi', n: k === 'single' ? 30 : 10 }; });
  if (saved.cats) {
    for (const k of CAT_KEYS) if (saved.cats[k]) cats[k] = { on: !!saved.cats[k].on, n: clampN(saved.cats[k].n) };
  }
  S.mock = {
    units: new Set(Array.isArray(saved.units) ? saved.units.filter(id => all.includes(id)) : all),
    cats,
    weighted: !!saved.weighted,
    timer: !!saved.timer,
    minutes: clampN(saved.minutes || 20, 1, 180),
  };
  return S.mock;
}

function updateMockSum() {
  const el = $('#mockSum');
  if (!el) return;
  const m = getMock(), c = Quiz.counts(m.units);
  const total = CAT_KEYS.reduce((a, k) => a + (m.cats[k].on ? m.cats[k].n : 0), 0);
  el.textContent = `予定 ${total}問（候補：択一${c.single}・複数${c.multi}・○×${c.tf}・並べ替え${c.order}・変換${c.conv}）`;
}

function vMock() {
  const m = getMock(), C = S.catalog;
  const row = u => `<label class="urow">
    <input type="checkbox" data-change="mockUnit" data-id="${esc(u.id)}" ${m.units.has(u.id) ? 'checked' : ''}>
    <span class="ut"><b>${esc(u.title)}${C.isExtra(u) ? ' <em class="badge ext">番外編</em>' : ''}</b></span></label>`;
  const open = us => us.some(u => m.units.has(u.id));
  const text = groupBlocks(u => !C.isExtra(u), row, open);
  const extra = groupBlocks(u => C.isExtra(u), row, open);
  render(`
    <h3>範囲</h3>
    <div class="chips">
      <button type="button" data-act="mockShort" data-s="all">全範囲</button>
      <button type="button" data-act="mockShort" data-s="text">テキストだけ</button>
      <button type="button" data-act="mockShort" data-s="extra">番外編だけ</button>
      <button type="button" data-act="mockShort" data-s="none">クリア</button>
    </div>
    ${text || '<p class="muted">単元がありません</p>'}
    ${extra ? `<h2 class="sec">番外編</h2>${extra}` : ''}
    <h3>問題数と形式</h3>
    <div class="chips">${[10, 20, 30, 50].map(n => `<button type="button" data-act="mockPreset" data-n="${n}">${n}問</button>`).join('')}</div>
    ${CAT_KEYS.map(k => `<div class="catrow">
      <label class="check"><input type="checkbox" data-change="mockCat" data-k="${k}" ${m.cats[k].on ? 'checked' : ''}> ${CAT_LABEL[k]}</label>
      <span><input class="num" type="number" min="0" max="200" value="${m.cats[k].n}" data-change="mockN" data-k="${k}"> 問</span></div>`).join('')}
    <label class="check"><input type="checkbox" data-change="mockFlag" data-k="weighted" ${m.weighted ? 'checked' : ''}> 苦手優先（間違えた問題が出やすくなる）</label>
    <label class="check"><input type="checkbox" data-change="mockFlag" data-k="timer" ${m.timer ? 'checked' : ''}> タイマーを使う</label>
    <label class="check">制限時間 <input class="num" type="number" min="1" max="180" value="${m.minutes}" data-change="mockN" data-k="minutes"> 分</label>
    <p id="mockSum" class="hint"></p>
    <button class="big accent" data-act="mockStart">模試を始める</button>`, 'ランダム・模試');
  updateMockSum();
}

function vWeakList(p) {
  const C = S.catalog;
  const unit = C.unitMap.get(p.id);
  const rows = [];
  for (const pr of S.progress.values()) {
    if (!pr.weak) continue;
    const d = Stats.describeKey(C, pr.key);
    if (!d || d.unitId !== p.id) continue;
    rows.push(`<li><div>${esc(d.question)}</div><div class="ans">正解：<b>${esc(d.answer)}</b> <small>不正解 ${pr.wrong}回</small></div></li>`);
  }
  render(`<h2 class="sec">${esc(unit ? unit.title : '')}</h2>
    ${rows.length ? `<ul class="wlist">${rows.join('')}</ul>` : '<p class="muted">苦手な問題はありません</p>'}`, '苦手一覧');
}

// 問題画面：空欄の表示
function clozeBody(item, ui, checked) {
  const sel = ui.sel, rev = ui.rev || {};
  const flip = item.mode === 'flip';
  const text = item.text.split(/(\{\{\d+\}\})/).map(seg => {
    const m = /^\{\{(\d+)\}\}$/.exec(seg);
    if (!m) return esc(seg).replace(/\n/g, '<br>');
    const no = Number(m[1]);
    const b = item.blanks.find(x => x.no === no);
    let cls = 'blank', label, tag = 'button', attrs = `data-act="blank" data-no="${no}"`;
    if (checked) {
      const ok = flip ? sel[no] === 'ok' : sel[no] === b.answer;
      cls += ok ? ' ok' : ' ng';
      label = esc(b.answer);
      tag = 'span';
      attrs = '';
    } else if (flip) {
      label = rev[no] ? esc(b.answer) : circ(no);
      if (rev[no]) cls += ' rev';
      if (sel[no]) cls += sel[no] === 'ok' ? ' ok' : ' ng';
    } else {
      label = sel[no] ? esc(sel[no]) : circ(no);
      if (sel[no]) cls += ' filled';
    }
    if (!checked && ui.open === no) cls += ' open';
    return `<${tag} class="${cls}" ${attrs}>${label}</${tag}>`;
  }).join('');
  let panel = '';
  if (flip && !checked) {
    const marks = item.blanks.filter(b => rev[b.no] && !sel[b.no]).map(b => `<div class="markrow">
      <span>${circ(b.no)}</span>
      <button type="button" class="good" data-act="mark" data-no="${b.no}" data-ok="1">覚えてた</button>
      <button type="button" class="bad" data-act="mark" data-no="${b.no}" data-ok="0">覚えてなかった</button></div>`).join('');
    panel = marks || (Object.keys(rev).length === 0 ? '<p class="hint">空欄をタップすると答えが出ます</p>' : '');
  } else if (!checked) {
    panel = '<p class="hint">空欄（①②…）をタップして答えを選びます</p>';
  }
  return `<div class="cloze">${text}</div>${panel}`;
}

// 4択の選択肢を下から出す
function sheetHtml(item, ui) {
  if (item.kind !== 'cloze' || item.mode !== 'choose' || ui.open == null) return '';
  const b = item.blanks.find(x => x.no === ui.open);
  if (!b) return '';
  return `<div class="pickpanel">
    <div class="pickpanel-head"><b>空欄${circ(b.no)}の答え</b><button type="button" data-act="closeSheet" class="sm">閉じる</button></div>
    ${b.choices.map((t, i) => `<button type="button" class="opt" data-act="pick" data-no="${b.no}" data-i="${i}">${esc(t)}</button>`).join('')}
  </div>`;
}

function choiceOpts(item, ui, checked) {
  const sel = ui.sel || [];
  return item.choices.map((c, i) => {
    const on = sel.includes(i);
    let cls = 'opt' + (on ? ' on' : '');
    if (checked) {
      if (c.ok) cls += ' ok';
      if (on && !c.ok) cls += ' ng';
    }
    const mark = item.multi ? (on ? '☑' : '☐') : (on ? '●' : '○');
    return `<button type="button" class="${cls}" data-act="opt" data-i="${i}" ${checked ? 'disabled' : ''}><span class="mark">${mark}</span><span>${esc(c.text)}</span></button>`;
  }).join('');
}

function tfOpts(item, ui, checked) {
  const cur = ui.sel;
  const btn = (v, label) => {
    let cls = cur === v ? 'on' : '';
    if (checked && item.answer === v) cls += ' ok';
    if (checked && cur === v && item.answer !== v) cls += ' ng';
    return `<button type="button" class="${cls}" data-act="tf" data-v="${v ? 1 : 0}" ${checked ? 'disabled' : ''}>${label}</button>`;
  };
  return `<div class="tf">${btn(true, '○')}${btn(false, '×')}</div>`;
}

function orderBody(item, ui, checked) {
  const seq = ui.seq || [];
  const placed = seq.map((pi, p) => {
    let cls = 'opt placed';
    if (checked) cls += item.pool[pi] === item.correct[p] ? ' ok' : ' ng';
    return `<button type="button" class="${cls}" data-act="unplace" data-p="${p}" ${checked ? 'disabled' : ''}><span class="mark">${p + 1}</span><span>${esc(item.pool[pi])}</span></button>`;
  }).join('');
  const rest = checked ? '' : `<div class="pool">${item.pool.map((t, i) => (seq.includes(i) ? '' :
    `<button type="button" class="chip" data-act="pool" data-i="${i}">${esc(t)}</button>`)).join('')}</div>`;
  return `<div class="seq">${placed || '<p class="hint">下の項目を上から順にタップします</p>'}</div>${rest}`;
}

function itemBody(item, ui, checked) {
  if (item.kind === 'cloze') return clozeBody(item, ui, checked);
  if (item.kind === 'choice') return `<p class="stem">${item.multi ? '【複数選択】' : ''}${esc(item.stem)}</p>${choiceOpts(item, ui, checked)}`;
  if (item.kind === 'tf') return `<p class="stem">${esc(item.stem)}</p>${tfOpts(item, ui, checked)}`;
  return `<p class="stem">${esc(item.stem)}</p>${orderBody(item, ui, checked)}`;
}

function canSubmit(item, ui) {
  if (item.kind === 'cloze') return item.blanks.every(b => ui.sel[b.no] !== undefined);
  if (item.kind === 'choice') return item.multi ? ui.sel.length > 0 : ui.sel.length === 1;
  if (item.kind === 'tf') return ui.sel !== undefined;
  return ui.seq.length === item.pool.length;
}

function freshUI(item) {
  if (!item) return {};
  if (item.kind === 'cloze') return { sel: {}, rev: {}, open: null };
  if (item.kind === 'choice') return { sel: [] };
  if (item.kind === 'tf') return { sel: undefined };
  return { seq: [] };
}

// 答え合わせの表示（正誤・正解・解説・覚え方・出典）
function feedbackHtml(item, res) {
  const q = item.q, ui = res.ui;
  let detail = '';
  if (item.kind === 'cloze') {
    detail = `<ul class="fb-list">${item.blanks.map(b => {
      const ok = res.parts.some(p => p.key === b.key && p.ok);
      const mine = item.mode === 'flip' ? (ui.sel[b.no] === 'ok' ? '覚えてた' : '覚えてなかった') : (ui.sel[b.no] || '未回答');
      return `<li class="${ok ? 'ok' : 'ng'}">${circ(b.no)} 正解：<b>${esc(b.answer)}</b>${ok ? ' ○' : ` ×（あなた：${esc(mine)}）`}</li>`;
    }).join('')}</ul>`;
  } else if (item.kind === 'choice') {
    const correct = item.choices.filter(c => c.ok).map(c => c.text);
    const mine = (ui.sel || []).map(i => item.choices[i].text);
    detail = `<p>正解：<b>${correct.map(esc).join('、')}</b></p>${res.ok ? '' : `<p class="muted">あなたの答え：${mine.length ? mine.map(esc).join('、') : '未回答'}</p>`}`;
  } else if (item.kind === 'tf') {
    detail = `<p>正解：<b>${item.answer ? '○' : '×'}</b></p>`;
  } else {
    detail = `<p>正しい順番</p><ol class="fb-order">${item.correct.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`;
  }
  const expl = q.explanation ? `<div class="block"><h4>解説</h4><p>${esc(q.explanation)}</p></div>` : '';
  const memo = q.memo ? `<div class="block memo"><h4>覚え方</h4><p>${esc(q.memo)}</p></div>` : '';
  const tags = (q.tags || []).map(t => `<span class="chip sm">${esc(t)}</span>`).join('');
  const meta = (q.page || tags) ? `<div class="meta">${q.page ? `${esc(q.page)} ` : ''}${tags}</div>` : '';
  const refs = (q.refs || []).length ? `<div class="meta">出典：${q.refs.map(linkHtml).join('<br>')}</div>` : '';
  return `<section class="card fb">
    <div class="verdict ${res.ok ? 'ok' : 'ng'}">${res.ok ? '正解' : '不正解'}</div>
    ${detail}${expl}${memo}${meta}${refs}</section>`;
}

// ---------- セッション ----------
function startSession({ mode, title, items, notes = [], timerMin = 0 }) {
  const now = Date.now();
  S.session = {
    mode, title, items, notes, idx: 0, answers: [], checked: false,
    ui: freshUI(items[0]), startedAt: now,
    endAt: timerMin ? now + timerMin * 60000 : 0,
  };
  S.stack = [{ name: 'home', params: {} }];
  show('question');
  if (notes.length) toast(notes.join('／'));
}

function curItem() {
  return S.session.items[S.session.idx];
}

function vQuestion() {
  const s = S.session;
  if (!s) { show('home', {}, true); return; }
  const item = curItem(), n = s.items.length, q = item.q;
  const unit = S.catalog.unitMap.get(q.unitId);
  const badges = (q.important ? '<em class="badge imp">頻出</em>' : '')
    + (unit && S.catalog.isExtra(unit) ? '<em class="badge ext">番外編</em>' : '');
  let action;
  if (s.checked) {
    action = `<button class="big accent" data-act="next">${s.idx + 1 >= n ? '結果を見る' : '次へ'}</button>`;
  } else {
    const label = s.mode === 'honban' ? (s.idx + 1 >= n ? '回答して採点へ' : '回答して次へ') : '回答する';
    action = `<button class="big accent" data-act="submit" ${canSubmit(item, s.ui) ? '' : 'disabled'}>${label}</button>`;
  }
  render(`
    <div class="qbar">
      <span class="count">${s.idx + 1} ／ ${n}</span>
      <span class="timer" data-timer>${s.endAt ? fmtMS(s.endAt - Date.now()) : ''}</span>
      <button type="button" class="sm" data-act="quit">やめる</button>
    </div>
    <div class="bar thin"><i style="width:${(s.idx / n) * 100}%"></i></div>
    <article class="card">
      <div class="qhead">${badges}<span class="muted">${esc(unit ? unit.title : '')}${q.page ? ' ・ ' + esc(q.page) : ''}</span></div>
      ${itemBody(item, s.ui, s.checked)}
      ${s.checked ? '' : sheetHtml(item, s.ui)}
    </article>
    ${s.checked ? feedbackHtml(item, s.answers[s.idx]) : ''}
    <div class="actions">${action}</div>`, s.title);
}

function clickBlank(no) {
  const s = S.session;
  if (!s || s.checked) return;
  if (curItem().mode === 'flip') s.ui.rev[no] = true;
  else s.ui.open = s.ui.open === no ? null : no;
  paint();
}

function advance() {
  const s = S.session;
  s.idx++;
  s.checked = false;
  s.ui = freshUI(s.items[s.idx]);
  if (s.idx >= s.items.length) finish('完了');
  else paint();
}

async function submit() {
  const s = S.session;
  if (!s || s.checked) return;
  const item = curItem();
  if (!canSubmit(item, s.ui)) return;
  const res = Quiz.evaluate(item, s.ui);
  const snap = JSON.parse(JSON.stringify(s.ui));
  s.answers[s.idx] = { ok: res.ok, parts: res.parts, ui: snap };
  if (s.mode === 'honban') {
    advance();   // 本番は解説を出さず、最後にまとめて採点する
    return;
  }
  DB.putMany('progress', Stats.record(S.progress, res.parts));
  s.checked = true;
  paint();
}

function quitSession() {
  if (!S.session) return;
  confirmBox('ここまでの回答で終了しますか？', '終了する').then(ok => { if (ok) finish('中断'); });
}

// 採点・記録・結果画面へ
async function finish(reason) {
  const s = S.session;
  if (!s) return;
  S.session = null;
  await flushStudy();
  const rows = s.items.map((item, i) => {
    const a = s.answers[i];
    return { i, item, answered: !!a, ok: !!(a && a.ok), ui: a ? a.ui : null, parts: a ? a.parts : [] };
  });
  const honban = s.mode === 'honban';
  const scored = honban ? rows : rows.filter(r => r.answered);
  const correct = scored.filter(r => r.ok).length;
  const points = honban ? correct * 2 : null;
  if (honban) {
    const changed = [];
    rows.forEach(r => { if (r.answered) changed.push(...Stats.record(S.progress, r.parts)); });
    if (changed.length) await DB.putMany('progress', changed);
  }
  const rec = {
    startedAt: s.startedAt, endedAt: Date.now(), mode: s.mode, title: s.title, reason,
    total: scored.length, correct, points,
    items: rows.filter(r => r.answered || honban).map(r => ({
      qid: r.item.qid, ok: r.ok, answered: r.answered, user: r.answered ? Quiz.userText(r.item, r.ui) : '',
    })),
  };
  try {
    await DB.add('sessions', rec);
  } catch (e) {
    toast('成績の保存に失敗しました');
  }
  S.lastResult = { rec, rows, reason };
  if (topName() === 'question') S.stack.pop();
  show('result');
}

function tick() {
  const s = S.session;
  if (s && s.endAt && Date.now() >= s.endAt) { finish('時間切れ'); return; }
  if (s && topName() === 'question' && document.visibilityState === 'visible' && Date.now() - S.lastAct < 60000) {
    S.studyPending += 1000;
  }
  if (s && s.endAt) {
    const el = document.querySelector('[data-timer]');
    if (el) el.textContent = fmtMS(s.endAt - Date.now());
  }
  if (S.studyPending >= 15000) flushStudy();
}

function vResult() {
  const { rec, rows, reason } = S.lastResult;
  const honban = rec.mode === 'honban';
  const acc = rec.total ? Math.round((rec.correct / rec.total) * 100) : 0;
  const head = honban
    ? `<div class="score"><strong>${rec.points}</strong><span>／ 100点</span></div>
       <div class="scale"><i style="width:${rec.points}%"></i><b style="left:76%">76</b><b class="goal" style="left:80%">80</b></div>
       <p class="muted">正解 ${rec.correct}／${rec.total}　（ボーダー76点・目標80点）</p>
       <p>${rec.points >= 80 ? '目標の80点に届きました' : rec.points >= 76 ? 'ボーダーを超えました' : 'ボーダーの76点には届きませんでした'}</p>`
    : `<div class="score"><strong>${acc}</strong><span>％</span></div><p class="muted">正解 ${rec.correct}／${rec.total}</p>`;
  const note = reason && reason !== '完了' ? `<p class="hint">（${esc(reason)}）</p>` : '';
  const list = rows.filter(r => r.answered || honban).map(r => {
    const cls = !r.answered ? 'none' : r.ok ? 'ok' : 'ng';
    const mark = !r.answered ? '－' : r.ok ? '○' : '×';
    return `<li><button type="button" class="rowbtn ${cls}" data-act="review" data-i="${r.i}">${mark} ${esc(Quiz.itemTitle(r.item))}</button></li>`;
  }).join('');
  const wrongCount = rows.filter(r => (r.answered ? !r.ok : honban)).length;
  render(`
    <section class="card center">${head}${note}</section>
    <h3>問題ごとの結果（タップで答え合わせ）</h3>
    <ol class="reslist">${list}</ol>
    <button class="big" data-act="retryWrong" ${wrongCount ? '' : 'disabled'}>間違えた問題だけもう一度</button>
    <button class="big accent" data-act="home">ホームへ</button>`, '結果');
}

function vReview(p) {
  const r = S.lastResult.rows[p.i];
  if (!r) { show('home', {}, true); return; }
  const res = r.answered
    ? { ok: r.ok, parts: r.parts, ui: r.ui }
    : { ok: false, parts: [], ui: freshUI(r.item) };
  const item = r.item, q = item.q;
  const unit = S.catalog.unitMap.get(q.unitId);
  render(`
    <article class="card">
      <div class="qhead"><span class="muted">${esc(unit ? unit.title : '')}${q.page ? ' ・ ' + esc(q.page) : ''}</span></div>
      ${itemBody(item, res.ui, true)}
    </article>
    ${feedbackHtml(item, res)}`, '答え合わせ');
}

// ---------- 単元・模試の開始 ----------
function startUnit() {
  const pick = n => (document.querySelector(`input[name=${n}]:checked`) || {}).value;
  const items = Quiz.unitItems(S.selUnits, { format: pick('fmt'), order: pick('ord'), method: pick('met') });
  if (!items.length) { toast('出題できる問題がありません'); return; }
  startSession({ mode: 'unit', title: '単元で解く', items });
}

function mockPreset(n) {
  const m = getMock();
  const on = CAT_KEYS.filter(k => m.cats[k].on);
  if (!on.length) { toast('形式を1つ以上選んでください'); return; }
  const per = Math.floor(n / on.length), rem = n - per * on.length;
  on.forEach((k, i) => { m.cats[k].n = per + (i < rem ? 1 : 0); });
  paint();
}

function mockShort(kind) {
  const m = getMock(), C = S.catalog;
  m.units = new Set(C.units.filter(u =>
    kind === 'all' || (kind === 'text' && !C.isExtra(u)) || (kind === 'extra' && C.isExtra(u))).map(u => u.id));
  paint();
}

function mockStart() {
  const m = getMock();
  if (!m.units.size) { toast('範囲を選んでください'); return; }
  const cats = {};
  CAT_KEYS.forEach(k => { cats[k] = m.cats[k].on ? m.cats[k].n : 0; });
  if (!Object.values(cats).some(n => n > 0)) { toast('形式を1つ以上選んでください'); return; }
  const res = Quiz.mockItems({ unitIds: m.units, cats, weighted: m.weighted, fallback: false }, S.progress);
  if (!res.items.length) { toast('出題できる問題がありません'); return; }
  setSet('mockPrefs', {
    units: [...m.units], weighted: m.weighted, timer: m.timer, minutes: m.minutes,
    cats: Object.fromEntries(CAT_KEYS.map(k => [k, m.cats[k]])),
  });
  startSession({ mode: 'mock', title: 'ランダム・模試', items: res.items, notes: res.notes, timerMin: m.timer ? m.minutes : 0 });
}

function honban() {
  confirmBox('本番モード：4択40問＋複数選択10問（計50問）、制限30分です。解説は最後にまとめて表示されます。始めますか？', '始める')
    .then(ok => {
      if (!ok) return;
      const res = Quiz.mockItems({
        unitIds: new Set(S.catalog.units.map(u => u.id)),
        cats: { single: 40, multi: 10, tf: 0, order: 0, conv: 0 },
        weighted: false, fallback: true,
      }, S.progress);
      if (!res.items.length) { toast('出題できる問題がありません'); return; }
      startSession({ mode: 'honban', title: '本番モード', items: res.items, notes: res.notes, timerMin: 30 });
    });
}

function startWeak() {
  const items = Quiz.weakItems(S.progress);
  if (!items.length) { toast('苦手な問題はありません'); return; }
  startSession({ mode: 'weak', title: '苦手復習', items });
}

// ---------- 成績 ----------
function vStats() {
  render('<p class="muted">読み込み中…</p>', '成績');
  DB.getAll('sessions').then(sessions => {
    if (topName() !== 'stats') return;
    const C = S.catalog, st = Stats.unitStats(C, S.progress);
    const rows = C.units.map(u => {
      const s = st.get(u.id);
      return `<div class="srow">
        <div><b>${esc(u.title)}</b>${C.isExtra(u) ? ' <em class="badge ext">番外編</em>' : ''}</div>
        <div class="bar thin"><i style="width:${s.accuracy == null ? 0 : Math.round(s.accuracy * 100)}%"></i></div>
        <div class="smeta"><small>正答率 ${accText(s)} ・ 解いた ${s.attempted}／${s.qcount}問 ・ 苦手 ${s.weak}件</small>
        <button type="button" class="sm" data-act="unitWeak" data-id="${esc(u.id)}" ${s.weak ? '' : 'disabled'}>苦手一覧</button></div>
      </div>`;
    }).join('');
    const hb = sessions.filter(x => x.mode === 'honban').sort((a, b) => a.endedAt - b.endedAt);
    const n = hb.length;
    const pts = hb.map((x, i) => `${(n > 1 ? 10 + i * (280 / (n - 1)) : 150).toFixed(1)},${(110 - x.points).toFixed(1)}`);
    const chart = n
      ? `<svg class="chart" viewBox="0 0 300 120" role="img" aria-label="本番モードの点数の推移">
          <line x1="0" x2="300" y1="34" y2="34" class="line-b"/><line x1="0" x2="300" y1="30" y2="30" class="line-g"/>
          ${n > 1 ? `<polyline class="pl" points="${pts.join(' ')}"/>` : ''}
          ${pts.map(p => { const [x, y] = p.split(','); return `<circle cx="${x}" cy="${y}" r="4"/>`; }).join('')}
        </svg><p class="hint">横線：ボーダー76点（上）・目標80点（下）</p>`
      : '<p class="muted">本番モードの記録はまだありません</p>';
    const hist = hb.slice().reverse().slice(0, 10).map(x =>
      `<li>${Stats.dayKey(new Date(x.endedAt))} ・ <b>${x.points}点</b> ・ 正解 ${x.correct}／${x.total}</li>`).join('');
    const daily = getSet('studyDaily', {});
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = Stats.dayKey(d);
      days.push({ k, ms: (daily[k] || 0) + (i === 0 ? S.studyPending : 0) });
    }
    const max = Math.max(1, ...days.map(d => d.ms));
    const bars = days.map(d => `<div class="dbar"><i style="height:${Math.round((d.ms / max) * 100)}%"></i><span>${Number(d.k.slice(8))}</span></div>`).join('');
    render(`
      <h3>本番モードの点数</h3>
      <div class="card">${chart}${hist ? `<ul class="plain">${hist}</ul>` : ''}</div>
      <h3>学習時間（直近14日）</h3>
      <div class="card"><div class="dbars">${bars}</div><p class="hint">累計 ${fmtHM(totalStudyMs())}</p></div>
      <h3>単元別</h3>
      <div class="card">${rows || '<p class="muted">単元がありません</p>'}</div>`, '成績');
  });
}

// ---------- 設定 ----------
function packRow(p) {
  return `<div class="prow">
    <div><b>${esc(p.title)}</b><small><br>${esc(p.packId)} ・ v${p.packVersion} ・ 更新 ${esc(p.updatedAt)} ・ ${p.questions.length}問</small></div>
    <button type="button" class="danger sm" data-act="packDelete" data-id="${esc(p.packId)}">削除</button></div>`;
}

function vSettings() {
  const exam = getSet('examDate', ''), target = getSet('targetHours', 20);
  const fs = getSet('fontSize', 'm'), th = getSet('theme', 'auto');
  const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  render(`
    <h2 class="sec">問題パック</h2>
    <div class="card">${S.packs.length ? S.packs.map(packRow).join('') : '<p class="muted">まだパックがありません</p>'}</div>
    <h2 class="sec">パックを取り込む</h2>
    <p class="hint">Claudeが出力したJSONをコピーして下の欄に貼り付け、「検証して取り込む」を押してください。</p>
    <textarea id="packText" rows="6" spellcheck="false" placeholder="{ &quot;schema&quot;: 1, ... }"></textarea>
    <div class="row2">
      <button type="button" data-act="pasteText">貼り付け</button>
      <label class="filebtn">ファイルを選ぶ<input type="file" accept=".json,application/json" multiple hidden data-change="packFiles"></label>
      <button type="button" class="accent" data-act="importValidate">検証して取り込む</button>
    </div>
    <div id="importResult"></div>
    <h2 class="sec">学習の設定</h2>
    <div class="card">
      <label class="field">試験日 <input type="date" value="${esc(exam)}" data-change="examDate"></label>
      <label class="field">目標時間（時間） <input class="num" type="number" min="1" max="500" value="${target}" data-change="targetHours"></label>
      <label class="field">文字サイズ <select data-change="fontSize">${opts([['s', '小'], ['m', '中'], ['l', '大']], fs)}</select></label>
      <label class="field">テーマ <select data-change="theme">${opts([['auto', '自動（端末に合わせる）'], ['light', 'ライト'], ['dark', 'ダーク']], th)}</select></label>
    </div>
    <h2 class="sec">バックアップ・書き出し</h2>
    <div class="card stack">
      <button type="button" data-act="backupExport">バックアップを書き出す</button>
      <label class="filebtn">バックアップを読み込む<input type="file" accept=".json,application/json" hidden data-change="restore"></label>
      <button type="button" data-act="claudeExport">成績を書き出す（Claudeに渡す用）</button>
    </div>
    <h2 class="sec">危険な操作</h2>
    <div class="card"><button type="button" class="danger" data-act="deleteAll">全データを削除</button></div>
    <p class="muted center">BAドリル v${APP_VERSION}</p>`, '設定');
  renderDraft();
}

// 取り込みの検証結果を表示する
function renderDraft() {
  const box = $('#importResult');
  if (!box) return;
  const d = S.draft;
  if (!d) { box.innerHTML = ''; return; }
  const parseErr = d.parseErrors.map(e => `<div class="card err">${esc(e.name)}：${esc(e.error)}</div>`).join('');
  const cards = d.results.map(r => {
    const status = r.status === 'error' ? 'エラー（取り込めません）'
      : r.status === 'new' ? '新規'
        : r.status === 'upgrade' ? `更新（v${r.existing} → v${r.packVersion}）`
          : `同じか古い版（v${r.packVersion}）：取り込むと置き換えます`;
    const fatal = r.fatal.map(f => `<li class="err">${esc(f)}</li>`).join('');
    const errs = r.errors.slice(0, 50).map(e => `<li>${esc(e.label)} <code>${esc(e.field)}</code>：${esc(e.message)}</li>`).join('');
    const more = r.errors.length > 50 ? `<li>ほか ${r.errors.length - 50} 件</li>` : '';
    return `<div class="card">
      <b>${esc(r.title || '（名前なし）')}</b> <small>${esc(r.packId)} ・ v${esc(r.packVersion)}</small>
      <p class="hint">${esc(status)}</p>
      <p>単元 ${r.units.length} ／ 取り込める問題 ${r.questions.length} ／ エラー ${r.errors.length + r.fatal.length}</p>
      ${fatal ? `<ul class="errs">${fatal}</ul>` : ''}
      ${errs || more ? `<ul class="errs">${errs}${more}</ul>` : ''}
    </div>`;
  }).join('');
  const blocked = d.parseErrors.length > 0 || d.results.some(r => r.fatal.length);
  const hasQErr = d.results.some(r => r.errors.length > 0);
  let actions = '';
  if (!blocked && d.results.length) {
    actions = `<div class="row2">
      ${hasQErr
        ? '<button type="button" class="accent" data-act="importCommit">エラーの問題を飛ばして取り込む</button>'
        : '<button type="button" class="accent" data-act="importCommit">取り込む</button>'}
      <button type="button" data-act="importClear">中止</button></div>`;
  } else {
    actions = '<div class="row2"><button type="button" data-act="importClear">閉じる</button></div>';
  }
  box.innerHTML = parseErr + cards + actions;
}

async function importCommit() {
  const d = S.draft;
  if (!d || d.parseErrors.length || d.results.some(r => r.fatal.length)) return;
  if (d.results.some(r => r.status === 'same')
    && !(await confirmBox('同じか古いバージョンのパックがあります。置き換えますか？（成績は消えません）', '置き換える'))) return;
  const saved = await Pack.save(d.results);
  await reloadPacks();
  const total = saved.reduce((a, r) => a + r.questions.length, 0);
  S.draft = null;
  toast(`取り込みました（${saved.length}パック・${total}問）`);
  paint();
}

async function readPackFiles(el) {
  const list = [], parseErrors = [];
  for (const f of [...el.files]) {
    const parsed = Pack.parseText(await f.text());
    if (parsed.error) parseErrors.push({ name: f.name, error: parsed.error });
    else list.push(...parsed.packs);
  }
  el.value = '';
  S.draft = { results: Pack.validateBatch(list, S.packs), parseErrors };
  renderDraft();
}

async function restoreBackup(el) {
  const f = el.files[0];
  el.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (e) { toast('バックアップを読めませんでした'); return; }
  if (!data || data.app !== 'ba-drill' || !data.backupVersion) { toast('BAドリルのバックアップではありません'); return; }
  if (!(await confirmBox('今のデータはすべて置き換わります。読み込みますか？', '読み込む', true))) return;
  await DB.replaceAll(data);
  await loadAll();
  applyTheme();
  toast('復元しました');
  show('home', {}, true);
}

// ---------- 操作（クリック・変更） ----------
const ACT = {
  home: () => show('home', {}, true),
  back,
  goUnits: () => show('units'),
  unitSetup: () => show('unitSetup'),
  startUnit,
  goMock: () => show('mock'),
  mockStart,
  mockPreset: el => mockPreset(Number(el.dataset.n)),
  mockShort: el => mockShort(el.dataset.s),
  honban,
  weak: startWeak,
  goStats: () => show('stats'),
  unitWeak: el => show('weakList', { id: el.dataset.id }),
  goSettings: () => show('settings'),
  blank: el => clickBlank(Number(el.dataset.no)),
  pick: el => {
    const s = S.session, b = curItem().blanks.find(x => x.no === Number(el.dataset.no));
    s.ui.sel[b.no] = b.choices[Number(el.dataset.i)];
    s.ui.open = null;
    paint();
  },
  closeSheet: () => { S.session.ui.open = null; paint(); },
  mark: el => {
    S.session.ui.sel[Number(el.dataset.no)] = el.dataset.ok === '1' ? 'ok' : 'ng';
    paint();
  },
  opt: el => {
    const s = S.session, i = Number(el.dataset.i), sel = s.ui.sel;
    if (curItem().multi) {
      const at = sel.indexOf(i);
      if (at >= 0) sel.splice(at, 1); else sel.push(i);
    } else {
      s.ui.sel = [i];
    }
    paint();
  },
  tf: el => { S.session.ui.sel = el.dataset.v === '1'; paint(); },
  pool: el => { S.session.ui.seq.push(Number(el.dataset.i)); paint(); },
  unplace: el => { S.session.ui.seq.splice(Number(el.dataset.p), 1); paint(); },
  submit,
  next: () => advance(),
  quit: quitSession,
  review: el => show('review', { i: Number(el.dataset.i) }),
  retryWrong: () => {
    const items = S.lastResult.rows.filter(r => (r.answered ? !r.ok : S.lastResult.rec.mode === 'honban')).map(r => r.item);
    if (!items.length) return;
    startSession({ mode: 'retry', title: '間違えた問題', items });
  },
  importValidate: () => {
    const parsed = Pack.parseText($('#packText').value);
    S.draft = parsed.error
      ? { results: [], parseErrors: [{ name: '貼り付けた内容', error: parsed.error }] }
      : { results: Pack.validateBatch(parsed.packs, S.packs), parseErrors: [] };
    renderDraft();
  },
  importCommit,
  importClear: () => { S.draft = null; renderDraft(); },
  pasteText: () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      toast('入力欄を長押しして貼り付けてください');
      return;
    }
    navigator.clipboard.readText()
      .then(t => { $('#packText').value = t; })
      .catch(() => toast('貼り付けできませんでした。入力欄を長押しして貼り付けてください'));
  },
  packDelete: async el => {
    const id = el.dataset.id;
    if (!(await confirmBox(`「${id}」を削除します。成績は消えません。`, '削除する', true))) return;
    await DB.del('packs', id);
    await reloadPacks();
    toast('削除しました');
    paint();
  },
  backupExport: async () => {
    const [packs, progress, sessions, settings] = await Promise.all(
      ['packs', 'progress', 'sessions', 'settings'].map(n => DB.getAll(n)));
    saveFile(`ba-drill-backup-${compactDay()}.json`, {
      app: 'ba-drill', backupVersion: 1, exportedAt: new Date().toISOString(),
      packs, progress, sessions, settings,
    });
  },
  claudeExport: async () => {
    const sessions = await DB.getAll('sessions');
    saveFile(`ba-drill-report-${compactDay()}.json`,
      Stats.report(S.catalog, S.progress, sessions, getSet('studyDaily', {})));
  },
  deleteAll: async () => {
    if (!(await confirmBox('すべてのデータ（パック・成績・設定）を削除します。元に戻せません。', '次へ', true))) return;
    if (!(await confirmBox('本当に削除しますか？', '削除する', true))) return;
    await DB.replaceAll({ packs: [], progress: [], sessions: [], settings: [] });
    await loadAll();
    applyTheme();
    toast('削除しました');
    show('home', {}, true);
  },
  update: () => { if (S.waitingSW) S.waitingSW.postMessage('SKIP_WAITING'); },
};

const CHG = {
  unit(el) {
    const id = el.dataset.id;
    if (el.checked) S.selUnits.add(id); else S.selUnits.delete(id);
    $('#selInfo').textContent = `${S.selUnits.size}単元 選択中`;
    $('#btnSetup').disabled = S.selUnits.size === 0;
  },
  mockUnit(el) {
    const m = getMock();
    if (el.checked) m.units.add(el.dataset.id); else m.units.delete(el.dataset.id);
    updateMockSum();
  },
  mockCat(el) { getMock().cats[el.dataset.k].on = el.checked; updateMockSum(); },
  mockN(el) {
    const m = getMock(), k = el.dataset.k;
    if (k === 'minutes') m.minutes = clampN(el.value, 1, 180);
    else m.cats[k].n = clampN(el.value, 0, 200);
    el.value = k === 'minutes' ? m.minutes : m.cats[k].n;
    updateMockSum();
  },
  mockFlag(el) { getMock()[el.dataset.k] = el.checked; },
  examDate(el) { setSet('examDate', el.value); },
  targetHours(el) { setSet('targetHours', clampN(el.value, 1, 500) || 20); },
  fontSize(el) { setSet('fontSize', el.value); applyTheme(); },
  theme(el) { setSet('theme', el.value); applyTheme(); },
  packFiles(el) { readPackFiles(el); },
  restore(el) { restoreBackup(el); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el, e);
});

document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const fn = CHG[el.dataset.change];
  if (fn) fn(el);
});

// ---------- 更新の検知（Service Worker） ----------
function showUpdate(worker) {
  S.waitingSW = worker;
  $('#updateBar').hidden = false;
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  S.hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting && S.hadController) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && S.hadController) showUpdate(w);
      });
    });
  }).catch(() => { /* オフライン非対応の端末では何もしない */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (S.hadController && !reloaded) { reloaded = true; location.reload(); }
  });
}

// ---------- 起動 ----------
async function boot() {
  try {
    await DB.open();
    await loadAll();
  } catch (e) {
    $('#app').innerHTML = `<div class="card err">データを開けませんでした：${esc(e.message)}</div>`;
    return;
  }
  applyTheme();
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, () => { S.lastAct = Date.now(); }, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStudy();
  });
  window.addEventListener('unhandledrejection', e => {
    toast(`エラー：${e.reason && e.reason.message ? e.reason.message : '保存できませんでした'}`);
  });
  setInterval(tick, 1000);
  registerSW();
  show('home', {}, true);
}

boot();
