// 栄養管理アプリ v0.2 2026-11-19（実機1回目の指摘「全くあっていない・量が狂っている・修正もできない」への対応）
//   ・指示文を直した（器の大きさで量を見積もる／弁当は仕切りごと／未開封の容器は数えない／鍋は全体量＋取り分け）
//   ・直す画面用：記録の書き換え（save）・今日の記録（day）・文章で品を足す（estimate）・覚えたこと（設定タブ）
//   ・材料ごとのグラムとカロリーを「データ」列（N列）にJSONで持つ＝量を変えるとカロリーを計算し直せる
// v0.1 2026-11-19（写真1枚 → Gemini → シートに1品1行＋料理の部分を切り抜いた写真）
// 画面は GitHub Pages（Apps Script の画面ではマイクが使えない＝GrowBook Capture で実測済み）。ここは doPost で受ける
// 公開設定：実行＝自分／アクセス＝全員（外の画面から送るため）。本人以外は合言葉（t）で弾く
// 個人の健康データ。外向けのコンテンツに流用しない

// v0.3 2026-11-19 栄養素の分析：日本食品標準成分表（八訂）増補2023年（文部科学省・2026-03-27更新版）の値 × 食べたグラム
//   ・材料 → 成分表の食品番号の当てはめは Gemini（成分表の一覧 約5万トークンを先頭に置く＝続けて呼ぶと暗黙キャッシュで割引）
//   ・kcal も成分表の値で計算し直す（当てはめられなかった材料だけ Gemini の推定）
//   ・比べる基準は 日本人の食事摂取基準（2025年版）男性30〜49歳（厚生労働省の報告書の表から 11/19 読み取り）
//   ・フィトケミカルは成分表に無いので、料理ごとに「含まれる主なもの」の名前だけ（量は出さない）
// v0.4 2026-11-19 ドテラのサプリ（公式ページの栄養成分表示・ラベル写真からの登録）を栄養に足す。耐容上限量（2025年版・男性30〜49歳）で上限超えを出す
// v0.4.1 2026-11-19 サプリの原材料名からフィトケミカル・エッセンシャルオイルを出す（量は出さない）
var VERSION = 'nutrition-app v0.6';
var MAP_MODEL = 'gemini-2.5-flash';       // 当てはめ用（考えない設定。11/19 試験で23品すべて正しい番号）
var SH_FOOD = '成分表';
var NUT_KEYS = ['kcal', 'prot', 'fat', 'carb', 'fib', 'salt', 'k', 'ca', 'mg', 'fe', 'zn', 'va', 'vd', 've', 'b1', 'b2', 'b6', 'b12', 'fol', 'vc'];
// 日本人の食事摂取基準（2025年版）男性30〜49歳。kind: 推奨量/目安量/目標量。min 以上・max 未満が望ましい
var DRI = {
  prot: { name: 'たんぱく質', unit: 'g', min: 65, kind: '推奨量', pe: [13, 20] },
  fat:  { name: '脂質', unit: 'g', kind: '目標量', pe: [20, 30] },
  carb: { name: '炭水化物', unit: 'g', kind: '目標量', pe: [50, 65] },
  fib:  { name: '食物繊維', unit: 'g', min: 22, kind: '目標量' },
  salt: { name: '食塩相当量', unit: 'g', max: 7.5, kind: '目標量' },
  k:    { name: 'カリウム', unit: 'mg', min: 3000, kind: '目標量' },
  ca:   { name: 'カルシウム', unit: 'mg', min: 750, kind: '推奨量', ul: 2500 },
  mg:   { name: 'マグネシウム', unit: 'mg', min: 380, kind: '推奨量' },
  fe:   { name: '鉄', unit: 'mg', min: 7.5, kind: '推奨量' },
  zn:   { name: '亜鉛', unit: 'mg', min: 9.5, kind: '推奨量', ul: 45 },
  va:   { name: 'ビタミンA', unit: 'µgRAE', min: 900, kind: '推奨量', ul: 2700 },
  vd:   { name: 'ビタミンD', unit: 'µg', min: 9.0, kind: '目安量', ul: 100 },
  ve:   { name: 'ビタミンE', unit: 'mg', min: 6.5, kind: '目安量', ul: 800 },
  b1:   { name: 'ビタミンB1', unit: 'mg', min: 1.2, kind: '推奨量' },
  b2:   { name: 'ビタミンB2', unit: 'mg', min: 1.7, kind: '推奨量' },
  b6:   { name: 'ビタミンB6', unit: 'mg', min: 1.5, kind: '推奨量', ul: 60 },
  b12:  { name: 'ビタミンB12', unit: 'µg', min: 4.0, kind: '目安量' },
  fol:  { name: '葉酸', unit: 'µg', min: 240, kind: '推奨量', ul: 1000 },
  vc:   { name: 'ビタミンC', unit: 'mg', min: 100, kind: '推奨量' }
};
var ROOT_NAME = '栄養管理アプリ';
var BOOK_NAME = '栄養管理_記録';
var GEMINI_MODEL = 'gemini-2.5-flash';
var USD_JPY = 150;                         // 利用ログの円換算（目安）
var PRICE_IN = 0.30, PRICE_OUT = 2.50;     // 100万トークンあたりのドル（2.5 Flash・画像/文字の入力／出力）

var SH_LOG = '記録', SH_SET = '設定', SH_USE = '利用ログ';
var HEAD = ['日付', '曜日', '区分', '時刻', '献立名', '材料名', '分量', 'カロリー(kcal)', '写真', '記録ID', '元の写真', '読み取りメモ', '登録日時', 'データ'];
var C = { date: 1, dow: 2, meal: 3, time: 4, dish: 5, ing: 6, amt: 7, kcal: 8, img: 9, id: 10, src: 11, note: 12, at: 13, data: 14 };
var NCOL = 14;
var DOW = ['日', '月', '火', '水', '木', '金', '土'];
var LEARN_ROW = 14;                        // 設定タブの「覚えたこと」の始まり（A14〜）

// ---------- 入口 ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  return ContentService.createTextOutput(p.v ? VERSION : 'ok');
}

