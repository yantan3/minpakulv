// ============================================================
// レ民泊レビュー自動生成 Worker
//   モード: guest = ゲスト宛てレビュー / reply = レビュー返信
//   エンドポイント:
//     GET  /            UI
//     GET  /ping        動作確認(デプロイ確認用)
//     GET  /init        D1テーブル作成(初回に一度だけ開く)
//     POST /gen         生成 {mode, name, memo, reviewText}
//     GET  /history?mode=guest|reply   直近10件
//   必要な設定:
//     D1バインディング: DB
//     シークレット: GEMINI_API_KEY
// ============================================================

const MODEL = 'gemini-2.5-flash-lite';
const SIM_TH = 0.38;           // 過去文との類似度がこれ以上なら書き直し (0-1)
const LEN_MIN = 220;           // 許容文字数の下限
const LEN_MAX = 380;           // 許容文字数の上限
const MAX_ATTEMPTS = 2;        // 生成の最大試行回数
const HISTORY_FOR_PROMPT = 10; // 「これらと似せるな」でプロンプトに渡す過去文の数
const HISTORY_FOR_CHECK = 50;  // 類似度チェックに使う過去文の数

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/') {
        return new Response(PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });
      }
      if (path === '/ping') {
        return json({ ok: true, model: MODEL });
      }
      if (path === '/init') {
        return await initDb(env);
      }
      if (path === '/gen' && request.method === 'POST') {
        return await handleGen(request, env);
      }
      if (path === '/history') {
        return await handleHistory(url, env);
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json;charset=utf-8' }
  });
}

// ---------------- D1 ----------------

async function initDb(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS reviews (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'mode TEXT NOT NULL,' +
    'name TEXT,' +
    'text TEXT NOT NULL,' +
    'sim REAL,' +
    'created_at TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_reviews_mode_id ON reviews(mode, id)'
  ).run();
  return json({ ok: true, message: 'table ready' });
}

async function handleHistory(url, env) {
  const mode = url.searchParams.get('mode') === 'reply' ? 'reply' : 'guest';
  const rows = await env.DB.prepare(
    'SELECT id, name, text, sim, created_at FROM reviews WHERE mode = ? ORDER BY id DESC LIMIT 10'
  ).bind(mode).all();
  return json({ items: rows.results || [] });
}

// ---------------- 生成 ----------------

async function handleGen(request, env) {
  const body = await request.json();
  const mode = body.mode === 'reply' ? 'reply' : 'guest';
  const name = String(body.name || '').trim().slice(0, 40);
  const memo = String(body.memo || '').trim().slice(0, 200);
  const reviewText = String(body.reviewText || '').trim().slice(0, 1000);

  if (mode === 'reply' && !reviewText) {
    return json({ error: 'ゲストのレビュー本文を入力してください' }, 400);
  }

  const rows = await env.DB.prepare(
    'SELECT text FROM reviews WHERE mode = ? ORDER BY id DESC LIMIT ?'
  ).bind(mode, HISTORY_FOR_CHECK).all();
  const pastTexts = (rows.results || []).map(function (r) { return r.text; });
  const pastGrams = pastTexts.map(bigrams);
  const recent = pastTexts.slice(0, HISTORY_FOR_PROMPT);

  let best = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = pickSeed();
    const prompt = buildPrompt(mode, name, memo, reviewText, recent, seed, attempt);
    const raw = await callGemini(env, prompt);
    const text = cleanup(raw);
    const sim = maxSim(bigrams(text), pastGrams);
    const cand = { text: text, sim: sim, len: text.length };
    if (!best || cand.sim < best.sim) best = cand;
    if (sim < SIM_TH && text.length >= LEN_MIN && text.length <= LEN_MAX) {
      best = cand;
      break;
    }
  }

  await env.DB.prepare(
    'INSERT INTO reviews (mode, name, text, sim, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(mode, name, best.text, best.sim, new Date().toISOString()).run();

  return json({ text: best.text, chars: best.len, sim: Math.round(best.sim * 100) });
}

