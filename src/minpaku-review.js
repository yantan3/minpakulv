// ============================================================
// レビュー番頭 - 民泊レビュー自動生成 Worker (5言語対応版)
//   モード: guest = ゲスト宛てレビュー / reply = レビュー返信
//   出力: 日本語で生成 → 必要な言語だけ翻訳
//   エンドポイント:
//     GET  /            UI
//     GET  /ping        動作確認(デプロイ確認用)
//     GET  /init        D1テーブル作成(初回に一度だけ開く)
//     POST /gen         生成 {mode, name, memo, reviewText}
//     POST /translate   翻訳 {text, sourceLang, targetLang}
//     GET  /history?mode=guest|reply   直近10件(日本語)
//   必要な設定:
//     D1バインディング: DB
//     シークレット: GEMINI_API_KEY
// ============================================================

const MODEL = 'gemini-2.5-flash-lite';

// 503/429/404時はこの順に自動フォールバック
const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];

const SIM_TH = 0.38;
const LEN_MIN = 220;
const LEN_MAX = 380;
const MAX_ATTEMPTS = 1;
const HISTORY_FOR_PROMPT = 10;
const HISTORY_FOR_CHECK = 50;

const LANGS = [
  { key: 'ja', label: '日本語' },
  { key: 'en', label: 'English' },
  { key: 'zh-CN', label: '简体中文' },
  { key: 'zh-TW', label: '繁體中文' },
  { key: 'ko', label: '한국어' }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const uid = getOrMakeUid(request);

      if (path === '/') {
        const headers = new Headers({ 'content-type': 'text/html;charset=utf-8' });
        headers.append('set-cookie', uidCookie(uid));
        return new Response(PAGE, { headers: headers });
      }

      if (path === '/ping') {
        return json({ ok: true, model: MODEL });
      }

      if (path === '/init') {
        return await initDb(env);
      }

      if (path === '/gen' && request.method === 'POST') {
        return await handleGen(request, env, uid);
      }

      if (path === '/translate' && request.method === 'POST') {
        return await handleTranslate(request, env);
      }

      if (path === '/history') {
        return await handleHistory(url, env, uid);
      }

      return new Response('not found', { status: 404 });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};

// ---------------- ユーザー識別 ----------------

function getOrMakeUid(request) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)uid=([A-Za-z0-9_-]{8,64})/);
  if (m) return m[1];

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(36);
  }

  return ('u' + s).slice(0, 40);
}

function uidCookie(uid) {
  return 'uid=' + uid + '; Max-Age=34560000; Path=/; SameSite=Lax; Secure';
}

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
      'uid TEXT,' +
      'created_at TEXT)'
  ).run();

  try {
    await env.DB.prepare('ALTER TABLE reviews ADD COLUMN uid TEXT').run();
  } catch (e) {}

  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_reviews_uid_mode_id ON reviews(uid, mode, id)'
  ).run();

  await env.DB.prepare('DELETE FROM reviews WHERE text LIKE ?').bind('{"ja"%').run();

  return json({ ok: true, message: 'table ready & cleaned' });
}

async function handleHistory(url, env, uid) {
  const mode = url.searchParams.get('mode') === 'reply' ? 'reply' : 'guest';

  const rows = await env.DB.prepare(
    'SELECT id, name, text, sim, created_at FROM reviews WHERE uid = ? AND mode = ? ORDER BY id DESC LIMIT 10'
  ).bind(uid, mode).all();

  return json({ items: rows.results || [] });
}

// ---------------- 生成 ----------------