// { t, action, ... } → { ok:true, data } / { ok:false, error }
function doPost(e) {
  var out;
  try {
    var q = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    guard_(q.t);
    var data;
    if (q.action === 'ping') data = VERSION;
    else if (q.action === 'photo') data = photo_(q);
    else if (q.action === 'crop') data = crop_(q);
    else if (q.action === 'today') data = today_(q.date);
    else if (q.action === 'history') data = history_(q.days);
    else if (q.action === 'day') data = day_(q.date);
    else if (q.action === 'save') data = save_(q);
    else if (q.action === 'estimate') data = estimate_(q);
    else if (q.action === 'ing') data = ing_(q);
    else if (q.action === 'learn') data = learn_(q.text);
    else if (q.action === 'nutri') data = nutri_(q.date);
    else if (q.action === 'nutrirange') data = nutriRange_(q);
    else if (q.action === 'sup') data = supDay_(q.date);
    else if (q.action === 'supsave') data = supSave_(q);
    else if (q.action === 'suplabel') data = supLabel_(q);
    else throw new Error('不明な操作です');
    out = { ok: true, data: data };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function guard_(t) {
  var k = prop_('NUTRI_TOKEN');
  if (!k || String(t || '') !== k) throw new Error('合言葉が違います');
}

// ---------- 保存先 ----------
function child_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function root_() { return child_(DriveApp.getRootFolder(), ROOT_NAME); }
function photoFolder_(d, kind) {
  return child_(child_(child_(root_(), '写真'), Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM')), kind);
}
function book_() {
  var id = prop_('SHEET_ID');
  if (!id) throw new Error('シートがまだありません（エディタで setup を実行してください）');
  return SpreadsheetApp.openById(id);
}
function fmt_(d, f) { return Utilities.formatDate(d, 'Asia/Tokyo', f); }
function dow_(d) { return DOW[Number(fmt_(d, 'u')) % 7]; }

// ---------- 料理の形（画面・シート共通） ----------
// dish = { name, shared, portion(1, 0.5, 0.333…), ings:[{ name, amount, grams, kcal, g0, k0 }] }
//   g0/k0 = 読み取った時のグラムとカロリー（量を変えたら kcal = k0 × grams / g0 で計算し直す）
function normDish_(d) {
  var ings = (d.ingredients || d.ings || []).map(function (x) {
    var g = Number(x.grams) || 0, k = Math.round(Number(x.kcal) || 0);
    var o = { name: String(x.name || ''), amount: String(x.amount || ''), grams: g, kcal: k,
              g0: Number(x.g0) || g, k0: x.k0 != null ? Number(x.k0) : k };
    if (x.c) { o.c = String(x.c); o.fn = String(x.fn || ''); }   // 成分表の食品番号と食品名
    return o;
  });
  var phyto = (d.phyto || []).map(String).filter(String).slice(0, 4);
  return { name: String(d.name || ''), shared: !!d.shared, portion: Number(d.portion) || 1, ings: ings, phyto: phyto };
}
function dishKcal_(d) {
  var s = d.ings.reduce(function (a, x) { return a + (Number(x.kcal) || 0); }, 0);
  return Math.round(s * (d.shared ? d.portion : 1));
}
function dishLabel_(d) {
  if (!d.shared || d.portion === 1) return d.name;
  var p = { 0.5: '1/2', 0.333: '1/3', 0.25: '1/4', 0.167: '1/6' }[Math.round(d.portion * 1000) / 1000] || (Math.round(d.portion * 100) + '%');
  return d.name + '（取り分け・全体の' + p + '）';
}
function rowsOf_(dishes, base) {
  // base = { date, dow, meal, time, id, at }
  return dishes.map(function (d) {
    return [base.date, base.dow, base.meal, base.time, dishLabel_(d),
      d.ings.map(function (x) { return x.name; }).join('\n'),
      d.ings.map(function (x) { return x.amount; }).join('\n'),
      dishKcal_(d), base.id, base.at, JSON.stringify(d)];
  });
}
// rowsOf_ の並び → シートの列へ（写真 I・元の写真 K・メモ L は触らない）
function writeRows_(sh, start, rows) {
  if (!rows.length) return;
  sh.getRange(start, 1, rows.length, 8).setValues(rows.map(function (r) { return r.slice(0, 8); }));
  sh.getRange(start, C.id, rows.length, 1).setValues(rows.map(function (r) { return [r[8]]; }));
  sh.getRange(start, C.at, rows.length, 2).setValues(rows.map(function (r) { return [r[9], r[10]]; }));
  sh.getRange(start, C.time, rows.length, 1).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, NCOL - 1).setVerticalAlignment('top').setWrap(true);
}

// ---------- 写真を読み取る ----------
// q = { b64(jpeg), ts(撮影時刻ミリ秒), meal('自動'|'朝食'|…), note }
function photo_(q) {
  if (!q.b64) throw new Error('写真が空です');
  var when = new Date(Number(q.ts) || Date.now());
  var id = fmt_(new Date(), 'yyyyMMdd-HHmmss') + '-' + Math.random().toString(36).slice(2, 6);
  var src = photoFolder_(when, '元').createFile(Utilities.newBlob(Utilities.base64Decode(q.b64), 'image/jpeg', id + '.jpg'));

  var r = gemini_([{ text: PROMPT + learned_() + (q.note ? '\n・本人のメモ（優先して反映する）：' + q.note : '') },
                   { inline_data: { mime_type: 'image/jpeg', data: q.b64 } }], SCHEMA);
  useLog_('写真', r._usage);
  if (!r.is_food) return { id: id, isFood: false, note: r.note || '料理が写っていないようです' };

  var meal = (q.meal && q.meal !== '自動') ? q.meal : mealOf_(when);
  var dishes = mapDishes_((r.dishes || []).map(normDish_));
  var base = { date: fmt_(when, 'yyyy/MM/dd'), dow: dow_(when), meal: meal, time: fmt_(when, 'HH:mm'), id: id, at: fmt_(new Date(), 'yyyy/MM/dd HH:mm') };
  var sh = book_().getSheetByName(SH_LOG);
  ensureDataCol_(sh);
  var start = sh.getLastRow() + 1;
  writeRows_(sh, start, rowsOf_(dishes, base));
  sh.getRange(start, C.src).setValue(src.getUrl());
  if (r.note) sh.getRange(start, C.note).setValue(String(r.note));
  return { id: id, isFood: true, meal: meal, date: base.date, time: base.time, dishes: dishes,
           total: dishes.reduce(function (s, d) { return s + dishKcal_(d); }, 0),
           crop: r.crop || null, note: r.note || '', today: today_(base.date) };
}

function mealOf_(d) {
  var h = Number(fmt_(d, 'H'));
  if (h >= 4 && h < 10) return '朝食';
  if (h >= 11 && h < 15) return '昼食';
  if (h >= 17 && h < 23) return '夕食';
  return '間食';
}

var PROMPT = [
  'この写真は、食事の記録のために撮った料理の写真です。病院の栄養指導に出す「食事内容記録表」（献立名・材料名・分量）を埋めるために読み取ってください。量の見積もりが最も大事です。',
  '',
  '【品を数える】',
  '・写っている料理と飲み物を1品ずつすべて挙げる。弁当や定食は仕切り・小鉢ごとに確認し、重なっている揚げ物（唐揚げとコロッケ等）も別々に数える',
  '・料理名は見た目でいちばん確からしいものにする（かぼちゃサラダとポテトサラダ、切り干し大根の煮物と筑前煮、里芋の煮物と鶏肉など、色・形・断面で見分ける）',
  '・パックのまま置かれた納豆・ヨーグルトなどは1パック分として数える',
  '・まだ開けていない大きな容器（キムチの容器・ドレッシングの瓶・ねぎのパックなど）や調味料のボトルは、皿に取り分けていなければ数えない',
  '',
  '【量を見積もる】',
  '・器の大きさを手がかりにする：普通の茶碗は直径約12cm・ご飯1杯約150g／大きめの茶碗やどんぶりは200〜300g／弁当のご飯の仕切りは180〜250g。箸・パック・皿の直径も物差しにする',
  '・肉・魚・芋は1切れ・1個ずつの大きさから合計を出す',
  '・amount は家庭で分かる単位（180g、1個、2枚、1切れ（約30g）など）。grams はそのグラム数の推定値（飲み物はmlをそのままgとしてよい）。少々・適量のときも grams に推定値を入れる',
  '・kcal はその材料のカロリー。日本食品標準成分表（八訂）の値を目安に計算する。油・マヨネーズ・ドレッシング・砂糖などカロリーの大きい調味料は、使われていそうなら材料に入れる',
  '・唐揚げ・コロッケ・餃子・だし巻き卵・切り干し大根の煮物など、料理そのものが成分表に1つの食品として載っているものは、衣・油・調味料に分けず1つの材料にする',
  '・ingredients の name は、成分表で探しやすい名前にする（例：白米のご飯、鶏もも肉（皮つき・焼き）、ほうれん草（ゆで））',
  '・phyto: その料理に含まれる代表的なフィトケミカル（植物由来の機能性成分）の名前を、よく知られた確かなものだけ最大3つ（例：納豆→大豆イソフラボン、キムチ→カプサイシン）。動物性の料理や分からなければ空',
  '',
  '【鍋・大皿】',
  '・鍋や大皿を何人かで取り分ける料理は shared を true にし、写っている全体の量で材料と kcal を出す（何人分食べたかは本人が後で選ぶ）',
  '',
  '・crop: 数えた品がすべて入る最小の四角を [ymin, xmin, ymax, xmax]（画像の上端・左端を0、下端・右端を1000）で。テーブルの余白・手・リモコンなど料理以外はできるだけ外す',
  '・is_food: 料理も飲み物も写っていなければ false',
  '・note: 写真だけでは判断しにくい点を短く。なければ空文字',
  '・日本語で答える'
].join('\n');

var ING_SCHEMA = { type: 'OBJECT', properties: {
  name: { type: 'STRING' }, amount: { type: 'STRING' }, grams: { type: 'NUMBER' }, kcal: { type: 'NUMBER' }
}, required: ['name', 'amount', 'grams', 'kcal'] };
var DISH_SCHEMA = { type: 'OBJECT', properties: {
  name: { type: 'STRING' }, shared: { type: 'BOOLEAN' }, ingredients: { type: 'ARRAY', items: ING_SCHEMA },
  phyto: { type: 'ARRAY', items: { type: 'STRING' } }
}, required: ['name', 'shared', 'ingredients', 'phyto'] };
var SCHEMA = { type: 'OBJECT', properties: {
  is_food: { type: 'BOOLEAN' }, dishes: { type: 'ARRAY', items: DISH_SCHEMA },
  crop: { type: 'ARRAY', items: { type: 'INTEGER' } }, note: { type: 'STRING' }
}, required: ['is_food', 'dishes', 'crop', 'note'] };

function gemini_(parts, schema, opt) {
  opt = opt || {};
  var key = prop_('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini のキーが未設定です');
  var payload = { contents: [{ parts: parts }],
                  // 考える量の上限 1024：上限なしは1回約2.4円・1024は約1.1円（11/19 実測）
                  generationConfig: { temperature: opt.temp != null ? opt.temp : 0.2, responseMimeType: 'application/json', responseSchema: schema,
                                      thinkingConfig: { thinkingBudget: opt.think != null ? opt.think : 1024 } } };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + (opt.model || GEMINI_MODEL) + ':generateContent?key=' + encodeURIComponent(key);
  var res, code;
  for (var i = 0; i < 2; i++) {
    res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
    code = res.getResponseCode();
    if (code === 200 || (code !== 429 && code < 500)) break;
    Utilities.sleep(3000);
  }
  if (code !== 200) throw new Error('読み取りに失敗しました（Gemini ' + code + '）' + res.getContentText().slice(0, 160));
  var j = JSON.parse(res.getContentText());
  var txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(function (p) { return p.text || ''; }).join('');
  var r = JSON.parse(txt || '{}');
  r._usage = j.usageMetadata || {};
  return r;
}

// ---------- 覚えたこと（設定タブ A14〜） ----------
function learnedList_() {
  var sh = book_().getSheetByName(SH_SET);
  var last = sh.getLastRow();
  if (last <= LEARN_ROW) return [];
  return sh.getRange(LEARN_ROW + 1, 1, last - LEARN_ROW, 1).getValues()
    .map(function (r) { return String(r[0] || '').trim(); }).filter(String);
}
function learned_() {
  var a = learnedList_();
  return a.length ? '\n\n【この人の食事で分かっていること（必ず守る）】\n' + a.map(function (s) { return '・' + s; }).join('\n') : '';
}
function learn_(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('空です');
  var sh = book_().getSheetByName(SH_SET);
  sh.getRange(Math.max(sh.getLastRow(), LEARN_ROW) + 1, 1).setValue(text.slice(0, 300));
  return learnedList_();
}

// ---------- 文章で品を足す（例：だし巻き卵1切れ） ----------
function estimate_(q) {
  var text = String(q.text || '').trim();
  if (!text) throw new Error('何を足すか書いてください');
  var prompt = [
    '次の食べ物を、病院の「食事内容記録表」に書く形にしてください。複数あれば1品ずつ分ける。',
    '・ingredients の amount は家庭で分かる単位、grams は推定グラム、kcal は日本食品標準成分表（八訂）の値を目安に計算',
    '・量が書いていなければ一般的な1人前',
    '・鍋や大皿を取り分けた料理なら shared を true（kcal は全体の量で）',
    '・日本語で答える',
    '',
    '食べ物：' + text
  ].join('\n') + learned_();
  var r = gemini_([{ text: prompt }], { type: 'OBJECT', properties: { dishes: { type: 'ARRAY', items: DISH_SCHEMA } }, required: ['dishes'] });
  useLog_('文章', r._usage);
  return mapDishes_((r.dishes || []).map(normDish_));
}

// ---------- 材料を1つ直す・足す（v0.5） ----------
// q = { dish(料理名), text('にんじん 30g' など・足すとき) | name(直した材料名) + grams(今の量) }
// → { name, amount, grams, kcal, g0, k0, c, fn }（成分表に当てはめて kcal を出す）
function ing_(q) {
  var dish = String(q.dish || '').trim();
  var text = String(q.text || q.name || '').trim();
  if (!text) throw new Error('材料名を書いてください');
  var keepG = Number(q.grams) || 0;   // 名前だけ直したとき：量はそのまま
  var prompt = [
    '料理「' + (dish || '不明') + '」の材料「' + text + '」を、病院の「食事内容記録表」の材料1つとして書いてください。',
    '・name は成分表で探しやすい名前（例：にんじん（ゆで）、かぼちゃ（ゆで）、マヨネーズ（全卵型））',
    '・amount は家庭で分かる単位、grams は推定グラム。量が書いてあればその量にする。書いていなければこの料理1人前に入る一般的な量',
    '・kcal は日本食品標準成分表（八訂）の値を目安に計算',
    '・日本語で答える'
  ].join('\n') + learned_();
  var r = gemini_([{ text: prompt }], ING_SCHEMA, { think: 0, temp: 0 });
  useLog_('材料', r._usage);
  var x = { name: String(r.name || text), amount: String(r.amount || ''), grams: Number(r.grams) || 0, kcal: Math.round(Number(r.kcal) || 0) };
  if (q.name && !q.text) x.name = text;   // 直した名前は本人の書いたとおりに残す
  if (keepG > 0) {
    if (x.grams > 0) x.kcal = Math.round(x.kcal * keepG / x.grams);
    x.grams = keepG;
    x.amount = '約' + keepG + 'g';
  }
  var d = normDish_({ name: dish || text, ings: [x] });
  return mapDishes_([d])[0].ings[0];
}

// ---------- 成分表（シート「成分表」：食品番号・食品名・100gあたりの値） ----------
var FOODS_ = null;
function foods_() {
  if (FOODS_) return FOODS_;
  var cache = CacheService.getScriptCache(), n = Number(cache.get('foods_n') || 0), txt = '';
  if (n) {
    var parts = cache.getAll(Array.apply(null, Array(n)).map(function (_, i) { return 'foods_' + i; }));
    for (var i = 0; i < n; i++) { if (!parts['foods_' + i]) { txt = ''; break; } txt += parts['foods_' + i]; }
  }
  var list;
  if (txt) list = JSON.parse(txt);
  else {
    var sh = book_().getSheetByName(SH_FOOD);
    if (!sh) return (FOODS_ = { list: [], byCode: {} });
    var v = sh.getDataRange().getValues(), head = v[0];
    list = v.slice(1).filter(function (r) { return r[0]; }).map(function (r) {
      var o = {};
      head.forEach(function (h, j) { o[h] = (j < 2) ? String(r[j]) : (r[j] === '' ? null : Number(r[j])); });
      return o;
    });
    var s = JSON.stringify(list), CH = 90000, k = Math.ceil(s.length / CH), put = { foods_n: String(k) };
    for (var c = 0; c < k; c++) put['foods_' + c] = s.slice(c * CH, (c + 1) * CH);
    try { cache.putAll(put, 21600); } catch (e) { /* 入らなくても動く */ }
  }
  var by = {};
  list.forEach(function (f) { by[f.code] = f; });
  return (FOODS_ = { list: list, byCode: by });
}

// 材料に成分表の食品番号を付け、kcal を成分表の値で計算し直す（番号がすでにある材料はそのまま）
function mapDishes_(dishes) {
  var F = foods_();
  if (!F.list.length) return dishes;
  var todo = [];
  dishes.forEach(function (d) { d.ings.forEach(function (x) { if (!x.c || !F.byCode[x.c]) todo.push({ d: d, x: x }); }); });
  if (todo.length) {
    try {
      var idx = F.list.map(function (f) { return f.code + ' ' + f.name; }).join('\n');
      // 一覧を先頭に置く（同じ先頭が続くと暗黙キャッシュで安くなる）
      // 番号（1. 2. …）で返させると一覧の行とずれた（11/19 実測で8つずれ）→ id と材料名を返させ、照らし合わせてから使う
      var prompt = '【食品成分表の一覧】（食品番号 食品名）\n' + idx + '\n\n'
        + '上の一覧から、下の各材料にいちばん近い食品を1つずつ選び、id・材料名・食品番号を返してください。'
        + '調理した状態（ゆで・焼き・油いため等）や、調理済み食品（から揚げ・コロッケ等）の項目があればそれを優先する。どうしても無ければ食品番号は空文字。\n\n【材料】\n'
        + todo.map(function (t, i) { return 'm' + (i + 1) + '｜' + t.x.name + '（料理：' + t.d.name + '）'; }).join('\n');
      var r = gemini_([{ text: prompt }], { type: 'OBJECT', properties: { codes: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        id: { type: 'STRING' }, name: { type: 'STRING' }, code: { type: 'STRING' } }, required: ['id', 'name', 'code'] } } }, required: ['codes'] },
        { model: MAP_MODEL, think: 0, temp: 0 });
      useLog_('当てはめ', r._usage);
      (r.codes || []).forEach(function (c) {
        var m = /^m(\d+)$/.exec(String(c.id || '').trim()); if (!m) return;
        var t = todo[Number(m[1]) - 1]; if (!t) return;
        var nm = String(c.name || '').split('（')[0];
        if (!nm || (t.x.name.indexOf(nm) < 0 && nm.indexOf(t.x.name) < 0)) return;   // 名前が合わなければ使わない
        var f = F.byCode[String(c.code)];
        if (f) { t.x.c = f.code; t.x.fn = f.name; }
      });
    } catch (e) { /* 当てはめに失敗しても記録は止めない（kcal は Gemini の推定のまま） */ }
  }
  dishes.forEach(function (d) {
    d.ings.forEach(function (x) {
      var f = x.c && F.byCode[x.c];
      if (f && f.kcal != null && x.g0 > 0) {
        x.k0 = Math.round(f.kcal * x.g0 / 100);
        x.kcal = Math.round(f.kcal * x.grams / 100);
      }
    });
  });
  return dishes;
}

