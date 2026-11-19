// 栄養管理アプリ v0.2 2026-11-19（実機1回目の指摘「全くあっていない・量が狂っている・修正もできない」への対応）
//   ・指示文を直した（器の大きさで量を見積もる／弁当は仕切りごと／未開封の容器は数えない／鍋は全体量＋取り分け）
//   ・直す画面用：記録の書き換え（save）・今日の記録（day）・文章で品を足す（estimate）・覚えたこと（設定タブ）
//   ・材料ごとのグラムとカロリーを「データ」列（N列）にJSONで持つ＝量を変えるとカロリーを計算し直せる
// v0.1 2026-11-19（写真1枚 → Gemini → シートに1品1行＋料理の部分を切り抜いた写真）
// 画面は GitHub Pages（Apps Script の画面ではマイクが使えない＝GrowBook Capture で実測済み）。ここは doPost で受ける
// 公開設定：実行＝自分／アクセス＝全員（外の画面から送るため）。本人以外は合言葉（t）で弾く
// 個人の健康データ。外向けのコンテンツに流用しない

var VERSION = 'nutrition-app v0.2';
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
    else if (q.action === 'today') data = today_();
    else if (q.action === 'day') data = day_(q.date);
    else if (q.action === 'save') data = save_(q);
    else if (q.action === 'estimate') data = estimate_(q);
    else if (q.action === 'learn') data = learn_(q.text);
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
    return { name: String(x.name || ''), amount: String(x.amount || ''), grams: g, kcal: k,
             g0: Number(x.g0) || g, k0: x.k0 != null ? Number(x.k0) : k };
  });
  return { name: String(d.name || ''), shared: !!d.shared, portion: Number(d.portion) || 1, ings: ings };
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
  var dishes = (r.dishes || []).map(normDish_);
  var base = { date: fmt_(when, 'yyyy/MM/dd'), dow: dow_(when), meal: meal, time: fmt_(when, 'HH:mm'), id: id, at: fmt_(new Date(), 'yyyy/MM/dd HH:mm') };
  var sh = book_().getSheetByName(SH_LOG);
  ensureDataCol_(sh);
  var start = sh.getLastRow() + 1;
  writeRows_(sh, start, rowsOf_(dishes, base));
  sh.getRange(start, C.src).setValue(src.getUrl());
  if (r.note) sh.getRange(start, C.note).setValue(String(r.note));
  return { id: id, isFood: true, meal: meal, date: base.date, time: base.time, dishes: dishes,
           total: dishes.reduce(function (s, d) { return s + dishKcal_(d); }, 0),
           crop: r.crop || null, note: r.note || '', today: today_() };
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
  name: { type: 'STRING' }, shared: { type: 'BOOLEAN' }, ingredients: { type: 'ARRAY', items: ING_SCHEMA }
}, required: ['name', 'shared', 'ingredients'] };
var SCHEMA = { type: 'OBJECT', properties: {
  is_food: { type: 'BOOLEAN' }, dishes: { type: 'ARRAY', items: DISH_SCHEMA },
  crop: { type: 'ARRAY', items: { type: 'INTEGER' } }, note: { type: 'STRING' }
}, required: ['is_food', 'dishes', 'crop', 'note'] };

function gemini_(parts, schema) {
  var key = prop_('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini のキーが未設定です');
  var payload = { contents: [{ parts: parts }],
                  // 考える量の上限 1024：上限なしは1回約2.4円・1024は約1.1円（11/19 実測）
                  generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema,
                                      thinkingConfig: { thinkingBudget: 1024 } } };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(key);
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
  return (r.dishes || []).map(normDish_);
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
  if (!dishes.length) {
    // 全部消した：写真ごと記録を消す
    sh.deleteRows(first, old);
    return { deleted: true, today: today_() };
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
  return { saved: n, total: dishes.reduce(function (s, x) { return s + dishKcal_(x); }, 0), today: today_() };
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
  var sh = book_().getSheetByName(SH_LOG);
  var last = sh.getLastRow(), recs = {}, order = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, NCOL).getValues().forEach(function (r) {
      var d = r[0] instanceof Date ? fmt_(r[0], 'yyyy/MM/dd') : String(r[0]);
      if (d !== date) return;
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
  var mo = { '朝食': 1, '昼食': 2, '夕食': 3, '間食': 4 };
  var list = order.map(function (k) { return recs[k]; });
  list.sort(function (a, b) { return (mo[a.meal] || 9) - (mo[b.meal] || 9) || (a.time < b.time ? -1 : 1); });
  list.forEach(function (x) { x.total = x.dishes.reduce(function (s, d) { return s + dishKcal_(d); }, 0); });
  return { date: date, records: list, today: today_() };
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
function today_() {
  var ss = book_();
  var sh = ss.getSheetByName(SH_LOG);
  var day = fmt_(new Date(), 'yyyy/MM/dd');
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
