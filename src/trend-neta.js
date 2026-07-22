// ============================================================
// 民泊ネタ帳 - 民泊・旅館・インバウンド ニュースフィード Worker
//   実装済み:
//     - X収集: Grok(xAI) x_search で反響の大きい話題をJSON取得
//     - RSS+YouTube収集: Geminiでまとめて要約・分類・熱量付け
//     - D1保存(URL重複自動スキップ) / ソース・カテゴリ・★フィルタ / 熱量ソート
//     - 要約ボタン(X=Grok / YouTube=説明文+Gemini / 他=記事本文+Gemini)
//     - ★お気に入りとゴミ箱は右下アイコンから別ページ(★は自動削除の対象外・ゴミ箱に出ない)
//     - 期限切れの自動削除(収集ボタンのたびに実行。期限は検索窓と同期)
//     - 検索 / さらに読み込む / 複数選択→一括使った / 切り口ボタン
//     - 今日のおすすめ(収集後にGeminiが3本選定、X収集完了後に裏で生成)
//     - YouTube既存分の投稿日時を収集のたびに自動補完(videos.list 50件=クォータ1)
//
//   エンドポイント:
//     GET  /            フィードUI(新着 / ★お気に入り / ゴミ箱ページ)
//     GET  /admin       管理ページ(手動収集ボタン・自動収集ログ・保存件数)
//     GET  /admin/data  管理ページ用JSON
//     GET  /ping        動作確認
//     GET  /init        D1テーブル作成・更新(初回・スキーマ変更後に一度開く)
//     GET  /feed        ネタ一覧JSON (?status=new|used / ?fav=1 / &category= / &source= / &sort=heat / &q= / &offset=)
//     GET  /reco        今日のおすすめJSON(読み取りのみ)
//     POST /reco/generate    今日のおすすめを生成
//     GET  /weekly      今週の業界まとめJSON(読み取りのみ)
//     POST /weekly/generate  今週の業界まとめを生成
//     POST /scan/all    期限切れ削除 → RSS+YouTube同期収集、X収集→おすすめ生成を裏で実行
//     POST /scan/x      X収集(Grok)のみ (?wait=1 で同期デバッグ)
//     POST /scan/rss    RSS+YouTube収集のみ
//     POST /scan/cron   cronと同じ処理を手動起動(動作確認 / cron不発時の代替経路)
//     POST /summarize   {id} の要約を生成して detail に保存
//     POST /angle       {id} の切り口(SNSで語る視点3つ)を生成して angle に保存
//     POST /use         {id} または {ids:[...]} を使用済み(ゴミ箱)へ
//     POST /restore     {id} または {ids:[...]} をゴミ箱から新着へ戻す
//     POST /fav         {id, fav:0|1} ★お気に入り切替
//     GET  /ng          NGリスト一覧
//     POST /ng/add      {value} 発信元をNG登録(既存の該当ネタは非表示になる)
//     POST /ng/delete   {id} NG解除(隠していたネタが元に戻る)
//     POST /reset       収集済みネタを全削除(★含む。NG設定は残る)
//
//   必要な設定:
//     D1バインディング: DB (例: trend-neta-db)
//     シークレット: XAI_API_KEY    (X収集用 / console.x.ai)
//     シークレット: GEMINI_API_KEY (分類・要約用 / 番頭と同じキーでOK)
//     シークレット: YT_API_KEY     (YouTube収集・要約用 / 未設定なら自動スキップ)
//     シークレット: ADMIN_TOKEN    (管理・収集系の保護用 / 好きな文字列。/admin?token=... で開く)
//     シークレット: XAI_MGMT_KEY   (任意 / xAI残高表示用の管理キー。console.x.ai で作成)
//     シークレット: XAI_TEAM_ID    (任意 / xAI残高表示用のチームID)
//     cron: 3時間毎に自動収集(ダッシュボード Settings > Triggers で登録)
//       0 */3 * * *
//     ※Xの収集はxAI残高節約のためJST 6時と18時の回だけ実行される
// ============================================================

// ---- Grok(xAI) : X収集用 ----
// grok-4.3 を第一候補にする。X検索結果が大量の入力トークンになるため
// トークン単価がそのままコストに直結する:
//   grok-4.3 = 入力$1.25 / 出力$2.50   (100万トークンあたり)
//   grok-4.5 = 入力$2.00 / 出力$6.00
// 「X投稿を拾ってJSONに整形する」用途に4.5の推論力は不要なので、
// 4.3を既定にして4.5は障害時のフォールバックに回す(Grok代が約4割減る)。
const XAI_MODELS = [
  'grok-4.3',
  'grok-4.5'
];

// ---- Gemini : RSS要約・分類用 (番頭と同じフォールバック方式) ----
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];

// ---- カテゴリ定義 ----
//   inbound: インバウンド / knowhow: 運営ノウハウ / revenue: 収益・単価
//   regulation: 規制・制度 / trouble: トラブル・事件 / trend: トレンド・体験
const CATEGORIES = ['inbound', 'knowhow', 'revenue', 'regulation', 'trouble', 'trend'];

// ---- RSSソース (Phase 2) ----
//   type: news | note | youtube | gov (UIのバッジ色分けに使う)
//   tzfix: 'us_pacific' = pubDateがGMT表記でも実際は米国太平洋時間(Bingの仕様バグ対策)
//   落ちているフィードがあっても他ソースの収集は継続する
const RSS_SOURCES = [
  { name: 'Bingニュース:民泊', type: 'news', tzfix: 'us_pacific',
    url: 'https://www.bing.com/news/search?q=%E6%B0%91%E6%B3%8A&format=rss&setmkt=ja-JP' },
  { name: 'Bingニュース:インバウンド観光', type: 'news', tzfix: 'us_pacific',
    url: 'https://www.bing.com/news/search?q=%E3%82%A4%E3%83%B3%E3%83%90%E3%82%A6%E3%83%B3%E3%83%89%E8%A6%B3%E5%85%89&format=rss&setmkt=ja-JP' },
  { name: 'Bingニュース:旅館', type: 'news', tzfix: 'us_pacific',
    url: 'https://www.bing.com/news/search?q=%E6%97%85%E9%A4%A8&format=rss&setmkt=ja-JP' },
  { name: 'トラベルボイス', type: 'news',
    url: 'https://www.travelvoice.jp/feed' },
  { name: '観光経済新聞', type: 'news',
    url: 'https://www.kankokeizai.com/feed/' },
  { name: 'note:民泊', type: 'note',
    url: 'https://note.com/hashtag/%E6%B0%91%E6%B3%8A/rss' }
];

const FEED_LIMIT = 100;        // 一覧の最大表示件数
const RSS_ITEMS_PER_FEED = 10; // 1フィードから読む最新記事数

// 1回の収集で分類にかける最大件数。取得(約105件)を取りこぼさない値にする。
// 分類しなかった記事は次回の収集に持ち越されるが、その間にRSSから消えると
// 二度と拾えないため、基本的に全件を処理できる上限にしておく。
const RSS_BATCH_MAX = 120;

// Geminiに一度で渡す件数。出力上限(maxOutputTokens=4096)を超えるとJSONが途中で切れ、
// 分類が全滅するため40件ずつに分割して複数回呼ぶ(1記事あたり約90トークン)。
// Geminiの呼び出し自体は無料枠の誤差なので、回数が増えてもコストは実質変わらない。
const CLASSIFY_CHUNK = 40;

// ---- YouTube検索 (YT_API_KEY 設定時のみ有効) ----
//   search 1回 = クォータ100消費(1日1万)。クエリは重複の少ない6本に絞る。
//   'Airbnb' や 'オーバーツーリズム' 単体だと海外の宿紹介・海外旅行vlogを大量に拾うため、
//   日本語の限定語を足して国内の話題に寄せる(relevanceLanguage=ja だけでは効きが弱い)。
const YT_QUERIES = ['民泊', '旅館 経営', 'インバウンド 訪日外国人', 'ホテル業界 日本', 'オーバーツーリズム 日本', 'Airbnb 民泊 運営'];
const YT_RESULTS_PER_QUERY = 8;
const YT_DAYS_BACK = 30;       // 直近何日の動画を対象にするか(=YouTubeの保持日数)

// ---- 保持期限 ----
//   ニュース/X/note は14日で自動削除(★お気に入りは対象外)。
//   YouTube の保持は YT_DAYS_BACK(30日)と共通。検索窓より先にDBから消すと、
//   ゴミ箱に入れた動画を再収集で拾い直す「ブーメラン」が起きるため、窓と期限は必ず揃える。
const RETENTION_DAYS = 14;

// ---- 1回の収集で登録する上限 ----
//   件数が増えすぎたため、分類を通った候補を熱量順に並べて上位だけ登録する。
//   予算: 2週間で300〜400件 ≒ 25件/日。
//     ニュース/YouTube: 2件/回 × 8回/日(3時間毎) = 最大16件/日
//     X:                4件/回 × 2回/日(朝6/夕18) = 最大 8件/日
//   合計 最大24件/日 ≒ 336件/2週間。重複スキップ分だけ実際はこれより減る。
//   登録に漏れた記事も、次の収集でまだ新鮮なら再候補になる(消えるわけではない)。
const RSS_ADD_MAX = 2;
const X_ADD_MAX = 4;

// ---- 熱量の下限 ----
//   これ未満の記事は保存しない。30以下は「◯◯社が交流会を開催」「ウェビナー告知」など
//   プレスリリースが大半で、SNSのネタにならないまま一覧を埋めてしまう。
//   35以上は「文化財ホテルが開業」程度の、話のとっかかりになる記事が残る。
//   実際の値は app_meta の heat_min から読む(管理画面のスライダーで変更可能)。
//   ここは app_meta が空の場合のフォールバックとして残す。
const HEAT_MIN_DEFAULT = 35;

// app_metaから熱量下限を読む。未設定・壊れた値はデフォルトに落とす。
// 収集の頭で1回だけ呼び、ループ中はローカル変数を使う(1件ごとにDBを叩かない)。
async function getHeatMin(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'heat_min'").first();
    if (!row) return HEAT_MIN_DEFAULT;
    const n = parseInt(row.value, 10);
    if (isNaN(n) || n < 0 || n > 100) return HEAT_MIN_DEFAULT;
    return n;
  } catch (e) {
    return HEAT_MIN_DEFAULT;
  }
}

// 管理画面から熱量下限を保存する。0〜100に丸める。既存データには触らない。
async function setHeatMin(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  let n = parseInt(body && body.value, 10);
  if (isNaN(n)) return json({ error: '数値を指定してください' }, 400);
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  await env.DB.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('heat_min', ?)")
    .bind(String(n)).run();
  return json({ ok: true, heat_min: n });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // アプリ全体をADMIN_TOKENで保護する。
      // 要約・切り口・おすすめ・週次まとめはGeminiを消費するため、
      // これらだけ開いておくとURLを知られた時点で叩き放題になる。
      // 単独利用のツールなので、アイコンと死活確認以外は全て認証必須にする。
      const PUBLIC = ['/icon.png', '/icon-v2.png', '/icon-v3.png', '/icon-admin.png', '/icon.svg', '/ping'];
      const authed = checkAdmin(request, url, env);
      if (PUBLIC.indexOf(path) < 0 && !authed) {
        if (!env.ADMIN_TOKEN) {
          return json({ error: 'ADMIN_TOKEN が未設定です。Cloudflareのシークレットに追加してください' }, 401);
        }
        return new Response(UNAUTH_PAGE, {
          status: 401,
          headers: { 'content-type': 'text/html;charset=utf-8' }
        });
      }
      if (path === '/') {
        return htmlWithCookie(PAGE, env);
      }
      if (path === '/admin') {
        return htmlWithCookie(ADMIN_PAGE, env);
      }
      if (path === '/admin/data') {
        return await adminData(env);
      }
      if (path === '/settings/heatmin' && request.method === 'POST') {
        return await setHeatMin(request, env);
      }
      if (path === '/icon.png' || path === '/icon-v2.png' || path === '/icon-v3.png') {
        return iconPng();
      }
      if (path === '/icon-admin.png') {
        return iconPng(true);
      }
      if (path === '/icon.svg') {
        return new Response(ICON_SVG, {
          headers: {
            'content-type': 'image/svg+xml;charset=utf-8',
            'cache-control': 'public, max-age=86400'
          }
        });
      }
      if (path === '/ping') {
        return json({ ok: true, xai: XAI_MODELS[0], gemini: GEMINI_MODELS[0] });
      }
      if (path === '/init') {
        return await initDb(env);
      }
      if (path === '/feed') {
        return await handleFeed(url, env);
      }
      if (path === '/dedupe') {
        // 重複排除だけを実行して結果を返す(収集なし)。原因切り分け用。
        const stat = await dedupeExisting(env);
        return json({ ok: true, dedupe: stat });
      }
      if (path === '/scan/all') {
        // 期限切れを先に掃除(失敗しても収集は続行)
        try { await purgeOld(env); } catch (e) {}
        try { await dedupeExisting(env); } catch (e) {}
        // 補正前に保存されたBing行の投稿日時を一度だけ修正(実行済みなら何もしない)
        try { await fixOldBingDates(env); } catch (e) {}
        // YouTube既存分の投稿日時を裏で補完(対象が無くなれば何もしない)
        ctx.waitUntil(backfillYtDates(env).catch(function () {}));
        // X収集→おすすめ再生成を裏で実行(2〜3分)
        ctx.waitUntil(
          scanX(env).catch(function () {})
            .then(function () { return generateReco(env); })
            .catch(function () {})
        );
        // ニュースは同期実行。直後にニュースベースのおすすめも裏で生成しておく
        // (X完了後の再生成で上書きされる。X側が失敗しても最低限のおすすめは出る)
        const res = await scanRss(env);
        // 収集で入った重複を掃除してからおすすめを作る
        ctx.waitUntil(
          dedupeExisting(env).catch(function () {})
            .then(function () { return generateReco(env); })
            .catch(function () {})
        );
        return res;
      }
      if (path === '/scan/x') {
        // Grokは2〜3分かかるためバックグラウンド実行(Safariのタイムアウト対策)。
        // ?wait=1 を付けると同期実行(デバッグ用)。
        if (url.searchParams.get('wait') === '1') {
          return await scanX(env);
        }
        ctx.waitUntil(scanX(env).catch(function () {}));
        return json({ ok: true, started: true, message: 'X収集を開始しました。2〜3分後に画面を更新してください' });
      }
      if (path === '/scan/rss') {
        const res = await scanRss(env);
        // 収集で入った重複を裏で掃除する
        ctx.waitUntil(dedupeExisting(env).catch(function () {}));
        return res;
      }
      if (path === '/scan/cron') {
        // cronと同じ処理を手動起動する(cron登録の動作確認、
        // またはCloudflareのcronが不発の場合にGitHub Actions等から叩く代替経路)。
        // ?force=x を付けるとX収集も実行する(通常は時刻で判定)
        const forceX = url.searchParams.get('force') === 'x';
        const now = new Date();
        await scheduledScan(env, forceX ? new Date(Date.UTC(
          now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21
        )) : now);
        return await getReco(env, { ok: true, reason: 'cronと同じ処理を実行しました' });
      }
      if (path === '/summarize' && request.method === 'POST') {
        return await summarize(request, env);
      }
      if (path === '/use' && request.method === 'POST') {
        return await setStatus(request, env, 'used');
      }
      if (path === '/restore' && request.method === 'POST') {
        return await setStatus(request, env, 'new');
      }
      if (path === '/fav' && request.method === 'POST') {
        return await setFav(request, env);
      }
      if (path === '/ng') {
        return await listNg(env);
      }
      if (path === '/ng/add' && request.method === 'POST') {
        return await addNg(request, env);
      }
      if (path === '/ng/delete' && request.method === 'POST') {
        return await delNg(request, env);
      }
      if (path === '/reset' && request.method === 'POST') {
        return await resetAll(env);
      }
      if (path === '/angle' && request.method === 'POST') {
        return await makeAngle(request, env);
      }
      if (path === '/reco') {
        return await getReco(env, null);
      }
      if (path === '/reco/generate' && request.method === 'POST') {
        // GETで生成を走らせない(クローラやプレビューでAPIを消費されるため)
        let st;
        try {
          st = await generateReco(env);
        } catch (e) {
          st = { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
        }
        return await getReco(env, st);
      }
      if (path === '/weekly') {
        return await getWeekly(env, null);
      }
      if (path === '/weekly/generate' && request.method === 'POST') {
        let wst;
        try {
          wst = await generateWeekly(env);
        } catch (e) {
          wst = { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
        }
        return await getWeekly(env, wst);
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  // 3時間ごとの自動収集(cron: 0 */3 * * *)。ダッシュボードのTriggersで登録する
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledScan(env, new Date(event.scheduledTime)));
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json;charset=utf-8' }
  });
}

// 認証: ?token= / x-admin-token ヘッダー / Cookie のいずれかが ADMIN_TOKEN と一致すればOK。
// PWA(ホーム画面から起動)はSafariとCookie保管庫が分かれる場合があるため、
// 起動URLに ?token= を含めておけば確実に通る。Cookieはブラウザで開いた時の利便用。
function checkAdmin(request, url, env) {
  if (!env.ADMIN_TOKEN) return false;
  const q = url.searchParams.get('token') || '';
  if (q === env.ADMIN_TOKEN) return true;
  const h = request.headers.get('x-admin-token') || '';
  if (h === env.ADMIN_TOKEN) return true;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)tn_token=([^;]+)/);
  if (m) {
    try {
      if (decodeURIComponent(m[1]) === env.ADMIN_TOKEN) return true;
    } catch (e) {}
  }
  return false;
}

// 認証済みのページ応答にCookieを付けて、次回以降はトークン無しのURLでも開けるようにする
function htmlWithCookie(html, env) {
  return new Response(html, {
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'set-cookie': 'tn_token=' + encodeURIComponent(env.ADMIN_TOKEN) +
        '; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax'
    }
  });
}

// 未認証時に返すページ
const UNAUTH_PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>民泊ネタ帳</title></head>' +
  '<body style="margin:0;background:#f7f6f2;color:#26262b;' +
  'font-family:-apple-system,sans-serif;padding:60px 24px;line-height:1.8">' +
  '<p style="font-size:15px;font-weight:700;margin:0 0 8px">アクセスできません</p>' +
  '<p style="font-size:13px;color:#8b8a94;margin:0">' +
  'URLの末尾に ?token=(合言葉) を付けて開いてください。' +
  '一度開けば、以降はトークン無しでもアクセスできます。</p></body></html>';

// ---------------- D1 ----------------

async function initDb(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS neta (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'source TEXT NOT NULL,' +
    'source_name TEXT,' +
    'category TEXT,' +
    'title TEXT,' +
    'summary TEXT NOT NULL,' +
    'url TEXT,' +
    'heat INTEGER DEFAULT 0,' +
    "status TEXT DEFAULT 'new'," +
    'created_at TEXT)'
  ).run();
  // 詳細要約カラム(要約ボタン用)。既存テーブルには追加、あればエラー無視
  try { await env.DB.prepare('ALTER TABLE neta ADD COLUMN detail TEXT').run(); } catch (e) {}
  // サムネイル画像カラム(YouTube等)
  try { await env.DB.prepare('ALTER TABLE neta ADD COLUMN image TEXT').run(); } catch (e) {}
  // ★お気に入り(1なら自動削除の対象外)
  try { await env.DB.prepare('ALTER TABLE neta ADD COLUMN fav INTEGER DEFAULT 0').run(); } catch (e) {}
  // 元記事の投稿日時(RSSのpubDate / YouTubeのpublishedAt。無ければNULL)
  try { await env.DB.prepare('ALTER TABLE neta ADD COLUMN published_at TEXT').run(); } catch (e) {}
  // 切り口キャッシュ(「なぜ面白い？」ボタン用)
  try { await env.DB.prepare('ALTER TABLE neta ADD COLUMN angle TEXT').run(); } catch (e) {}
  // NGによる非表示フラグ(1=NG登録で隠されている。NG解除すると0に戻り復活する)
  try { await env.DB.prepare('ALTER TABLE neta ADD COLUMN ng_hidden INTEGER DEFAULT 0').run(); } catch (e) {}
  // リンク切れフラグ(1=元記事が404/410で消えている)。
  // 要約取得で404/410を受けた時に立てる。purgeOldでニュース系の1を掃除する(★は除外)。
  try { await env.DB.prepare('ALTER TABLE neta ADD COLUMN dead INTEGER DEFAULT 0').run(); } catch (e) {}
  // アプリ全体の保存用キーバリュー(おすすめ・週次まとめ・収集ログの保存に使用)
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)'
  ).run();
  // NGリスト(迷惑メール設定に相当。発信元名で今後表示しない発信元を記録する)
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS ng (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'kind TEXT NOT NULL,' +
    'value TEXT NOT NULL,' +
    'created_at TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ng_kv ON ng(kind, value)'
  ).run();
  // URL重複を防ぐ(NULLは重複可)。INSERT OR IGNORE で自動スキップ
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_neta_url ON neta(url)'
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_neta_status_id ON neta(status, id)'
  ).run();
  return json({ ok: true, message: 'table ready (fav / published_at / angle / app_meta / ng)' });
}