// ---------- サプリ（v0.4） ----------
// シート「サプリ」：1単位（1粒・1本・1mL）あたりの値。公式ページの栄養成分表示から（無いものは空＝量だけ記録）
// シート「サプリ記録」：日付・サプリID・名前・量・単位・登録日時（その日の分は保存のたびに入れ替える）
var SH_SUP = 'サプリ', SH_SUPLOG = 'サプリ記録';
function supMaster_() {
  var sh = book_().getSheetByName(SH_SUP);
  if (!sh) return { list: [], head: [], sh: null };
  var v = sh.getDataRange().getValues(), head = v[0].map(String);
  var list = v.slice(1).filter(function (r) { return r[0]; }).map(function (r, i) {
    var o = { row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    o.id = String(o.id); o.name = String(o.name); o.unit = String(o.unit); o['default'] = Number(o['default']) || 1;
    NUT_KEYS.forEach(function (k) { o[k] = (o[k] === '' || o[k] == null) ? null : Number(o[k]); });
    try { o.extra = o.extra ? JSON.parse(o.extra) : {}; } catch (e) { o.extra = {}; }
    try { o.phyto = o.phyto ? JSON.parse(o.phyto) : []; } catch (e) { o.phyto = []; }
    try { o.eo = o.eo ? JSON.parse(o.eo) : []; } catch (e) { o.eo = []; }
    o.mine = String(o.mine || '') !== '';
    return o;
  });
  return { list: list, head: head, sh: sh };
}
function supLogs_(date) {
  var sh = book_().getSheetByName(SH_SUPLOG);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().map(function (r, i) {
    var d = r[0] instanceof Date ? fmt_(r[0], 'yyyy/MM/dd') : String(r[0]);
    // G列＝家族で分けたときの自分の割合（空なら全部＝1）。量（D列）は自分が飲んだ分
    return { row: i + 2, date: d, id: String(r[1]), name: String(r[2]), amount: Number(r[3]) || 0, unit: String(r[4]), share: Number(r[6]) || 1 };
  }).filter(function (x) { return !date || x.date === date; });
}
function supDay_(date) {
  date = String(date || fmt_(new Date(), 'yyyy/MM/dd'));
  var M = supMaster_();
  return { date: date, list: M.list.map(function (o) {
    return { id: o.id, name: o.name, unit: o.unit, def: o['default'], label: String(o.label || ''), source: String(o.source || ''), mine: o.mine,
             has: NUT_KEYS.filter(function (k) { return o[k] != null; }).length + Object.keys(o.extra).length };
  }), logs: supLogs_(date) };
}
// q = { date, items:[{id, amount}], mine:[id…] }
function supSave_(q) {
  var date = String(q.date || fmt_(new Date(), 'yyyy/MM/dd'));
  var M = supMaster_(), by = {};
  M.list.forEach(function (o) { by[o.id] = o; });
  if (q.mine && M.sh) {
    var col = M.head.indexOf('mine') + 1, set = {};
    q.mine.forEach(function (id) { set[id] = 1; });
    M.list.forEach(function (o) { M.sh.getRange(o.row, col).setValue(set[o.id] ? '○' : ''); });
  }
  var sh = book_().getSheetByName(SH_SUPLOG);
  var old = supLogs_(date).map(function (x) { return x.row; }).sort(function (a, b) { return b - a; });
  old.forEach(function (r) { sh.deleteRow(r); });
  var at = fmt_(new Date(), 'yyyy/MM/dd HH:mm');
  if (String(sh.getRange(1, 7).getValue()) !== '分けた割合') sh.getRange(1, 7).setValue('分けた割合').setFontWeight('bold');
  // amount＝自分が飲んだ量（全体×割合）。share＝自分の割合（全部なら空）
  var rows = (q.items || []).filter(function (x) { return by[x.id] && Number(x.amount) > 0; })
    .map(function (x) {
      var o = by[x.id], s = Number(x.share) || 1;
      return [date, o.id, o.name, Math.round(Number(x.amount) * 1000) / 1000, o.unit, at, s < 1 ? Math.round(s * 1000) / 1000 : ''];
    });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
  return { saved: rows.length };
}
// ラベル（栄養成分表示）の写真 → 1単位あたりの値をサプリ表に書く。q = { id, b64 }
function supLabel_(q) {
  var M = supMaster_(), o = null;
  M.list.forEach(function (x) { if (x.id === String(q.id)) o = x; });
  if (!o) throw new Error('サプリが見つかりません');
  var props = {}; NUT_KEYS.forEach(function (k) { props[k] = { type: 'NUMBER' }; });
  var schema = { type: 'OBJECT', properties: {
    found: { type: 'BOOLEAN' }, per_amount: { type: 'NUMBER' }, per_unit: { type: 'STRING' }, values: { type: 'OBJECT', properties: props },
    others: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, value: { type: 'NUMBER' }, unit: { type: 'STRING' } }, required: ['name', 'value', 'unit'] } },
    text: { type: 'STRING' } }, required: ['found', 'per_amount', 'per_unit', 'values', 'others', 'text'] };
  var prompt = [
    'これはサプリメント「' + o.name + '」のラベルの写真です。「栄養成分表示」の枠の中に書かれている値だけを、そのまま読み取ってください。',
    '・表示が何あたりか（例：大さじ1杯15mLあたり→ per_amount=15, per_unit="mL"／4粒あたり→ 4, "粒"）',
    '・values のキー：kcal=エネルギー(kcal), prot=たんぱく質(g), fat=脂質(g), carb=炭水化物(g), fib=食物繊維(g), salt=食塩相当量(g), k=カリウム(mg), ca=カルシウム(mg), mg=マグネシウム(mg), fe=鉄(mg), zn=亜鉛(mg), va=ビタミンA(µg), vd=ビタミンD(µg), ve=ビタミンE(mg), b1,b2,b6=mg, b12=µg, fol=葉酸(µg), vc=ビタミンC(mg)。単位が違えば換算する。ナトリウムだけなら食塩相当量＝ナトリウム(mg)×2.54÷1000',
    '・それ以外の成分（例：ケイ素、亜鉛以外の微量元素、DHA）は others に名前・値・単位で',
    '・表示に無い値は入れない（推測しない）。栄養成分表示が写っていなければ found=false',
    '・text には読み取った表示の文字をそのまま書く'
  ].join('\n');
  var r = gemini_([{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: q.b64 } }], schema, { temp: 0 });
  useLog_('ラベル', r._usage);
  if (!r.found) return { ok: false, text: r.text || '' };
  var unitMatch = String(r.per_unit || '').indexOf(o.unit) >= 0 || (o.unit === 'mL' && /ml|ｍｌ|ミリ/i.test(r.per_unit));
  if (!unitMatch) return { ok: false, text: r.text, error: '表示の単位（' + r.per_unit + '）がこのサプリの単位（' + o.unit + '）と違います。量の単位を確かめてください' };
  var per = Number(r.per_amount) || 1;
  NUT_KEYS.forEach(function (k) {
    var v = r.values && r.values[k];
    var col = M.head.indexOf(k) + 1;
    if (col > 0) M.sh.getRange(o.row, col).setValue(v != null && v !== '' ? Math.round(Number(v) / per * 1e6) / 1e6 : '');
  });
  var ex = {};
  (r.others || []).forEach(function (x) { ex[x.name + '(' + x.unit + ')'] = Math.round(Number(x.value) / per * 1e6) / 1e6; });
  M.sh.getRange(o.row, M.head.indexOf('extra') + 1).setValue(Object.keys(ex).length ? JSON.stringify(ex) : '');
  M.sh.getRange(o.row, M.head.indexOf('label') + 1).setValue('ラベル写真');
  M.sh.getRange(o.row, M.head.indexOf('source') + 1).setValue('ボトルのラベルの写真から読み取り（' + fmt_(new Date(), 'yyyy-MM-dd') + '）：' + String(r.text || '').slice(0, 400));
  return { ok: true, text: r.text, per: per + r.per_unit };
}
// その日のサプリの合計（栄養の画面用）
function supTotals_(date, M, logs) {
  M = M || supMaster_();
  var by = {}, tot = {}, extra = {}, items = [], phyto = [], eo = {};
  M.list.forEach(function (o) { by[o.id] = o; });
  NUT_KEYS.forEach(function (k) { tot[k] = 0; });
  (logs || supLogs_(date)).forEach(function (x) {
    var o = by[x.id]; if (!o) return;
    NUT_KEYS.forEach(function (k) { if (o[k] != null) tot[k] += o[k] * x.amount; });
    Object.keys(o.extra).forEach(function (k) { extra[k] = (extra[k] || 0) + o.extra[k] * x.amount; });
    (o.phyto || []).forEach(function (p) { phyto.push({ name: p, from: o.name }); });
    (o.eo || []).forEach(function (e) { var k = e.name; (eo[k] = eo[k] || { name: k, main: e.main || '', from: [] }).from.push(o.name); });
    items.push({ id: o.id, name: o.name, amount: x.amount, unit: o.unit, share: x.share, noLabel: NUT_KEYS.every(function (k) { return o[k] == null; }) && !Object.keys(o.extra).length });
  });
  return { tot: tot, extra: extra, items: items, phyto: phyto, eo: Object.keys(eo).map(function (k) { return eo[k]; }) };
}

