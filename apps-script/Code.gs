/**
 * Rennic Jersey — Apps Script Backend
 * ----------------------------------------------------------------------
 * เวอร์ชันนี้ = เวอร์ชัน SECURED เดิม + ระบบรับเงินอัตโนมัติ (ชำระผ่าน QR แล้วยืนยันออเดอร์เอง)
 *
 * เพิ่มใหม่
 *   • create_order   สร้างออเดอร์ "รอชำระ" คำนวณราคา/ตรวจสต็อกที่ฝั่งเซิร์ฟเวอร์ (ไม่เชื่อราคาจากหน้าเว็บ)
 *                    จองสต็อก แล้วขอ QR จากผู้ให้บริการรับชำระเงิน
 *   • order_status   หน้าเว็บถามสถานะทุกไม่กี่วินาที (pending / paid / expired)
 *   • webhook        ผู้ให้บริการแจ้งว่าเงินเข้า -> ระบบถามยอดจากผู้ให้บริการซ้ำเพื่อยืนยัน
 *                    -> เปลี่ยนสถานะเป็น "ยืนยันแล้ว" + ตัดสต็อกจริง + แจ้ง Telegram
 *   • cancel_order   ลูกค้ากดยกเลิกเอง (คืนสต็อก)
 *   • หมดเวลา 15 นาที ถ้าไม่จ่าย -> ยกเลิกอัตโนมัติ + คืนสต็อก (ตั้ง trigger ด้วย setupTriggers)
 *   • ลูกค้าที่ล็อกอินเห็น "ออเดอร์ของฉัน" ได้แล้ว (ผูก uid ไว้ในคอลัมน์ P)
 *
 * ผู้ให้บริการรับชำระเงิน (Script Property: PAYMENT_PROVIDER)
 *   mock   ตัวจำลองสำหรับ "ทดสอบเท่านั้น" — ใครกดปุ่มจำลองก็ถือว่าจ่ายแล้ว ห้ามเปิดไว้บนเว็บที่ขายจริง
 *   omise  Opn Payments (Omise) PromptPay — เขียนไว้แล้วแต่ "ยังไม่ได้ทดสอบกับบัญชีจริง"
 *          ต้องทดสอบด้วย test key ก่อนใช้จริงเสมอ
 *
 * Script Properties ที่ต้องตั้ง (Project Settings > Script Properties)
 *   ADMIN_EMAIL         อีเมล Firebase ของแอดมิน
 *   TG_TOKEN, TG_CHAT   Telegram (ย้ายออกจากโค้ดแล้ว — ห้ามใส่ในโค้ดอีก)
 *   PAYMENT_PROVIDER    mock | omise
 *   OMISE_SECRET_KEY    (เฉพาะเมื่อใช้ omise) skey_test_... หรือ skey_...
 *
 * โครงสร้างชีต Order (A..K เหมือนเดิม ทุกอย่างในหน้า admin ใช้ต่อได้)
 *   A วันที่  B ชื่อ  C เบอร์  D ที่อยู่  E รายการ  F ยอด  G หมายเหตุ  H สถานะ
 *   I ขนส่ง  J เลขพัสดุ  K สลิป
 *   เพิ่มใหม่:  L orderId  M chargeId  N หมดเวลา(ISO)  O ชำระเมื่อ  P uid  Q รายการ(JSON)
 *   สถานะใหม่: "รอชำระ" -> "ยืนยันแล้ว" -> "จัดส่งแล้ว"
 */

// ── CONFIG ────────────────────────────────────────────────────────
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

var TG_TOKEN = prop_('TG_TOKEN');
var TG_CHAT  = prop_('TG_CHAT');
var FIREBASE_API_KEY = 'AIzaSyCaMuwi38-IL-3WE28WiRwiXR7CNXL4ngQ'; // public identifier ไม่ใช่ secret

var PUBLIC_READ_SHEETS = ['Store'];
var PAY_WINDOW_MIN = 15;          // เวลาที่ลูกค้ามีในการสแกนจ่าย
var MAX_PENDING_PER_PHONE = 2;    // กันคนกดจองสินค้าไว้เฉยๆ
var MAX_ITEMS_PER_ORDER = 10;
var MAX_QTY_PER_ITEM = 5;

var COL = { DATE:0, NAME:1, PHONE:2, ADDR:3, ITEMS:4, TOTAL:5, NOTE:6, STATUS:7, CARRIER:8, TRACKING:9, SLIP:10,
            ORDER_ID:11, CHARGE_ID:12, EXPIRES:13, PAID_AT:14, UID:15, ITEMS_JSON:16 };