async function handleGen(request, env, uid) {
  const body = await request.json();

  const mode = body.mode === 'reply' ? 'reply' : 'guest';
  const name = String(body.name || '').trim().slice(0, 40);
  const memo = String(body.memo || '').trim().slice(0, 200);
  const reviewText = String(body.reviewText || '').trim().slice(0, 1000);

  if (mode === 'reply' && !reviewText) {
    return json({ error: 'ゲストのレビュー本文を入力してください' }, 400);
  }

  const rows = await env.DB.prepare(
    'SELECT text FROM reviews WHERE uid = ? AND mode = ? ORDER BY id DESC LIMIT ?'
  ).bind(uid, mode, HISTORY_FOR_CHECK).all();

  const pastTexts = (rows.results || []).map(function (r) {
    return r.text;
  });

  const pastGrams = pastTexts.map(bigrams);
  const recent = pastTexts.slice(0, HISTORY_FOR_PROMPT);

  let best = null;

  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const seed = pickSeed();
    const prompt = buildPrompt(mode, name, memo, reviewText, recent, seed, attempt);
    const raw = await callGemini(env, prompt, 1.2, false);
    const ja = cleanup(raw).replace(/^[「『"]/, '').replace(/[」』"]$/, '').trim();

    const sim = maxSim(bigrams(ja), pastGrams);
    const cand = { ja: ja, sim: sim, len: ja.length };

    if (!best || cand.sim < best.sim) best = cand;

    if (sim < SIM_TH && ja.length >= LEN_MIN && ja.length <= LEN_MAX) {
      best = cand;
      break;
    }
  }

  if (!best || !best.ja) {
    return json({ error: '生成に失敗しました。もう一度お試しください' }, 502);
  }

  await env.DB.prepare(
    'INSERT INTO reviews (mode, name, text, sim, uid, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(mode, name, best.ja, best.sim, uid, new Date().toISOString()).run();

  return json({
    ja: best.ja,
    chars: best.len,
    sim: Math.round(best.sim * 100)
  });
}

// ---------------- 翻訳 ----------------

async function handleTranslate(request, env) {
  const body = await request.json();

  const text = String(body.text || '').trim().slice(0, 2000);
  const src = LANGS.some(function (l) { return l.key === body.sourceLang; }) ? body.sourceLang : 'ja';
  const tgt = LANGS.some(function (l) { return l.key === body.targetLang; }) ? body.targetLang : 'en';

  if (!text) return json({ error: '翻訳するテキストが空です' }, 400);
  if (src === tgt) return json({ text: text });

  const raw = await callGemini(env, buildTranslatePrompt(text, src, tgt), 0.3, false);
  const out = cleanup(raw).replace(/^[「『"]/, '').replace(/[」』"]$/, '').trim();

  if (!out) {
    return json({ error: '翻訳に失敗しました。もう一度お試しください' }, 502);
  }

  return json({ text: out });
}

function langLabel(key) {
  for (const l of LANGS) {
    if (l.key === key) return l.label;
  }
  return key;
}

function buildTranslatePrompt(text, src, tgt) {
  const lines = [];

  lines.push('あなたはプロの翻訳者です。宿泊施設のホストがゲストに送る文章を翻訳します。');
  lines.push('以下の' + langLabel(src) + 'の原文を、' + langLabel(tgt) + 'に翻訳してください。');
  lines.push('その言語のネイティブが書いたような自然な文章にし、直訳調にしないこと。丁寧で温かいトーンを保つこと。');
  lines.push('');
  lines.push('--- 原文(' + langLabel(src) + ') ---');
  lines.push(text);
  lines.push('---');
  lines.push('');
  lines.push('# 出力形式');
  lines.push(langLabel(tgt) + 'の訳文だけを出力。前置き・説明・かぎ括弧・引用符は一切付けない。');

  return lines.join('\n');
}

// ---------------- プロンプト ----------------

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

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickSeed() {
  return {
    style: pick(STYLES),
    opening: pick(OPENINGS),
    closing: pick(CLOSINGS)
  };
}