// ---------- その日の栄養 ----------
// 記録（料理の並び）から食事の栄養の合計を出す。phyto＝{名前:[料理名…]}
function foodTot_(records, F) {
  var tot = {}, mapped = 0, all = 0, phyto = {}, byMeal = {};
  NUT_KEYS.forEach(function (k) { tot[k] = 0; });
  records.forEach(function (rec) {
    rec.dishes.forEach(function (d) {
      var p = d.shared ? d.portion : 1;
      (d.phyto || []).forEach(function (s) { (phyto[s] = phyto[s] || []).push(d.name); });
      d.ings.forEach(function (x) {
        all += x.kcal * p;
        var f = x.c && F.byCode[x.c];
        if (f) {
          mapped += x.kcal * p;
          NUT_KEYS.forEach(function (k) { if (k !== 'kcal' && f[k] != null) tot[k] += f[k] * x.grams / 100 * p; });
        }
        tot.kcal += x.kcal * p;
      });
    });
    byMeal[rec.meal] = (byMeal[rec.meal] || 0) + rec.total;
  });
  return { tot: tot, mapped: mapped, all: all, phyto: phyto, byMeal: byMeal };
}
function nutri_(date) {
  var D = day_(date), F = foods_();
  var FT = foodTot_(D.records, F), tot = FT.tot, mapped = FT.mapped, all = FT.all, phyto = FT.phyto, byMeal = FT.byMeal;
  // サプリを足す（食事の分は food に残す）
  var S = supTotals_(D.date), food = {};
  // サプリのフィトケミカル（原材料名から・量は不明）。「名前（原料）」の名前の部分で食事の分とまとめる
  S.phyto.forEach(function (p) { var nm = p.name.split('（')[0]; (phyto[nm] = phyto[nm] || []).push('サプリ：' + p.from); });
  NUT_KEYS.forEach(function (k) { food[k] = tot[k]; tot[k] += S.tot[k]; });
  var zero = {}; NUT_KEYS.forEach(function (k) { zero[k] = 0; });
  var A = judge_(tot, S.tot, food), B = judge_(food, zero, food);   // A＝サプリ込み・B＝食事だけ
  return { date: D.date, kcal: Math.round(tot.kcal), kcal0: Math.round(food.kcal), target: D.today.target,
           rows: A.rows, pfc: A.pfc, rows0: B.rows, pfc0: B.pfc, sup: S,
           coverage: all ? Math.round(mapped / all * 100) : 0, byMeal: byMeal,
           phyto: Object.keys(phyto).map(function (s) { return { name: s, from: phyto[s].filter(function (v, i, a) { return a.indexOf(v) === i; }) }; }),
           source: '日本食品標準成分表（八訂）増補2023年／日本人の食事摂取基準（2025年版）男性30〜49歳' };
}
// ---------- 期間の栄養（v0.6）：記録のある日の1日あたり平均・サプリ込み／食事だけ・日ごとの判定 ----------
// q = { days(7|30…), to('yyyy/MM/dd'・既定は今日) }
function nutriRange_(q) {
  var n = Math.min(90, Math.max(2, Number(q.days) || 7));
  var to = String(q.to || fmt_(new Date(), 'yyyy/MM/dd'));
  var tt = new Date(to.replace(/\//g, '-') + 'T12:00:00+09:00');
  var from = fmt_(new Date(tt.getTime() - (n - 1) * 86400000), 'yyyy/MM/dd');
  var R = recordsIn_(from, to), F = foods_(), M = supMaster_();
  var logs = {}; supLogs_('').forEach(function (x) { if (x.date >= from && x.date <= to) (logs[x.date] = logs[x.date] || []).push(x); });
  var dates = Object.keys(R).filter(function (d) { return R[d].length; }).sort();
  var sumF = {}, sumS = {}, zero = {}, mapped = 0, all = 0, phyto = {}, items = {}, eo = {}, days = [];
  NUT_KEYS.forEach(function (k) { sumF[k] = 0; sumS[k] = 0; zero[k] = 0; });
  dates.forEach(function (d) {
    var FT = foodTot_(R[d], F), S = supTotals_(d, M, logs[d] || []), w = {};
    mapped += FT.mapped; all += FT.all;
    NUT_KEYS.forEach(function (k) { sumF[k] += FT.tot[k]; sumS[k] += S.tot[k]; w[k] = FT.tot[k] + S.tot[k]; });
    Object.keys(FT.phyto).forEach(function (p) { (phyto[p] = phyto[p] || []).push.apply(phyto[p], FT.phyto[p]); });
    S.phyto.forEach(function (p) { var nm = p.name.split('（')[0]; (phyto[nm] = phyto[nm] || []).push('サプリ：' + p.from); });
    S.items.forEach(function (x) { var o = items[x.id] = items[x.id] || { name: x.name, unit: x.unit, days: 0, sum: 0, noLabel: x.noLabel }; o.days++; o.sum += x.amount; });
    (S.eo || []).forEach(function (e) { var o = eo[e.name] = eo[e.name] || { name: e.name, main: e.main, from: [] }; e.from.forEach(function (f) { if (o.from.indexOf(f) < 0) o.from.push(f); }); });
    var A = judge_(w, S.tot, FT.tot).rows, B = judge_(FT.tot, zero, FT.tot).rows;
    days.push({ date: d, kcal: Math.round(FT.tot.kcal), sup: S.items.length,
                ok: A.filter(function (x) { return x.status === 'ちょうど'; }).length,
                ok0: B.filter(function (x) { return x.status === 'ちょうど'; }).length,
                lack: A.filter(function (x) { return /少ない/.test(x.status); }).map(function (x) { return x.name; }),
                lack0: B.filter(function (x) { return /少ない/.test(x.status); }).map(function (x) { return x.name; }) });
  });
  var nd = dates.length || 1, avgF = {}, avgS = {}, avgT = {};
  NUT_KEYS.forEach(function (k) { avgF[k] = sumF[k] / nd; avgS[k] = sumS[k] / nd; avgT[k] = avgF[k] + avgS[k]; });
  var A = judge_(avgT, avgS, avgF), B = judge_(avgF, zero, avgF);
  var tgt = Math.round(Number(book_().getSheetByName(SH_SET).getRange('B10').getValue()) || 1800);
  return { range: true, from: from, to: to, span: n, nDays: dates.length, date: to,
           kcal: Math.round(avgT.kcal), kcal0: Math.round(avgF.kcal), target: tgt,
           rows: A.rows, pfc: A.pfc, rows0: B.rows, pfc0: B.pfc, days: days.reverse(), total: DRI_N_(),
           sup: { items: Object.keys(items).map(function (k) { var o = items[k]; return { name: o.name, unit: o.unit, days: o.days, amount: Math.round(o.sum / o.days * 100) / 100, noLabel: o.noLabel }; }),
                  extra: {}, eo: Object.keys(eo).map(function (k) { return eo[k]; }) },
           coverage: all ? Math.round(mapped / all * 100) : 0,
           phyto: Object.keys(phyto).map(function (s) { return { name: s, from: phyto[s].filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4) }; }),
           source: '日本食品標準成分表（八訂）増補2023年／日本人の食事摂取基準（2025年版）男性30〜49歳' };
}
function DRI_N_() { return Object.keys(DRI).length; }

// 合計（tot）を摂取基準で判定する。supTot＝そのうちサプリの分（葉酸の上限はサプリの分だけで比べる）
function judge_(tot, supTot, food) {
  var e = tot.kcal || 1;
  var pfc = { prot: tot.prot * 4 / e * 100, fat: tot.fat * 9 / e * 100, carb: tot.carb * 4 / e * 100 };
  var S = { tot: supTot };
  var rows = Object.keys(DRI).map(function (k) {
    var g = DRI[k], v = tot[k], st = '', ref = '', base = { key: k, name: g.name, unit: g.unit, value: v, food: food[k], sup: S.tot[k], kind: g.kind };
    if (g.pe) {
      var pe = pfc[k]; ref = g.pe[0] + '〜' + g.pe[1] + '%エネルギー';
      st = pe < g.pe[0] ? '少ない' : pe > g.pe[1] ? '多い' : 'ちょうど';
      if (k === 'prot' && v < g.min) st = '少ない';
      if (k === 'prot') ref = g.min + 'g以上・' + ref;
      base.pe = Math.round(pe); base.ref = ref; base.status = st; base.ratio = g.min ? v / g.min : null; return base;
    }
    if (g.max != null) { base.ref = g.max + g.unit + '未満'; base.status = v < g.max ? 'ちょうど' : '多い'; base.ratio = v / g.max; return base; }
    ref = g.min + g.unit + (g.kind === '目標量' ? '以上' : '');
    st = v >= g.min ? 'ちょうど' : v >= g.min * 0.7 ? 'やや少ない' : '少ない';
    // 耐容上限量（葉酸はサプリ由来の分だけで比べる）
    if (g.ul != null) {
      var uv = k === 'fol' ? S.tot[k] : v;
      ref += '・上限' + g.ul + g.unit + (k === 'fol' ? '（サプリ分）' : '');
      if (uv > g.ul) st = '上限超え';
    }
    base.ref = ref; base.status = st; base.ratio = v / g.min; return base;
  });
  return { rows: rows, pfc: pfc };
}

// ---------- 記録を書き換える（直す画面の「保存」） ----------
// q = { id, date('yyyy/MM/dd'), meal, time('HH:mm'), dishes:[dish…] }
function save_(q) {
  var sh = book_().getSheetByName(SH_LOG);
  ensureDataCol_(sh);
  var rows = rowsById_(sh, q.id);
  if (!rows.length) throw new Error('記録が見つかりません（' + q.id + '）');
  var first = rows[0], old = rows.length;
  var dishes = (q.dishes || []).map(normDish_).filter(function (d) { return d.name; });
  if (dishes.length) dishes = mapDishes_(dishes);   // 番号の無い材料だけ当てはめる
  if (!dishes.length) {
    // 全部消した：写真ごと記録を消す
    sh.deleteRows(first, old);
    return { deleted: true, today: today_(q.date) };
  }
  var d = new Date(String(q.date).replace(/\//g, '-') + 'T12:00:00+09:00');
  var at = sh.getRange(first, C.at).getValue();
  var base = { date: q.date, dow: dow_(d), meal: q.meal, time: String(q.time || ''), id: q.id,
               at: at instanceof Date ? fmt_(at, 'yyyy/MM/dd HH:mm') : String(at) };
  var n = dishes.length;
  if (n > old) sh.insertRowsAfter(first + old - 1, n - old);
  if (n < old) sh.deleteRows(first + n, old - n);
  writeRows_(sh, first, rowsOf_(dishes, base));
  var note = String(sh.getRange(first, C.note).getValue() || '');
  if (note.indexOf('画面で修正') < 0) sh.getRange(first, C.note).setValue((note ? note + '／' : '') + '画面で修正 ' + fmt_(new Date(), 'MM/dd HH:mm'));
  return { saved: n, total: dishes.reduce(function (s, x) { return s + dishKcal_(x); }, 0), today: today_(q.date) };
}

function rowsById_(sh, id) {
  var last = sh.getLastRow(), out = [];
  if (last < 2) return out;
  var ids = sh.getRange(2, C.id, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) out.push(i + 2);
  return out;
}

// データ列（N）が無い古いシートに見出しを足す
function ensureDataCol_(sh) {
  if (String(sh.getRange(1, C.data).getValue()) !== 'データ') {
    sh.getRange(1, C.data).setValue('データ').setFontWeight('bold').setBackground('#e8f0e8');
    sh.setColumnWidth(C.data, 60);
  }
}

// ---------- その日の記録（直す画面の一覧） ----------
function day_(date) {
  date = String(date || fmt_(new Date(), 'yyyy/MM/dd'));
  return { date: date, records: recordsIn_(date, date)[date] || [], today: today_(date) };
}
// from〜to（'yyyy/MM/dd'）の記録を日付ごとに → { 日付: [記録…] }（シートは1回だけ読む）
function recordsIn_(from, to) {
  var sh = book_().getSheetByName(SH_LOG);
  var last = sh.getLastRow(), recs = {}, order = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, NCOL).getValues().forEach(function (r) {
      var d = r[0] instanceof Date ? fmt_(r[0], 'yyyy/MM/dd') : String(r[0]);
      if (d < from || d > to) return;
      var id = String(r[C.id - 1]);
      if (!recs[id]) { recs[id] = { id: id, date: d, meal: String(r[C.meal - 1]), time: r[C.time - 1] instanceof Date ? fmt_(r[C.time - 1], 'HH:mm') : String(r[C.time - 1] || ''), dishes: [] }; order.push(id); }
      var dish;
      try { dish = normDish_(JSON.parse(r[C.data - 1])); } catch (e) {
        // データ列が無い古い行：材料は名前と分量だけ、カロリーは料理全体で1つ
        var names = String(r[C.ing - 1]).split('\n'), amts = String(r[C.amt - 1]).split('\n');
        dish = normDish_({ name: String(r[C.dish - 1]), ings: [{ name: names.join('・'), amount: amts.join('・'), grams: 0, kcal: Number(r[C.kcal - 1]) || 0 }] });
      }
      recs[id].dishes.push(dish);
    });
  }
  var mo = { '朝食': 1, '昼食': 2, '夕食': 3, '間食': 4 }, out = {};
  order.forEach(function (k) { var x = recs[k]; (out[x.date] = out[x.date] || []).push(x); });
  Object.keys(out).forEach(function (d) {
    out[d].sort(function (a, b) { return (mo[a.meal] || 9) - (mo[b.meal] || 9) || (a.time < b.time ? -1 : 1); });
    out[d].forEach(function (x) { x.total = x.dishes.reduce(function (s, dd) { return s + dishKcal_(dd); }, 0); });
  });
  return out;
}

// ---------- 切り抜いた写真を貼る ----------
function crop_(q) {
  var sh = book_().getSheetByName(SH_LOG);
  var rows = rowsById_(sh, q.id);
  if (!rows.length) throw new Error('記録が見つかりません（' + q.id + '）');
  var row = rows[0];
  var bytes = Utilities.base64Decode(q.b64);
  photoFolder_(new Date(), '切り抜き').createFile(Utilities.newBlob(bytes, 'image/jpeg', q.id + '_切り抜き.jpg'));
  var how = 'セル';
  try {
    var img = SpreadsheetApp.newCellImage().setSourceUrl('data:image/jpeg;base64,' + q.b64).setAltTextTitle('料理の写真 ' + q.id).build();
    sh.getRange(row, C.img).setValue(img);
  } catch (err) {
    var im = sh.insertImage(Utilities.newBlob(bytes, 'image/jpeg', q.id + '.jpg'), C.img, row);
    im.setWidth(110).setHeight(110);
    how = 'セルの上';
  }
  sh.setRowHeight(row, 120);
  return { row: row, how: how };
}

// ---------- 今日の合計 ----------
function today_(date) {
  var ss = book_();
  var sh = ss.getSheetByName(SH_LOG);
  var day = String(date || fmt_(new Date(), 'yyyy/MM/dd'));
  var total = 0, last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, C.kcal).getValues().forEach(function (r) {
      var d = r[0] instanceof Date ? fmt_(r[0], 'yyyy/MM/dd') : String(r[0]);
      if (d === day) total += Number(r[C.kcal - 1]) || 0;
    });
  }
  return { date: day, total: Math.round(total), target: Math.round(Number(ss.getSheetByName(SH_SET).getRange('B10').getValue()) || 1800) };
}