var ST_WAIT = 'รอชำระ', ST_PAID = 'ยืนยันแล้ว', ST_SHIPPED = 'จัดส่งแล้ว', ST_REVIEW = 'ตรวจสอบยอด';

// ── AUTH HELPERS ──────────────────────────────────────────────────
function verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    var resp = UrlFetchApp.fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
      { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true }
    );
    var data = JSON.parse(resp.getContentText());
    if (data.users && data.users.length > 0) return data.users[0];
    return null;
  } catch (err) {
    Logger.log('verifyIdToken error: ' + err);
    return null;
  }
}
function getAdminEmail() { return prop_('ADMIN_EMAIL'); }
function isAdminUser(user) {
  var adminEmail = getAdminEmail();
  return !!(user && adminEmail && user.email === adminEmail);
}
function authError() { return out({ status: 'error', message: 'unauthorized' }); }

// ── TELEGRAM ──────────────────────────────────────────────────────
function pushTelegram(txt) {
  if (!TG_TOKEN || !TG_CHAT) return;
  UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({ chat_id: TG_CHAT, text: String(txt) }), muteHttpExceptions: true
  });
}
function pushTelegramPhoto(photoUrl, caption) {
  if (!TG_TOKEN || !TG_CHAT) return;
  UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendPhoto', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({ chat_id: TG_CHAT, photo: photoUrl, caption: String(caption) }), muteHttpExceptions: true
  });
}

// ══════════════════════════════════════════════════════════════════
// PAYMENT PROVIDERS — ทุกเจ้าต้องมี 2 ฟังก์ชันนี้
//   createCharge({orderId, amountSatang, description, expiresAtIso}) -> {chargeId, qrImage, qrPayload}
//   getCharge(chargeId) -> {id, paid:boolean, amountSatang:number, currency:'THB'}
// หัวใจความปลอดภัย: เราไม่เชื่อข้อความ webhook เลย แค่ใช้เป็นสัญญาณให้ "ถามผู้ให้บริการอีกครั้ง"
// ══════════════════════════════════════════════════════════════════
var PROVIDERS = {
  mock: {
    createCharge: function (o) {
      var id = 'mock_' + o.orderId;
      PropertiesService.getScriptProperties().setProperty('MOCK_AMT_' + id, String(o.amountSatang));
      return { chargeId: id, qrImage: '', qrPayload: 'MOCK-PAY:' + o.orderId };
    },
    getCharge: function (id) {
      var p = PropertiesService.getScriptProperties();
      return { id: id, paid: p.getProperty('MOCK_PAID_' + id) === '1',
               amountSatang: Number(p.getProperty('MOCK_AMT_' + id) || 0), currency: 'THB' };
    },
    cleanup: function (id) {
      var p = PropertiesService.getScriptProperties();
      p.deleteProperty('MOCK_PAID_' + id); p.deleteProperty('MOCK_AMT_' + id);
    }
  },
  // ⚠️ ยังไม่ได้ทดสอบกับ Omise จริง — ทดสอบด้วย skey_test_ ก่อน และเทียบกับเอกสาร https://docs.opn.ooo
  omise: {
    _auth: function () { return { Authorization: 'Basic ' + Utilities.base64Encode(prop_('OMISE_SECRET_KEY') + ':') }; },
    createCharge: function (o) {
      var resp = UrlFetchApp.fetch('https://api.omise.co/charges', {
        method: 'post', headers: this._auth(), muteHttpExceptions: true,
        payload: { amount: String(o.amountSatang), currency: 'thb', 'source[type]': 'promptpay',
                   description: o.description, 'metadata[orderId]': o.orderId, expires_at: o.expiresAtIso }
      });
      var d = JSON.parse(resp.getContentText());
      if (!d.id || d.object === 'error') throw new Error('omise: ' + (d.message || resp.getResponseCode()));
      var img = d.source && d.source.scannable_code && d.source.scannable_code.image && d.source.scannable_code.image.download_uri;
      return { chargeId: d.id, qrImage: img || '', qrPayload: '' };
    },
    getCharge: function (id) {
      var resp = UrlFetchApp.fetch('https://api.omise.co/charges/' + encodeURIComponent(id),
        { method: 'get', headers: this._auth(), muteHttpExceptions: true });
      var d = JSON.parse(resp.getContentText());
      if (!d.id) throw new Error('omise getCharge: ' + (d.message || resp.getResponseCode()));
      return { id: d.id, paid: d.paid === true && d.status === 'successful',
               amountSatang: Number(d.amount) || 0, currency: String(d.currency || '').toUpperCase() };
    },
    cleanup: function () {}
  }
};
function provider_() {
  var name = prop_('PAYMENT_PROVIDER');   // ต้องตั้งเองชัดเจน — ถ้าไม่ตั้ง ระบบจะไม่รับออเดอร์ (กันเผลอเปิดโหมดจำลองบนเว็บจริง)
  var p = PROVIDERS[name];
  if (!p) throw new Error('PAYMENT_PROVIDER ไม่ถูกต้องหรือยังไม่ได้ตั้ง: ' + name);
  return p;
}
function isMock_() { return prop_('PAYMENT_PROVIDER') === 'mock'; }