// 文体・書き出し・締めをランダムに振って構造から変える
const STYLES = [
  'です・ます調で丁寧に',
  'です・ます調だが軽やかでフレンドリーに',
  '簡潔で率直に、短めの文を重ねて',
  '温かみを最優先に、柔らかい言葉選びで',
  'ややフォーマルに、落ち着いた語り口で'
];
const OPENINGS = [
  '感謝の言葉から書き出す',
  '滞在中の様子や印象から書き出す',
  'チェックインやチェックアウト時の場面から書き出す',
  'またお迎えしたいという気持ちから書き出す',
  '時候や季節感に軽く触れてから書き出す'
];
const CLOSINGS = [
  '再訪歓迎の言葉で締める',
  '他のホストへの推薦の言葉で締める',
  '旅の無事や今後の幸運を祈って締める',
  'シンプルな感謝で締める'
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function pickSeed() {
  return { style: pick(STYLES), opening: pick(OPENINGS), closing: pick(CLOSINGS) };
}

function buildPrompt(mode, name, memo, reviewText, recent, seed, attempt) {
  const lines = [];
  if (mode === 'guest') {
    lines.push('あなたは日本の民泊ホストです。宿泊を終えたゲストに向けたレビューを日本語で1件だけ書いてください。');
    lines.push('ゲスト名: ' + (name ? name + ' 様(本文に自然に一度だけ入れる)' : 'なし(名前は本文に出さない)'));
    lines.push('ゲストの特徴メモ: ' + (memo ? memo : '特になし(丁寧に利用してくれた良いゲストとして書く)'));
  } else {
    lines.push('あなたは日本の民泊ホストです。ゲストから届いた以下のレビューへの返信を日本語で1件だけ書いてください。');
    lines.push('--- ゲストのレビュー ---');
    lines.push(reviewText);
    lines.push('---');
    lines.push('返信相手の名前: ' + (name ? name + ' 様' : 'なし(名前は出さない)'));
    lines.push('レビュー内で触れられている具体的な点に必ず言及すること。指摘や低評価が含まれる場合は、言い訳をせず感謝と改善の姿勢を誠実に示すこと。');
  }
  lines.push('');
  lines.push('# 条件');
  lines.push('- 全体で280〜320文字。');
  lines.push('- 文体: ' + seed.style + '。');
  lines.push('- 書き出し: ' + seed.opening + '。');
  lines.push('- 締め: ' + seed.closing + '。');
  lines.push('- 絵文字・顔文字・記号装飾は使わない。');
  lines.push('- 渡された情報にない具体的な出来事を創作しない。大げさな誇張もしない。');
  lines.push('- 出力は本文のみ。前置き・タイトル・かぎ括弧・引用符は一切付けない。');
  if (recent.length > 0) {
    lines.push('');
    lines.push('# 過去に生成した文章(最重要: これらと書き出し・構成・語彙・言い回しを明確に変えること)');
    recent.forEach(function (t, i) { lines.push('[' + (i + 1) + '] ' + t); });
  }
  if (attempt > 0) {
    lines.push('');
    lines.push('# 追加指示: 直前の生成が過去文と似すぎていました。構成と言い回しを根本から変えて、大胆に書き直してください。');
  }
  return lines.join('\n');
}

function cleanup(s) {
  let t = String(s || '').trim();
  const FENCE = String.fromCharCode(96, 96, 96); // コードフェンス対策(バッククォート3つ)
  if (t.indexOf(FENCE) >= 0) {
    t = t.split('\n').filter(function (l) { return l.indexOf(FENCE) !== 0; }).join('\n').trim();
  }
  t = t.replace(/^[「『"]/, '').replace(/[」』"]$/, '').trim();
  return t;
}

async function callGemini(env, prompt) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL +
    ':generateContent?key=' + env.GEMINI_API_KEY;
  let lastStatus = 0;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(1500 * i); // 2回目=1.5秒待ち, 3回目=3秒待ち
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1.2, maxOutputTokens: 2048 }
      })
    });
    if (res.status === 503 || res.status === 429) {
      lastStatus = res.status;
      continue; // 混雑・レート制限は再試行
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error('Gemini API error ' + res.status + ': ' + t.slice(0, 200));
    }
    const data = await res.json();
    const parts = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts || []).map(function (p) { return p.text || ''; }).join('');
    if (!text) throw new Error('Geminiの応答が空でした');
    return text;
  }
  throw new Error('Gemini混雑中(' + lastStatus + ')。3回試しましたが通りませんでした。少し待ってから再度お試しください');
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---------------- 類似度 (文字bigramのJaccard) ----------------