// ---------- 利用ログ（費用の実測用） ----------
// ---------- これまでの記録（v0.5）：日ごとのカロリー合計・品数・サプリの有無 ----------
function history_(days) {
  days = Math.min(120, Math.max(1, Number(days) || 60));
  var ss = book_(), sh = ss.getSheetByName(SH_LOG), last = sh.getLastRow(), by = {};
  var from = fmt_(new Date(Date.now() - (days - 1) * 86400000), 'yyyy/MM/dd');
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, C.id).getValues().forEach(function (r) {
      var d = r[0] instanceof Date ? fmt_(r[0], 'yyyy/MM/dd') : String(r[0]);
      if (!/^\d{4}\/\d{2}\/\d{2}$/.test(d) || d < from) return;
      var o = by[d] = by[d] || { date: d, dow: String(r[1] || ''), kcal: 0, ids: {}, meals: {} };
      o.kcal += Number(r[C.kcal - 1]) || 0; o.ids[String(r[C.id - 1])] = 1; o.meals[String(r[C.meal - 1])] = 1;
    });
  }
  supLogs_('').forEach(function (x) {
    if (x.date < from) return;
    var o = by[x.date] = by[x.date] || { date: x.date, dow: '', kcal: 0, ids: {}, meals: {} };
    o.sup = (o.sup || 0) + 1;
  });
  var target = Math.round(Number(ss.getSheetByName(SH_SET).getRange('B10').getValue()) || 1800);
  return { target: target, days: Object.keys(by).sort().reverse().map(function (k) {
    var o = by[k];
    return { date: o.date, dow: o.dow, kcal: Math.round(o.kcal), records: Object.keys(o.ids).length, meals: Object.keys(o.meals).filter(String), sup: o.sup || 0 };
  }) };
}