async function handleFeed(url, env) {
  const cat = url.searchParams.get('category') || '';
  const source = url.searchParams.get('source') || '';
  // 並び順: 新着順(既定) / 古い順 / 熱量順
  // 記事の公開日時で並べる。published_at が無い場合は収集日時で代替。
  // id(挿入順)で並べると、古い記事を後から収集したときに上位へ来てしまう。
  const sortKey = url.searchParams.get('sort') || '';
  const pubKey = 'COALESCE(published_at, created_at)';
  let sort = pubKey + ' DESC, id DESC';
  if (sortKey === 'heat') sort = 'heat DESC, ' + pubKey + ' DESC, id DESC';
  else if (sortKey === 'old') sort = pubKey + ' ASC, id ASC';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  let where;
  const binds = [];
  if (url.searchParams.get('fav') === '1') {
    // ★お気に入りビュー: 新着/使用済みを問わず fav=1 を表示
    where = 'fav = 1';
  } else {
    const st = url.searchParams.get('status') === 'used' ? 'used' : 'new';
    where = 'status = ?';
    binds.push(st);
    // ★付きはゴミ箱に出さない(★を外すと使用済ならゴミ箱に戻る)
    if (st === 'used') where += ' AND fav = 0';
  }
  // カテゴリはカンマ区切りで複数指定できる(UIの「経営」= knowhow,revenue)
  if (cat) {
    const cats = cat.split(',').filter(function (c) { return CATEGORIES.indexOf(c) >= 0; });
    if (cats.length) {
      where += ' AND category IN (' + cats.map(function () { return '?'; }).join(',') + ')';
      for (const c of cats) binds.push(c);
    }
  }
  if (source && ['x', 'news', 'note', 'youtube', 'gov'].indexOf(source) >= 0) {
    where += ' AND source = ?';
    binds.push(source);
  }
  if (q) {
    where += ' AND (title LIKE ? OR summary LIKE ?)';
    const like = '%' + q + '%';
    binds.push(like, like);
  }
  // 表示フィルター(任意)。収集は広く拾い、見る時だけ絞るための出口側の絞り込み。
  // fheat: この熱量以上だけ表示 / fdays: 投稿がこの日数以内だけ表示
  const fheat = parseInt(url.searchParams.get('fheat') || '0', 10);
  if (!isNaN(fheat) && fheat > 0 && fheat <= 100) {
    where += ' AND COALESCE(heat, 0) >= ?';
    binds.push(fheat);
  }
  const fdays = parseInt(url.searchParams.get('fdays') || '0', 10);
  if (!isNaN(fdays) && fdays > 0 && fdays <= 365) {
    where += ' AND COALESCE(published_at, created_at) >= ?';
    binds.push(new Date(Date.now() - fdays * 24 * 3600 * 1000).toISOString());
  }
  // NGで隠されたネタはどのビューにも出さない(NG解除で復活する)
  where += ' AND COALESCE(ng_hidden, 0) = 0';
  // 1件多めに取って続きの有無を判定
  const stmt = env.DB.prepare(
    'SELECT id, source, source_name, category, title, summary, url, heat, status, fav, created_at, published_at, detail, angle, image, dead ' +
    'FROM neta WHERE ' + where + ' ORDER BY ' + sort +
    ' LIMIT ' + (FEED_LIMIT + 1) + ' OFFSET ' + offset
  );
  const rows = await stmt.bind.apply(stmt, binds).all();
  const items = rows.results || [];
  const more = items.length > FEED_LIMIT;
  const out = { items: more ? items.slice(0, FEED_LIMIT) : items, more: more };
  // ページ送りするビュー(お気に入り)では総ページ数を出すため件数も返す。
  // 一覧は無限スクロールなので total は不要(COUNT の分だけ無駄になる)。
  if (url.searchParams.get('total') === '1') {
    const cstmt = env.DB.prepare('SELECT COUNT(*) AS n FROM neta WHERE ' + where);
    const c = await cstmt.bind.apply(cstmt, binds).first();
    out.total = (c && c.n) || 0;
  }
  return json(out);
}

async function setStatus(request, env, status) {
  const body = await request.json();
  let ids = [];
  if (Array.isArray(body.ids)) {
    ids = body.ids.map(function (v) { return parseInt(v, 10); })
      .filter(function (n) { return n > 0; });
  } else {
    const id = parseInt(body.id, 10);
    if (id) ids = [id];
  }
  if (!ids.length) return json({ error: 'idが必要です' }, 400);
  ids = ids.slice(0, 100);
  const ph = ids.map(function () { return '?'; }).join(',');
  const stmt = env.DB.prepare('UPDATE neta SET status = ? WHERE id IN (' + ph + ')');
  await stmt.bind.apply(stmt, [status].concat(ids)).run();
  return json({ ok: true, count: ids.length });
}

async function setFav(request, env) {
  const body = await request.json();
  const id = parseInt(body.id, 10);
  if (!id) return json({ error: 'idが必要です' }, 400);
  const fav = body.fav ? 1 : 0;
  await env.DB.prepare('UPDATE neta SET fav = ? WHERE id = ?').bind(fav, id).run();
  return json({ ok: true, fav: fav });
}

// 期限切れネタの自動削除。収集(手動/自動)のたびに実行。
// ★お気に入り(fav=1)は消さない。手動の完全削除は廃止(消すと再収集で復活するため)。
// 既にDBに入ってしまった重複を掃除する。
// Bingのリダイレクタは同じ記事に tid 違いのURLを振るため、
// normalizeUrl を通すと同一になる行が複数存在しうる。
// 各グループで「★付き > 要約/切り口あり > id が小さい」の順に1件だけ残す。
async function dedupeExisting(env) {
  const rows = await env.DB.prepare(
    'SELECT id, url, fav, detail, angle FROM neta'
  ).all();
  const all = (rows && rows.results) || [];
  const groups = {};
  let normFail = 0;   // 正規化しても bing のままだった件数(=URLパースに失敗)
  for (const r of all) {
    const key = normalizeUrl(r.url);
    if (key && key.indexOf('bing.com/news/apiclick') >= 0) normFail++;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  const doomed = [];
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    if (g.length < 2) continue;
    // 残す1件を選ぶ: ★ > 中身が埋まっている > 古い(idが小さい)
    g.sort(function (a, b) {
      if ((b.fav || 0) !== (a.fav || 0)) return (b.fav || 0) - (a.fav || 0);
      const av = (a.detail ? 1 : 0) + (a.angle ? 1 : 0);
      const bv = (b.detail ? 1 : 0) + (b.angle ? 1 : 0);
      if (bv !== av) return bv - av;
      return a.id - b.id;
    });
    for (let i = 1; i < g.length; i++) doomed.push(g[i].id);
  }
  const stat = {
    rows: all.length,
    groups: Object.keys(groups).length,
    normFail: normFail,
    deleted: 0
  };
  if (!doomed.length) return stat;
  // SQLite の変数上限を避けて分割して削除
  for (let i = 0; i < doomed.length; i += 50) {
    const chunk = doomed.slice(i, i + 50);
    const marks = chunk.map(function () { return '?'; }).join(',');
    const stmt = env.DB.prepare('DELETE FROM neta WHERE id IN (' + marks + ')');
    await stmt.bind.apply(stmt, chunk).run();
  }
  stat.deleted = doomed.length;
  return stat;
}

async function purgeOld(env) {
  const ytCut = new Date(Date.now() - YT_DAYS_BACK * 24 * 3600 * 1000).toISOString();
  const defCut = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  // 記事の公開日時で判定する。created_at(収集日時)で判定すると、
  // 数ヶ月前の記事をRSSが今日配信した場合に「収集したばかり」とみなされ永久に残る。
  await env.DB.prepare(
    "DELETE FROM neta WHERE fav = 0 AND (" +
    "(source = 'youtube' AND COALESCE(published_at, created_at) < ?) OR " +
    "(source <> 'youtube' AND COALESCE(published_at, created_at) < ?))"
  ).bind(ytCut, defCut).run();
  // リンク切れ(dead=1)の自動整理。要約取得で404/410だった記事は元URLが消えている。
  // 【重要】削除ではなくゴミ箱へ移す。行ごと消すとURLがDBから消え、
  // Bing RSSがまだ配信中の同URLを次の収集で「新規」として拾い直すブーメランが起きる。
  // 行を残せば既存URLチェックが効き続け、保持期限(14日)で自然に消える頃には
  // RSSの入口フィルタ(同じ14日)からも外れているため拾い直しは起きない。
  // ★付きは対象外(ユーザーが意図的に保存したものは動かさない)。
  await env.DB.prepare(
    "UPDATE neta SET status = 'used' WHERE dead = 1 AND fav = 0 AND status = 'new'"
  ).run();
}

// 自動収集の本体(cronから起動)。同期的に順番に回し、結果ログをapp_metaに残す。
// RSS/YouTube/おすすめ生成は毎回(=3時間毎)。
// xAI残高節約のため、Xの収集は朝6時と夕方18時(JST)の回だけ実行する(UTCで21時と9時)。
async function scheduledScan(env, when) {
  const log = { when: new Date().toISOString(), mode: 'auto' };
  try { await purgeOld(env); } catch (e) {}
  try {
    log.dedupe = await dedupeExisting(env);
  } catch (e) {
    log.dedupe = { error: String((e && e.message) || e).slice(0, 300) };
  }
  try { await fixOldBingDates(env); } catch (e) {}
  try { await backfillYtDates(env); } catch (e) {}
  try {
    const r = await scanRss(env);
    log.rss = await r.json();
  } catch (e) {
    log.rss = { error: String((e && e.message) || e).slice(0, 200) };
  }
  const h = when.getUTCHours();
  if (h === 21 || h === 9) {
    try {
      const r2 = await scanX(env);
      log.x = await r2.json();
    } catch (e) {
      log.x = { error: String((e && e.message) || e).slice(0, 200) };
    }
  } else {
    log.x = { skipped: true };
  }
  // 収集で入った新しい重複をここで掃除する。
  // 既存行が旧形式(Bing生URL)のままだと、正規化済みURLで入る新規行と
  // 文字列が異なるため UNIQUE 制約をすり抜けて重複が生まれる。
  // おすすめ生成の前に消しておかないと、重複記事が選ばれてしまう。
  try {
    log.dedupe2 = await dedupeExisting(env);
  } catch (e) {
    log.dedupe2 = { error: String((e && e.message) || e).slice(0, 300) };
  }
  try { await generateReco(env); } catch (e) {}
  // 月曜朝6時(JST)=UTC日曜21時の回で週次まとめを更新
  if (h === 21 && when.getUTCDay() === 0) {
    try { await generateWeekly(env); } catch (e) {}
  }
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_scan', ?)"
    ).bind(log.when).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_scan_log', ?)"
    ).bind(JSON.stringify(log)).run();
  } catch (e) {}
}

// 管理ページ用: 保存件数と自動収集の状態を返す
async function adminData(env) {
  const counts = await env.DB.prepare(
    'SELECT source, status, COUNT(*) AS n FROM neta GROUP BY source, status'
  ).all();
  const favRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM neta WHERE fav = 1').first();
  const metas = await env.DB.prepare(
    "SELECT key, value FROM app_meta WHERE key IN ('last_scan', 'last_scan_log', 'last_x_scan_log')"
  ).all();
  const out = { counts: (counts && counts.results) || [], fav: favRow ? favRow.n : 0 };
  out.heat_min = await getHeatMin(env);
  out.xai = await getXaiBalance(env);
  for (const r of ((metas && metas.results) || [])) {
    if (r.key === 'last_scan') out.last_scan = r.value;
    if (r.key === 'last_scan_log') {
      try { out.last_scan_log = JSON.parse(r.value); } catch (e) {}
    }
    if (r.key === 'last_x_scan_log') {
      try { out.last_x_scan_log = JSON.parse(r.value); } catch (e) {}
    }
  }
  return json(out);
}

// 1件INSERT(URL重複は自動スキップ)。追加できたらtrue
async function insertNeta(env, item) {
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO neta (source, source_name, category, title, summary, url, heat, image, published_at, detail, status, created_at) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)"
  ).bind(
    item.source, item.source_name || '', normCategory(item.category),
    String(item.title || '').slice(0, 120),
    String(item.summary || '').slice(0, 500),
    item.url || null,
    clampHeat(item.heat),
    item.image || null,
    item.published_at || null,
    item.detail ? String(item.detail).slice(0, 1000) : null,
    new Date().toISOString()
  ).run();
  return !!(res && res.meta && res.meta.changes > 0);
}

function normCategory(c) {
  return CATEGORIES.indexOf(c) >= 0 ? c : 'trend';
}

function clampHeat(h) {
  const n = parseInt(h, 10);
  if (isNaN(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

// ---------------- NGリスト (迷惑メール設定に相当) ----------------
// YouTubeのチャンネル単位で「今後表示しない」を登録する。
// ニュースやnoteは媒体・ドメイン単位で切ると有用な記事まで巻き添えになるため対象外。
// (単発の不要な記事は「使った」でゴミ箱へ送れば新着から消え、再収集もされない)
// 既存ネタは「削除」ではなく ng_hidden=1 で隠すだけなので、NG解除で完全に元へ戻せる。
// 隠している間も収集時フィルタが効くため、再収集で増えることはない。

// NGの照合は前後の空白を落として行う。
// YouTubeのチャンネル名には末尾に空白が入っていることがあり(例: 'The Glam Soul '),
// 登録側だけtrimすると source_name との完全一致が外れてNGが効かなくなる。
async function loadNg(env) {
  try {
    const rows = await env.DB.prepare("SELECT value FROM ng WHERE kind = 'channel'").all();
    return ((rows && rows.results) || []).map(function (r) { return String(r.value || '').trim(); });
  } catch (e) {
    return []; // NGテーブル未作成(=/init未実行)でも収集は止めない
  }
}

// 収集した1件がNG発信元に該当するか
function isNg(ngNames, sourceName) {
  const s = String(sourceName || '').trim();
  if (!s) return false;
  return ngNames.indexOf(s) >= 0;
}

async function listNg(env) {
  const rows = await env.DB.prepare(
    'SELECT id, kind, value, created_at FROM ng ORDER BY id DESC'
  ).all();
  return json({ items: (rows && rows.results) || [] });
}

// NG登録: 既存の該当ネタを ng_hidden=1 で隠す(★付きも隠すが、解除で戻る)
async function addNg(request, env) {
  const body = await request.json();
  const value = String(body.value || '').trim().slice(0, 60);
  if (!value) return json({ error: '発信元名が必要です' }, 400);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO ng (kind, value, created_at) VALUES ('channel', ?, ?)"
  ).bind(value, new Date().toISOString()).run();
  // TRIM同士で比較する(チャンネル名の末尾空白で一致が外れるのを防ぐ)
  const res = await env.DB.prepare(
    'UPDATE neta SET ng_hidden = 1 WHERE TRIM(source_name) = ?'
  ).bind(value).run();
  const hidden = (res && res.meta && res.meta.changes) || 0;
  return json({ ok: true, value: value, hidden: hidden });
}

// NG解除: 隠していたネタを元に戻す(新着・ゴミ箱・★の状態はそのまま復元される)
async function delNg(request, env) {
  const body = await request.json();
  const id = parseInt(body.id, 10);
  if (!id) return json({ error: 'idが必要です' }, 400);
  const row = await env.DB.prepare('SELECT value FROM ng WHERE id = ?').bind(id).first();
  if (!row) return json({ error: '対象が見つかりません' }, 404);
  await env.DB.prepare('DELETE FROM ng WHERE id = ?').bind(id).run();
  const res = await env.DB.prepare(
    'UPDATE neta SET ng_hidden = 0 WHERE ng_hidden = 1 AND TRIM(source_name) = ?'
  ).bind(String(row.value || '').trim()).run();
  const restored = (res && res.meta && res.meta.changes) || 0;
  return json({ ok: true, value: row.value, restored: restored });
}

// 収集済みネタを全消去(★も含む)。古いデータが混ざって検証しづらい時のリセット用。
// NGリストと最終収集ログは残す(消すと設定まで失われるため)。
async function resetAll(env) {
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM neta').first();
  await env.DB.prepare('DELETE FROM neta').run();
  // おすすめ・週次まとめは元ネタが消えるので合わせて破棄
  await env.DB.prepare("DELETE FROM app_meta WHERE key IN ('reco', 'weekly')").run();
  return json({ ok: true, deleted: before ? before.n : 0 });
}

// ---------------- xAI 残高 (Management API) ----------------
// 残高 = チャージ額 - 使用額 で算出する。
//   チャージ額: GET  /v1/billing/teams/{id}/prepaid/balance の changes から
//               PURCHASE かつ SUCCEEDED のものを合計(amount.val はUSDセント・入金はマイナス表記)
//   使用額    : POST /v1/billing/teams/{id}/usage で最初のチャージ日から今日までを集計(USD)
// prepaid/balance の total は「消費が台帳へ反映されるまでチャージ額のまま」になるため使わない
// (反映後に使用額を二重に引く事故も防げる)。通常のXAI_API_KEYではなく管理キーが必要。
async function getXaiBalance(env) {
  if (!env.XAI_MGMT_KEY || !env.XAI_TEAM_ID) {
    return { ok: false, reason: 'XAI_MGMT_KEY / XAI_TEAM_ID が未設定です' };
  }
  const base = 'https://management-api.x.ai/v1/billing/teams/' + encodeURIComponent(env.XAI_TEAM_ID);
  const headers = {
    'authorization': 'Bearer ' + env.XAI_MGMT_KEY,
    'content-type': 'application/json'
  };
  try {
    // 1) チャージ額
    const res1 = await fetch(base + '/prepaid/balance', { headers: headers });
    if (!res1.ok) {
      const t = await res1.text();
      return { ok: false, reason: '残高API error ' + res1.status + ': ' + t.slice(0, 120) };
    }
    const d1 = await res1.json();
    let purchased = 0;
    let earliest = '';
    for (const c of ((d1 && d1.changes) || [])) {
      if (c && c.changeOrigin === 'PURCHASE' && c.topupStatus === 'SUCCEEDED' && c.amount) {
        const v = parseFloat(c.amount.val);
        if (!isNaN(v)) purchased += Math.abs(v) / 100;
        const t = c.createTime || c.createTs || '';
        if (t && (!earliest || t < earliest)) earliest = t;
      }
    }

    // 2) 使用額(最初のチャージ日から今日まで)
    const startDay = earliest ? String(earliest).slice(0, 10) : '2026-01-01';
    const endDay = new Date().toISOString().slice(0, 10);
    const res2 = await fetch(base + '/usage', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        analyticsRequest: {
          timeRange: {
            startTime: startDay + ' 00:00:00',
            endTime: endDay + ' 23:59:59',
            timezone: 'Etc/GMT'
          },
          timeUnit: 'TIME_UNIT_DAY',
          values: [{ name: 'usd', aggregation: 'AGGREGATION_SUM' }],
          groupBy: ['description'],
          filters: []
        }
      })
    });
    if (!res2.ok) {
      // 使用額が取れない時はチャージ額だけ返す(残高不明であることを明示)
      const t2 = await res2.text();
      return {
        ok: true, purchased: purchased, usd: null,
        note: '使用額の取得に失敗(' + res2.status + ': ' + t2.slice(0, 80) + ')'
      };
    }
    const d2 = await res2.json();
    let used = 0;
    for (const s of ((d2 && d2.timeSeries) || [])) {
      for (const p of ((s && s.dataPoints) || [])) {
        const v = p && p.values && p.values[0];
        if (typeof v === 'number') used += v;
      }
    }
    return { ok: true, usd: purchased - used, purchased: purchased, used: used };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 150) };
  }
}

// ---------------- 記事要約 (要約ボタン) ----------------
//   X投稿 → Grok(x_search)でスレッド・反応込みで要約
//   YouTube → Data APIで説明文を取得しGeminiで要約(ページfetchでは本文が取れないため)
//   ニュース/note → 記事ページを取得して本文抽出 → Geminiで要約
//   結果は detail カラムに保存(2回目以降は即返す)