function buildPrompt(mode, name, memo, reviewText, recent, seed, attempt) {
  const lines = [];

  if (mode === 'guest') {
    lines.push('あなたは日本の民泊ホストです。宿泊を終えたゲストに向けたレビューを、まず日本語で1件だけ考えてください。');
    lines.push('ゲスト名: ' + (name ? name + ' 様(本文に自然に一度だけ入れる)' : 'なし(名前は本文に出さない)'));
    lines.push('ゲストの特徴メモ: ' + (memo ? memo : '特になし(丁寧に利用してくれた良いゲストとして書く)'));
  } else {
    lines.push('あなたは日本の民泊ホストです。ゲストから届いた以下のレビューへの返信を、まず日本語で1件だけ考えてください。');
    lines.push('--- ゲストのレビュー ---');
    lines.push(reviewText);
    lines.push('---');
    lines.push('返信相手の名前: ' + (name ? name + ' 様' : 'なし(名前は出さない)'));
    lines.push('レビュー内で触れられている具体的な点に必ず言及すること。指摘や低評価が含まれる場合は、言い訳をせず感謝と改善の姿勢を誠実に示すこと。');
  }

  lines.push('');
  lines.push('# 日本語本文の条件');
  lines.push('- 全体で280〜320文字。');
  lines.push('- 文体: ' + seed.style + '。');
  lines.push('- 書き出し: ' + seed.opening + '。');
  lines.push('- 締め: ' + seed.closing + '。');
  lines.push('- 絵文字・顔文字・記号装飾は使わない。');
  lines.push('- 渡された情報にない具体的な出来事を創作しない。大げさな誇張もしない。');

  if (recent.length > 0) {
    lines.push('');
    lines.push('# 過去に生成した文章(最重要: これらと書き出し・構成・語彙・言い回しを明確に変えること)');
    recent.forEach(function (t, i) {
      lines.push('[' + (i + 1) + '] ' + t);
    });
  }

  if (attempt > 0) {
    lines.push('');
    lines.push('# 追加指示: 直前の生成が過去文と似すぎていました。構成と言い回しを根本から変えて、大胆に書き直してください。');
  }

  lines.push('');
  lines.push('# 出力形式(最重要)');
  lines.push('日本語の本文だけを出力してください。翻訳や他言語は不要です。');
  lines.push('前置き・説明・タイトル・かぎ括弧・引用符・コードフェンスは一切付けず、本文そのものだけを返すこと。');

  return lines.join('\n');
}

// ---------------- Gemini ----------------

async function callGemini(env, prompt, temperature, jsonMode) {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY が未設定です');
  }

  const temp = typeof temperature === 'number' ? temperature : 1.2;
  const useJson = jsonMode !== false;

  let lastStatus = 0;
  let lastBody = '';

  for (let mi = 0; mi < MODELS.length; mi++) {
    const modelName = MODELS[mi];

    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      modelName +
      ':generateContent?key=' +
      env.GEMINI_API_KEY;

    const cfg = {
      temperature: temp,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 }
    };

    if (useJson) {
      cfg.responseMimeType = 'application/json';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: cfg
      })
    });

    if (res.status === 503 || res.status === 429 || res.status === 404) {
      lastStatus = res.status;
      lastBody = await res.text();
      continue;
    }

    if (!res.ok) {
      const t = await res.text();
      throw new Error('Gemini API error ' + res.status + ': ' + t.slice(0, 200));
    }

    const data = await res.json();

    const parts =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts;

    const text = (parts || []).map(function (p) {
      return p.text || '';
    }).join('');

    if (!text) {
      throw new Error('Geminiの応答が空でした');
    }

    return text;
  }

  const label = lastStatus === 429 ? 'レート上限' : '混雑';

  throw new Error(
    'Gemini ' +
      label +
      '(' +
      lastStatus +
      ')。' +
      MODELS.length +
      'モデル試しましたが全て混雑中でした。少し待ってから再度お試しください。詳細: ' +
      lastBody.slice(0, 300)
  );
}

// ---------------- JSON補助 ----------------

function parseLangs(raw) {
  let t = cleanup(raw);

  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');

  if (s >= 0 && e > s) {
    t = t.slice(s, e + 1);
  }

  let obj = null;

  try {
    obj = JSON.parse(t);
  } catch (err) {
    obj = null;
  }

  if (!obj || typeof obj !== 'object') {
    obj = {};
    LANGS.forEach(function (l) {
      obj[l.key] = extractField(t, l.key);
    });
  }

  const out = {};

  LANGS.forEach(function (l) {
    out[l.key] = String(obj[l.key] || '').trim();
  });

  return out;
}