// ── doGet ─────────────────────────────────────────────────────────
function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = (e && e.parameter) || {};
  var name = p.sheet ? p.sheet : 'Store';
  var idToken = p.idToken;

  // สถานะออเดอร์ (สาธารณะ แต่ต้องรู้ orderId 32 ตัวอักษรที่เดาไม่ได้ และไม่คืนข้อมูลส่วนตัว)
  if (p.action === 'order_status') {
    try { return out(orderStatus_(String(p.orderId || ''))); }
    catch (err) { Logger.log('order_status ERROR: ' + err); return out({ status: 'error', message: 'status failed' }); }
  }

  if (PUBLIC_READ_SHEETS.indexOf(name) !== -1) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return out({ status: 'error', message: 'no sheet: ' + name });
    return out({ status: 'ok', data: sheet.getDataRange().getValues() });
  }

  if (name === 'Member') {
    var user = verifyIdToken(idToken);
    if (!user) return authError();
    var msheet = ss.getSheetByName('Member');
    if (!msheet) return out({ status: 'error', message: 'no sheet: Member' });
    var rows = msheet.getDataRange().getValues();
    if (isAdminUser(user)) return out({ status: 'ok', data: rows });
    var own = rows.filter(function (r, i) { return i === 0 || String(r[0]).trim() === user.localId; });
    return out({ status: 'ok', data: own });
  }

  if (name === 'Order') {
    var user2 = verifyIdToken(idToken);
    if (!user2) return authError();
    var osheet = ss.getSheetByName('Order');
    if (!osheet) return out({ status: 'error', message: 'no sheet: Order' });
    var orows = osheet.getDataRange().getValues();
    if (isAdminUser(user2)) return out({ status: 'ok', data: orows });
    // ผู้ใช้ทั่วไป: เห็นเฉพาะออเดอร์ที่ผูก uid ของตัวเอง (คอลัมน์ P) — ตัดข้อมูลภายในออก
    var mine = orows.filter(function (r, i) { return i > 0 && String(r[COL.UID] || '').trim() === user2.localId; })
      .map(function (r) { return r.slice(0, COL.SLIP + 1).concat(['', '', '', '', '', '']); });
    return out({ status: 'ok', scoped: true, data: [orows[0] || []].concat(mine) });
  }

  var user3 = verifyIdToken(idToken);
  if (!isAdminUser(user3)) return authError();
  var sheet3 = ss.getSheetByName(name);
  if (!sheet3) return out({ status: 'error', message: 'no sheet: ' + name });
  return out({ status: 'ok', data: sheet3.getDataRange().getValues() });
}