async function summarize(request, env) {
  const body = await request.json();
  const id = parseInt(body.id, 10);
  if (!id) return json({ error: 'idが必要です' }, 400);
  const row = await env.DB.prepare('SELECT id, source, url, title, summary, detail FROM neta WHERE id = ?')
    .bind(id).first();
  if (!row) return json({ error: '対象が見つかりません' }, 404);
  if (row.detail) return json({ ok: true, detail: row.detail, cached: true });
  if (!row.url) return json({ error: 'この項目には出典URLがありません' }, 400);

  let detail = '';
  if (row.source === 'x') {
    // 新規X投稿は収集時にdetailが入るため、ここは旧データ用。
    // x_search節約のためGrokは使わず、収集済みの情報からGeminiで整形する
    const raw = await callGemini(env,
      '以下はXで話題になった投稿の収集メモです。この情報だけを使って内容を日本語2〜3文で整理してください。' +
      '推測で情報を足さないこと。本文のみを出力。\n---\n' +
      'タイトル: ' + String(row.title || '') + '\nメモ: ' + String(row.summary || ''), false);
    detail = String(raw || '').trim();
  } else if (row.source === 'youtube') {
    detail = await summarizeYoutube(env, row);
  } else {
    const res = await fetch(row.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      redirect: 'follow'
    });
    if (!res.ok) {
      // 404/410 は元記事が消えている。リンク切れフラグを立てて、フロントに知らせる。
      // ★付きは掃除対象外だが、切れている事実は記録しておく。
      if (res.status === 404 || res.status === 410) {
        try { await env.DB.prepare('UPDATE neta SET dead = 1 WHERE id = ?').bind(id).run(); } catch (e) {}
        return json({ error: '元記事が見つかりません(' + res.status + ')。リンク切れとして削除できます。', dead: true }, 502);
      }
      return json({ error: '記事の取得に失敗しました(' + res.status + ')' }, 502);
    }
    const html = await res.text();
    const text = htmlToText(html).slice(0, 6000);
    if (text.length < 100) return json({ error: '記事本文を抽出できませんでした' }, 502);
    const raw = await callGemini(env,
      '以下はニュース記事ページから抽出したテキストです(サイトのメニュー等のノイズを含む場合があります)。' +
      '記事「' + String(row.title || '') + '」の内容を日本語3〜4文で要約してください。' +
      '要約本文のみを出力(前置き・見出し不要)。\n---\n' + text, false);
    detail = String(raw || '').trim();
  }
  if (!detail) return json({ error: '要約の生成に失敗しました' }, 502);
  detail = detail.slice(0, 1000);
  await env.DB.prepare('UPDATE neta SET detail = ? WHERE id = ?').bind(detail, id).run();
  return json({ ok: true, detail: detail });
}

// YouTube動画の要約。Data API(videos.list=クォータ1)で説明文を取り、Geminiに渡す。
// 説明文が取れない場合は要約を作らない。タイトルだけからの推測は、釣りタイトルや
// 反語的タイトルで内容を逆に取り違え、ネタ帳の信頼性を壊すため(誤情報より無情報の方がマシ)。
async function summarizeYoutube(env, row) {
  const m = String(row.url || '').match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  const vid = m ? m[1] : '';
  let desc = '';
  if (vid && env.YT_API_KEY) {
    try {
      const u = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + vid +
        '&key=' + env.YT_API_KEY;
      const res = await fetch(u);
      if (res.ok) {
        const data = await res.json();
        const sn = data && data.items && data.items[0] && data.items[0].snippet;
        if (sn && sn.description) desc = String(sn.description);
      }
    } catch (e) {}
  }
  if (desc.length < 40) {
    return '動画の説明文を取得できなかったため、要約は生成していません(推測は書きません)。元動画を確認してください。';
  }
  const raw = await callGemini(env,
    '以下はYouTube動画「' + String(row.title || '') + '」の説明文です。' +
    '動画の内容を日本語3〜4文で要約してください。宿泊事業者(民泊・旅館)に関係する点があれば触れてください。' +
    '説明文に書かれていないことを推測で補わないこと。要約本文のみを出力(前置き・見出し不要)。\n---\n' +
    desc.slice(0, 6000), false);
  return String(raw || '').trim();
}

// 「切り口」ボタン: 宿泊事業者がSNSで語るための視点3つをGeminiで生成し angle に保存
async function makeAngle(request, env) {
  const body = await request.json();
  const id = parseInt(body.id, 10);
  if (!id) return json({ error: 'idが必要です' }, 400);
  const row = await env.DB.prepare('SELECT id, title, summary, detail, angle FROM neta WHERE id = ?')
    .bind(id).first();
  if (!row) return json({ error: '対象が見つかりません' }, 404);
  if (row.angle) return json({ ok: true, angle: row.angle, cached: true });
  let src = 'タイトル: ' + String(row.title || '') + '\n概要: ' + String(row.summary || '');
  if (row.detail) src += '\n詳細: ' + String(row.detail).slice(0, 800);
  const raw = await callGemini(env,
    'あなたは民泊・旅館オーナー向けのSNS発信アドバイザーです。' +
    '以下のネタについて、宿泊事業者がSNSで語るときの切り口を3つ挙げてください。\n' +
    '各行「・視点(10字以内): 補足を一言」の形式で3行だけを出力。前置き・結論・見出しは不要。\n---\n' + src,
    false);
  const angle = String(raw || '').trim().slice(0, 600);
  if (!angle) return json({ error: '切り口の生成に失敗しました' }, 502);
  await env.DB.prepare('UPDATE neta SET angle = ? WHERE id = ?').bind(angle, id).run();
  return json({ ok: true, angle: angle });
}

// 投稿(or取得)からの経過を「当日/N日前」で返す
function fmtAge(iso) {
  const t = new Date(iso || 0).getTime();
  if (!t) return '不明';
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? '当日' : d + '日前';
}

// 「今日のおすすめ」: 未使用の直近ネタからGeminiが3本選定。
// 選定材料: 熱量(heat)・鮮度(経過日数)・カテゴリ別のトレンド統計(直近2日vsその前5日)・
// エムの採用傾向(使った/★の履歴)。/scan/all と自動収集の最後に実行
async function generateReco(env) {
  const rows = await env.DB.prepare(
    "SELECT id, title, summary, source, category, heat, published_at, created_at " +
    "FROM neta WHERE status = 'new' AND COALESCE(ng_hidden, 0) = 0 " +
    "ORDER BY COALESCE(published_at, created_at) DESC LIMIT 40"
  ).all();
  const items = (rows && rows.results) || [];
  if (items.length < 3) return { ok: false, reason: '未使用のネタが3件未満です' };

  // 採用傾向(好みの参考): 直近の「使った」と★
  const usedRows = await env.DB.prepare(
    "SELECT title FROM neta WHERE status = 'used' ORDER BY id DESC LIMIT 15"
  ).all();
  const favRows = await env.DB.prepare(
    'SELECT title FROM neta WHERE fav = 1 ORDER BY id DESC LIMIT 15'
  ).all();
  const usedTitles = ((usedRows && usedRows.results) || []).map(function (r) { return r.title; });
  const favTitles = ((favRows && favRows.results) || []).map(function (r) { return r.title; });

  // カテゴリ別トレンド統計: 直近2日 vs その前5日
  const cut2 = new Date(Date.now() - 2 * 86400000).toISOString();
  const cut7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentCat = await env.DB.prepare(
    'SELECT category, COUNT(*) AS n FROM neta ' +
    'WHERE COALESCE(published_at, created_at) > ? AND COALESCE(ng_hidden, 0) = 0 ' +
    'GROUP BY category'
  ).bind(cut2).all();
  const prevCat = await env.DB.prepare(
    'SELECT category, COUNT(*) AS n FROM neta ' +
    'WHERE COALESCE(published_at, created_at) <= ? AND COALESCE(published_at, created_at) > ? ' +
    'AND COALESCE(ng_hidden, 0) = 0 GROUP BY category'
  ).bind(cut2, cut7).all();
  const rMap = {};
  const pMap = {};
  (((recentCat && recentCat.results) || [])).forEach(function (r) { rMap[r.category] = r.n; });
  (((prevCat && prevCat.results) || [])).forEach(function (r) { pMap[r.category] = r.n; });

  const lines = [];
  lines.push('あなたは民泊・旅館オーナー向けSNS発信のネタ選定者です。');
  lines.push('以下の候補から「今日これを題材に投稿すれば最もバズる3本」を選び、選んだ理由を一言ずつ付けてください。');
  lines.push('');
  lines.push('# 選定基準(総合判断)');
  lines.push('1. 世間の関心・話題性が大きい(熱量🔥が高い)');
  lines.push('2. 驚き・怒り・共感など感情が動く(事件・炎上・賛否が割れる話題は強い)');
  lines.push('3. 宿泊事業者として当事者性を持って語れる(円安・災害・訪日客マナーなど間接的な話題も可)');
  lines.push('4. 鮮度が高い(古いネタは弱い)');
  lines.push('5. トレンド統計で件数が伸びているカテゴリ・話題(=今まさに来ている)');
  lines.push('6. 「過去に採用したネタ」の傾向に近いテーマ(発信者の好み)');
  lines.push('');
  lines.push('# カテゴリ別トレンド統計');
  CATEGORIES.forEach(function (c) {
    lines.push('- ' + c + ': 直近2日 ' + (rMap[c] || 0) + '件 / その前5日 ' + (pMap[c] || 0) + '件');
  });
  lines.push('');
  if (usedTitles.length || favTitles.length) {
    lines.push('# 過去に採用したネタ(好みの参考)');
    usedTitles.forEach(function (t) { lines.push('- ' + t); });
    favTitles.forEach(function (t) { lines.push('- ★ ' + t); });
    lines.push('');
  }
  lines.push('# 候補');
  items.forEach(function (it) {
    lines.push('[id:' + it.id + '] (' + it.source + '/' + it.category + '/🔥' + it.heat +
      '/' + fmtAge(it.published_at || it.created_at) + ') ' +
      String(it.title || '') + ' - ' + String(it.summary || '').slice(0, 60));
  });
  lines.push('');
  lines.push('# 出力形式(最重要)');
  lines.push('JSON配列のみを出力。前置き・説明・コードフェンス禁止。');
  lines.push('[{"id":123,"reason":"なぜバズるかを一言(30字以内)"}] の形で3件。idは候補のidをそのまま使う。');
  const raw = await callGemini(env, lines.join('\n'));
  const picked = extractJsonArray(raw) || [];
  const byId = {};
  items.forEach(function (it) { byId[it.id] = it; });
  const out = [];
  for (const p of picked) {
    const it = p && byId[p.id];
    if (!it) continue;
    out.push({ id: it.id, title: it.title, source: it.source, reason: String(p.reason || '').slice(0, 80) });
    if (out.length >= 3) break;
  }
  if (!out.length) return { ok: false, reason: 'AI応答の解析に失敗しました', raw: String(raw || '').slice(0, 200) };
  await env.DB.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .bind('reco', JSON.stringify({ generated_at: new Date().toISOString(), items: out })).run();
  return { ok: true, count: out.length };
}

async function getReco(env, makeStatus) {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM app_meta WHERE key IN ('reco', 'last_scan')"
  ).all();
  let data = { items: null };
  let last = null;
  for (const r of ((rows && rows.results) || [])) {
    if (r.key === 'reco' && r.value) {
      try { data = JSON.parse(r.value); } catch (e) {}
    }
    if (r.key === 'last_scan') last = r.value;
  }
  if (last) data.last_scan = last;
  if (makeStatus) data.make = makeStatus;
  return json(data);
}

// 「今週の業界まとめ」: 直近7日のネタからGeminiが動向と来週の注目を生成。
// 月曜朝6時(JST)の自動収集で更新、POST /weekly/generate で手動生成も可
async function generateWeekly(env) {
  const cut = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = await env.DB.prepare(
    'SELECT title, category, heat, source FROM neta ' +
    'WHERE COALESCE(published_at, created_at) > ? AND COALESCE(ng_hidden, 0) = 0 ' +
    'ORDER BY heat DESC, id DESC LIMIT 60'
  ).bind(cut).all();
  const items = (rows && rows.results) || [];
  if (items.length < 5) return { ok: false, reason: '直近7日のネタが5件未満です' };
  const lines = [];
  lines.push('あなたは民泊・旅館・インバウンド業界のアナリストです。');
  lines.push('以下は直近7日に収集した業界の話題(熱量順)です。これを俯瞰して週次まとめを書いてください。');
  lines.push('');
  lines.push('# 話題一覧');
  items.forEach(function (it) {
    lines.push('- (' + it.source + '/' + it.category + '/🔥' + it.heat + ') ' + String(it.title || ''));
  });
  lines.push('');
  lines.push('# 出力形式(最重要)');
  lines.push('プレーンテキストのみ。マークダウン記号・前置き・結びは不要。全体300字程度。');
  lines.push('1行目「■今週の動向」、続けて何が話題の中心だったかを3〜4行。');
  lines.push('空行を挟んで「■来週の注目」、続けて続きそうな論点や仕込みたいネタを2〜3行。');
  const raw = await callGemini(env, lines.join('\n'), false);
  const text = String(raw || '').trim().slice(0, 800);
  if (!text) return { ok: false, reason: '生成に失敗しました' };
  await env.DB.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .bind('weekly', JSON.stringify({ generated_at: new Date().toISOString(), text: text })).run();
  return { ok: true };
}

async function getWeekly(env, makeStatus) {
  const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'weekly'").first();
  let data = { text: null };
  if (row && row.value) {
    try { data = JSON.parse(row.value); } catch (e) {}
  }
  if (makeStatus) data.make = makeStatus;
  return json(data);
}

// 既存YouTube行の published_at を videos.list(1回で最大50件・クォータ1)で補完。
// 対象が無くなれば何もしない(自然終了)。/scan/all のたびに裏で実行
async function backfillYtDates(env) {
  if (!env.YT_API_KEY) return;
  const rows = await env.DB.prepare(
    "SELECT id, url FROM neta WHERE source = 'youtube' AND (published_at IS NULL OR published_at = '') LIMIT 50"
  ).all();
  const items = (rows && rows.results) || [];
  if (!items.length) return;
  const map = {};
  const vids = [];
  for (const r of items) {
    const m = String(r.url || '').match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (m) { map[m[1]] = r.id; vids.push(m[1]); }
  }
  if (!vids.length) return;
  const u = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + vids.join(',') +
    '&key=' + env.YT_API_KEY;
  const res = await fetch(u);
  if (!res.ok) return;
  const data = await res.json();
  for (const it of (data.items || [])) {
    const rid = it && it.id && map[it.id];
    const sn = it && it.snippet;
    if (!rid || !sn || !sn.publishedAt) continue;
    await env.DB.prepare('UPDATE neta SET published_at = ? WHERE id = ?')
      .bind(String(sn.publishedAt), rid).run();
  }
}

function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// ---------------- X収集 (Grok x_search) ----------------

async function scanX(env) {
  const heatMin = await getHeatMin(env);
  const prompt =
    'あなたは日本の宿泊事業者(民泊・旅館・ホテル)のSNS発信を支えるネタ探し担当です。\n' +
    'Xで直近数日に日本語圏で話題になっている投稿を検索し、15件に整理してください。\n' +
    '目的は「宿泊事業者がこれを題材に投稿してバズること」です。\n' +
    '\n' +
    '# 対象にする話題(広めに取る)\n' +
    '宿泊業そのものの話題だけでは数が足りません。宿泊事業者が一言持てる話題なら広く拾ってください。\n' +
    '- 宿泊・観光: 民泊/旅館/ホテル/インバウンド/観光地/オーバーツーリズム\n' +
    '- 訪日客: マナー問題、爆買い、宿泊マナー、外国人客とのトラブル、多言語対応\n' +
    '- 経済・市況: 円安、物価高、人手不足、最低賃金、インバウンド消費、不動産価格\n' +
    '- 事件・トラブル: 事件、事故、炎上、治安、迷惑行為、近隣トラブル、災害・地震\n' +
    '- 政策・制度: 民泊規制、宿泊税、入管政策、観光政策、外国人受け入れ論争\n' +
    '- 地方・空き家: 地方創生、空き家問題、移住、シャッター街、地方の観光振興\n' +
    '- 働き方・接客: 接客業の悩み、クレーマー、カスハラ、人手不足、副業\n' +
    '\n' +
    '# 選び方\n' +
    '- 実際に反響が大きい(RT・いいね・引用が多い)投稿を優先する。\n' +
    '- 賛否が割れる話題、感情が動く話題(怒り・驚き・共感)を優先する。\n' +
    '- 事件・炎上・トラブルは必ず含める。事業者の安全対応や近隣説明に直結する重要ネタ。\n' +
    '- 日本語の投稿・日本国内の話題に限る(海外の話題は日本に影響するものだけ)。\n' +
    '- 単なる宣伝/告知/開業案内、反響の小さい投稿は含めない。\n' +
    '\n' +
    '# カテゴリ定義\n' +
    '- inbound: インバウンド・訪日客・円安・多言語対応\n' +
    '- knowhow: 民泊/旅館の運営ノウハウ・接客・人手不足・働き方\n' +
    '- revenue: 収益・宿泊単価・OTA手数料・消費動向・不動産・物価\n' +
    '- regulation: 規制・条例・制度・税・政策\n' +
    '- trouble: トラブル・事件・事故・炎上・治安・近隣問題・災害・カスハラ\n' +
    '- trend: トレンド・新業態・体験・観光地・地方創生・空き家・その他\n' +
    '\n' +
    '# 出力形式(最重要)\n' +
    '以下の形のJSON配列だけを出力。前置き・説明・コードフェンスは一切禁止。\n' +
    '[{"title":"短い見出し(20字以内)","summary":"内容の要約(1〜2文)","detail":"投稿内容と主な反応の詳しめの要約(3〜4文)","url":"代表的な元投稿のURL","category":"trouble","heat":85}]\n' +
    '- urlは必ず実在するX投稿のURL(x.com)。特定できない話題は含めない。\n' +
    '- heatは「この話題を題材にした投稿がバズる見込み」を0〜100の整数で。判断材料は次の3つ:\n' +
    '  (1)実際の反響の大きさ (2)驚き・怒り・共感など感情が動くか (3)宿泊事業者として当事者性を持って語れるか\n' +
    '  事件・炎上・賛否が割れる話題は高くなりやすい。単なる開業/受賞/宣伝の告知は低くする。\n' +
    '- summaryは日本語で投稿内容と反応の要点。detailも日本語で、後から読み返す用の詳しい版。';

  const result = await callGrokXSearch(env, prompt);
  const items = extractJsonArray(result.text);
  if (!items || !items.length) {
    return json({ error: 'X収集: Grok応答の解析に失敗しました。もう一度お試しください', raw: (result.text || '').slice(0, 300) }, 502);
  }
  let added = 0;
  let skipped = 0;
  let lowHeat = 0;
  let capSkip = 0;
  // 熱量の高い順に上位 X_ADD_MAX 件だけ登録する(件数抑制)。
  // Xは重複だと INSERT OR IGNORE で弾かれて枠が無駄になるため、挿入結果を見ながら進める。
  const sorted = items.slice().sort(function (a, b) {
    return ((b && b.heat) || 0) - ((a && a.heat) || 0);
  });
  for (const it of sorted) {
    if (!it || !it.summary) continue;
    const u = String(it.url || '');
    if (!/^https?:\/\//.test(u)) continue; // URL無しは採用しない(出典必須)
    // ニュース側と基準を揃える。Xは元々バズった投稿なので該当は少ないが、
    // 経路ごとに基準が違うと一覧に低スコアが混ざる。
    if (typeof it.heat === 'number' && it.heat < heatMin) { lowHeat++; continue; }
    if (added >= X_ADD_MAX) { capSkip++; continue; }
    const ok = await insertNeta(env, {
      source: 'x', source_name: 'X', category: it.category,
      title: it.title, summary: it.summary, url: normalizeUrl(u), heat: it.heat,
      detail: it.detail
    });
    if (ok) added++; else skipped++;
  }
  // バックグラウンド実行でも結果を管理画面で確認できるよう記録
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_x_scan_log', ?)"
    ).bind(JSON.stringify({
      when: new Date().toISOString(), added: added, skipped: skipped, lowHeat: lowHeat, capSkip: capSkip, found: items.length
    })).run();
  } catch (e) {}
  return json({ ok: true, added: added, capSkip: capSkip, skipped: skipped, lowHeat: lowHeat, heatMin: heatMin, found: items.length });
}

async function callGrokXSearch(env, userText) {
  if (!env.XAI_API_KEY) throw new Error('XAI_API_KEY が未設定です');
  let lastStatus = 0;
  let lastBody = '';
  for (let mi = 0; mi < XAI_MODELS.length; mi++) {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + env.XAI_API_KEY
      },
      body: JSON.stringify({
        model: XAI_MODELS[mi],
        input: [{ role: 'user', content: userText }],
        tools: [{ type: 'x_search' }]
      })
    });
    // 503/429=混雑、404=モデル未提供、403=地域制限やモデル権限なし。
    // いずれも「このモデルが使えないだけ」なので、次のモデルを試す。
    if (res.status === 503 || res.status === 429 || res.status === 404 || res.status === 403) {
      lastStatus = res.status;
      lastBody = await res.text();
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error('xAI API error ' + res.status + ': ' + t.slice(0, 300));
    }
    const data = await res.json();
    return parseGrokResponses(data);
  }
  throw new Error('xAI 混雑/エラー(' + lastStatus + ')。詳細: ' + lastBody.slice(0, 200));
}

// Responses API から本文テキストを取り出す(防御的に複数パターン対応)
function parseGrokResponses(data) {
  let text = '';
  if (data && typeof data.output_text === 'string' && data.output_text.trim()) {
    text = data.output_text.trim();
  }
  if (!text && data && Array.isArray(data.output)) {
    const chunks = [];
    for (const item of data.output) {
      const content = item && item.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c.text === 'string') chunks.push(c.text);
        }
      }
    }
    if (chunks.length) text = chunks.join('\n').trim();
  }
  if (!text && data && Array.isArray(data.choices) && data.choices[0]) {
    const msg = data.choices[0].message;
    if (msg && typeof msg.content === 'string') text = msg.content.trim();
  }
  return { text: text };
}