function extractField(t, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
  const m = t.match(re);

  if (!m) return '';

  try {
    return JSON.parse('"' + m[1] + '"');
  } catch (e2) {
    return m[1];
  }
}

function cleanup(s) {
  let t = String(s || '').trim();

  const FENCE = String.fromCharCode(96, 96, 96);

  if (t.indexOf(FENCE) >= 0) {
    t = t.split('\n').filter(function (l) {
      return l.indexOf(FENCE) !== 0;
    }).join('\n').trim();
  }

  if (t.slice(0, 4).toLowerCase() === 'json') {
    t = t.slice(4).trim();
  }

  return t;
}

// ---------------- 類似度 ----------------

function bigrams(s) {
  const t = String(s || '').replace(/[\s、。！？!?…・「」『』（）()～]/g, '');
  const set = new Set();

  for (let i = 0; i < t.length - 1; i++) {
    set.add(t.slice(i, i + 2));
  }

  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;

  let inter = 0;

  for (const x of a) {
    if (b.has(x)) inter++;
  }

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

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

// テスト用に公開
export { bigrams, jaccard, maxSim, cleanup, pickSeed, buildPrompt, parseLangs };

// ---------------- UI ----------------

const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>返答自動生成</title>
<style>
:root{
  --bg:#f7f5fb;
  --card:#ffffff;
  --line:#e7e2f2;
  --tx:#2b2740;
  --sub:#8a86a3;
  --acc:#c2a24e;
  --accd:#a8873a;
  --lav:#efeafb;
  --lavln:#ded4f2;
}

*{
  box-sizing:border-box;
  -webkit-tap-highlight-color:transparent;
}

button,
input,
textarea,
select{
  -webkit-appearance:none;
  appearance:none;
  font-family:inherit;
}

html{
  background:var(--bg);
}

body{
  margin:0 auto;
  max-width:560px;
  background:linear-gradient(180deg,#f9f7fd 0%,#f4f0fb 100%);
  min-height:100vh;
  color:var(--tx);
  font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
  font-size:15px;
  line-height:1.75;
  padding:28px 16px calc(36px + env(safe-area-inset-bottom));
}

h1{
  font-family:"Hiragino Mincho ProN","Yu Mincho",serif;
  font-size:23px;
  font-weight:600;
  letter-spacing:.16em;
  margin:0 0 3px;
  background:linear-gradient(90deg,#3a3457,#6b5aa6);
  -webkit-background-clip:text;
  background-clip:text;
  -webkit-text-fill-color:transparent;
}

.sub{
  color:var(--acc);
  font-size:10px;
  letter-spacing:.3em;
  margin:0 0 24px;
  font-weight:600;
}

.tabs{
  display:flex;
  gap:10px;
  margin:0 0 18px;
}

.tab{
  flex:1;
  padding:13px 0;
  text-align:center;
  border:1px solid var(--lavln);
  border-radius:12px;
  background:var(--lav);
  color:var(--sub);
  font-size:14px;
  font-weight:500;
  cursor:pointer;
  user-select:none;
  transition:all .15s;
}

.tab.on{
  border-color:transparent;
  color:#fff;
  background:linear-gradient(135deg,#7d6ab5,#9585c4);
  box-shadow:0 4px 14px rgba(125,106,181,.28);
}

label{
  display:block;
  color:var(--sub);
  font-size:12px;
  margin:16px 0 6px;
  letter-spacing:.06em;
  font-weight:500;
}

input,
textarea,
select{
  width:100%;
  background:var(--card);
  border:1px solid var(--line);
  border-radius:12px;
  color:var(--tx);
  font-size:16px;
  padding:12px 13px;
  box-shadow:0 1px 3px rgba(80,60,140,.04);
}

input::placeholder,
textarea::placeholder{
  color:#b7b3c9;
}

input:focus,
textarea:focus,
select:focus{
  outline:none;
  border-color:var(--acc);
  box-shadow:0 0 0 3px rgba(194,162,78,.14);
}

textarea{
  resize:vertical;
  min-height:110px;
}

.btn{
  -webkit-appearance:none;
  appearance:none;
  display:block;
  position:relative;
  overflow:hidden;
  width:100%;
  margin-top:22px;
  padding:16px 0;
  border:0;
  border-radius:14px;
  background:linear-gradient(135deg,#ccae5c,#b0913c);
  color:#fff;
  font-family:inherit;
  font-size:16px;
  font-weight:700;
  line-height:1.4;
  letter-spacing:.12em;
  text-align:center;
  cursor:pointer;
  box-shadow:0 6px 18px rgba(176,145,60,.32);
  transition:transform .12s, opacity .12s;
}

.btn:active{
  transform:scale(.97);
}

.btn:disabled{
  opacity:.55;
  box-shadow:none;
  cursor:not-allowed;
}

.dot{
  position:absolute;
  border-radius:50%;
  pointer-events:none;
  opacity:0;
}

.dot.go{
  animation:pop .6s ease-out forwards;
}

@keyframes pop{
  0%{
    opacity:1;
    transform:translate(0,0) scale(.4);
  }
  100%{
    opacity:0;
    transform:translate(var(--dx),var(--dy)) scale(1);
  }
}

.card{
  margin-top:20px;
  background:var(--card);
  border:1px solid var(--line);
  border-radius:16px;
  padding:16px;
  box-shadow:0 8px 26px rgba(90,70,150,.08);
}

.resultHead{
  display:flex;
  flex-wrap:wrap;
  justify-content:flex-end;
  align-items:center;
  gap:8px;
  margin-bottom:12px;
}

.langSel{
  width:auto;
  min-width:120px;
  margin-right:auto;
  padding:9px 12px;
  font-size:14px;
  background:var(--lav);
  border-color:var(--lavln);
  color:#5a4f7a;
  font-weight:600;
}

.meta{
  color:var(--sub);
  font-size:11px;
  margin-bottom:10px;
  letter-spacing:.05em;
}

.bodytext{
  white-space:pre-wrap;
  font-size:15px;
  color:#33304a;
}

.bodyedit{
  width:100%;
  background:#fdfcff;
  border:1px dashed var(--lavln);
  border-radius:12px;
  padding:13px 14px;
  font-family:inherit;
  font-size:15px;
  line-height:1.8;
  color:#33304a;
  min-height:320px;
  resize:vertical;
}

.bodyedit:focus{
  outline:none;
  border-style:solid;
  border-color:var(--acc);
  box-shadow:0 0 0 3px rgba(194,162,78,.14);
}

.mini{
  -webkit-appearance:none;
  appearance:none;
  border:1px solid var(--acc);
  background:transparent;
  color:var(--accd);
  border-radius:9px;
  font-family:inherit;
  font-size:12px;
  line-height:1.2;
  padding:8px 15px;
  cursor:pointer;
  white-space:nowrap;
  font-weight:600;
}

.mini:active{
  background:var(--acc);
  color:#fff;
}

.copyRow{
  margin-top:12px;
  text-align:right;
}

h2{
  font-family:"Hiragino Mincho ProN","Yu Mincho",serif;
  font-size:15px;
  font-weight:600;
  letter-spacing:.12em;
  margin:32px 0 12px;
  color:#4a4468;
}

.hist{
  background:var(--card);
  border:1px solid var(--line);
  border-radius:14px;
  padding:13px 15px;
  margin-bottom:11px;
  box-shadow:0 3px 12px rgba(90,70,150,.05);
}

.histHead{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:6px;
}

.histMeta{
  color:var(--sub);
  font-size:11px;
}

.histText{
  font-size:13.5px;
  white-space:pre-wrap;
  color:#494466;
}

.clamp{
  display:-webkit-box;
  -webkit-line-clamp:2;
  -webkit-box-orient:vertical;
  overflow:hidden;
}

.empty{
  color:var(--sub);
  font-size:13px;
  padding:6px 2px;
}
</style>
</head>
<body>
<h1>返答自動生成</h1>
<p class="sub">AUTO REPLY GENERATOR</p>

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
  <textarea id="reviewIn" placeholder="届いたレビューをそのまま貼り付け（外国語でもOK）"></textarea>
</div>

<button class="btn" id="genBtn" type="button">レビューを生成</button>

<div class="card" id="resultCard">
  <div class="resultHead">
    <select class="langSel" id="langSel"></select>
    <button class="mini" id="reTrans" type="button">翻訳</button>
    <button class="mini" id="clearBtn" type="button">クリア</button>
    <button class="mini" id="resultCopy" type="button">コピー</button>
  </div>
  <div class="meta" id="resultMeta">生成するか、自分で本文を入力して「翻訳」を押せます</div>
  <textarea class="bodyedit" id="resultText" placeholder="生成した本文がここに表示されます。自分で入力して、上のプルダウンで言語を選ぶとその言語に翻訳します（約400字まで）"></textarea>
</div>

<h2>履歴（直近10件・日本語・タップで全文）</h2>
<div id="histList"></div>
<div class="empty" id="histEmpty" style="display:none">まだ履歴がありません</div>

<script>
var mode = 'guest';

var LANGS = [
  { key: 'ja', label: '日本語' },
  { key: 'en', label: 'English' },
  { key: 'zh-CN', label: '简体中文' },
  { key: 'zh-TW', label: '繁體中文' },
  { key: 'ko', label: '한국어' }
];

var cache = {};
var curLang = 'ja';
var baseLang = 'ja';

function byId(id){
  return document.getElementById(id);
}

function genLabel(){
  return mode === 'guest' ? 'レビューを生成' : '返信を生成';
}

function buildLangOptions(){
  var sel = byId('langSel');
  sel.innerHTML = '';

  LANGS.forEach(function(l){
    var op = document.createElement('option');
    op.value = l.key;
    op.textContent = l.label;
    sel.appendChild(op);
  });

  sel.value = curLang;
}

function setMode(m){
  mode = m;

  byId('tabGuest').classList.toggle('on', m === 'guest');
  byId('tabReply').classList.toggle('on', m === 'reply');
  byId('guestFields').style.display = m === 'guest' ? '' : 'none';
  byId('replyFields').style.display = m === 'reply' ? '' : 'none';
  byId('genBtn').textContent = genLabel();

  cache = {};
  curLang = 'ja';
  baseLang = 'ja';

  byId('langSel').value = 'ja';
  byId('resultText').value = '';
  byId('resultMeta').textContent = '生成するか、自分で本文を入力して言語を選ぶと翻訳します';

  loadHistory();
}

function showLang(){
  byId('resultText').value = cache[curLang] || '';
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

    if (!payload.reviewText.trim()) {
      alert('ゲストのレビュー本文を貼り付けてください');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = '生成中…';

  try {
    var res = await fetch('/gen', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    var data = await res.json();

    if (data.error) {
      throw new Error(data.error);
    }

    cache = { ja: data.ja };
    curLang = 'ja';
    baseLang = 'ja';

    byId('langSel').value = 'ja';
    showLang();

    byId('resultMeta').textContent =
      '日本語 ' + data.chars + '文字 ／ 過去との最大類似度 ' + data.sim + '%';

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

    try {
      ok = document.execCommand('copy');
    } catch (e2) {}

    ta.remove();
  }

  if (btn) {
    var old = btn.textContent;
    btn.textContent = ok ? 'コピー済み' : '失敗';

    setTimeout(function(){
      btn.textContent = old;
    }, 1200);
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
    var res = await fetch('/history?mode=' + mode, {
      credentials: 'same-origin'
    });

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
      cbtn.type = 'button';
      cbtn.textContent = 'コピー';

      cbtn.onclick = function(ev){
        ev.stopPropagation();
        copyText(it.text, cbtn);
      };

      head.appendChild(meta);
      head.appendChild(cbtn);

      var bodyDiv = document.createElement('div');
      bodyDiv.className = 'histText clamp';
      bodyDiv.textContent = it.text;

      li.onclick = function(){
        bodyDiv.classList.toggle('clamp');
      };

      li.appendChild(head);
      li.appendChild(bodyDiv);

      list.appendChild(li);
    });
  } catch (e) {}
}

async function ensureLang(target){
  if (cache[target] != null) {
    return true;
  }

  var baseText = cache[baseLang];

  if (!baseText || !baseText.trim()) {
    alert('先に本文を入力または生成してください');
    return false;
  }

  var sel = byId('langSel');
  var re = byId('reTrans');

  sel.disabled = true;
  re.disabled = true;

  var old = re.textContent;
  re.textContent = '翻訳中…';

  try {
    var res = await fetch('/translate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: baseText,
        sourceLang: baseLang,
        targetLang: target
      })
    });

    var data = await res.json();

    if (data.error) {
      throw new Error(data.error);
    }

    cache[target] = data.text;
    return true;
  } catch (e) {
    alert('エラー: ' + e.message);
    return false;
  } finally {
    sel.disabled = false;
    re.disabled = false;
    re.textContent = old;
  }
}

byId('resultText').oninput = function(){
  baseLang = curLang;
  cache = {};
  cache[curLang] = this.value;
  byId('resultMeta').textContent = '入力中（言語を選ぶとその言語へ翻訳します）';
};

byId('tabGuest').onclick = function(){
  setMode('guest');
};

byId('tabReply').onclick = function(){
  setMode('reply');
};

function burstDots(btn){
  var colors = ['#d3b25f','#c9a24e','#e6cf8a','#b0913c'];

  for(var i = 0; i < 14; i++){
    var d = document.createElement('span');
    d.className = 'dot';

    var size = 6 + Math.random() * 10;

    d.style.width = size + 'px';
    d.style.height = size + 'px';
    d.style.left = (42 + Math.random() * 16) + '%';
    d.style.top = (30 + Math.random() * 40) + '%';
    d.style.background = colors[i % colors.length];

    var ang = Math.random() * Math.PI * 2;
    var dist = 40 + Math.random() * 55;

    d.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
    d.style.setProperty('--dy', (Math.sin(ang) * dist) + 'px');

    btn.appendChild(d);

    void d.offsetWidth;
    d.classList.add('go');

    (function(el){
      setTimeout(function(){
        el.remove();
      }, 650);
    })(d);
  }
}

byId('genBtn').onclick = function(){
  burstDots(byId('genBtn'));
  gen();
};

byId('langSel').onchange = async function(){
  var target = this.value;

  if (target === curLang) {
    return;
  }

  var ok = await ensureLang(target);

  if (!ok) {
    this.value = curLang;
    return;
  }

  curLang = target;
  showLang();

  byId('resultMeta').textContent = labelOf(target) + 'を表示中';
};

byId('reTrans').onclick = async function(){
  if (curLang === baseLang) {
    alert('原文の言語です。他の言語を選ぶと翻訳します');
    return;
  }

  delete cache[curLang];

  var ok = await ensureLang(curLang);

  if (ok) {
    showLang();
    byId('resultMeta').textContent = labelOf(curLang) + 'を翻訳し直しました';
  }
};

byId('resultCopy').onclick = function(){
  copyText(byId('resultText').value, byId('resultCopy'));
};

byId('clearBtn').onclick = function(){
  if (!byId('resultText').value.trim()) {
    return;
  }

  if (!confirm('本文を消去します。よろしいですか？')) {
    return;
  }

  cache = {};
  curLang = 'ja';
  baseLang = 'ja';

  byId('langSel').value = 'ja';
  byId('resultText').value = '';
  byId('resultMeta').textContent = '生成するか、自分で本文を入力して言語を選ぶと翻訳します';
  byId('resultText').focus();
};

function labelOf(key){
  for (var i = 0; i < LANGS.length; i++) {
    if (LANGS[i].key === key) {
      return LANGS[i].label;
    }
  }

  return key;
}

buildLangOptions();
setMode('guest');
</script>
</body>
</html>`;