// ── doPost ────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var b = JSON.parse(e.postData.contents);
    var idToken = b.idToken;
    Logger.log('action=' + b.action + ' sheet=' + b.sheet);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── webhook จาก Omise (ไม่มี action) — ใช้เป็นแค่สัญญาณ แล้วไปถาม Omise ซ้ำ ──
    if (b.object === 'event') {
      if (b.key === 'charge.complete' && b.data && b.data.object === 'charge' && b.data.id) {
        confirmPaymentByCharge_(String(b.data.id));
      }
      return out({ status: 'ok' });
    }

    // ── ระบบรับเงิน (สาธารณะ) ──
    if (b.action === 'create_order') {
      var cuser = idToken ? verifyIdToken(idToken) : null; // ถ้า login อยู่ จะผูก uid ให้ดู "ออเดอร์ของฉัน"
      return out(createOrder_(b, cuser));
    }
    if (b.action === 'cancel_order') return out(cancelOrderByCustomer_(String(b.orderId || '')));
    if (b.action === 'payment_webhook') { // ใช้เรียกซ้ำมือ/ทดสอบ: ยังถามผู้ให้บริการอยู่ดี
      confirmPaymentByCharge_(String(b.chargeId || '')); return out({ status: 'ok' });
    }
    if (b.action === 'mock_pay') { // เฉพาะโหมดจำลองเท่านั้น
      if (!isMock_()) return authError();
      var oid = String(b.orderId || '');
      var rowInfo = findOrderRow_(oid);
      if (!rowInfo) return out({ status: 'error', message: 'order not found' });
      PropertiesService.getScriptProperties().setProperty('MOCK_PAID_' + rowInfo.values[COL.CHARGE_ID], '1');
      confirmPaymentByCharge_(String(rowInfo.values[COL.CHARGE_ID]));
      return out({ status: 'ok' });
    }

    // ── โหมดเดิม (โอน+แนบสลิป): ตัดสต็อกจากหน้าเว็บ ──
    if (b.action === 'updateQty') {
      var s = ss.getSheetByName(b.sheet || 'Store');
      var rows = s.getDataRange().getValues();
      var ri = -1;
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][0]).trim() === String(b.productId).trim()) { ri = i; break; }
      }
      if (ri < 0) return out({ status: 'error', message: 'product not found' });
      var delta = parseInt(b.delta) || 0;
      if (delta < -20 || delta > 20) return out({ status: 'error', message: 'invalid delta' });
      var q = {};
      try { q = JSON.parse(rows[ri][9] || '{}'); } catch (x) {}
      if (b.size && q.hasOwnProperty(b.size)) q[b.size] = Math.max(0, (parseInt(q[b.size]) || 0) + delta);
      s.getRange(ri + 1, 10).setValue(JSON.stringify(q));
      return out({ status: 'ok', qty: q });
    }

    if (b.action === 'append' && b.sheet === 'Order') {
      var d = b.data;
      if (!Array.isArray(d) || d.length < 6) return out({ status: 'error', message: 'invalid order data' });
      var phone = String(d[2] || '').trim();
      if (!/^0[0-9]{8,9}$/.test(phone)) return out({ status: 'error', message: 'invalid phone' });
      var total = Number(d[5]);
      if (!isFinite(total) || total <= 0 || total > 200000) return out({ status: 'error', message: 'invalid total' });
      var osheet = ss.getSheetByName('Order');
      osheet.appendRow(d);
      var msg = '📦 New Order - Rennic Jersey\n'
        + 'Name: ' + (d[1] || '-') + '\n' + 'Tel: ' + (d[2] || '-') + '\n'
        + 'Item:\n' + (d[4] || '-').split(',').map(function (x, i) { return (i + 1) + '. ' + x.trim(); }).join('\n') + '\n'
        + '💸 Total: ' + (d[5] || 0) + ' THB\n' + '📍 Address: ' + (d[3] || '-') + '\n'
        + (d[6] ? 'Note: ' + d[6] + '\n' : '') + 'Time: ' + (d[0] || '');
      var slipUrl = d[10] || '';
      if (slipUrl) pushTelegramPhoto(slipUrl, msg); else pushTelegram(msg);
      return out({ status: 'ok' });
    }

    if ((b.action === 'append' || b.action === 'update') && b.sheet === 'Member') {
      var muser = verifyIdToken(idToken);
      if (!muser) return authError();
      var callerUid = b.data && b.data[0];
      if (!isAdminUser(muser) && String(callerUid).trim() !== String(muser.localId).trim()) return authError();
      var msheet2 = ss.getSheetByName('Member');
      if (b.action === 'append') { msheet2.appendRow(b.data); return out({ status: 'ok' }); }
      msheet2.getRange(b.row, 1, 1, b.data.length).setValues([b.data]);
      return out({ status: 'ok' });
    }

    // ── ที่เหลือทั้งหมด: Admin เท่านั้น ──
    var user = verifyIdToken(idToken);
    if (!isAdminUser(user)) return authError();

    if (b.action === 'restoreQty') {
      var storeSheet = ss.getSheetByName('Store');
      var srows = storeSheet.getDataRange().getValues();
      var productName = String(b.productName || '').trim();
      var size = String(b.size || '').trim();
      var qty = parseInt(b.qty) || 1;
      for (var j = 1; j < srows.length; j++) {
        if (String(srows[j][1]).trim() === productName) {
          storeSheet.getRange(j + 1, 9).setValue('available');
          if (size) {
            var q2 = {};
            try { q2 = JSON.parse(srows[j][9] || '{}'); } catch (x) {}
            q2[size] = (parseInt(q2[size]) || 0) + qty;
            storeSheet.getRange(j + 1, 10).setValue(JSON.stringify(q2));
          }
          break;
        }
      }
      return out({ status: 'ok' });
    }

    var s2 = ss.getSheetByName(b.sheet || 'Sheet1');
    if (!s2) return out({ status: 'error', message: 'no sheet: ' + b.sheet });
    if (b.action === 'append') { s2.appendRow(b.data); return out({ status: 'ok' }); }
    if (b.action === 'update') {
      b.data.forEach(function (v, i) { s2.getRange(b.row, i + 1).setValue(v); });
      return out({ status: 'ok' });
    }
    if (b.action === 'delete') { s2.deleteRow(b.row); return out({ status: 'ok' }); }
    return out({ status: 'error', message: 'unknown action' });
  } catch (err) {
    Logger.log('ERROR: ' + err.toString());
    return out({ status: 'error', message: 'server error' });
  }
}