// ---------------- RSS収集 (Gemini分類) ----------------

// 新規記事をソース種別ごとに均等配分してから上限で切る。
// 単純に先頭からmaxTotal件取ると、配列後方のYouTube/note/後発フィードが
// ニュースの新着だけで枠を食い潰されて1件も分類に回らない(取りこぼし)ため。
function balanceFresh(items, maxTotal) {
  const groups = {};
  for (const it of items) {
    const key = it.type || 'other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(it);
  }
  const keys = Object.keys(groups);
  if (!keys.length) return [];
  const per = Math.max(5, Math.floor(maxTotal / keys.length));
  const out = [];
  const used = {};
  for (const k of keys) {
    for (const it of groups[k].slice(0, per)) {
      out.push(it);
      used[it.url] = true;
    }
  }
  // 枠が余ったら元の順序で補充
  for (const it of items) {
    if (out.length >= maxTotal) break;
    if (!used[it.url]) {
      out.push(it);
      used[it.url] = true;
    }
  }
  return out.slice(0, maxTotal);
}

async function scanRss(env) {
  const heatMin = await getHeatMin(env);
  // 1) 全フィードを取得(失敗したソースはスキップして継続)
  const found = [];
  const feedErrors = [];
  for (const src of RSS_SOURCES) {
    try {
      const res = await fetch(src.url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; trend-neta/1.0)' }
      });
      if (!res.ok) { feedErrors.push(src.name + ':' + res.status); continue; }
      const xml = await res.text();
      const items = parseRssItems(xml).slice(0, RSS_ITEMS_PER_FEED);
      for (const it of items) {
        if (!it.url || !it.title) continue;
        found.push({
          type: src.type, source_name: src.name,
          title: it.title, url: it.url, snippet: it.snippet,
          published_at: (src.tzfix === 'us_pacific') ? fixBingDate(it.published_at) : it.published_at
        });
      }
    } catch (e) {
      feedErrors.push(src.name + ':' + String((e && e.message) || e).slice(0, 40));
    }
  }

  // 1.5) YouTube検索(YT_API_KEY設定時のみ)。動画もニュースと同じ分類フローに合流させる
  const yt = await fetchYoutube(env);
  for (const it of yt.items) found.push(it);
  for (const er of yt.errors) feedErrors.push(er);

  // 1.6) NG登録済みの発信元を除外
  const ngList = await loadNg(env);
  let ngHit = 0;
  const kept = [];
  for (const it of found) {
    if (isNg(ngList, it.source_name)) { ngHit++; continue; }
    kept.push(it);
  }
  found.length = 0;
  for (const it of kept) found.push(it);

  // 1.7) 保持期間より古い記事は入口で捨てる。
  //      RSSは数ヶ月前の記事を突然配信することがある。取り込むと purgeOld で消され、
  //      次の収集でまた入る、を繰り返して重複の温床になる。published_at が無い場合は通す。
  const ytOldCut = Date.now() - YT_DAYS_BACK * 24 * 3600 * 1000;
  const defOldCut = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  let tooOld = 0;
  const inRange = [];
  for (const it of found) {
    const t = it.published_at ? Date.parse(it.published_at) : NaN;
    const cut = (it.type === 'youtube') ? ytOldCut : defOldCut;
    if (!isNaN(t) && t < cut) { tooOld++; continue; }
    inRange.push(it);
  }
  found.length = 0;
  for (const it of inRange) found.push(it);

  if (!found.length) {
    return json({ error: 'RSS収集: 記事を取得できませんでした', feeds: feedErrors }, 502);
  }

  // 2) 既存URLと突合して新規のみ残す(全件チェックしてからソース均等に配分)
  //    1件ずつSELECTすると取得件数ぶんD1を叩くことになる(サブリクエスト予算と速度の両方に効く)。
  //    IN句でまとめて引き、SQLiteの変数上限を避けるため80件ずつに分割する。
  const existing = {};
  const allUrls = found.map(function (it) { return it.url; });
  for (let i = 0; i < allUrls.length; i += 80) {
    const chunk = allUrls.slice(i, i + 80);
    const ph = chunk.map(function () { return '?'; }).join(',');
    const stmt = env.DB.prepare('SELECT url FROM neta WHERE url IN (' + ph + ')');
    const rows = await stmt.bind.apply(stmt, chunk).all();
    for (const r of ((rows && rows.results) || [])) existing[r.url] = true;
  }
  const freshAll = [];
  for (const it of found) {
    if (!existing[it.url]) freshAll.push(it);
  }
  const fresh = balanceFresh(freshAll, RSS_BATCH_MAX);
  if (!fresh.length) {
    return json({ ok: true, added: 0, excluded: 0, dup: 0, tooOld: tooOld, found: found.length, feeds: feedErrors });
  }

  // 2.5) 重複判定の参照用に、既に保存済みの直近タイトルを取得
  // (別フィードが同じ出来事を配信してURL違いで重複するのを防ぐ)
  // 窓が狭いと、少し間隔をあけて再配信された記事を毎回「新規」と誤判定する。
  // 保持期間(RETENTION_DAYS)と同じ窓にする: DBに残っている記事は全てタイトル照合の対象。
  const recentRows = await env.DB.prepare(
    'SELECT title FROM neta WHERE created_at > ? ORDER BY id DESC LIMIT 200'
  ).bind(new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString()).all();
  const recentTitles = ((recentRows && recentRows.results) || []).map(function (r) { return r.title; });

  // 3) Geminiで要約・分類・重複判定。
  //    出力トークン上限を超えるとJSONが途中で切れて分類が全滅するため、
  //    CLASSIFY_CHUNK 件ずつに分けて複数回呼ぶ。
  //    チャンクをまたぐ重複を拾えるよう、前のチャンクで採用したタイトルを次に引き継ぐ。
  const known = recentTitles.slice(0);
  let added = 0;
  let excluded = 0;
  let dup = 0;
  let unjudged = 0; // 分類できず保存を見送った件数(次回の収集で再試行される)
  let lowHeat = 0;  // 熱量が heatMin 未満で捨てた件数
  const cands = []; // 分類を通った登録候補。最後に熱量順で上位 RSS_ADD_MAX 件だけ登録する

  for (let base = 0; base < fresh.length; base += CLASSIFY_CHUNK) {
    const chunk = fresh.slice(base, base + CLASSIFY_CHUNK);
    const lines = [];
    lines.push('あなたは日本の宿泊事業者(民泊・旅館・ホテル)のSNS発信を支えるネタ選別担当です。');
    lines.push('目的は「宿泊事業者がこれを題材に投稿してバズること」です。その観点で各記事を分類してください。');
    lines.push('');
    lines.push('# 残す記事 / 除外する記事');
    lines.push('- 宿泊業・観光の話題は残す。');
    lines.push('- 宿泊業の外の話題でも、事業者として一言語れるものは残す。');
    lines.push('  例: 円安・物価、災害や事件事故、訪日客のマナー問題や炎上、観光地の混雑・オーバーツーリズム、');
    lines.push('      入管や観光政策、治安、旅行者トラブル');
    lines.push('- 事件・トラブル・炎上は重要ネタなので必ず残す(安全対応や近隣説明に直結する)。');
    lines.push('- 一方で次は exclude を true にする: ゲーム実況・プレイ動画、2chまとめ/スカッと系/ゆっくり解説などの');
    lines.push('  まとめコンテンツ、宿泊業と全く接点のない娯楽コンテンツ、宣伝・告知だけの内容。');
    lines.push('- 海外の宿泊施設紹介・海外旅行vlog・外国語のみのコンテンツなど、');
    lines.push('  日本国内の宿泊業と関係のない海外向けコンテンツも exclude を true にする。');
    lines.push('  (日本の宿泊業に影響する海外の動き=訪日客・為替・海外政策の話題は残す)');
    lines.push('');
    lines.push('# カテゴリ定義');
    lines.push('- inbound: インバウンド・訪日客関連(円安や訪日客のマナー問題もここ)');
    lines.push('- knowhow: 民泊/旅館の運営ノウハウ・経営術');
    lines.push('- revenue: 収益・宿泊単価・OTA手数料・消費動向・料金');
    lines.push('- regulation: 規制・条例・制度・税・政策');
    lines.push('- trouble: トラブル・事件・事故・炎上・治安・近隣問題・災害');
    lines.push('- trend: トレンド・新業態・体験・観光地・その他');
    lines.push('');
    lines.push('# 記事リスト');
    chunk.forEach(function (it, i) {
      let s = '[' + i + '] [' + (it.source_name || '') + '] ' + it.title;
      if (it.snippet) s += '\n    概要: ' + String(it.snippet).slice(0, 300);
      lines.push(s);
    });
    lines.push('');
    if (known.length) {
      lines.push('# 既に保存済みの直近記事(重複判定の参照用)');
      known.forEach(function (t) { lines.push('- ' + t); });
      lines.push('');
    }
    lines.push('# 出力形式(最重要)');
    lines.push('JSON配列のみを出力。前置き・説明・コードフェンス禁止。全記事分を idx 順に返す。');
    lines.push('[{"idx":0,"exclude":false,"dup":false,"summary":"内容の1文要約(日本語)","category":"trend","heat":50}]');
    lines.push('- summary: 概要があればそれを踏まえて書く。無ければタイトルから読み取れる範囲で書く。');
    lines.push('- dup: 「既に保存済みの直近記事」と同一の出来事を報じているだけなら true。');
    lines.push('- 記事リスト内で同一の出来事を扱う記事が複数ある場合は、最も情報量が多い(または媒体の信頼性が高い)1件だけを dup:false とし、残りを dup:true にする。同じグループの全記事を dup:true にしてはいけない。');
    lines.push('- 似たテーマでも別の出来事なら dup は false。');
    lines.push('- heat は「この話題を題材にした投稿がバズる見込み」を0〜100の整数で。判断材料は次の3つ:');
    lines.push('  (1)世間の関心・話題性の大きさ (2)驚き・怒り・共感など感情が動くか (3)宿泊事業者として当事者性を持って語れるか');
    lines.push('  事件・炎上・賛否が割れる話題は高くなりやすい。単なる開業/リニューアル/受賞/宣伝の告知は低くする。');

    let judged = [];
    try {
      const raw = await callGemini(env, lines.join('\n'));
      judged = extractJsonArray(raw) || [];
    } catch (e) {
      judged = [];
    }
    const byIdx = {};
    for (const j of judged) {
      if (j && typeof j.idx === 'number') byIdx[j.idx] = j;
    }

    // 4) 保存
    //    分類結果が無い記事は「保存しない」。既定値で入れてしまうと、Geminiが落ちた回に
    //    ゲーム実況・まとめ記事・宣伝までheat40で紛れ込み、URL重複で二度と分類されず居座る。
    //    保存しなければURL未登録のままなので、次回の収集で再度分類にかけられる。
    for (let i = 0; i < chunk.length; i++) {
      const it = chunk[i];
      const j = byIdx[i];
      if (!j) { unjudged++; continue; }
      if (j.exclude === true) { excluded++; continue; }
      if (j.dup === true) { dup++; continue; }
      // 熱量が低すぎる記事は捨てる(プレスリリース・イベント告知の類)
      if (typeof j.heat === 'number' && j.heat < heatMin) { lowHeat++; continue; }
      // ここでは登録せず候補に貯める。全チャンク分類後に熱量順で上位だけ登録する。
      cands.push({
        source: it.type, source_name: it.source_name,
        category: j.category,
        title: it.title,
        summary: j.summary || it.title,
        url: it.url,
        heat: j.heat,
        image: it.image || null,
        published_at: it.published_at || null
      });
      known.push(it.title); // 次チャンクの重複判定に使う
    }
    if (!judged.length) {
      feedErrors.push('Gemini分類失敗: ' + (base + 1) + '〜' + (base + chunk.length) + '件目(次回再試行)');
    }
  }

  // 熱量の高い順に上位 RSS_ADD_MAX 件だけ登録する。
  // 漏れた記事は削除ではなく「今回は見送り」。次の収集でまだ新鮮なら再び候補になる。
  cands.sort(function (a, b) { return (b.heat || 0) - (a.heat || 0); });
  let capSkip = 0;
  for (let ci = 0; ci < cands.length; ci++) {
    if (added >= RSS_ADD_MAX) { capSkip = cands.length - ci; break; }
    const ok = await insertNeta(env, cands[ci]);
    if (ok) added++;
  }

  return json({ ok: true, added: added, capSkip: capSkip, excluded: excluded, dup: dup, unjudged: unjudged, lowHeat: lowHeat, heatMin: heatMin, ng: ngHit, tooOld: tooOld, found: found.length, feeds: feedErrors });
}

// YouTube Data API v3 でキーワード検索。YT_API_KEY未設定なら黙ってスキップ。
// サムネイルは video ID から i.ytimg.com のURLを機械的に構築(APIレスポンス非依存で安定)
async function fetchYoutube(env) {
  const out = [];
  const errors = [];
  if (!env.YT_API_KEY) return { items: out, errors: errors };
  const after = new Date(Date.now() - YT_DAYS_BACK * 24 * 3600 * 1000).toISOString();
  for (const q of YT_QUERIES) {
    try {
      const u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date' +
        '&maxResults=' + YT_RESULTS_PER_QUERY +
        '&relevanceLanguage=ja&regionCode=JP' +
        '&publishedAfter=' + encodeURIComponent(after) +
        '&q=' + encodeURIComponent(q) +
        '&key=' + env.YT_API_KEY;
      const res = await fetch(u);
      if (!res.ok) { errors.push('YouTube(' + q + '):' + res.status); continue; }
      const data = await res.json();
      for (const it of (data.items || [])) {
        const vid = it && it.id && it.id.videoId;
        const sn = it && it.snippet;
        if (!vid || !sn) continue;
        out.push({
          type: 'youtube',
          // チャンネル名を保存(チャンネル単位のNG登録に使う)
          source_name: sn.channelTitle ? String(sn.channelTitle).slice(0, 60) : 'YouTube',
          title: decodeXml(sn.title || ''),
          url: 'https://www.youtube.com/watch?v=' + vid,
          image: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg',
          published_at: sn.publishedAt ? String(sn.publishedAt) : null
        });
      }
    } catch (e) {
      errors.push('YouTube(' + q + '):' + String((e && e.message) || e).slice(0, 40));
    }
  }
  return { items: out, errors: errors };
}

// RSS2.0/Atom の item をざっくり抽出(Worker には DOMParser が無いため正規表現)
function parseRssItems(xml) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const b of blocks) {
    const title = decodeXml(pickTag(b, 'title'));
    let link = decodeXml(pickTag(b, 'link'));
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/);
      if (m) link = decodeXml(m[1]);
    }
    const dateRaw = pickTag(b, 'pubDate') || pickTag(b, 'published') ||
      pickTag(b, 'updated') || pickTag(b, 'dc:date');
    // 本文抜粋(分類・要約・熱量・重複判定の精度が上がる)。HTMLタグは落とす
    const descRaw = pickTag(b, 'description') || pickTag(b, 'summary') ||
      pickTag(b, 'content:encoded');
    const snippet = descRaw ? htmlToText(decodeXml(descRaw)).slice(0, 400) : '';
    out.push({
      title: title, url: normalizeUrl(link), snippet: snippet,
      published_at: toIso(decodeXml(dateRaw))
    });
  }
  return out;
}

// RSSの日付文字列(RFC822/ISO)をISO 8601に正規化。解釈できなければnull。
// タイムゾーン表記が無い日付はJSTのローカル表記とみなす
// (WorkerはUTCで動くため、素通しすると表示が9時間先にズレる)。
// 未来の日付(10分超)はデータ不良として捨て、取得時刻表示にフォールバックさせる
// RSSが返すURLを、記事を一意に識別できる形に整える。
// Bingニュースは同じ記事でも収集のたびに tid= が変わるリダイレクタURLを返すため、
// URL全体をユニークキーにすると同一記事が何度も登録されてしまう。
// 1) Bing の apiclick.aspx なら url= に埋まった本来の記事URLを取り出す
// 2) 追跡用パラメータ(utm_*, fbclid など)を落とす
// 失敗したら元のURLをそのまま返す(取りこぼすより重複するほうがまし)。
function normalizeUrl(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  try {
    let u = new URL(s);
    // 1) Bingのリダイレクタを剥がす
    if (u.hostname.indexOf('bing.com') >= 0 && u.pathname.indexOf('apiclick') >= 0) {
      const inner = u.searchParams.get('url');
      if (inner) {
        u = new URL(inner);
      }
    }
    // 2) 追跡パラメータを除去
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'ref', 'ref_src', 'spm', 'cmpid', 'yclid'];
    for (const k of drop) u.searchParams.delete(k);
    // 3) X投稿は https://x.com/ユーザー/status/ID が正準形。
    //    共有時に付く ?s=20&t=... はすべて落とし、twitter.com は x.com に統一する
    //    (同じ投稿がパラメータ違い・ドメイン違いで重複するのを防ぐ)。
    if (u.hostname === 'twitter.com' || u.hostname === 'www.twitter.com' ||
        u.hostname === 'x.com' || u.hostname === 'www.x.com') {
      if (u.pathname.indexOf('/status/') >= 0) {
        return 'https://x.com' + u.pathname.replace(/\/+$/, '');
      }
    }
    // 4) MSN は同じ記事を別カテゴリのパスで配信する
    //    (/ja-jp/news/other/... と /ja-jp/society.../social-issues/... など)。
    //    末尾の記事ID(ar-XXXXXXXX)だけが記事を一意に決めるので、それをキーにする。
    if (u.hostname.indexOf('msn.com') >= 0) {
      const seg = u.pathname.split('/');
      const last = seg[seg.length - 1] || '';
      if (last.indexOf('ar-') === 0) {
        return 'https://www.msn.com/article/' + last;
      }
    }
    // 5) 末尾スラッシュとフラグメントを揃える
    u.hash = '';
    let out = u.toString();
    if (out.length > 1 && out.charAt(out.length - 1) === '/') out = out.slice(0, -1);
    return out;
  } catch (e) {
    return s;
  }
}

function toIso(s) {
  if (!s) return null;
  const t = String(s).trim();
  let d = new Date(t);
  if (isNaN(d.getTime())) return null;
  const hasTz = /(GMT|UTC|Z|[ECMP][SD]T|[+-]\d{4}|[+-]\d{2}:\d{2})\s*$/i.test(t);
  if (!hasTz) d = new Date(d.getTime() - 9 * 3600 * 1000);
  if (d.getTime() > Date.now() + 10 * 60 * 1000) return null;
  return d.toISOString();
}

// ---- BingニュースRSSの時刻補正 ----
// BingのpubDateは "GMT" 表記だが、実際は米国太平洋時間の壁時計が入っている
// (実測: 実際10:21 JSTの記事がカードで03:21 JST = ちょうどPDTの7時間ズレ)。
// 夏時間(PDT)なら+7時間、冬時間(PST)なら+8時間して本当のUTCに直す
function fixBingDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const offset = isUsDstWall(d) ? 7 : 8;
  const fixed = new Date(d.getTime() + offset * 3600 * 1000);
  if (fixed.getTime() > Date.now() + 10 * 60 * 1000) return null;
  return fixed.toISOString();
}

// 壁時計時刻(UTC扱いのDate)が米国夏時間の期間内か
// (3月第2日曜 2:00 〜 11月第1日曜 2:00、2007年以降のルール)
function isUsDstWall(d) {
  const y = d.getUTCFullYear();
  const start = nthSundayUtc(y, 2, 2, 2);
  const end = nthSundayUtc(y, 10, 1, 2);
  return d >= start && d < end;
}

function nthSundayUtc(year, month, nth, hour) {
  const first = new Date(Date.UTC(year, month, 1));
  const date = 1 + ((7 - first.getUTCDay()) % 7) + (nth - 1) * 7;
  return new Date(Date.UTC(year, month, date, hour));
}

// 補正実装前に保存されたBing行の投稿日時を一度だけ直す(実行済みフラグをapp_metaに記録)。
// 新規挿入分と競合しないよう /scan/all の収集開始前に同期実行する
async function fixOldBingDates(env) {
  const done = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'bing_date_fix'").first();
  if (done && done.value === '1') return;
  const rows = await env.DB.prepare(
    "SELECT id, published_at FROM neta WHERE source_name LIKE 'Bing%' AND published_at IS NOT NULL"
  ).all();
  for (const r of ((rows && rows.results) || [])) {
    const fixed = fixBingDate(r.published_at);
    await env.DB.prepare('UPDATE neta SET published_at = ? WHERE id = ?').bind(fixed, r.id).run();
  }
  await env.DB.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('bing_date_fix', '1')").run();
}

function pickTag(block, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function decodeXml(s) {
  let t = String(s || '');
  const cd = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cd) t = cd[1];
  return t
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .trim();
}