function useLog_(kind, u) {
  try {
    var inT = Number(u.promptTokenCount) || 0;
    var outT = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
    var yen = (inT * PRICE_IN + outT * PRICE_OUT) / 1e6 * USD_JPY;
    book_().getSheetByName(SH_USE).appendRow([fmt_(new Date(), 'yyyy/MM/dd HH:mm'), kind, inT, outT, Math.round(yen * 100) / 100]);
  } catch (e) { /* ログの失敗で記録を止めない */ }
}

// ---------- 設定（エディタから1回実行） ----------
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('NUTRI_TOKEN')) props.setProperty('NUTRI_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  var root = root_();
  var ss;
  if (props.getProperty('SHEET_ID')) {
    ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  } else {
    ss = SpreadsheetApp.create(BOOK_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    props.setProperty('SHEET_ID', ss.getId());
    ss.setSpreadsheetTimeZone('Asia/Tokyo');
  }
  var log = ss.getSheetByName(SH_LOG) || ss.getSheets()[0].setName(SH_LOG);
  if (!log.getRange(1, 1).getValue()) {
    log.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#e8f0e8');
    log.setFrozenRows(1);
    var w = [90, 40, 50, 50, 140, 160, 90, 90, 120, 150, 80, 220, 120, 60];
    for (var i = 0; i < w.length; i++) log.setColumnWidth(i + 1, w[i]);
  }
  var set = ss.getSheetByName(SH_SET) || ss.insertSheet(SH_SET);
  if (!set.getRange('A1').getValue()) {
    set.getRange('A1:C12').setValues([
      ['項目', '値', '説明'],
      ['性別', '男性', ''],
      ['年齢', 46, ''],
      ['身長(cm)', 170, ''],
      ['体重(kg)', 84, '体重が変わったら書き換える'],
      ['目標体重(kg)', 75, ''],
      ['活動量の係数', 1.375, '座り仕事＋週1〜3回の運動や歩き'],
      ['1日に使うカロリー(kcal)', '', '基礎代謝（Mifflin-St Jeor式）×活動量の係数'],
      ['医師・栄養指導の目標(kcal)', '', '数字が出たらここに入れる。入っていればこちらを優先'],
      ['1日の目安カロリー(kcal)', '', '医師の値があればその値／なければ「使うカロリー −500」を100単位で丸めた値'],
      ['', '', ''],
      ['注意', '', '目安です。医師・栄養指導の値があればそちらを優先してください']
    ]);
    set.getRange('B8').setFormula('=ROUND((10*B5+6.25*B4-5*B3+IF(B2="男性",5,-161))*B7)');
    set.getRange('B10').setFormula('=IF(B9<>"",B9,ROUND(B8-500,-2))');
    set.getRange('A1:C1').setFontWeight('bold').setBackground('#e8f0e8');
    set.setColumnWidth(1, 200); set.setColumnWidth(2, 90); set.setColumnWidth(3, 420);
  }
  setupLearn_(set);
  var use = ss.getSheetByName(SH_USE) || ss.insertSheet(SH_USE);
  if (!use.getRange('A1').getValue()) {
    use.getRange(1, 1, 1, 5).setValues([['日時', '種類', '入力トークン', '出力トークン', '推定(円)']]).setFontWeight('bold');
  }
  ensureDataCol_(log);
  Logger.log('保存フォルダ: ' + root.getUrl());
  Logger.log('シート: ' + ss.getUrl());
  Logger.log('Gemini のキー: ' + (prop_('GEMINI_API_KEY') ? 'あり' : 'なし（スクリプト プロパティ GEMINI_API_KEY を入れてください）'));
}

function setupLearn_(set) {
  if (String(set.getRange(LEARN_ROW, 1).getValue()) !== '覚えたこと') {
    set.getRange(LEARN_ROW, 1, 1, 3).setValues([['覚えたこと', '', '読み取りのたびに Gemini に渡す。1行に1つ。消せば使わなくなる']]).setFontWeight('bold').setBackground('#e8f0e8');
  }
}