// ══════════════════════════════════════════════════════════════════
// ORDER / PAYMENT LOGIC
// ══════════════════════════════════════════════════════════════════
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function toMs_(v) { return (v instanceof Date) ? v.getTime() : Date.parse(v); }
function normPhone_(v) { return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, ''); }
function parseQty_(v) { try { var o = JSON.parse(v || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (x) { return {}; } }
function sumQty_(o) { var t = 0; for (var k in o) t += parseInt(o[k]) || 0; return t; }
function thaiNow_() {
  var d = new Date();
  var y = Number(Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy')) + 543;
  return Utilities.formatDate(d, 'Asia/Bangkok', 'd/M/') + y + ' ' + Utilities.formatDate(d, 'Asia/Bangkok', 'HH:mm:ss');
}
function ordersSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Order'); }
function storeSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Store'); }

/** คืน {row (1-based), values} หรือ null */
function findOrderRow_(orderId) {
  if (!orderId || orderId.length < 16) return null;
  var rows = ordersSheet_().getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][COL.ORDER_ID]) === orderId) return { row: i + 1, values: rows[i] };
  }
  return null;
}
function findChargeRow_(chargeId) {
  if (!chargeId) return null;
  var rows = ordersSheet_().getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][COL.CHARGE_ID]) === chargeId) return { row: i + 1, values: rows[i] };
  }
  return null;
}