// ---------------- Gemini (番頭のフォールバック方式を踏襲) ----------------

async function callGemini(env, prompt, jsonMode) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です(RSS収集・要約に必要)');
  const useJson = (jsonMode !== false);
  let lastStatus = 0;
  let lastBody = '';
  for (let mi = 0; mi < GEMINI_MODELS.length; mi++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODELS[mi] +
      ':generateContent?key=' + env.GEMINI_API_KEY;
    const cfg = {
      temperature: 0.3,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    };
    if (useJson) cfg.responseMimeType = 'application/json';
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
    const parts = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts || []).map(function (p) { return p.text || ''; }).join('');
    if (!text) throw new Error('Geminiの応答が空でした');
    return text;
  }
  throw new Error('Gemini 混雑/エラー(' + lastStatus + ')。詳細: ' + lastBody.slice(0, 200));
}

// ---------------- JSON抽出 (コードフェンス・前置き対策) ----------------

function extractJsonArray(raw) {
  let t = String(raw || '').trim();
  const FENCE = String.fromCharCode(96, 96, 96);
  if (t.indexOf(FENCE) >= 0) {
    t = t.split('\n').filter(function (l) { return l.indexOf(FENCE) !== 0; }).join('\n').trim();
  }
  const s = t.indexOf('[');
  const e = t.lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  try {
    const arr = JSON.parse(t.slice(s, e + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (err) {
    return null;
  }
}

// ---------------- アプリアイコン ----------------
// ホーム画面用アイコン(藍地に情報の弧＋朱の発信点)。単一ファイル構成を保つため埋め込み。
// iOSのapple-touch-iconはPNGのみ有効なため、PNGをbase64で保持する。
const ICON_PNG_B64 = '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';

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">' +
  '<rect width="180" height="180" fill="#2b4c7e"/>' +
  '<g fill="none" stroke="#f7f6f2" stroke-width="10" stroke-linecap="round">' +
  '<path d="M84 124 A26 26 0 0 0 58 98"/>' +
  '<path d="M106 124 A48 48 0 0 0 58 76"/>' +
  '<path d="M128 124 A70 70 0 0 0 58 54"/>' +
  '</g><circle cx="58" cy="124" r="8" fill="#cf4527"/></svg>';

// 管理ページ用アイコン(黒基調)。本体(藍)と役割を色で区別する
const ICON_ADMIN_PNG_B64 = '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';

function iconPng(admin) {
  const bin = atob(admin ? ICON_ADMIN_PNG_B64 : ICON_PNG_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400'
    }
  });
}

// ---------------- UI ----------------
// 注意: このテンプレートリテラル内ではバッククォートとドル波括弧を使わないこと

const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>民泊ネタ帳</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="民泊ネタ帳">
<meta name="theme-color" content="#f7f6f2">
<link rel="apple-touch-icon" href="data:image/png;base64,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">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root{
  --bg:#f7f6f2; --ink:#26262b; --sub:#8b8a94; --line:#e5e3dc; --accent:#2b4c7e;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
body{margin:0 auto;background:var(--bg);color:var(--ink);
  font-family:-apple-system,"Hiragino Sans",sans-serif;
  max-width:720px;
  padding:calc(env(safe-area-inset-top) + 18px) 14px 132px;}

/* 画面が広いとき(PC・タブレット横向き)。
   body は中央寄せになるので、画面端に固定していたボタンを
   コンテンツの幅に合わせて内側へ寄せる。
   720/2 = 360px がコンテンツの端。そこから 16px 内側に置く。
   PCは視距離が遠いぶん、文字とボタンをひと回り大きくする(約15%増)。 */
@media (min-width: 760px){
  /* 固定ボタンの位置をコンテンツ幅に追従させる */
  .jumpFab{left:calc(50% - 344px);width:48px;height:48px;border-radius:24px;}
  .favFab{right:calc(50% - 344px);width:54px;height:54px;border-radius:27px;}
  .fabIc{width:23px;height:23px;}
  .favFab .fabIc{width:26px;height:26px;}

  /* カード本文 */
  .title{font-size:16px;}
  .sum{font-size:14.5px;}
  .link{font-size:13.5px;}
  .meta{font-size:11.5px;}
  .detail{font-size:14px;}

  /* カード内のボタン(要約・切り口・使った) */
  .mini{font-size:12.5px;padding:7px 14px;border-radius:10px;}
  .useIc{width:15px;height:15px;}

  /* カード上部のラベル・熱量・★ */
  .badge{font-size:11px;padding:3px 9px;}
  .cat{font-size:11px;padding:2px 8px;}
  .heat{font-size:12.5px;}
  .favBtn{font-size:20px;}
  .ngChip{font-size:11px;}

  /* 絞り込み */
  .chip{font-size:13px;padding:8px 12px;}
  .srcBtn .lb{font-size:11px;}
  .srcIc{width:24px;height:24px;}
  .rowLabel{font-size:10px;}

  /* ヘッダー行・並び替え・選択 */
  #sortBtn{font-size:12.5px;padding:6px 15px;}
  #selBtn{font-size:12.5px;padding:6px 15px;}
  #stats{font-size:12px;}
  .lastScan{font-size:12px;}
  #ngLink{font-size:12px;}

  /* おすすめ・週次まとめ */
  .recoItem{font-size:14px;}
  #weekHead{font-size:14px;}
  #weekBody{font-size:14px;}
  .searchBox{font-size:14px;}

  /* さらに読み込む */
  #moreBtn{font-size:13.5px;padding:13px 0;}

  /* ゴミ箱・お気に入りのページ送り */
  #favSortBtn,#trashSortBtn{font-size:12.5px;padding:6px 15px;}
  #favStats,#trashStats{font-size:12px;}
  .pager button{font-size:13.5px;padding:9px 18px;}
  #favPageNum,#trashPageNum{font-size:13.5px;}
}
/* 引っ張って更新 */
#ptr{position:fixed;left:0;right:0;top:calc(env(safe-area-inset-top) + 10px);
  height:34px;display:flex;align-items:center;justify-content:center;
  pointer-events:none;opacity:0;z-index:60;
  transform:translateY(-52px);}
#ptrIc{width:28px;height:28px;display:block;
  filter:drop-shadow(0 1px 3px rgba(60,60,80,.16));
  transform-origin:50% 50%;}
h1{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;
  font-size:22px;letter-spacing:.12em;margin:0 0 2px;}
.sub{color:var(--sub);font-size:12px;margin:0 0 14px;letter-spacing:.05em;line-height:1.6;}
.lastScanRow{display:flex;align-items:center;margin:0 0 12px;}
.lastScan{color:var(--sub);font-size:11px;letter-spacing:.03em;margin:0;}
#trashLink{margin-left:auto;background:#fff;border:1px solid var(--line);border-radius:12px;
  width:34px;height:28px;color:#6f6d79;display:flex;align-items:center;justify-content:center;padding:0;}
#trashLink .fabIc{width:16px;height:16px;}
#ngLink{margin-left:6px;background:#fff;border:1px solid var(--line);border-radius:12px;
  padding:6px 12px;font-size:10.5px;color:var(--sub);white-space:nowrap;}
.ngRow{background:#fff;border:1px solid var(--line);border-radius:12px;
  padding:12px 14px;margin:0 0 8px;display:flex;align-items:center;gap:10px;}
.ngRow .nm{font-size:13.5px;font-weight:700;min-width:0;word-break:break-all;}
.ngRow button{margin-left:auto;background:var(--accent);border:none;border-radius:10px;
  padding:8px 14px;font-size:11.5px;color:#fff;font-weight:600;white-space:nowrap;}
.searchRow{display:flex;gap:8px;margin:0 0 12px;}
.searchRow .searchBox{flex:1;margin:0;}
#qBtn{width:46px;background:#fff;border:1px solid var(--line);border-radius:14px;font-size:16px;color:var(--sub);}
#filtBtn{width:46px;background:#fff;border:1px solid var(--line);border-radius:14px;color:var(--sub);
  display:flex;align-items:center;justify-content:center;}
#filtBtn svg{display:block;}
/* フィルター適用中はくすんだ朱で点灯。藍(選択)と区別し「絞り込み中」を一目で伝える */
#filtBtn.filtOn{background:#b5492e;border-color:#b5492e;color:#fff;}
#filtBtn.filtOn svg circle{fill:#b5492e;}
#filtPanel{background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:12px 14px 6px;margin:0 0 12px;}
#fheatChips,#fdaysChips{display:flex;flex-wrap:wrap;gap:7px;padding:0 0 10px;}
/* パネル内: 実際に絞る値(fval)の選択時だけ朱。「指定なし/すべて」の選択は通常の藍 */
#filtPanel .chip.fval.on{background:#b5492e;border-color:#b5492e;}
.rowLabel{font-size:10px;color:var(--sub);letter-spacing:.12em;margin:0 0 5px;}
#srcChips{display:flex;gap:7px;padding:0 0 12px;}
.srcBtn{flex:1;min-width:0;background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:10px 0 8px;display:flex;flex-direction:column;align-items:center;gap:4px;
  color:var(--sub);box-shadow:0 1px 4px rgba(60,60,80,.05);}
.srcBtn .ic{height:22px;display:flex;align-items:center;justify-content:center;}
.srcIc{width:22px;height:22px;border-radius:5px;display:block;object-fit:contain;}
.srcBtn .lb{font-size:9.5px;letter-spacing:.02em;}
.srcBtn.on{background:#eef2f8;border-color:var(--accent);color:var(--accent);
  box-shadow:inset 0 0 0 1px var(--accent);}
/* 6つのチップが1行に収まるサイズ。未選択は少し小さく、選択中だけ大きくする。
   nowrapにすると小さい端末で見切れるため、折り返しは残す(最悪でも2行目に落ちるだけ) */
.chips{display:flex;flex-wrap:wrap;gap:5px;padding:0 0 10px;align-items:center;}
.chip{white-space:nowrap;background:#fff;border:1px solid var(--line);border-radius:16px;
  padding:7px 8px;font-size:11.5px;color:var(--sub);
  transition:font-size .12s, padding .12s;}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff;
  padding:8px 12px;font-size:13px;font-weight:700;}
#statsRow{display:flex;align-items:center;margin:0 0 10px;}
#stats{font-size:11px;color:var(--sub);}
/* 並び替えは3択(新着→古い→熱量)。今どれかが一目で分かるよう色を変える */
#sortBtn{margin-left:auto;background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:5px 13px;font-size:11px;color:var(--sub);font-weight:600;}
#sortBtn.s-date{border-color:var(--accent);color:var(--accent);background:#eef2f8;}
#sortBtn.s-old{border-color:#b8b6c0;color:#6f6d79;background:#f1f0eb;}
#sortBtn.s-heat{border-color:#cf4527;color:#cf4527;background:#fbeee8;}

/* お気に入りページ: 並び替え + ページ送り */
#favStatsRow,#trashStatsRow{display:flex;align-items:center;margin:0 0 10px;}
#favStats,#trashStats{font-size:11px;color:var(--sub);}
#favSortBtn,#trashSortBtn{margin-left:auto;background:#fff;border:1px solid var(--line);
  border-radius:14px;padding:5px 13px;font-size:11px;color:var(--sub);font-weight:600;}
#favSortBtn.s-date,#trashSortBtn.s-date{border-color:var(--accent);color:var(--accent);background:#eef2f8;}
#favSortBtn.s-old,#trashSortBtn.s-old{border-color:#b8b6c0;color:#6f6d79;background:#f1f0eb;}
#favSortBtn.s-heat,#trashSortBtn.s-heat{border-color:#cf4527;color:#cf4527;background:#fbeee8;}
#favQBtn,#trashQBtn{width:46px;background:#fff;border:1px solid var(--line);
  border-radius:14px;font-size:16px;color:var(--sub);}
.pager{display:flex;align-items:center;justify-content:center;gap:14px;
  margin:16px 0 4px;}