function bigrams(s) {
  const t = String(s || '').replace(/[\s、。！？!?…・「」『』（）()～]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function maxSim(gram, pastGrams) {
  let m = 0;
  for (const g of pastGrams) {
    const s = jaccard(gram, g);
    if (s > m) m = s;
  }
  return m;
}

// テスト用に公開(Worker動作には影響なし)
export { bigrams, jaccard, maxSim, cleanup, pickSeed, buildPrompt };

// ---------------- UI ----------------
// 注意: PAGE内ではテンプレート補間(ドル+波括弧)とバッククォートを一切使わないこと(埋め込みJSは文字列連結のみ)

const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>レビュー番頭</title>
<style>
:root{
  --bg:#141416; --card:#1c1c20; --line:#2b2b31;
  --tx:#e8e5de; --sub:#8b887f; --acc:#c9a86a;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html{background:var(--bg);}
body{
  margin:0 auto; max-width:560px;
  background:var(--bg); color:var(--tx);
  font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
  font-size:15px; line-height:1.75;
  padding:24px 16px calc(32px + env(safe-area-inset-bottom));
}
h1{
  font-family:"Hiragino Mincho ProN","Yu Mincho",serif;
  font-size:22px; font-weight:600; letter-spacing:.18em; margin:0 0 2px;
}
.sub{color:var(--sub); font-size:10px; letter-spacing:.28em; margin:0 0 22px;}
.tabs{display:flex; gap:8px; margin:0 0 16px;}
.tab{
  flex:1; padding:12px 0; text-align:center;
  border:1px solid var(--line); border-radius:10px;
  background:var(--card); color:var(--sub); font-size:14px;
  cursor:pointer; user-select:none;
}
.tab.on{border-color:var(--acc); color:var(--acc);}
label{display:block; color:var(--sub); font-size:12px; margin:14px 0 6px; letter-spacing:.06em;}
input,textarea{
  width:100%; background:var(--card); border:1px solid var(--line); border-radius:10px;
  color:var(--tx); font-size:16px; padding:11px 12px; font-family:inherit;
}
input:focus,textarea:focus{outline:none; border-color:var(--acc);}
textarea{resize:vertical; min-height:110px;}
.btn{
  width:100%; margin-top:20px; padding:15px 0;
  border:none; border-radius:12px;
  background:var(--acc); color:#17150f;
  font-size:16px; font-weight:600; letter-spacing:.12em; cursor:pointer;
}
.btn:disabled{opacity:.55;}
.card{margin-top:18px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px;}
.meta{color:var(--sub); font-size:11px; margin-bottom:8px; letter-spacing:.05em;}
.bodytext{white-space:pre-wrap; font-size:15px;}
.mini{
  border:1px solid var(--acc); background:transparent; color:var(--acc);
  border-radius:8px; font-size:12px; padding:7px 14px; cursor:pointer;
}
.copyRow{margin-top:12px; text-align:right;}
h2{
  font-family:"Hiragino Mincho ProN","Yu Mincho",serif;
  font-size:15px; font-weight:600; letter-spacing:.14em;
  margin:30px 0 10px;
}
.hist{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:10px;}
.histHead{display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;}
.histMeta{color:var(--sub); font-size:11px;}
.histText{font-size:13.5px; white-space:pre-wrap;}
.clamp{display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;}
.empty{color:var(--sub); font-size:13px; padding:6px 2px;}
</style>
</head>
<body>
<h1>レビュー番頭</h1>
<p class="sub">MINPAKU REVIEW GENERATOR</p>

<div class="tabs">
  <div class="tab on" id="tabGuest">ゲスト宛て</div>
  <div class="tab" id="tabReply">レビュー返信</div>
</div>

<div id="guestFields">
  <label>ゲスト名（任意）</label>
  <input id="nameIn" placeholder="未入力なら名前なしで生成">
  <label>特徴メモ（任意）</label>
  <input id="memoIn" placeholder="例: 連絡が丁寧、退室がきれい">
</div>

<div id="replyFields" style="display:none">
  <label>ゲスト名（任意）</label>
  <input id="nameIn2" placeholder="未入力なら名前なしで生成">
  <label>ゲストのレビュー本文（貼り付け）</label>
  <textarea id="reviewIn" placeholder="届いたレビューをそのまま貼り付け"></textarea>
</div>

<button class="btn" id="genBtn">レビューを生成</button>

<div class="card" id="resultCard" style="display:none">
  <div class="meta" id="resultMeta"></div>
  <div class="bodytext" id="resultText"></div>
  <div class="copyRow"><button class="mini" id="resultCopy">コピー</button></div>
</div>

<h2>履歴（直近10件・タップで全文）</h2>
<div id="histList"></div>
<div class="empty" id="histEmpty" style="display:none">まだ履歴がありません</div>

<script>
var mode = 'guest';

function byId(id){ return document.getElementById(id); }

function genLabel(){ return mode === 'guest' ? 'レビューを生成' : '返信を生成'; }

function setMode(m){
  mode = m;
  byId('tabGuest').classList.toggle('on', m === 'guest');
  byId('tabReply').classList.toggle('on', m === 'reply');
  byId('guestFields').style.display = (m === 'guest') ? '' : 'none';
  byId('replyFields').style.display = (m === 'reply') ? '' : 'none';
  byId('genBtn').textContent = genLabel();
  byId('resultCard').style.display = 'none';
  loadHistory();
}

async function gen(){
  var btn = byId('genBtn');
  var payload = { mode: mode };
  if (mode === 'guest') {
    payload.name = byId('nameIn').value;
    payload.memo = byId('memoIn').value;
  } else {
    payload.name = byId('nameIn2').value;
    payload.reviewText = byId('reviewIn').value;
    if (!payload.reviewText.trim()) { alert('ゲストのレビュー本文を貼り付けてください'); return; }
  }
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    var res = await fetch('/gen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var data = await res.json();
    if (data.error) { throw new Error(data.error); }
    byId('resultText').textContent = data.text;
    byId('resultMeta').textContent = data.chars + '文字 ／ 過去との最大類似度 ' + data.sim + '%';
    byId('resultCard').style.display = '';
    loadHistory();
  } catch (e) {
    alert('エラー: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = genLabel();
  }
}

async function copyText(t, btn){
  var ok = false;
  try {
    await navigator.clipboard.writeText(t);
    ok = true;
  } catch (e) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  if (btn) {
    var old = btn.textContent;
    btn.textContent = ok ? 'コピー済み' : '失敗';
    setTimeout(function(){ btn.textContent = old; }, 1200);
  }
}

function fmtDate(iso){
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var hh = ('0' + d.getHours()).slice(-2);
  var mm = ('0' + d.getMinutes()).slice(-2);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm;
}

async function loadHistory(){
  try {
    var res = await fetch('/history?mode=' + mode);
    var data = await res.json();
    var list = byId('histList');
    list.innerHTML = '';
    var items = data.items || [];
    byId('histEmpty').style.display = items.length === 0 ? '' : 'none';
    items.forEach(function(it){
      var li = document.createElement('div');
      li.className = 'hist';
      var head = document.createElement('div');
      head.className = 'histHead';
      var meta = document.createElement('span');
      meta.className = 'histMeta';
      meta.textContent = fmtDate(it.created_at) + (it.name ? ' ・ ' + it.name : '');
      var cbtn = document.createElement('button');
      cbtn.className = 'mini';
      cbtn.textContent = 'コピー';
      cbtn.onclick = function(ev){ ev.stopPropagation(); copyText(it.text, cbtn); };
      head.appendChild(meta);
      head.appendChild(cbtn);
      var bodyDiv = document.createElement('div');
      bodyDiv.className = 'histText clamp';
      bodyDiv.textContent = it.text;
      li.onclick = function(){ bodyDiv.classList.toggle('clamp'); };
      li.appendChild(head);
      li.appendChild(bodyDiv);
      list.appendChild(li);
    });
  } catch (e) {}
}

byId('tabGuest').onclick = function(){ setMode('guest'); };
byId('tabReply').onclick = function(){ setMode('reply'); };
byId('genBtn').onclick = gen;
byId('resultCopy').onclick = function(){ copyText(byId('resultText').textContent, byId('resultCopy')); };

setMode('guest');
</script>
</body>
</html>`;