function createOrder_(b, user) {
  var items = b.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS_PER_ORDER) return { status: 'error', code: 'invalid_items' };
  var name = String(b.name || '').trim().slice(0, 100);
  var phone = String(b.phone || '').trim();
  var address = String(b.address || '').trim().slice(0, 500);
  var note = String(b.note || '').trim().slice(0, 300);
  if (!name || !address) return { status: 'error', code: 'invalid_customer' };
  if (!/^0[0-9]{8,9}$/.test(phone)) return { status: 'error', code: 'invalid_phone' };

  return withLock_(function () {
    expirePendingNoLock_();

    var osheet = ordersSheet_(), ssheet = storeSheet_();
    var orders = osheet.getDataRange().getValues();
    var pendingForPhone = 0;
    for (var oi = 1; oi < orders.length; oi++) {
      if (String(orders[oi][COL.STATUS]) === ST_WAIT && normPhone_(orders[oi][COL.PHONE]) === normPhone_(phone)) pendingForPhone++;
    }
    if (pendingForPhone >= MAX_PENDING_PER_PHONE) return { status: 'error', code: 'too_many_pending' };

    var store = ssheet.getDataRange().getValues();
    var total = 0, lines = [], snapshot = [];
    var touched = {};   // rowIndex -> {qty: obj|null, pending: bool}
    for (var k = 0; k < items.length; k++) {
      var it = items[k] || {};
      var pid = String(it.id || '').trim();
      var qty = parseInt(it.qty) || 1;
      if (qty < 1 || qty > MAX_QTY_PER_ITEM) return { status: 'error', code: 'invalid_items' };
      var ri = -1;
      for (var r = 1; r < store.length; r++) { if (String(store[r][0]).trim() === pid) { ri = r; break; } }
      if (ri < 0) return { status: 'error', code: 'unavailable', productId: pid };
      var row = store[ri];
      if (String(row[8]).trim() !== 'available') return { status: 'error', code: 'unavailable', productId: pid };
      var price = Number(row[4]);
      if (!isFinite(price) || price <= 0) return { status: 'error', code: 'unavailable', productId: pid };
      var size = String(it.size || row[3] || '').trim();
      var t = touched[ri] || (touched[ri] = { qty: parseQty_(row[9]), pending: false });
      if (size && t.qty.hasOwnProperty(size)) {
        var have = parseInt(t.qty[size]) || 0;
        if (have < qty) return { status: 'error', code: 'out_of_stock', productId: pid, size: size };
        t.qty[size] = have - qty;
        if (sumQty_(t.qty) === 0) t.pending = true;
      } else {                       // สินค้าชิ้นเดียว (ไม่มี qty ตามไซส์)
        if (qty !== 1 || t.pending) return { status: 'error', code: 'out_of_stock', productId: pid, size: size };
        t.pending = true; t.single = true;
      }
      total += price * qty;
      lines.push(String(row[1]) + '(' + size + ')' + (qty > 1 ? ' x' + qty : ''));
      snapshot.push({ id: pid, name: String(row[1]), size: size, qty: qty, price: price });
    }
    if (!isFinite(total) || total <= 0 || total > 200000) return { status: 'error', code: 'invalid_total' };

    var orderId = Utilities.getUuid().replace(/-/g, '');
    var expires = new Date(Date.now() + PAY_WINDOW_MIN * 60 * 1000);
    var charge;
    try {
      charge = provider_().createCharge({
        orderId: orderId, amountSatang: Math.round(total * 100),
        description: 'Rennic Jersey ' + orderId.slice(0, 8).toUpperCase(),
        expiresAtIso: expires.toISOString()
      });
    } catch (err) {
      Logger.log('createCharge failed: ' + err);
      pushTelegram('⚠️ สร้าง QR ไม่สำเร็จ: ' + err);
      return { status: 'error', code: 'payment_provider_error' };
    }

    // จองสต็อกจริง (หลังขอ QR สำเร็จแล้วเท่านั้น)
    for (var key in touched) {
      var rowNo = Number(key) + 1, tt = touched[key];
      if (!tt.single) ssheet.getRange(rowNo, 10).setValue(JSON.stringify(tt.qty));
      if (tt.pending) ssheet.getRange(rowNo, 9).setValue('pending');
    }
    osheet.appendRow([thaiNow_(), name, phone, address, lines.join(', '), total, note, ST_WAIT, '', '', '',
      orderId, charge.chargeId, expires.toISOString(), '', user ? user.localId : '', JSON.stringify(snapshot)]);

    return { status: 'ok', orderId: orderId, ref: orderId.slice(0, 8).toUpperCase(), amount: total,
             expiresAt: expires.toISOString(), qrImage: charge.qrImage || '', qrPayload: charge.qrPayload || '',
             mock: isMock_() };
  });
}

/** คืนสต็อกตาม snapshot ของออเดอร์ (ไม่ล็อกเอง — ผู้เรียกต้องถือ lock) */
function restoreStockNoLock_(snapshot) {
  var ssheet = storeSheet_();
  var store = ssheet.getDataRange().getValues();
  snapshot.forEach(function (it) {
    for (var r = 1; r < store.length; r++) {
      if (String(store[r][0]).trim() !== String(it.id)) continue;
      var q = parseQty_(store[r][9]);
      if (it.size && q.hasOwnProperty(it.size)) {
        q[it.size] = (parseInt(q[it.size]) || 0) + it.qty;
        ssheet.getRange(r + 1, 10).setValue(JSON.stringify(q));
        store[r][9] = JSON.stringify(q);
      }
      ssheet.getRange(r + 1, 9).setValue('available');
      break;
    }
  });
}
function cancelRowNoLock_(rowInfo) {
  var snapshot = [];
  try { snapshot = JSON.parse(rowInfo.values[COL.ITEMS_JSON] || '[]'); } catch (x) {}
  restoreStockNoLock_(snapshot);
  try { provider_().cleanup(String(rowInfo.values[COL.CHARGE_ID])); } catch (x) {}
  ordersSheet_().deleteRow(rowInfo.row);
}