.pager button{background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:8px 16px;font-size:12px;color:var(--accent);font-weight:600;}
.pager button:disabled{color:#c9c7d0;border-color:var(--line);background:#f7f6f2;}
.pager button:active:not(:disabled){background:#eef2f8;}
#favPageNum,#trashPageNum{font-size:12px;color:var(--sub);font-weight:600;
  min-width:56px;text-align:center;}
.detail{background:#f3f2ec;border-radius:10px;padding:10px 12px;
  font-size:12.5px;line-height:1.7;color:#4a4a52;margin:2px 0 8px;}
.card{background:#fff;border-radius:14px;padding:13px 14px;margin:0 0 10px;
  box-shadow:0 2px 10px rgba(60,60,80,.06);}
.cardHead{display:flex;align-items:center;gap:7px;margin:0 0 6px;}
.badge{font-size:10px;font-weight:700;color:#fff;border-radius:5px;padding:2px 7px;letter-spacing:.05em;}
.badge.x{background:#1d1d21;}
.badge.news{background:#2b4c7e;}
.badge.note{background:#2cb696;}
.badge.youtube{background:#c0392b;}
.badge.gov{background:#6b5b95;}
.cat{font-size:10px;color:var(--sub);border:1px solid var(--line);border-radius:5px;padding:1px 6px;}
.heat{margin-left:auto;font-size:11px;font-weight:700;color:#b8b6c0;}
.heat.hot{color:#cf4527;}
.favBtn{background:none;border:none;font-size:17px;line-height:1;padding:0 0 0 6px;color:#d4d2dc;}
.favBtn.on{color:#e6a23c;}
.thumb{width:100%;max-height:170px;object-fit:cover;border-radius:10px;margin:2px 0 8px;display:block;}
.title{font-weight:700;font-size:14px;line-height:1.45;margin:0 0 4px;}
.sum{font-size:13px;line-height:1.6;color:#4a4a52;margin:0 0 8px;}
.cardFoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.link{font-size:12px;color:var(--accent);text-decoration:none;}
.meta{font-size:10px;color:var(--sub);}
.act{margin-left:auto;display:flex;gap:6px;}
.mini{background:#fff;border:1px solid var(--line);border-radius:9px;
  padding:5px 11px;font-size:11px;color:var(--sub);}
/* 「使った」は行き先(ゴミ箱)が分かるようアイコンを添える */
.mini.useBtn{display:inline-flex;align-items:center;gap:4px;padding:5px 9px;}
.useIc{width:13px;height:13px;display:block;flex-shrink:0;}
/* リンク切れ(元記事が404)のカード。中身が読めないので全体を沈め、削除を促す */
.card.dead{opacity:.62;}
.card.dead .title{text-decoration:line-through;text-decoration-color:#c9c7bf;}
.mini.deadBtn{color:#cf4527;border-color:#cf4527;}
/* font-sizeは16px必須。16px未満だとiOSが入力時に画面を自動ズームし、元に戻らなくなる */
.searchBox{width:100%;background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:9px 14px;font-size:16px;color:var(--ink);margin:0 0 10px;-webkit-appearance:none;}
#recoBox{background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:12px 14px;margin:0 0 12px;}
.recoHead{display:flex;align-items:center;font-size:12px;font-weight:700;color:var(--accent);letter-spacing:.08em;margin:0 0 8px;}
#recoRe,#weekRe{margin-left:auto;background:#fff;border:1px solid var(--line);border-radius:9px;
  padding:3px 10px;font-size:10px;font-weight:400;color:var(--sub);}
#weekBox{background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:12px 14px;margin:0 0 12px;}
#weekHead{cursor:pointer;}
#weekTgl{margin-left:6px;font-size:9px;color:var(--sub);}
#weekBody{font-size:12.5px;line-height:1.8;color:#4a4a52;white-space:pre-wrap;margin:4px 0 0;}
/* フローティングボタンは全て線画SVG(1.8px・丸端・currentColorで色を継承) */
.jumpFab{position:fixed;left:16px;width:42px;height:42px;border-radius:21px;background:#fff;
  border:1px solid var(--line);box-shadow:0 3px 14px rgba(60,60,80,.18);
  z-index:5;color:#6f6d79;display:flex;align-items:center;justify-content:center;padding:0;}
.jumpFab:active{background:#f1f0eb;}
#jumpTop{bottom:calc(env(safe-area-inset-bottom) + 66px);}
#jumpBottom{bottom:calc(env(safe-area-inset-bottom) + 16px);}
.fabIc{width:20px;height:20px;display:block;}
.recoItem{font-size:12.5px;line-height:1.6;margin:0 0 7px;}
.recoTitle{font-weight:700;}
.recoReason{color:var(--sub);}
.usedTag{font-size:10px;color:#fff;background:#b8b6c0;border-radius:5px;padding:2px 7px;}
.card.usedCard{background:#f1f0eb;}
.usedCard .cardHead,.usedCard .thumb,.usedCard .title,.usedCard .sum{opacity:.5;}
.card.sel{outline:2px solid var(--accent);}
.card.flash{outline:2px solid #cf4527;}
.mini.strong{background:var(--accent);border-color:var(--accent);color:#fff;}
.mini.sumBtn{border-color:#2b4c7e;color:#2b4c7e;}
.mini.angBtn{border-color:#a2572b;color:#a2572b;}
.ngChip{display:inline-flex;align-items:center;gap:3px;background:#fff;
  border:1px solid #d8d6de;border-radius:5px;padding:2px 6px;margin-left:2px;
  font-size:10px;font-weight:700;color:#a09eaa;letter-spacing:.04em;}
.ngChip:active{background:#f1f0eb;}
.closeIc{width:10px;height:10px;display:block;flex-shrink:0;}
.ngPanel{background:#f3f2ec;border-radius:10px;padding:10px 12px;margin:2px 0 8px;}
.ngPanel .t{font-size:11px;color:var(--sub);line-height:1.6;margin:0 0 8px;}
.ngPanel .r{display:flex;gap:6px;margin:0 0 6px;}
.ngPanel button{background:#fff;border:1px solid var(--line);border-radius:8px;
  padding:9px 16px;font-size:12px;color:var(--sub);white-space:nowrap;}
.ngPanel button.go{background:#cf4527;border-color:#cf4527;color:#fff;font-weight:600;}
.detail.sumBox{background:#eef2f8;}
.detail.sumBox:before{content:'要約';display:block;font-size:10px;font-weight:700;color:#2b4c7e;letter-spacing:.1em;margin:0 0 3px;}
.detail.angBox{background:#f7efe7;}
.detail.angBox:before{content:'切り口';display:block;font-size:10px;font-weight:700;color:#a2572b;letter-spacing:.1em;margin:0 0 3px;}
#selBtn{background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:5px 13px;font-size:11px;color:var(--sub);margin-left:8px;}
#selBtn.on{background:var(--accent);border-color:var(--accent);color:#fff;}
.selBar{position:fixed;left:14px;right:14px;bottom:calc(env(safe-area-inset-bottom) + 14px);
  background:#26262b;color:#fff;border-radius:16px;padding:12px 16px;
  display:none;align-items:center;gap:10px;z-index:6;box-shadow:0 4px 18px rgba(0,0,0,.25);}
.selBar span{font-size:12px;}
.selBar button{border:none;border-radius:10px;padding:8px 14px;font-size:12px;font-weight:600;}
#selUse{background:#cf4527;color:#fff;margin-left:auto;
  display:inline-flex;align-items:center;gap:5px;}
#selCancel{background:rgba(255,255,255,.15);color:#fff;}
#moreBtn{display:none;width:100%;background:#fff;border:1px solid var(--line);border-radius:14px;
  padding:11px 0;font-size:13px;color:var(--accent);margin:2px 0 10px;}
.emptyMsg{color:var(--sub);font-size:13px;text-align:center;padding:36px 0;}
.favFab{position:fixed;right:16px;bottom:calc(env(safe-area-inset-bottom) + 16px);
  width:48px;height:48px;border-radius:24px;background:#fff;border:1px solid var(--line);
  box-shadow:0 3px 14px rgba(60,60,80,.18);z-index:5;color:#e6a23c;
  display:flex;align-items:center;justify-content:center;padding:0;}
.favFab:active{background:#f1f0eb;}
.favFab .fabIc{width:22px;height:22px;}
.pageHead{display:flex;align-items:center;gap:10px;margin:0 0 6px;}
.backBtn{background:#fff;border:1px solid var(--line);border-radius:12px;
  padding:8px 14px;font-size:13px;color:var(--sub);}
.pageTitle{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;
  font-size:19px;letter-spacing:.12em;font-weight:700;}
</style>
</head>
<body>

<div id="ptr"><svg id="ptrIc" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="9" fill="none" stroke="#e5e3dc" stroke-width="2.5"/>
  <path id="ptrArc" d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#2b4c7e"
    stroke-width="2.5" stroke-linecap="round"/>
</svg></div>

<div id="mainView">
  <div class="lastScanRow">
    <p class="lastScan" id="lastScan">最終収集: 確認中…</p>
    <button id="trashLink" aria-label="ゴミ箱"></button>
    <button id="ngLink">NG設定</button>
  </div>

  <div id="recoBox">
    <div class="recoHead">今日のおすすめ<button id="recoRe">再生成</button></div>
    <div id="recoList"></div>
  </div>

  <div id="weekBox">
    <div class="recoHead" id="weekHead">今週の業界まとめ<span id="weekTgl">&#9660;</span><button id="weekRe">更新</button></div>
    <div id="weekBody" style="display:none"></div>
  </div>

  <div class="searchRow">
    <input class="searchBox" id="qBox" type="search" placeholder="ネタを検索">
    <button id="qBtn">&#128269;</button>
    <button id="filtBtn" aria-label="表示フィルター">
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
        <path d="M3 5.5h14"></path><circle cx="7" cy="5.5" r="1.9" fill="#fff"></circle>
        <path d="M3 10h14"></path><circle cx="12.5" cy="10" r="1.9" fill="#fff"></circle>
        <path d="M3 14.5h14"></path><circle cx="8.5" cy="14.5" r="1.9" fill="#fff"></circle>
      </svg>
    </button>
  </div>

  <div id="filtPanel" style="display:none">
    <div class="rowLabel">&#128293; 熱量</div>
    <div id="fheatChips"></div>
    <div class="rowLabel">期間</div>
    <div id="fdaysChips"></div>
  </div>

  <div class="rowLabel">ソース</div>
  <div id="srcChips"></div>
  <div class="rowLabel">カテゴリ</div>
  <div class="chips" id="chips"></div>
  <div id="statsRow">
    <span id="stats"></span>
    <button id="sortBtn">並び: 新着順</button>
    <button id="selBtn">選択</button>
  </div>
  <div id="list"></div>
  <button id="moreBtn">さらに読み込む</button>
  <div id="empty" class="emptyMsg" style="display:none">まだネタがありません。3時間毎の自動収集をお待ちください。</div>
</div>

<div id="trashView" style="display:none">
  <div class="pageHead">
    <button class="backBtn" id="backBtn">&#8592; 戻る</button>
    <span class="pageTitle">ゴミ箱</span>
  </div>
  <p class="sub">使ったネタ。ニュース・X・noteは14日、YouTubeは30日で自動的に消えます(★付きは残ります)。日付は記事の投稿日が基準です。</p>
  <div class="searchRow">
    <input id="trashQ" class="searchBox" type="search" placeholder="ゴミ箱を検索" autocomplete="off">
    <button id="trashQBtn">&#128269;</button>
  </div>
  <div id="trashStatsRow">
    <span id="trashStats"></span>
    <button id="trashSortBtn" class="s-date">並び: 新着順</button>
  </div>
  <div id="trashList"></div>
  <div id="trashEmpty" class="emptyMsg" style="display:none">ゴミ箱は空です。</div>
  <div class="pager" id="trashPager" style="display:none">
    <button id="trashPrev">&#8592; 前</button>
    <span id="trashPageNum">1 / 1</span>
    <button id="trashNext">次 &#8594;</button>
  </div>
</div>

<div id="ngView" style="display:none">
  <div class="pageHead">
    <button class="backBtn" id="ngBackBtn">&#8592; 戻る</button>
    <span class="pageTitle">NG設定</span>
  </div>
  <p class="sub">表示しないようにしたYouTubeチャンネルです。解除すると、隠れていた動画が元の場所(新着・ゴミ箱・★)にそのまま戻ります。</p>
  <div id="ngList"></div>
  <div id="ngEmpty" class="emptyMsg" style="display:none">NGに登録したチャンネルはありません。<br>YouTubeカードの「NG」ボタンから登録できます。</div>
</div>

<div id="favView" style="display:none">
  <div class="pageHead">
    <button class="backBtn" id="favBackBtn">&#8592; 戻る</button>
    <span class="pageTitle">★お気に入り</span>
  </div>
  <p class="sub">★を付けたネタ。自動削除の対象外で、使っても消えません(使用済はグレー表示)。</p>
  <div class="searchRow">
    <input id="favQ" class="searchBox" type="search" placeholder="お気に入りを検索" autocomplete="off">
    <button id="favQBtn">&#128269;</button>
  </div>
  <div id="favStatsRow">
    <span id="favStats"></span>
    <button id="favSortBtn" class="s-date">並び: 新着順</button>
  </div>
  <div id="favList"></div>
  <div id="favEmpty" class="emptyMsg" style="display:none">お気に入りはまだありません。</div>
  <div class="pager" id="favPager" style="display:none">
    <button id="favPrev">&#8592; 前</button>
    <span id="favPageNum">1 / 1</span>
    <button id="favNext">次 &#8594;</button>
  </div>
</div>

<div class="selBar" id="selBar">
  <span id="selCount">0件選択</span>
  <button id="selCancel">キャンセル</button>
  <button id="selUse">使った</button>
</div>

<button class="favFab" id="favFab" aria-label="お気に入り"></button>
<button class="jumpFab" id="jumpTop" aria-label="一番上へ"></button>
<button class="jumpFab" id="jumpBottom" aria-label="一番下へ"></button>

<script>
// フィルタのチップ(運営と収益は「経営」に統合。1行に収まる短いラベルにする)
var CATS = [
  { key:'',                  label:'すべて' },
  { key:'inbound',           label:'インバウンド' },
  { key:'knowhow,revenue',   label:'経営' },
  { key:'regulation',        label:'規制' },
  { key:'trouble',           label:'事件' },
  { key:'trend',             label:'話題' }
];
// カードのバッジは元の細かい分類のまま表示する
var CAT_LABEL = {
  inbound:'インバウンド', knowhow:'運営', revenue:'収益',
  regulation:'規制・制度', trouble:'トラブル', trend:'トレンド'
};

// ソースアイコン: X/YouTube/noteは公式favicon(Googleのfaviconサービス経由で実物を参照)、
// ブランドの無い「全ソース」「ニュース」は藍の線画SVG(currentColorで選択色に追従)
var SVG_ALL = '<svg viewBox="0 0 24 24" width="22" height="22"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
  '<rect x="3.2" y="3.2" width="7.2" height="7.2" rx="2"></rect>' +
  '<rect x="13.6" y="3.2" width="7.2" height="7.2" rx="2"></rect>' +
  '<rect x="3.2" y="13.6" width="7.2" height="7.2" rx="2"></rect>' +
  '<rect x="13.6" y="13.6" width="7.2" height="7.2" rx="2"></rect></g></svg>';
var SVG_NEWS = '<svg viewBox="0 0 24 24" width="22" height="22"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
  '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect>' +
  '<path d="M7 9h10M7 12.5h10M7 16h6"></path></g></svg>';

var SRCS = [
  { key:'',        label:'全ソース', svg: SVG_ALL },
  { key:'x',       label:'X',       img:'https://www.google.com/s2/favicons?domain=x.com&sz=64' },
  { key:'news',    label:'ニュース', svg: SVG_NEWS },
  { key:'youtube', label:'YouTube', img:'https://www.google.com/s2/favicons?domain=youtube.com&sz=64' },
  { key:'note',    label:'note',    img:'https://www.google.com/s2/favicons?domain=note.com&sz=64' }
];

var curView = 'main';
var curCat = '';
var curSrc = '';
var curSort = 'date'; // date=新着順 / old=古い順 / heat=熱量順
var curQ = '';
// 表示フィルター(チューンアイコンから設定)。0=無効
var curFHeat = 0;
var curFDays = 0;
var curOffset = 0;
var lastMore = false;
var curItems = [];
var curTotal = 0;   // 絞り込み後の総件数(初回ロードで取得)
var selMode = false;
var selIds = {};
var qTimer = null;
var recoGen = '';
var recoTimer = null;

function byId(id){ return document.getElementById(id); }

// フローティングボタンのアイコン(線画SVG。currentColorでボタン側の色を継承する)
var FAB_ICONS = {
  favFab: '<svg class="fabIc" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 3.6l2.42 4.9 5.41.79-3.92 3.82.93 5.39L12 15.95l-4.84 2.55.93-5.39L4.17 9.29l5.41-.79z"/></svg>',
  trashLink: '<svg class="fabIc" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 6.5h16"/><path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/>' +
    '<path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/>' +
    '<path d="M10.3 10.5v6M13.7 10.5v6"/></svg>',
  jumpTop: '<svg class="fabIc" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 19V6"/><path d="M6.5 11.5L12 6l5.5 5.5"/></svg>',
  jumpBottom: '<svg class="fabIc" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 5v13"/><path d="M6.5 12.5L12 18l5.5-5.5"/></svg>'
};
for(var fk in FAB_ICONS){ byId(fk).innerHTML = FAB_ICONS[fk]; }

// 「使った」ボタンに添える小さなゴミ箱(行き先を示す。フローティングボタンと同じ意匠)
var TRASH_MINI_SVG = '<svg class="useIc" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 6.5h16"/><path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/>' +
  '<path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/></svg>';
byId('selUse').innerHTML = '使った' + TRASH_MINI_SVG;

// エラー表示。fetchの失敗(Load failed 等)は原因が伝わらないため、対処を促す文言に置き換える
function friendlyError(e){
  var m = (e && e.message) ? String(e.message) : '';
  if(/load failed|failed to fetch|network|timeout|timed out|aborted/i.test(m)){
    return '処理に時間がかかりすぎたか、通信が不安定なようです。' +
      '少し時間をおいて、もう一度お試しください。';
  }
  return m ? ('エラーが発生しました: ' + m) : 'エラーが発生しました。もう一度お試しください。';
}

// NGチップに添える✕
var CLOSE_MINI_SVG = '<svg class="closeIc" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M6 6l12 12M18 6L6 18"/></svg>';

// 認証: 通常はCookieで通るが、Cookieが使えない環境のために
// 起動URLに ?token= があれば全リクエストへ引き継ぐ
var TOKEN = new URLSearchParams(location.search).get('token') || '';
function tfetch(path, opts){
  var u = path;
  if(TOKEN){
    u += (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  }
  return fetch(u, opts);
}

function feedQuery(withTotal){
  var q = '/feed?status=new' + (curSrc ? '&source=' + curSrc : '');
  q += (curCat ? '&category=' + curCat : '') +
    (curSort !== 'date' ? '&sort=' + curSort : '') +
    (curQ ? '&q=' + encodeURIComponent(curQ) : '') +
    (curFHeat ? '&fheat=' + curFHeat : '') +
    (curFDays ? '&fdays=' + curFDays : '') +
    (curOffset ? '&offset=' + curOffset : '');
  // 総件数は初回ロード時だけ取る(追加読み込みのたびに COUNT すると無駄)
  if(withTotal) q += '&total=1';
  return q;
}

function resetSel(){
  selMode = false;
  selIds = {};
  byId('selBtn').className = '';
  byId('selBar').style.display = 'none';
  byId('jumpTop').style.display = '';
  byId('jumpBottom').style.display = '';
  // メイン表示中のみ右下のフローティングボタンを出す
  if(curView === 'main'){
    byId('favFab').style.display = '';
  }
}

function render(){
  var list = byId('list');
  list.innerHTML = '';
  curItems.forEach(function(it){ list.appendChild(card(it, 'main')); });
  byId('empty').style.display = curItems.length ? 'none' : '';
  byId('stats').textContent = curTotal ? (curTotal + '件') : '';
  byId('moreBtn').style.display = lastMore ? 'block' : 'none';
}

function buildChips(){
  var box = byId('chips');
  box.innerHTML = '';
  CATS.forEach(function(c){
    var b = document.createElement('button');
    b.className = 'chip' + (curCat===c.key ? ' on' : '');
    b.textContent = c.label;
    b.onclick = function(){ curCat = c.key; buildChips(); load(); };
    box.appendChild(b);
  });
  var sbox = byId('srcChips');
  sbox.innerHTML = '';
  SRCS.forEach(function(s){
    var b = document.createElement('button');
    b.className = 'srcBtn' + (curSrc===s.key ? ' on' : '');
    var ic = document.createElement('div');
    ic.className = 'ic';
    if(s.img){
      var im = document.createElement('img');
      im.className = 'srcIc';
      im.src = s.img;
      im.alt = s.label;
      im.onerror = function(){
        // ロゴ取得失敗時は頭文字で代替
        ic.removeChild(im);
        ic.textContent = s.label.charAt(0);
        ic.style.fontSize = '15px';
        ic.style.fontWeight = '700';
      };
      ic.appendChild(im);
    } else {
      ic.innerHTML = s.svg;
    }
    var lb = document.createElement('div');
    lb.className = 'lb';
    lb.textContent = s.label;
    b.appendChild(ic);
    b.appendChild(lb);
    b.onclick = function(){
      curSrc = s.key;
      curCat = ''; // カテゴリ絞り込みが残ったままだと「新着なし」に見えるためリセット
      buildChips();
      load();
    };
    sbox.appendChild(b);
  });
}

function fmtDate(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  var j = new Date(d.getTime() + 9*3600*1000);
  function p(n){ return ('0'+n).slice(-2); }
  return (j.getUTCMonth()+1) + '/' + j.getUTCDate() + ' ' + p(j.getUTCHours()) + ':' + p(j.getUTCMinutes());
}

function badgeClass(src){
  if(src==='x'||src==='news'||src==='note'||src==='youtube'||src==='gov') return src;
  return 'news';
}
function badgeLabel(src, name){
  if(src==='x') return 'X';
  if(src==='note') return 'note';
  if(src==='youtube') return 'YouTube';
  return name || 'ニュース';
}

function load(done){
  curOffset = 0;
  resetSel();
  tfetch(feedQuery(true)).then(function(r){ return r.json(); }).then(function(data){
    if(data.error){
      curItems = [];
      lastMore = false;
      curTotal = 0;
      render();
      byId('stats').textContent = '読み込みエラー: ' + data.error + ' (/init を開くと直る場合があります)';
      if(done) done();
      return;
    }
    curItems = data.items || [];
    lastMore = !!data.more;
    curTotal = data.total || curItems.length;
    render();
    if(done) done();
  }).catch(function(e){
    byId('stats').textContent = '読み込みエラー: ' + e.message;
    if(done) done();
  });
}

function loadMore(done){
  curOffset += 100; // サーバ側 FEED_LIMIT と合わせる
  byId('moreBtn').disabled = true;
  tfetch(feedQuery()).then(function(r){ return r.json(); }).then(function(data){
    byId('moreBtn').disabled = false;
    if(data.error){ alert('エラー: ' + data.error); if(done) done(); return; }
    curItems = curItems.concat(data.items || []);
    lastMore = !!data.more;
    render();
    if(done) done();
  }).catch(function(e){
    byId('moreBtn').disabled = false;
    alert(friendlyError(e));
    if(done) done();
  });
}

// ---- ゴミ箱 / お気に入り ----
// 一覧(無限スクロール)と違い、100件ごとのページ送りにする。
// 溜まり続けるので、何ページ目を見ているかが分かる方が探しやすい。
// 2ビューは構造が同じなので、状態と描画をまとめて扱う。
var subViews = {
  trash: { sort:'date', page:0, total:0, q:'',
           list:'trashList', empty:'trashEmpty', stats:'trashStats',
           sortBtn:'trashSortBtn', pager:'trashPager', pageNum:'trashPageNum',
           prev:'trashPrev', next:'trashNext', qBox:'trashQ',
           emptyMsg:'ゴミ箱は空です。', mode:'trash' },
  fav:   { sort:'date', page:0, total:0, q:'',
           list:'favList', empty:'favEmpty', stats:'favStats',
           sortBtn:'favSortBtn', pager:'favPager', pageNum:'favPageNum',
           prev:'favPrev', next:'favNext', qBox:'favQ',
           emptyMsg:'お気に入りはまだありません。', mode:'fav' }
};

function subQuery(name){
  var v = subViews[name];
  var q = (name === 'fav') ? '/feed?fav=1' : '/feed?status=used';
  q += '&total=1';
  if(v.sort !== 'date') q += '&sort=' + v.sort;
  if(v.q) q += '&q=' + encodeURIComponent(v.q);
  if(v.page) q += '&offset=' + (v.page * 100);
  return q;
}

function loadSub(name){
  var v = subViews[name];
  tfetch(subQuery(name)).then(function(r){ return r.json(); }).then(function(data){
    if(data.error){
      byId(v.list).innerHTML = '';
      byId(v.pager).style.display = 'none';
      byId(v.stats).textContent = '';
      byId(v.empty).style.display = '';
      byId(v.empty).textContent = '読み込みエラー: ' + data.error;
      return;
    }
    var items = data.items || [];
    v.total = data.total || 0;
    // 削除や★解除で今のページが空になったら前のページへ戻す
    if(!items.length && v.page > 0){
      v.page--;
      loadSub(name);
      return;
    }
    var list = byId(v.list);
    list.innerHTML = '';
    byId(v.empty).textContent = v.q ? '該当するネタはありません。' : v.emptyMsg;
    byId(v.empty).style.display = items.length ? 'none' : '';
    items.forEach(function(it){
      list.appendChild(card(it, v.mode));
    });
    renderSubPager(name);
    window.scrollTo(0, 0);
  }).catch(function(e){
    byId(v.pager).style.display = 'none';
    byId(v.empty).style.display = '';
    byId(v.empty).textContent = '読み込みエラー: ' + e.message;
  });
}

function renderSubPager(name){
  var v = subViews[name];
  var pages = Math.max(1, Math.ceil(v.total / 100));
  byId(v.stats).textContent = v.total ? (v.total + '件') : '';
  byId(v.pager).style.display = (pages > 1) ? 'flex' : 'none';
  byId(v.pageNum).textContent = (v.page + 1) + ' / ' + pages;
  byId(v.prev).disabled = (v.page <= 0);
  byId(v.next).disabled = (v.page >= pages - 1);
}

function applySubSort(name){
  var v = subViews[name];
  var s = SORTS.filter(function(x){ return x.key === v.sort; })[0] || SORTS[0];
  var b = byId(v.sortBtn);
  b.textContent = '並び: ' + s.label;
  b.className = s.cls;
}

// 2ビュー分のボタンをまとめて配線する
['trash','fav'].forEach(function(name){
  var v = subViews[name];
  byId(v.prev).onclick = function(){
    if(v.page <= 0) return;
    v.page--;
    loadSub(name);
  };
  byId(v.next).onclick = function(){
    var pages = Math.max(1, Math.ceil(v.total / 100));
    if(v.page >= pages - 1) return;
    v.page++;
    loadSub(name);
  };
  byId(v.sortBtn).onclick = function(){
    var i = 0;
    for(var n = 0; n < SORTS.length; n++){ if(SORTS[n].key === v.sort) i = n; }
    v.sort = SORTS[(i + 1) % SORTS.length].key;
    v.page = 0;   // 並びを変えたら1ページ目へ
    applySubSort(name);
    loadSub(name);
  };
  var doSearch = function(){
    v.q = byId(v.qBox).value.trim().slice(0, 60);
    v.page = 0;
    loadSub(name);
  };
  byId(v.qBox + 'Btn').onclick = doSearch;
  byId(v.qBox).onkeydown = function(e){
    if(e.key === 'Enter'){ e.preventDefault(); doSearch(); }
  };
  byId(v.qBox).onsearch = doSearch;   // ×で消したときも反映
});

// 既存の呼び出し名を保つための薄いラッパ
function loadTrash(){ loadSub('trash'); }
function loadFav(){ loadSub('fav'); }

function card(it, mode){
  var c = document.createElement('div');
  var isUsedFav = (mode === 'fav' && it.status === 'used');
  if(mode === 'main') c.id = 'neta-' + it.id;
  var base = 'card' + (isUsedFav ? ' usedCard' : '');
  c.className = base + (selMode && selIds[it.id] ? ' sel' : '');

  var head = document.createElement('div');
  head.className = 'cardHead';
  var bd = document.createElement('span');
  bd.className = 'badge ' + badgeClass(it.source);
  bd.textContent = badgeLabel(it.source, it.source_name);
  head.appendChild(bd);
  if(it.category && CAT_LABEL[it.category]){
    var ct = document.createElement('span');
    ct.className = 'cat';
    ct.textContent = CAT_LABEL[it.category];
    head.appendChild(ct);
  }
  if(isUsedFav){
    var ut = document.createElement('span');
    ut.className = 'usedTag';
    ut.textContent = '使用済';
    head.appendChild(ut);
  }
  var chName = it.source_name || '';
  var canNg = (it.source === 'youtube' && chName && chName !== 'YouTube');

  var ht = document.createElement('span');
  ht.className = 'heat' + (it.heat >= 70 ? ' hot' : '');
  ht.textContent = '🔥' + (it.heat==null ? '-' : it.heat);
  head.appendChild(ht);

  // NGボタン(YouTubeのみ)。カテゴリの隣に置くとタグに見えるため、熱量の右に置く
  if(canNg && mode !== 'trash' && !selMode){
    var ngBtn = document.createElement('button');
    ngBtn.className = 'ngChip';
    ngBtn.innerHTML = 'NG' + CLOSE_MINI_SVG;
    ngBtn.onclick = function(){
      var show = ngBox.style.display === 'none';
      ngBox.style.display = show ? '' : 'none';
    };
    head.appendChild(ngBtn);
  }
  if((mode === 'main' || mode === 'fav') && !selMode){
    var fb = document.createElement('button');
    fb.className = 'favBtn' + (it.fav ? ' on' : '');
    fb.textContent = '★';
    fb.onclick = function(){
      var nv = it.fav ? 0 : 1;
      tfetch('/fav', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ id: it.id, fav: nv })
      }).then(function(r){ return r.json(); }).then(function(d){
        if(d.error){ alert('エラー: ' + d.error); return; }
        it.fav = nv;
        fb.className = 'favBtn' + (nv ? ' on' : '');
        if(!nv && mode === 'fav'){
          // ★を外すと一覧から消える。DOMを直接いじると件数とページャが
          // 古いまま残るので、読み込み直して全部を再計算させる。
          loadSub('fav');
        }
      }).catch(function(e){ alert(friendlyError(e)); });
    };
    head.appendChild(fb);
  }
  c.appendChild(head);

  if(it.image){
    var img = document.createElement('img');
    img.className = 'thumb';
    img.src = it.image;
    img.loading = 'lazy';
    img.onerror = function(){ img.style.display = 'none'; };
    c.appendChild(img);
  }

  if(it.title){
    var t = document.createElement('div');
    t.className = 'title';
    t.textContent = it.title;
    c.appendChild(t);
  }
  var s = document.createElement('div');
  s.className = 'sum';
  s.textContent = it.summary || '';
  c.appendChild(s);

  // 選択モード: カード全体のタップで選択切替(ボタン類は出さない)
  if(mode === 'main' && selMode){
    var mf = document.createElement('div');
    mf.className = 'cardFoot';
    var mm = document.createElement('span');
    mm.className = 'meta';
    mm.textContent = fmtDate(it.published_at || it.created_at);
    mf.appendChild(mm);
    c.appendChild(mf);
    c.onclick = function(){
      if(selIds[it.id]){
        delete selIds[it.id];
        c.className = base;
      } else {
        selIds[it.id] = 1;
        c.className = base + ' sel';
      }
      byId('selCount').textContent = Object.keys(selIds).length + '件選択';
    };
    return c;
  }

  var detBox = document.createElement('div');
  detBox.className = 'detail sumBox';
  detBox.style.display = 'none';
  if(it.detail){ detBox.textContent = it.detail; }
  c.appendChild(detBox);

  var angBox = document.createElement('div');
  angBox.className = 'detail angBox';
  angBox.style.display = 'none';
  if(it.angle){ angBox.textContent = it.angle; }
  c.appendChild(angBox);

  // NGパネル: YouTubeのチャンネル単位でのみ登録できる。
  // ニュース/note/Xは媒体やドメインで切ると有用な記事まで巻き添えになるため対象外。
  // (単発の不要な記事は「使った」でゴミ箱へ送れば新着から消え、再収集もされない)
  var ngBox = document.createElement('div');
  ngBox.className = 'ngPanel';
  ngBox.style.display = 'none';
  if(canNg){
    var ngT = document.createElement('div');
    ngT.className = 't';
    ngT.textContent = 'チャンネル「' + chName + '」の動画を今後表示しません。既存分も隠れます(「NG設定」から解除すれば全て元に戻ります)。';
    ngBox.appendChild(ngT);
    var r1 = document.createElement('div');
    r1.className = 'r';
    var b1 = document.createElement('button');
    b1.className = 'go';
    b1.textContent = '表示しない';
    var b0 = document.createElement('button');
    b0.textContent = 'やめる';
    b0.onclick = function(){ ngBox.style.display = 'none'; };
    b1.onclick = function(){
      b1.disabled = true;
      b1.textContent = '登録中…';
      tfetch('/ng/add', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ value: chName })
      }).then(function(r){ return r.json(); }).then(function(d){
        if(d.error){
          alert('エラー: ' + d.error);
          b1.disabled = false;
          b1.textContent = '表示しない';
          return;
        }
        if(mode === 'fav'){ loadFav(); } else { load(); }
      }).catch(function(e){
        alert(friendlyError(e));
        b1.disabled = false;
        b1.textContent = '表示しない';
      });
    };
    r1.appendChild(b1);
    r1.appendChild(b0);
    ngBox.appendChild(r1);
    c.appendChild(ngBox);
  }

  var foot = document.createElement('div');
  foot.className = 'cardFoot';
  if(it.url){
    var a = document.createElement('a');
    a.className = 'link';
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '元記事を見る';
    foot.appendChild(a);
  }
  var m = document.createElement('span');
  m.className = 'meta';
  m.textContent = fmtDate(it.published_at || it.created_at);
  foot.appendChild(m);

  var act = document.createElement('span');
  act.className = 'act';
  if(it.url){
    var sumBtn = document.createElement('button');
    sumBtn.className = 'mini sumBtn';
    sumBtn.textContent = it.detail ? '要約を見る' : '要約';
    sumBtn.onclick = function(){
      if(detBox.textContent){
        var show = detBox.style.display === 'none';
        detBox.style.display = show ? '' : 'none';
        sumBtn.textContent = show ? '要約を隠す' : '要約を見る';
        return;
      }
      sumBtn.disabled = true;
      sumBtn.textContent = '要約中…';
      tfetch('/summarize', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ id: it.id })
      }).then(function(r){ return r.json(); }).then(function(d){
        sumBtn.disabled = false;
        if(d.error){
          if(d.dead){ it.dead = 1; markCardDead(c, it, sumBtn); return; }
          sumBtn.textContent = '要約';
          alert('要約を作れませんでした: ' + d.error);
          return;
        }
        it.detail = d.detail;
        detBox.textContent = d.detail;
        detBox.style.display = '';
        sumBtn.textContent = '要約を隠す';
      }).catch(function(e){
        sumBtn.disabled = false;
        sumBtn.textContent = '要約';
        alert(friendlyError(e));
      });
    };
    act.appendChild(sumBtn);
  }
  if(mode === 'main' || mode === 'fav'){
    var angBtn = document.createElement('button');
    angBtn.className = 'mini angBtn';
    angBtn.textContent = it.angle ? '切り口を見る' : '切り口';
    angBtn.onclick = function(){
      if(angBox.textContent){
        var show2 = angBox.style.display === 'none';
        angBox.style.display = show2 ? '' : 'none';
        angBtn.textContent = show2 ? '切り口を隠す' : '切り口を見る';
        return;
      }
      angBtn.disabled = true;
      angBtn.textContent = '生成中…';
      tfetch('/angle', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ id: it.id })
      }).then(function(r){ return r.json(); }).then(function(d){
        angBtn.disabled = false;
        if(d.error){ angBtn.textContent = '切り口'; alert('切り口を作れませんでした: ' + d.error); return; }
        it.angle = d.angle;
        angBox.textContent = d.angle;
        angBox.style.display = '';
        angBtn.textContent = '切り口を隠す';
      }).catch(function(e){
        angBtn.disabled = false;
        angBtn.textContent = '切り口';
        alert(friendlyError(e));
      });
    };
    act.appendChild(angBtn);
  }
  if(mode === 'trash'){
    var backB = document.createElement('button');
    backB.className = 'mini';
    backB.textContent = '戻す';
    // 件数とページャを正しく再計算させるため読み込み直す
    backB.onclick = function(){ post('/restore', it.id, c, function(){ loadSub('trash'); }); };
    act.appendChild(backB);
  }
  if(mode === 'fav'){
    if(it.status === 'used'){
      var rb = document.createElement('button');
      rb.className = 'mini strong';
      rb.textContent = '戻す';
      rb.onclick = function(){ post('/restore', it.id, c, function(){ loadSub('fav'); }); };
      act.appendChild(rb);
    } else {
      var ub = document.createElement('button');
      ub.className = 'mini useBtn';
      ub.innerHTML = '使った' + TRASH_MINI_SVG;
      ub.onclick = function(){ post('/use', it.id, c, function(){ loadSub('fav'); }); };
      act.appendChild(ub);
    }
  } else if(mode === 'main'){
    var useBtn = document.createElement('button');
    useBtn.className = 'mini useBtn';
    useBtn.innerHTML = '使った' + TRASH_MINI_SVG;
    // 一覧は無限スクロールなので読み込み直すとスクロール位置が飛ぶ。
    // カードはDOMから外し、総件数の表示だけ手で減らす。
    useBtn.onclick = function(){
      post('/use', it.id, c, function(){
        if(c.parentNode) c.parentNode.removeChild(c);
        if(curTotal > 0) curTotal--;
        byId('stats').textContent = curTotal ? (curTotal + '件') : '';
      });
    };
    act.appendChild(useBtn);
  }
  foot.appendChild(act);
  c.appendChild(foot);
  // 前回のセッション等で既にリンク切れと分かっている場合は、最初から削除状態で出す。
  // (main/favビューのみ。ゴミ箱では対象外)
  if(it.dead && (mode === 'main' || mode === 'fav') && typeof sumBtn !== 'undefined'){
    markCardDead(c, it, sumBtn);
  }
  return c;
}

function post(path, id, cardEl, done){
  tfetch(path, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: id })
  }).then(function(r){ return r.json(); }).then(function(d){
    if(d.error){ alert('エラー: ' + d.error); return; }
    if(done){ done(); return; }
    if(cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
  }).catch(function(e){ alert(friendlyError(e)); });
}

// リンク切れ(元記事404/410)と判明したカードの見た目を落とし、
// 要約ボタンを「リンク切れ・削除」ボタンに差し替える。押すとゴミ箱へ送りDOMから外す。
// mainビューでのみ総件数を手で減らす(無限スクロールのスクロール位置維持のため)。
function markCardDead(c, it, sumBtn){
  c.className += ' dead';
  if(sumBtn && sumBtn.parentNode){
    var del = document.createElement('button');
    del.className = 'mini deadBtn';
    del.textContent = 'リンク切れ・削除';
    del.onclick = function(){
      post('/use', it.id, c, function(){
        if(c.parentNode) c.parentNode.removeChild(c);
        if(typeof curTotal === 'number' && curTotal > 0){
          curTotal--;
          byId('stats').textContent = curTotal ? (curTotal + '件') : '';
        }
      });
    };
    sumBtn.parentNode.replaceChild(del, sumBtn);
  }
}

function showView(name){
  curView = name;
  byId('mainView').style.display = (name === 'main') ? '' : 'none';
  byId('trashView').style.display = (name === 'trash') ? '' : 'none';
  byId('favView').style.display = (name === 'fav') ? '' : 'none';
  byId('ngView').style.display = (name === 'ng') ? '' : 'none';
  byId('favFab').style.display = (name === 'main') ? '' : 'none';
  window.scrollTo(0, 0);
}
function showTrash(){
  resetSel();
  showView('trash');
  resetSub('trash');
  loadTrash();
}
function showFav(){
  resetSel();
  showView('fav');
  resetSub('fav');
  loadFav();
}

// 開くたびに1ページ目・検索なしの状態から始める
function resetSub(name){
  var v = subViews[name];
  v.page = 0;
  v.q = '';
  byId(v.qBox).value = '';
}
function showMain(){
  showView('main');
  load();
}
function showNgPage(){
  resetSel();
  showView('ng');
  loadNgPage();
}

function loadNgPage(){
  tfetch('/ng').then(function(r){ return r.json(); }).then(function(d){
    var list = byId('ngList');
    list.innerHTML = '';
    var items = (d && d.items) || [];
    byId('ngEmpty').style.display = items.length ? 'none' : '';
    items.forEach(function(it){
      var row = document.createElement('div');
      row.className = 'ngRow';
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.value;
      var b = document.createElement('button');
      b.textContent = '解除';
      b.onclick = function(){
        if(!confirm('「' + it.value + '」の非表示を解除しますか？隠れていたネタが元に戻ります。')) return;
        b.disabled = true;
        tfetch('/ng/delete', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ id: it.id })
        }).then(function(r){ return r.json(); }).then(function(d2){
          if(d2.error){ alert('エラー: ' + d2.error); b.disabled = false; return; }
          alert(d2.restored + '件を元に戻しました');
          loadNgPage();
        }).catch(function(e){ alert(friendlyError(e)); b.disabled = false; });
      };
      row.appendChild(nm);
      row.appendChild(b);
      list.appendChild(row);
    });
  }).catch(function(e){
    byId('ngEmpty').style.display = '';
    byId('ngEmpty').textContent = '読み込みエラー: ' + e.message;
  });
}

byId('trashLink').onclick = showTrash;
byId('favFab').onclick = showFav;
byId('ngLink').onclick = showNgPage;
byId('backBtn').onclick = showMain;
byId('favBackBtn').onclick = showMain;
byId('ngBackBtn').onclick = showMain;

// ---- 今日のおすすめ ----
// おすすめ→該当カードへジャンプ。表示中に無ければフィルタ・検索・並び順を初期化して探す
function jumpToCard(id){
  var el = document.getElementById('neta-' + id);
  if(el){ flashCard(el); return; }
  curCat = ''; curSrc = ''; curQ = ''; curSort = 'date';
  curFHeat = 0; curFDays = 0;
  byId('qBox').value = '';
  applySort();
  buildChips();
  buildFiltChips();
  load(function(){
    var el2 = document.getElementById('neta-' + id);
    if(el2){ flashCard(el2); }
    else { alert('この記事は新着一覧に見つかりませんでした(使用済みの可能性があります)'); }
  });
}

function flashCard(el){
  el.scrollIntoView();
  var base = el.className;
  el.className = base + ' flash';
  setTimeout(function(){ el.className = base; }, 1600);
}

function renderReco(d){
  var box = byId('recoList');
  box.innerHTML = '';
  if(!d || !d.items || !d.items.length){
    var ph = document.createElement('div');
    ph.className = 'recoReason';
    ph.textContent = 'まだ生成されていません。収集後に自動生成されます(再生成でも作れます)。';
    box.appendChild(ph);
    return;
  }
  recoGen = d.generated_at || '';
  d.items.forEach(function(it){
    var row = document.createElement('div');
    row.className = 'recoItem';
    var t = document.createElement('span');
    t.className = 'recoTitle';
    t.textContent = it.title;
    var rs = document.createElement('span');
    rs.className = 'recoReason';
    rs.textContent = ' — ' + (it.reason || '');
    row.appendChild(t);
    row.appendChild(rs);
    row.onclick = function(){ jumpToCard(it.id); };
    box.appendChild(row);
  });
}

function loadReco(){
  tfetch('/reco').then(function(r){ return r.json(); }).then(function(d){
    renderReco(d);
    if(d && d.last_scan){
      byId('lastScan').textContent = '最終収集: ' + fmtDate(d.last_scan) + ' (3時間毎に自動収集)';
    } else {
      byId('lastScan').textContent = '最終収集: まだ実行されていません (3時間毎に自動収集)';
    }
  }).catch(function(){});
}


// ---- 今週の業界まとめ(折りたたみ) ----
var weekOpen = false;

function renderWeekly(d){
  var b = byId('weekBody');
  b.innerHTML = '';
  if(d && d.text){
    var tx = document.createElement('div');
    tx.textContent = d.text;
    b.appendChild(tx);
    var mt = document.createElement('div');
    mt.className = 'recoReason';
    mt.textContent = '生成: ' + fmtDate(d.generated_at);
    b.appendChild(mt);
  } else {
    var ph = document.createElement('div');
    ph.className = 'recoReason';
    ph.textContent = 'まだ生成されていません。毎週月曜の朝に自動生成されます(更新でも作れます)。';
    b.appendChild(ph);
  }
}

function loadWeekly(){
  tfetch('/weekly').then(function(r){ return r.json(); }).then(function(d){
    renderWeekly(d);
  }).catch(function(){});
}

byId('weekHead').onclick = function(e){
  if(e && e.target && e.target.id === 'weekRe') return;
  weekOpen = !weekOpen;
  byId('weekBody').style.display = weekOpen ? '' : 'none';
  byId('weekTgl').textContent = weekOpen ? '▲' : '▼';
};

byId('weekRe').onclick = function(){
  var b = byId('weekRe');
  b.disabled = true;
  b.textContent = '生成中…';
  tfetch('/weekly/generate', { method:'POST' }).then(function(r){ return r.json(); }).then(function(d){
    b.disabled = false;
    b.textContent = '更新';
    renderWeekly(d);
    weekOpen = true;
    byId('weekBody').style.display = '';
    byId('weekTgl').textContent = '▲';
    if(!(d && d.text)){
      var reason = (d && d.make && d.make.reason) ? d.make.reason : '生成できませんでした';
      alert('週次まとめ: ' + reason);
    }
  }).catch(function(e){
    b.disabled = false;
    b.textContent = '更新';
    alert(friendlyError(e));
  });
};

// ---- 検索 ----
// 検索は「全体から探す」意思表示なので、ソース・カテゴリの絞り込みは解除する
// (絞り込みが残ったままだと、ヒットしているのに0件に見えて誤解を生む)
function runSearch(){
  var v = byId('qBox').value.trim();
  if(v && (curSrc || curCat)){
    curSrc = '';
    curCat = '';
    buildChips();
  }
  curQ = v;
  load();
}
byId('qBox').oninput = function(){
  if(qTimer) clearTimeout(qTimer);
  qTimer = setTimeout(runSearch, 400);
};
// 表示フィルター(チューンアイコン)。収集は広く拾い、見る時だけ任意で絞る。
// 条件が効いている間はアイコンを点灯させ、外し忘れに気付けるようにする。
var FHEATS = [
  { v: 0, label: '指定なし' }, { v: 50, label: '50以上' }, { v: 60, label: '60以上' },
  { v: 70, label: '70以上' }, { v: 80, label: '80以上' }
];
var FDAYS = [
  { v: 0, label: 'すべて' }, { v: 1, label: '今日' }, { v: 3, label: '3日以内' }, { v: 7, label: '7日以内' }
];
function buildFiltChips(){
  var hb = byId('fheatChips');
  hb.innerHTML = '';
  FHEATS.forEach(function(f){
    var b = document.createElement('button');
    // fval = 実際に絞る値。選択中の朱色はこれにだけ付け、「指定なし」は通常の藍にする
    b.className = 'chip' + (curFHeat===f.v ? ' on' : '') + (f.v ? ' fval' : '');
    b.textContent = f.label;
    b.onclick = function(){ curFHeat = f.v; buildFiltChips(); load(); };
    hb.appendChild(b);
  });
  var db = byId('fdaysChips');
  db.innerHTML = '';
  FDAYS.forEach(function(f){
    var b = document.createElement('button');
    b.className = 'chip' + (curFDays===f.v ? ' on' : '') + (f.v ? ' fval' : '');
    b.textContent = f.label;
    b.onclick = function(){ curFDays = f.v; buildFiltChips(); load(); };
    db.appendChild(b);
  });
  var fb = byId('filtBtn');
  fb.className = (curFHeat || curFDays) ? 'filtOn' : '';
}
byId('filtBtn').onclick = function(){
  var p = byId('filtPanel');
  p.style.display = (p.style.display === 'none') ? '' : 'none';
};

byId('qBtn').onclick = function(){
  if(qTimer) clearTimeout(qTimer);
  runSearch();
};

// ---- さらに読み込む ----
byId('moreBtn').onclick = loadMore;

// ---- おすすめ再生成(手動) ----
byId('recoRe').onclick = function(){
  var b = byId('recoRe');
  b.disabled = true;
  b.textContent = '生成中…';
  tfetch('/reco/generate', { method:'POST' }).then(function(r){ return r.json(); }).then(function(d){
    b.disabled = false;
    b.textContent = '再生成';
    renderReco(d);
    if(!(d && d.items && d.items.length)){
      var reason = (d && d.make && d.make.reason) ? d.make.reason : '生成できませんでした';
      alert('おすすめ: ' + reason);
    }
  }).catch(function(e){
    b.disabled = false;
    b.textContent = '再生成';
    alert(friendlyError(e));
  });
};

// ---- 一番上/一番下ジャンプ ----
byId('jumpTop').onclick = function(){ window.scrollTo(0, 0); };
byId('jumpBottom').onclick = function(){ window.scrollTo(0, document.body.scrollHeight); };

// ---- 複数選択→一括「使った」 ----
byId('selBtn').onclick = function(){
  if(selMode){
    resetSel();
    render();
    return;
  }
  selMode = true;
  selIds = {};
  byId('selBtn').className = 'on';
  byId('selBar').style.display = 'flex';
  byId('favFab').style.display = 'none';
  byId('jumpTop').style.display = 'none';
  byId('jumpBottom').style.display = 'none';
  byId('selCount').textContent = '0件選択';
  render();
};
byId('selCancel').onclick = function(){
  resetSel();
  render();
};
byId('selUse').onclick = function(){
  var ids = [];
  for(var k in selIds){ ids.push(parseInt(k, 10)); }
  if(!ids.length){ alert('カードをタップして選択してください'); return; }
  byId('selUse').disabled = true;
  tfetch('/use', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ ids: ids })
  }).then(function(r){ return r.json(); }).then(function(d){
    byId('selUse').disabled = false;
    if(d.error){ alert('エラー: ' + d.error); return; }
    resetSel();
    load();
  }).catch(function(e){
    byId('selUse').disabled = false;
    alert(friendlyError(e));
  });
};

// 並び替え: 新着順 → 古い順 → 熱量順 → 新着順… の循環。色でも現在の並びを示す
var SORTS = [
  { key:'date', label:'新着順', cls:'s-date' },
  { key:'old',  label:'古い順', cls:'s-old' },
  { key:'heat', label:'熱量順', cls:'s-heat' }
];
function applySort(){
  var s = SORTS.filter(function(x){ return x.key === curSort; })[0] || SORTS[0];
  var b = byId('sortBtn');
  b.textContent = '並び: ' + s.label;
  b.className = s.cls;
}
byId('sortBtn').onclick = function(){
  var i = 0;
  for(var n = 0; n < SORTS.length; n++){ if(SORTS[n].key === curSort) i = n; }
  curSort = SORTS[(i + 1) % SORTS.length].key;
  applySort();
  load();
};

applySort();
applySubSort('trash');
applySubSort('fav');
buildChips();
buildFiltChips();
load();
loadReco();
loadWeekly();

// ---- 無限スクロール ----
// 一覧の末尾に近づいたら自動で次の100件を読む。
// loadingMore で多重発火を防ぐ。lastMore が false なら何もしない。
var loadingMore = false;
function maybeLoadMore(){
  if(loadingMore) return;
  if(!lastMore) return;
  // 一覧タブ以外(ゴミ箱/お気に入り)を開いている間は動かさない。
  // moreBtn の display は CSS 既定が none のため判定に使わない(状態変数で見る)。
  if(byId('mainView').style.display === 'none') return;
  var scrolled = window.innerHeight + window.pageYOffset;
  var total = document.body.scrollHeight;
  if(scrolled < total - 600) return;   // 末尾600px手前で発火
  loadingMore = true;
  loadMore(function(){ loadingMore = false; });
}
window.addEventListener('scroll', maybeLoadMore, { passive: true });

// ---- 復帰時の自動更新 ----
// PWAをホーム画面から開き直さなくても、タブに戻った時点で最新にする。
// 直前の更新から60秒以内なら何もしない(連打・タブ切替の連続で無駄に叩かない)。
var lastLoadAt = Date.now();
function refreshIfStale(){
  if(document.visibilityState !== 'visible') return;
  if(Date.now() - lastLoadAt < 60 * 1000) return;
  lastLoadAt = Date.now();
  load();
  loadReco();
  loadWeekly();
}
document.addEventListener('visibilitychange', refreshIfStale);
window.addEventListener('pageshow', refreshIfStale);

// ---- 引っ張って更新 (Pull to Refresh) ----
// 画面最上部で下に引くと、指の移動量に応じてスピナーが降りてくる。
// THRESH を超えて指を離すと更新。PWAには標準の pull-to-refresh が無いため自前で用意する。
// 回転は CSS animation ではなくタイマーで回す(iOS PWA では animation が効かない場合がある)。
var PTR_THRESH = 70;     // これ以上引いたら更新
var PTR_MAX = 130;       // 見た目上の最大引き量(この位置でスピナーが止まる)
var PTR_MIN_MS = 700;     // 更新が速くてもこの時間はスピナーを回す
var ptrStartY = 0;
var ptrDist = 0;          // 現在の引き量(px)
var ptrPulling = false;
var ptrBusy = false;
var ptrTimer = null;      // 回転タイマー
var ptrAngle = 0;
var ptrArmed = false;     // 閾値を超えた瞬間に一度だけバイブさせるため

// 端末を短く振動させる。非対応端末では何も起きない。
function buzz(ms){
  try {
    if(navigator.vibrate) navigator.vibrate(ms);
  } catch(e){}
}

function ptrRotate(deg){
  byId('ptrIc').style.transform = 'rotate(' + deg + 'deg)';
}

function ptrSpinStart(){
  ptrStopSpin();
  ptrTimer = setInterval(function(){
    ptrAngle = (ptrAngle + 12) % 360;
    ptrRotate(ptrAngle);
  }, 16);
}

function ptrStopSpin(){
  if(ptrTimer){ clearInterval(ptrTimer); ptrTimer = null; }
}

function ptrSet(d){
  ptrDist = Math.min(Math.max(d, 0), PTR_MAX);
  var el = byId('ptr');
  el.style.transition = '';
  el.style.opacity = String(Math.min(ptrDist / PTR_THRESH, 1));
  el.style.transform = 'translateY(' + (ptrDist - 52) + 'px)';
  ptrRotate((ptrDist / PTR_THRESH) * 270);
  // 「離せば更新」に達した瞬間だけ、軽く一度振動させる
  if(!ptrArmed && ptrDist >= PTR_THRESH){
    ptrArmed = true;
    buzz(10);
  } else if(ptrArmed && ptrDist < PTR_THRESH){
    ptrArmed = false;
  }
}

function ptrReset(){
  ptrStopSpin();
  ptrDist = 0;
  ptrAngle = 0;
  ptrArmed = false;
  var el = byId('ptr');
  el.style.transition = 'opacity .25s, transform .25s';
  el.style.opacity = '0';
  el.style.transform = 'translateY(-52px)';
  ptrRotate(0);
}

function ptrAtTop(){
  // iOS はバウンス中に負の値になることがあるので <= 0 で判定する
  var y = window.pageYOffset || document.documentElement.scrollTop || 0;
  return y <= 0;
}

document.addEventListener('touchstart', function(e){
  if(ptrBusy) return;
  if(byId('mainView').style.display === 'none') return;
  if(!ptrAtTop()) return;
  ptrStartY = e.touches[0].clientY;
  ptrPulling = true;
  ptrDist = 0;
  ptrArmed = false;
}, { passive: true });

document.addEventListener('touchmove', function(e){
  if(!ptrPulling || ptrBusy) return;
  var dy = e.touches[0].clientY - ptrStartY;
  if(dy <= 0){
    // 上方向に動いたら通常スクロールに戻す
    if(ptrDist > 0) ptrReset();
    ptrPulling = false;
    return;
  }
  ptrSet(dy * 0.5);
}, { passive: true });

document.addEventListener('touchend', function(){
  if(!ptrPulling || ptrBusy){ ptrPulling = false; return; }
  ptrPulling = false;
  if(ptrDist < PTR_THRESH){ ptrReset(); return; }
  // 更新開始
  ptrBusy = true;
  var el = byId('ptr');
  el.style.transition = 'transform .2s';
  el.style.transform = 'translateY(' + (PTR_MAX - 52) + 'px)';
  el.style.opacity = '1';
  ptrSpinStart();
  lastLoadAt = Date.now();
  // 通信が速いとスピナーが一瞬で消えて「更新された」と分からないため、
  // 最低 PTR_MIN_MS は回し続ける。
  var startedAt = Date.now();
  loadReco();
  loadWeekly();
  load(function(){
    var wait = Math.max(0, PTR_MIN_MS - (Date.now() - startedAt));
    setTimeout(function(){
      ptrBusy = false;
      ptrReset();
      buzz(18);   // 更新完了
    }, wait);
  });
});
</script>
</body>
</html>`;

// ---------------- 管理ページ (/admin) ----------------
// 注意: このテンプレートリテラル内でもバッククォート・ドル波括弧・バックスラッシュ禁止

const ADMIN_PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>民泊ネタ帳 管理</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="民泊ネタ帳 管理">
<meta name="theme-color" content="#f7f6f2">
<link rel="apple-touch-icon" href="data:image/png;base64,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">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root{--bg:#f7f6f2;--ink:#26262b;--sub:#8b8a94;--line:#e5e3dc;--accent:#2b4c7e;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
body{margin:0 auto;background:var(--bg);color:var(--ink);
  font-family:-apple-system,"Hiragino Sans",sans-serif;
  max-width:720px;
  padding:calc(env(safe-area-inset-top) + 18px) 14px 40px;}
h1{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:20px;letter-spacing:.12em;margin:0 0 2px;}
.sub{color:var(--sub);font-size:12px;margin:0 0 16px;line-height:1.6;}
.panel{background:#fff;border:1px solid var(--line);border-radius:14px;padding:13px 14px;margin:0 0 12px;}
.pTitle{font-size:12px;font-weight:700;color:var(--accent);letter-spacing:.08em;margin:0 0 8px;}
.row{font-size:13px;line-height:1.8;}
.muted{color:var(--sub);font-size:12px;line-height:1.7;}
.btn{background:var(--accent);color:#fff;border:none;border-radius:22px;padding:11px 18px;
  font-size:13px;font-weight:600;letter-spacing:.06em;margin:0 8px 8px 0;}
.btn.ghost{background:#fff;color:var(--accent);border:1px solid var(--accent);}
.btn.danger{background:#fff;color:#cf4527;border:1px solid #cf4527;}
.btn:disabled{opacity:.5;}
.out{background:#f3f2ec;border-radius:10px;padding:10px 12px;font-size:11.5px;line-height:1.7;
  color:#4a4a52;margin:6px 0 0;word-break:break-all;white-space:pre-wrap;display:none;}
table{width:100%;border-collapse:collapse;font-size:12.5px;}
td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;}
th{color:var(--sub);font-weight:600;font-size:11px;}
td.num{text-align:right;}
a{color:var(--accent);}
.note{margin:0 0 4px;}
.note summary{list-style:none;cursor:pointer;color:var(--sub);font-size:12px;letter-spacing:.04em;
  display:flex;align-items:center;gap:5px;padding:2px 0;}
.note summary::-webkit-details-marker{display:none;}
.note summary::before{content:"";width:9px;height:9px;flex:none;
  background:no-repeat center/9px 9px url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M3 1.5L6.5 5L3 8.5' fill='none' stroke='%238b8a94' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  transition:transform .15s ease;}
.note[open] summary::before{transform:rotate(90deg);}
.note p{margin:6px 0 0;}
.hidden{display:none;}
.heatRow{display:flex;align-items:center;gap:12px;margin:10px 0 6px;}
.heatRow input[type=range]{flex:1;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;
  background:linear-gradient(90deg,#c9c7bf,var(--accent));outline:none;}
.heatRow input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
  width:26px;height:26px;border-radius:50%;background:#fff;border:2px solid var(--accent);
  box-shadow:0 1px 4px rgba(0,0,0,.18);cursor:pointer;}
.heatVal{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:22px;font-weight:600;
  min-width:2.4em;text-align:right;color:var(--accent);}
#heatMsg{margin-left:6px;}
</style>
</head>
<body>
<h1>管理ページ</h1>
<p class="sub">民泊ネタ帳の収集管理(緊急用) / <a href="/">フィードへ戻る</a></p>

<div class="panel">
  <div class="pTitle">自動収集の状態</div>
  <div class="row" id="lastScan">読み込み中…</div>
  <div class="muted" id="scanLog"></div>
</div>

<div class="panel">
  <div class="pTitle">xAI(Grok)残高</div>
  <div class="row" id="xaiBal">読み込み中…</div>
  <div class="muted" id="xaiNote"></div>
  <p class="muted" style="margin:8px 0 0">
    <a href="https://console.x.ai/team/d7572746-ffe3-4e85-9076-37bbc0d8cfbc" target="_blank" rel="noopener">console.x.ai でチャージ &#8599;</a>
  </p>
</div>

<div class="panel">
  <div class="pTitle">熱量の下限</div>
  <details class="note">
    <summary>この設定について</summary>
    <p class="muted">この値未満の記事は保存しません。低くすると件数が増える代わりにプレスリリースや告知が混ざり、高くすると事件・炎上など反応の大きいネタだけが残ります。<strong>次の収集から</strong>効きます(保存済みのネタは消えません)。</p>
  </details>
  <div class="heatRow">
    <input type="range" id="heatRange" min="0" max="100" step="1" value="35">
    <span class="heatVal" id="heatVal">35</span>
  </div>
  <div class="muted" id="heatHint"></div>
  <button class="btn" id="btnHeatSave">この値で保存</button>
  <span class="muted" id="heatMsg"></span>
</div>

<div class="panel">
  <div class="pTitle">手動収集(緊急用)</div>
  <p class="muted">通常は3時間毎に自動実行されます(XはxAI残高節約のためJST 6時と18時のみ)。フル収集はGrokを1コール消費します。</p>
  <button class="btn" id="btnFull">フル収集(X込み)</button>
  <button class="btn ghost" id="btnRss">ニュース/YouTubeのみ</button>
  <button class="btn ghost" id="btnCron">自動収集を今すぐ実行(テスト)</button>
  <p class="muted">「自動収集を今すぐ実行」は cron と同じ処理を同期実行します(2〜4分かかります)。cronが動いているかの切り分け用。</p>
  <div class="out" id="out"></div>
</div>

<div class="panel">
  <div class="pTitle">保存件数</div>
  <table><tbody id="countBody"></tbody></table>
</div>

<!-- データのリセット: 通常運用では使わないため非表示。
     機能は残してあるので、必要になったら下の hidden クラスを外すか、
     POST /reset?token=... を直接叩く。 -->
<div class="panel hidden">
  <div class="pTitle">データのリセット</div>
  <p class="muted">収集済みのネタを全て削除します(★お気に入りも含む)。NG設定は残ります。動作確認で古いデータを一掃したい時に使ってください。元に戻せません。</p>
  <button class="btn danger" id="btnReset">全ネタを削除</button>
</div>


<script>
function byId(id){ return document.getElementById(id); }
// /admin?token=... のトークンを保持し、管理APIに引き継ぐ
var TOKEN = new URLSearchParams(location.search).get('token') || '';
function withToken(path){
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
}
function fmtDate(iso){
  if(!iso) return '-';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '-';
  var j = new Date(d.getTime() + 9*3600*1000);
  function p(n){ return ('0'+n).slice(-2); }
  return (j.getUTCMonth()+1) + '/' + j.getUTCDate() + ' ' + p(j.getUTCHours()) + ':' + p(j.getUTCMinutes());
}
function loadData(){
  fetch(withToken('/admin/data')).then(function(r){ return r.json(); }).then(function(d){
    byId('lastScan').textContent = '最終自動収集: ' + fmtDate(d.last_scan);
    var hm = (typeof d.heat_min === 'number') ? d.heat_min : 35;
    byId('heatRange').value = String(hm);
    updateHeatLabel(hm);
    var x = d.xai || {};
    if(x.ok){
      if(x.usd != null){
        byId('xaiBal').textContent = '$' + Number(x.usd).toFixed(2);
        byId('xaiNote').textContent = '';
      } else {
        byId('xaiBal').textContent = 'チャージ $' + Number(x.purchased).toFixed(2);
        byId('xaiNote').textContent = x.note || '';
      }
    } else {
      byId('xaiBal').textContent = '取得できません';
      byId('xaiNote').textContent = (x.reason || '') +
        ' / 表示するには console.x.ai で管理キーを作成し、シークレット XAI_MGMT_KEY と XAI_TEAM_ID を登録してください。';
    }
    var box = byId('scanLog');
    box.innerHTML = '';
    function addLine(s){
      var dv = document.createElement('div');
      dv.textContent = s;
      box.appendChild(dv);
    }
    var log = d.last_scan_log;
    if(log){
      if(log.rss){
        var t = 'ニュース/YouTube: ';
        if(log.rss.error){ t += 'エラー(' + log.rss.error + ')'; }
        else {
          t += '+' + (log.rss.added || 0) + '件 / 上限見送り' + (log.rss.capSkip || 0) +
            ' / 重複' + (log.rss.dup || 0) + ' / 対象外' + (log.rss.excluded || 0) +
            ' / 熱量不足' + (log.rss.lowHeat || 0) +
            ' / 分類見送り' + (log.rss.unjudged || 0) + ' / NG' + (log.rss.ng || 0) + ' / 取得' + (log.rss.found || 0);
          if(log.rss.feeds && log.rss.feeds.length){ t += ' / フィード障害: ' + log.rss.feeds.join(', '); }
        }
        addLine(t);
      }
      if(log.x){
        var t2 = 'X: ';
        if(log.x.skipped){ t2 += 'この回はスキップ(朝6時/夕18時のみ実行)'; }
        else if(log.x.error){ t2 += 'エラー(' + log.x.error + ')'; }
        else { t2 += '+' + (log.x.added || 0) + '件'; }
        addLine(t2);
      }
    }
    if(d.last_x_scan_log){
      addLine('X収集の最終実行: ' + fmtDate(d.last_x_scan_log.when) +
        ' / +' + (d.last_x_scan_log.added || 0) + '件(重複スキップ ' + (d.last_x_scan_log.skipped || 0) + ')');
    }
    var body = byId('countBody');
    body.innerHTML = '';
    var head = document.createElement('tr');
    ['ソース', '新着', 'ゴミ箱'].forEach(function(h){
      var th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    });
    body.appendChild(head);
    var map = {};
    (d.counts || []).forEach(function(c){
      if(!map[c.source]) map[c.source] = { fresh:0, used:0 };
      if(c.status === 'new') map[c.source].fresh = c.n;
      if(c.status === 'used') map[c.source].used = c.n;
    });
    for(var k in map){
      var tr = document.createElement('tr');
      var td1 = document.createElement('td'); td1.textContent = k;
      var td2 = document.createElement('td'); td2.className = 'num'; td2.textContent = map[k].fresh;
      var td3 = document.createElement('td'); td3.className = 'num'; td3.textContent = map[k].used;
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      body.appendChild(tr);
    }
    var trF = document.createElement('tr');
    var tf1 = document.createElement('td'); tf1.textContent = '★お気に入り';
    var tf2 = document.createElement('td'); tf2.className = 'num'; tf2.textContent = d.fav || 0;
    var tf3 = document.createElement('td');
    trF.appendChild(tf1); trF.appendChild(tf2); trF.appendChild(tf3);
    body.appendChild(trF);
  }).catch(function(e){
    byId('lastScan').textContent = '読み込みエラー: ' + e.message;
  });
}
function runScan(path, btn){
  btn.disabled = true;
  byId('out').style.display = '';
  byId('out').textContent = '収集中…';
  fetch(withToken(path), { method:'POST' }).then(function(r){ return r.json(); }).then(function(d){
    btn.disabled = false;
    byId('out').textContent = 'ニュース・YouTubeの結果です。Xはバックグラウンドで実行中で、完了後にフィードへ追加され、上のログにも反映されます(数分後にこのページを再読み込み)。' +
      String.fromCharCode(10, 10) + JSON.stringify(d, null, 1);
    loadData();
  }).catch(function(e){
    btn.disabled = false;
    byId('out').textContent = 'エラー: ' + e.message;
  });
}

// 熱量スライダー。表示だけ即時更新し、保存はボタンを押した時だけ(誤操作で収集基準が変わらないように)
function heatHint(v){
  if(v <= 0) return '0: 全て保存します。分類できた記事は熱量に関係なく残ります。';
  if(v < 25) return v + ': ほぼ全て残ります。告知・プレスリリースも混ざります。';
  if(v < 40) return v + ': 標準(既定35)。話のとっかかりになる記事が残ります。';
  if(v < 60) return v + ': やや厳しめ。反応の見込める記事に絞られます。';
  if(v < 80) return v + ': 厳しめ。事件・炎上・賛否が割れる話題が中心になります。';
  return v + ': かなり厳しめ。該当が0件の日が出ます。';
}
function updateHeatLabel(v){
  byId('heatVal').textContent = String(v);
  byId('heatHint').textContent = heatHint(v);
}
byId('heatRange').oninput = function(){
  updateHeatLabel(parseInt(this.value, 10));
  byId('heatMsg').textContent = '';
};
byId('btnHeatSave').onclick = function(){
  var b = byId('btnHeatSave');
  var v = parseInt(byId('heatRange').value, 10);
  b.disabled = true;
  byId('heatMsg').textContent = '保存中…';
  fetch(withToken('/settings/heatmin'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: v })
  }).then(function(r){ return r.json(); }).then(function(d){
    b.disabled = false;
    if(d.error){ byId('heatMsg').textContent = 'エラー: ' + d.error; return; }
    byId('heatMsg').textContent = '保存しました(次の収集から適用)';
  }).catch(function(e){
    b.disabled = false;
    byId('heatMsg').textContent = 'エラー: ' + e.message;
  });
};

byId('btnFull').onclick = function(){ runScan('/scan/all', byId('btnFull')); };
byId('btnRss').onclick = function(){ runScan('/scan/rss', byId('btnRss')); };
byId('btnCron').onclick = function(){ runScan('/scan/cron', byId('btnCron')); };
byId('btnReset').onclick = function(){
  if(!confirm('収集済みのネタを全て削除します(★も含む)。元に戻せません。よろしいですか？')) return;
  if(!confirm('本当に削除しますか？この操作は取り消せません。')) return;
  var b = byId('btnReset');
  b.disabled = true;
  b.textContent = '削除中…';
  fetch(withToken('/reset'), { method:'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      b.disabled = false;
      b.textContent = '全ネタを削除';
      if(d.error){ alert('エラー: ' + d.error); return; }
      alert(d.deleted + '件を削除しました。「フル収集」で新しく集め直せます。');
      loadData();
    })
    .catch(function(e){
      b.disabled = false;
      b.textContent = '全ネタを削除';
      alert('エラー: ' + e.message);
    });
};
loadData();
</script>
</body>
</html>`;
