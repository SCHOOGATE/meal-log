// 栄養管理アプリ v0.1 2026-11-19（手順①：写真1枚 → Gemini で読み取り → シートに1品1行＋料理の部分を切り抜いた写真）
// 画面は GitHub Pages（Apps Script の画面ではマイクが使えない＝GrowBook Capture で実測済み）。ここは doPost で受ける
// 公開設定：実行＝自分／アクセス＝全員（外の画面から送るため）。本人以外は合言葉（t）で弾く
// 個人の健康データ。外向けのコンテンツに流用しない
// 次の段階：② 音声で追加・修正 ／ ③ 一覧画面・翌日の調整の目安

var VERSION = 'nutrition-app v0.1';
var ROOT_NAME = '栄養管理アプリ';
var BOOK_NAME = '栄養管理_記録';
var GEMINI_MODEL = 'gemini-2.5-flash';
var USD_JPY = 150;                         // 利用ログの円換算（目安）
var PRICE_IN = 0.30, PRICE_OUT = 2.50;     // 100万トークンあたりのドル（2.5 Flash・画像/文字の入力／出力）

var SH_LOG = '記録', SH_SET = '設定', SH_USE = '利用ログ';
var HEAD = ['日付', '曜日', '区分', '時刻', '献立名', '材料名', '分量', 'カロリー(kcal)', '写真', '記録ID', '元の写真', '読み取りメモ', '登録日時'];
var C = { date: 1, dow: 2, meal: 3, time: 4, dish: 5, ing: 6, amt: 7, kcal: 8, img: 9, id: 10, src: 11, note: 12, at: 13 };
var DOW = ['日', '月', '火', '水', '木', '金', '土'];

// ---------- 入口 ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  return ContentService.createTextOutput(p.v ? VERSION : 'ok');
}

// { t, action: 'ping'|'photo'|'crop'|'today', ... } → { ok:true, data } / { ok:false, error }
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

// ---------- 写真を読み取る ----------
// q = { b64(jpeg), ts(撮影時刻ミリ秒), meal('自動'|'朝食'|…), note }
function photo_(q) {
  if (!q.b64) throw new Error('写真が空です');
  var when = new Date(Number(q.ts) || Date.now());
  var id = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss') + '-' + Math.random().toString(36).slice(2, 6);

  // 元の写真をドライブへ（あとで見直せるように）
  var src = photoFolder_(when, '元').createFile(Utilities.newBlob(Utilities.base64Decode(q.b64), 'image/jpeg', id + '.jpg'));

  var r = gemini_(q.b64, String(q.note || ''));
  if (!r.is_food) {
    return { id: id, isFood: false, note: r.note || '料理が写っていないようです', srcUrl: src.getUrl() };
  }
  var meal = (q.meal && q.meal !== '自動') ? q.meal : mealOf_(when);
  var dishes = (r.dishes || []).map(function (d) {
    var ings = d.ingredients || [];
    var kcal = Math.round(Number(d.kcal) || ings.reduce(function (s, x) { return s + (Number(x.kcal) || 0); }, 0));
    return { name: String(d.name || ''), ings: ings, kcal: kcal };
  });
  var total = dishes.reduce(function (s, d) { return s + d.kcal; }, 0);

  var sh = book_().getSheetByName(SH_LOG);
  var dateStr = Utilities.formatDate(when, 'Asia/Tokyo', 'yyyy/MM/dd');
  var timeStr = Utilities.formatDate(when, 'Asia/Tokyo', 'HH:mm');
  var dow = DOW[Number(Utilities.formatDate(when, 'Asia/Tokyo', 'u')) % 7];
  var at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  var rows = dishes.map(function (d, i) {
    return [dateStr, dow, meal, timeStr, d.name,
      d.ings.map(function (x) { return x.name || ''; }).join('\n'),
      d.ings.map(function (x) { return x.amount || ''; }).join('\n'),
      d.kcal, '', id,
      i === 0 ? src.getUrl() : '',
      i === 0 ? String(r.note || '') : '',
      at];
  });
  if (rows.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, HEAD.length).setValues(rows);
    sh.getRange(start, C.time, rows.length, 1).setNumberFormat('@');
    sh.getRange(start, 1, rows.length, HEAD.length).setVerticalAlignment('top').setWrap(true);
  }
  useLog_('写真', r._usage);
  return { id: id, isFood: true, meal: meal, date: dateStr, time: timeStr, dishes: dishes, total: total,
           crop: r.crop || null, note: r.note || '', srcUrl: src.getUrl(), today: today_() };
}

function mealOf_(d) {
  var h = Number(Utilities.formatDate(d, 'Asia/Tokyo', 'H'));
  if (h >= 4 && h < 10) return '朝食';
  if (h >= 11 && h < 14) return '昼食';
  if (h >= 17 && h < 22) return '夕食';
  return '間食';
}

var PROMPT = [
  'この写真は、食事の記録のために撮った料理の写真です。病院の栄養指導に出す「食事内容記録表」（献立名・材料名・分量）を埋めるために読み取ってください。',
  '・dishes: 写っている料理と飲み物を1品ずつ。name＝献立名（例：ご飯、野菜炒め、味噌汁、ビール）',
  '・ingredients: その料理の材料。name＝材料名、amount＝分量（家庭で分かる単位。例：100g、1個、2枚、茶碗1杯、350ml、少々）、kcal＝その材料のカロリー',
  '・油・マヨネーズ・ドレッシング・砂糖・バターなどカロリーの大きい調味料は、使われていそうなら材料に入れる（分量は見た目の推定でよい）',
  '・分量とカロリーは、写真の見た目から日本の一般的な1人前と日本食品標準成分表の値を目安に推定する。kcal は料理の合計',
  '・大皿を何人かで分ける料理は、1人が食べる量（一般的な1人前）として推定する',
  '・crop: 料理と飲み物がすべて入る最小の四角を [ymin, xmin, ymax, xmax]（画像の上端・左端を0、下端・右端を1000とした整数）で。テーブルの余白・手・スマホ・ほかの物はできるだけ外す',
  '・is_food: 料理も飲み物も写っていなければ false（そのとき dishes は空）',
  '・note: 写真だけでは判断しにくい点を短く（例：ご飯の量が器で隠れている、ソースの中身が分からない）。なければ空文字',
  '・日本語で答える'
].join('\n');

var SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN' },
    dishes: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      name: { type: 'STRING' },
      kcal: { type: 'NUMBER' },
      ingredients: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        name: { type: 'STRING' }, amount: { type: 'STRING' }, kcal: { type: 'NUMBER' }
      }, required: ['name', 'amount', 'kcal'] } }
    }, required: ['name', 'kcal', 'ingredients'] } },
    crop: { type: 'ARRAY', items: { type: 'INTEGER' } },
    note: { type: 'STRING' }
  },
  required: ['is_food', 'dishes', 'crop', 'note']
};

function gemini_(b64, userNote) {
  var key = prop_('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini のキーが未設定です');
  var parts = [{ text: PROMPT + (userNote ? '\n・本人のメモ（優先して反映する）：' + userNote : '') },
               { inline_data: { mime_type: 'image/jpeg', data: b64 } }];
  var payload = { contents: [{ parts: parts }],
                  // 考える量の上限 1024：上限なしは1回約2.4円・1024は約1.1円で品数はむしろ細かい・0は約0.3円だが品を落とす（11/19 実測）
                  generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA,
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

// ---------- 切り抜いた写真を貼る ----------
// q = { id, b64(切り抜いて縮めた jpeg) }
function crop_(q) {
  var sh = book_().getSheetByName(SH_LOG);
  var last = sh.getLastRow();
  if (last < 2) throw new Error('記録が見つかりません');
  var ids = sh.getRange(2, C.id, last - 1, 1).getValues();
  var row = 0;
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(q.id)) { row = i + 2; break; }
  if (!row) throw new Error('記録が見つかりません（' + q.id + '）');
  var bytes = Utilities.base64Decode(q.b64);
  photoFolder_(new Date(), '切り抜き').createFile(Utilities.newBlob(bytes, 'image/jpeg', q.id + '_切り抜き.jpg'));
  var cell = sh.getRange(row, C.img);
  var how = 'セル';
  try {
    var img = SpreadsheetApp.newCellImage().setSourceUrl('data:image/jpeg;base64,' + q.b64)
      .setAltTextTitle('料理の写真 ' + q.id).build();
    cell.setValue(img);
  } catch (err) {
    // セルに入らないときは、セルの上に置く
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
  var day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  var total = 0, last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, C.kcal).getValues().forEach(function (r) {
      var d = r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Tokyo', 'yyyy/MM/dd') : String(r[0]);
      if (d === day) total += Number(r[C.kcal - 1]) || 0;
    });
  }
  return { date: day, total: Math.round(total), target: target_(ss) };
}

function target_(ss) {
  var v = ss.getSheetByName(SH_SET).getRange('B10').getValue();
  return Math.round(Number(v) || 1800);
}

// ---------- 利用ログ（費用の実測用） ----------
function useLog_(kind, u) {
  try {
    var inT = Number(u.promptTokenCount) || 0;
    var outT = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
    var yen = (inT * PRICE_IN + outT * PRICE_OUT) / 1e6 * USD_JPY;
    book_().getSheetByName(SH_USE).appendRow([Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'), kind, inT, outT, Math.round(yen * 100) / 100]);
  } catch (e) { /* ログの失敗で記録を止めない */ }
}

// ---------- 設定（エディタから1回実行） ----------
// 合言葉の発行・保存フォルダとシートの作成。CEO の数値は初期値（設定タブで直せる）
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
    var w = [90, 40, 50, 50, 140, 160, 90, 90, 120, 150, 80, 220, 120];
    for (var i = 0; i < w.length; i++) log.setColumnWidth(i + 1, w[i]);
  }
  var set = ss.getSheetByName(SH_SET) || ss.insertSheet(SH_SET);
  if (!set.getRange('A1').getValue()) {
    set.getRange('A1:C12').setValues([
      ['項目', '値', '説明'],
      ['性別', '男性', ''],
      ['年齢', 46, ''],
      ['身長(cm)', 170, ''],
      ['体重(kg)', 84, '体重が変わったら書き換える（③で画面から記録できるようにする）'],
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
  var use = ss.getSheetByName(SH_USE) || ss.insertSheet(SH_USE);
  if (!use.getRange('A1').getValue()) {
    use.getRange(1, 1, 1, 5).setValues([['日時', '種類', '入力トークン', '出力トークン', '推定(円)']]).setFontWeight('bold');
  }
  Logger.log('保存フォルダ: ' + root.getUrl());
  Logger.log('シート: ' + ss.getUrl());
  Logger.log('Gemini のキー: ' + (prop_('GEMINI_API_KEY') ? 'あり' : 'なし（スクリプト プロパティ GEMINI_API_KEY を入れてください）'));
  Logger.log('合言葉は設定済み（スクリプト プロパティ NUTRI_TOKEN）');
}

// 動作確認：キーが通り、モデルが使えるか
function checkGemini() {
  var key = prop_('GEMINI_API_KEY');
  if (!key) { Logger.log('キーがありません'); return; }
  var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + '?key=' + encodeURIComponent(key), { muteHttpExceptions: true });
  Logger.log('モデル確認 ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 150));
}