/** ยกเลิกออเดอร์ที่หมดเวลา — ถ้าผู้ให้บริการบอกว่าจ่ายแล้ว ให้ยืนยันแทน (กันเงินเข้าแต่ webhook พลาด) */
function expirePendingNoLock_() {
  var rows = ordersSheet_().getDataRange().getValues();
  var now = Date.now();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][COL.STATUS]) !== ST_WAIT) continue;
    var exp = toMs_(rows[i][COL.EXPIRES]);
    if (!exp || exp > now) continue;
    var info = { row: i + 1, values: rows[i] };
    var charge;
    try { charge = provider_().getCharge(String(rows[i][COL.CHARGE_ID])); } catch (err) { Logger.log('expire check failed: ' + err); continue; }
    if (charge.paid) { verifyAndFinalizeNoLock_(info, charge); }
    else { cancelRowNoLock_(info); }
  }
}
function expireTrigger() { withLock_(expirePendingNoLock_); }

function cancelOrderByCustomer_(orderId) {
  return withLock_(function () {
    var info = findOrderRow_(orderId);
    if (!info) return { status: 'ok', state: 'gone' };
    if (String(info.values[COL.STATUS]) !== ST_WAIT) return { status: 'error', code: 'not_cancellable' };
    var paid = false;
    try { paid = provider_().getCharge(String(info.values[COL.CHARGE_ID])).paid; } catch (x) {}
    if (paid) return { status: 'error', code: 'already_paid' };
    cancelRowNoLock_(info);
    return { status: 'ok', state: 'cancelled' };
  });
}

/** ผู้ให้บริการบอกว่าจ่ายแล้ว → ตรวจยอด/สกุลเงินให้ตรงกับออเดอร์ก่อนยืนยันเสมอ (ไม่ล็อกเอง)
 *  ถ้าไม่ตรง: ตั้งสถานะ "ตรวจสอบยอด" (เก็บสต็อกไว้) แจ้ง Telegram ครั้งเดียว ให้แอดมินตัดสินใจเอง */
function verifyAndFinalizeNoLock_(info, charge) {
  var expected = Math.round(Number(info.values[COL.TOTAL]) * 100);
  if (charge.amountSatang === expected && charge.currency === 'THB') {
    finalizePaidNoLock_(info, charge);
    return 'paid';
  }
  ordersSheet_().getRange(info.row, COL.STATUS + 1).setValue(ST_REVIEW);
  pushTelegram('⚠️ ยอดชำระไม่ตรง Ref ' + String(info.values[COL.ORDER_ID]).slice(0, 8).toUpperCase()
    + '\nควรได้ ' + (expected / 100) + ' THB แต่ได้ ' + (charge.amountSatang / 100) + ' ' + charge.currency
    + '\nไม่ได้ยืนยันอัตโนมัติ — เก็บสต็อกไว้ให้ ตรวจในชีต Order (สถานะ "' + ST_REVIEW + '") แล้วคืนเงินหรือยืนยันเอง');
  return 'mismatch';
}

/** เงินเข้าแล้ว: ตรวจยอดกับผู้ให้บริการ แล้วเปลี่ยนสถานะ + ตัดสต็อกถาวร + แจ้ง Telegram (ไม่ล็อกเอง) */
function finalizePaidNoLock_(info, charge) {
  var vals = info.values;
  var sheet = ordersSheet_();
  sheet.getRange(info.row, COL.STATUS + 1).setValue(ST_PAID);
  sheet.getRange(info.row, COL.PAID_AT + 1).setValue(new Date().toISOString());

  // สินค้าที่ขายหมดทุกไซส์ → ลบออกจาก Store (เหมือนที่หน้า admin ทำตอนกดยืนยัน)
  var snapshot = [];
  try { snapshot = JSON.parse(vals[COL.ITEMS_JSON] || '[]'); } catch (x) {}
  var ssheet = storeSheet_();
  var store = ssheet.getDataRange().getValues();
  var delRows = [];
  snapshot.forEach(function (it) {
    for (var r = 1; r < store.length; r++) {
      if (String(store[r][0]).trim() !== String(it.id)) continue;
      var q = parseQty_(store[r][9]);
      var soldOut = (String(store[r][8]).trim() === 'pending') && (Object.keys(q).length === 0 || sumQty_(q) === 0);
      if (soldOut && delRows.indexOf(r + 1) === -1) delRows.push(r + 1);
      break;
    }
  });
  delRows.sort(function (a, b) { return b - a; }).forEach(function (rn) { ssheet.deleteRow(rn); });
  try { provider_().cleanup(String(vals[COL.CHARGE_ID])); } catch (x) {}

  pushTelegram('✅ ชำระเงินแล้ว (อัตโนมัติ) - Rennic Jersey\n'
    + 'Ref: ' + String(vals[COL.ORDER_ID]).slice(0, 8).toUpperCase() + '\n'
    + 'Name: ' + vals[COL.NAME] + '\nTel: ' + vals[COL.PHONE] + '\n'
    + 'Item:\n' + String(vals[COL.ITEMS]).split(',').map(function (x, i) { return (i + 1) + '. ' + x.trim(); }).join('\n') + '\n'
    + '💸 Total: ' + vals[COL.TOTAL] + ' THB\n📍 Address: ' + vals[COL.ADDR]
    + (vals[COL.NOTE] ? '\nNote: ' + vals[COL.NOTE] : ''));
}

/** เรียกจาก webhook / mock_pay / order_status — ปลอดภัยต่อการเรียกซ้ำ */
function confirmPaymentByCharge_(chargeId) {
  if (!chargeId) return { state: 'ignored' };
  return withLock_(function () {
    var charge;
    try { charge = provider_().getCharge(chargeId); } catch (err) { Logger.log('getCharge failed: ' + err); return { state: 'error' }; }
    if (!charge.paid) return { state: 'pending' };
    var info = findChargeRow_(chargeId);
    if (!info) {
      pushTelegram('⚠️ มีเงินเข้าแต่หาออเดอร์ไม่เจอ (อาจหมดเวลา/ถูกยกเลิกไปแล้ว) ต้องตรวจและคืนเงินเอง\nCharge: ' + chargeId + '\nAmount: ' + (charge.amountSatang / 100) + ' THB');
      return { state: 'orphan' };
    }
    if (String(info.values[COL.STATUS]) !== ST_WAIT) return { state: 'already' };   // ซ้ำ = ไม่ทำอะไร
    return { state: verifyAndFinalizeNoLock_(info, charge) };
  });
}

function orderStatus_(orderId) {
  var info = findOrderRow_(orderId);
  if (!info) return { status: 'ok', state: 'gone' };   // ถูกยกเลิก/หมดเวลา (แถวถูกลบ)
  var v = info.values, st = String(v[COL.STATUS]);
  var base = { status: 'ok', ref: String(v[COL.ORDER_ID]).slice(0, 8).toUpperCase(), amount: Number(v[COL.TOTAL]), expiresAt: (v[COL.EXPIRES] instanceof Date ? v[COL.EXPIRES].toISOString() : v[COL.EXPIRES]) };
  if (st === ST_PAID || st === ST_SHIPPED) { base.state = 'paid'; base.orderStatus = st; return base; }
  if (st === ST_REVIEW) { base.state = 'review'; return base; }
  if (st !== ST_WAIT) { base.state = 'gone'; return base; }

  // รอชำระ: ถามผู้ให้บริการ (กันกรณี webhook ไม่มา) แต่ไม่ถี่เกิน 1 ครั้ง/5 วิ ต่อออเดอร์
  var cache = CacheService.getScriptCache();
  var key = 'poll_' + orderId.slice(0, 20);
  if (!cache.get(key)) {
    cache.put(key, '1', 5);
    var res = confirmPaymentByCharge_(String(v[COL.CHARGE_ID]));
    if (res.state === 'paid' || res.state === 'already') { base.state = 'paid'; base.orderStatus = ST_PAID; return base; }
    if (res.state === 'mismatch') { base.state = 'review'; return base; }
  }
  var exp = toMs_(v[COL.EXPIRES]);
  if (exp && exp <= Date.now()) {
    withLock_(expirePendingNoLock_);
    var again = findOrderRow_(orderId);
    if (!again) { base.state = 'expired'; return base; }
    if (String(again.values[COL.STATUS]) !== ST_WAIT) { base.state = 'paid'; base.orderStatus = String(again.values[COL.STATUS]); return base; }
  }
  base.state = 'pending';
  return base;
}

// ── ตั้งเวลาให้ระบบยกเลิกออเดอร์ที่หมดเวลาเองทุก 5 นาที (รันฟังก์ชันนี้ "ครั้งเดียว" จากหน้า editor) ──
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'expireTrigger' || t.getHandlerFunction() === 'expireTrigger_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('expireTrigger').timeBased().everyMinutes(5).create();
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function testNotify() { pushTelegram('Test from Rennic Jersey'); }
