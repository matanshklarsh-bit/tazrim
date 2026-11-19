// פענוח קבצי בנק וכרטיסים. פונקציות טהורות: מקבלות שורות (מערך של מערכים) ומחזירות תנועות + בדיקות.
// אין כאן נתונים כספיים. מספרי חשבון ות"ז לא נשמרים: מזהים רק לפי 4 ספרות אחרונות, ומסווים מספרים ארוכים בטקסט.

export const KINDS = { BANK: "bank", FX: "fx", ISRACARD: "isracard", CAL: "cal", MAX: "max" };
export const TYPE_LABEL = { bank: 'עו"ש (פועלים)', fx: 'מט"ח (פועלים)', isracard: 'ישראכרט "חיובים קרובים"', cal: "כאל", max: "מקס", paste: "הדבקה ידנית" };

const s = (v) => (v == null ? "" : String(v)).replace(/״/g, '"').replace(/׳/g, "'").replace(/''/g, '"').replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
const num = (v) => {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[,₪\s]/g, ""));
  return isNaN(n) ? null : n;
};
const r2 = (n) => Math.round(n * 100) / 100;

// תאריך → "YYYY-MM-DD". מספר = מספר סידורי של אקסל; מחרוזת dd-mm-yyyy / dd/mm/yyyy / yyyy-mm-dd.
export function iso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}

// מסווה רצפי ספרות ארוכים (חשבון, ת"ז, מזהה). מחזיר [טקסט, כמה הוסוו].
export function mask(text) {
  let n = 0;
  const out = s(text).replace(/\d[\d-]{4,}\d/g, (m) => { if (m.replace(/-/g, "").length >= 5) { n++; return "•••"; } return m; });
  return [out, n];
}

// מספר חשבון בכותרת → 4 ספרות אחרונות בלבד
function acctSuffix(rows) {
  for (const r of rows.slice(0, 12)) for (const c of r) {
    const m = s(c).match(/(\d{2,3})-(\d{3})-(\d{6})/) || s(c).match(/הפועלים (\d{3})-(\d{6})/);
    if (m) { const last = m[m.length - 1]; return last.slice(-4); }
  }
  return null;
}
const findRow = (rows, pred, from = 0) => { for (let i = from; i < rows.length; i++) if (pred(rows[i].map(s))) return i; return -1; };

export function detect(rows) {
  const flat = rows.slice(0, 12).map((r) => r.map(s).join("|")).join("\n");
  if (flat.includes("תנועות בחשבון") && flat.includes('יתרה בש"ח')) return KINDS.BANK;
  if (flat.includes('סה"כ שווי יתרות')) return KINDS.FX;
  if (flat.includes("חיובים קרובים") && rows.some((r) => s(r[0]).startsWith("פירוט עבור הכרטיסים"))) return KINDS.ISRACARD;
  if (flat.includes("פירוט עסקאות לחשבון") && flat.includes("לכרטיס")) return KINDS.CAL;
  if (flat.includes("4 ספרות אחרונות של כרטיס האשראי")) return KINDS.MAX;
  return null;
}

export function parse(rows) {
  const kind = detect(rows);
  if (!kind) return { kind: null, error: "סוג הקובץ לא זוהה" };
  const fn = { bank: parseBank, fx: parseFx, isracard: parseIsracard, cal: parseCal, max: parseMax }[kind];
  const res = fn(rows);
  res.kind = kind;
  if (res.txns.length) {
    const ds = res.txns.map((t) => t.date).filter(Boolean).sort();
    res.from = ds[0]; res.to = ds[ds.length - 1];
  }
  return res;
}

const link = (newer, older) => newer.balance != null && older.balance != null && Math.abs(r2(older.balance + newer.amount) - newer.balance) <= 0.01;
function chainBreaks(txns) {
  const t = txns.slice(); const out = [];
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i].balance == null || t[i + 1].balance == null || link(t[i], t[i + 1])) continue;
    // ניסיון החלפה: t[i+1] חדשה מ-t[i]
    if (i + 2 <= t.length && link(t[i + 1], t[i]) && (i + 2 === t.length || link(t[i], t[i + 2]))) {
      [t[i], t[i + 1]] = [t[i + 1], t[i]]; i++; continue;
    }
    out.push(`${t[i].date} ${t[i].desc} (${t[i].amount})`);
  }
  return out;
}

// ---------- עו"ש פועלים ----------
function parseBank(rows) {
  const h = findRow(rows, (r) => r.includes("תאריך") && r.includes("חובה") && r.includes("זכות"));
  const head = rows[h].map(s);
  const col = (name) => head.indexOf(name);
  const C = { date: col("תאריך"), act: col("הפעולה"), det: col("פרטים"), ref: col("אסמכתא"), dr: col("חובה"), cr: col("זכות"),
    bal: col('יתרה בש"ח'), val: col("תאריך ערך"), to: col("לטובת"), for: col("עבור") };
  const txns = []; let masked = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = iso(r[C.date]);
    if (!date) continue;
    const dr = num(r[C.dr]) || 0, cr = num(r[C.cr]) || 0;
    const [details, m1] = mask(r[C.det]); const [forTxt, m2] = mask(r[C.for]); const [cp, m3] = mask(r[C.to]);
    masked += m1 + m2 + m3;
    const action = s(r[C.act]);
    txns.push({
      date, valueDate: iso(r[C.val]), desc: action.replace(/\s*\(תאריך ערך:[^)]*\)/, ""), pending: /\(תאריך ערך:/.test(action),
      details, counterparty: cp, forText: forTxt, ref: s(r[C.ref]).replace(/\.0$/, ""),
      amount: r2(cr - dr), balance: num(r[C.bal])
    });
  }
  // שרשרת יתרות: השורות מהחדש לישן. יתרה[i] = יתרה[i+1] + סכום[i].
  // העברות ממתינות לפעמים מופיעות שורה אחת מוקדם מדי, ולכן מותר להחליף שתי שורות סמוכות אם זה סוגר את השרשרת.
  const breaks = chainBreaks(txns);
  const checks = [{ label: "שרשרת יתרות: כל יתרה = הקודמת ± הסכום", ok: breaks.length === 0, detail: breaks.slice(0, 5).join("; ") }];
  return { suffix: acctSuffix(rows), txns, checks, masked, lastBalance: txns[0] ? { date: txns[0].date, amount: txns[0].balance } : null };
}

// ---------- מט"ח פועלים ----------
function parseFx(rows) {
  const h = findRow(rows, (r) => r.includes("תיאור פעולה") && r.includes("זכות") && r.includes("חובה"));
  const head = rows[h].map(s);
  const col = (name) => head.indexOf(name);
  const C = { cur: col("מטבע"), date: col("תאריך"), act: col("תיאור פעולה"), val: col("יום ערך"), cr: col("זכות"), dr: col("חובה"), bal: col("יתרה במטבע"), ref: col("אסמכתא") };
  const txns = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]; const date = iso(r[C.date]);
    if (!date) continue;
    const dr = num(r[C.dr]) || 0, cr = num(r[C.cr]) || 0;
    txns.push({ date, valueDate: iso(r[C.val]), desc: s(r[C.act]), currency: s(r[C.cur]), ref: s(r[C.ref]).replace(/\.0$/, ""),
      amount: r2(cr - dr), balance: num(r[C.bal]) });
  }
  const breaks = chainBreaks(txns);
  // יתרה נוכחית מטבלת היתרות
  const bh = findRow(rows, (r) => r.includes("יתרה עדכנית במטבע"));
  let current = null;
  if (bh >= 0) {
    const bhead = rows[bh].map(s); const rr = rows[bh + 1] || [];
    current = { currency: s(rr[bhead.indexOf("מטבע")]), amount: num(rr[bhead.indexOf("יתרה עדכנית במטבע")]), ils: num(rr[bhead.indexOf("שווי משוערך")]) };
  }
  const checks = [{ label: "שרשרת יתרות במטבע", ok: breaks.length === 0, detail: breaks.join("; ") }];
  if (current && txns[0]) checks.push({ label: "היתרה העדכנית תואמת לתנועה האחרונה", ok: Math.abs(current.amount - txns[0].balance) < 0.01, detail: `${current.amount} מול ${txns[0].balance}` });
  return { suffix: acctSuffix(rows), txns, checks, masked: 0, fxBalance: current };
}

// ---------- ישראכרט "חיובים קרובים" ----------
function parseIsracard(rows) {
  const txns = []; const upcoming = []; const checks = [];
  for (let i = 0; i < rows.length; i++) {
    const title = s(rows[i][0]);
    // סיכומי חיוב קרוב: "רכישות בארץ" / "רכישות בחו"ל"
    if (title === "רכישות בארץ" || title === 'רכישות בחו"ל') {
      const h = findRow(rows, (r) => r[0] === "שם כרטיס", i);
      for (let j = h + 1; j < rows.length && s(rows[j][0]); j++) {
        const amt = num(rows[j][1]); const d = iso(rows[j][2]);
        if (amt != null && d) upcoming.push({ card: s(rows[j][0]), amount: amt, date: d, abroad: title !== "רכישות בארץ" });
      }
    }
    if (title.startsWith("פירוט עבור הכרטיסים")) {
      const h = findRow(rows, (r) => r[0] === "שם כרטיס", i);
      const head = rows[h].map(s);
      const col = (re) => head.findIndex((x) => re.test(x));
      const C = { card: 0, charge: col(/^חיוב לתאריך$/), date: col(/^תאריך$/), merchant: col(/^שם בית עסק$/),
        ils: col(/^סכום חיוב בש"ח$/), fcharge: col(/^סכום חיוב ב(דולר|יורו)$/), purchase: col(/^סכום קנייה$/),
        cur: col(/^(מטבע מקורי|מטבע)$/), ref: col(/^אסמכתא$/), type: col(/^תאור סוג עסקת אשראי$/), notes: col(/^הערות לעסקה$/) };
      const chargeCur = /בדו/.test(title) ? "USD" : /ביו/.test(title) ? "EUR" : "ILS";
      const abroad = /חו"ל/.test(title);
      for (let j = h + 1; j < rows.length && s(rows[j][0]); j++) {
        const r = rows[j];
        const charged = chargeCur === "ILS" ? num(r[C.ils]) : num(r[C.fcharge]);
        txns.push({
          card: s(r[C.card]), chargeDate: iso(r[C.charge]), date: iso(r[C.date]), desc: s(r[C.merchant]),
          amount: charged == null ? null : -charged, chargeCurrency: chargeCur, purchaseAmount: num(r[C.purchase]),
          purchaseCurrency: C.cur >= 0 ? s(r[C.cur]) || "ILS" : "ILS", ref: C.ref >= 0 ? s(r[C.ref]) : "",
          txType: C.type >= 0 ? s(r[C.type]) : "", notes: C.notes >= 0 ? s(r[C.notes]) : "", abroad
        });
      }
    }
  }
  // בדיקה: לכל חיוב קרוב, סכום העסקאות באותו כרטיס, תאריך וסוג (ארץ/חו"ל) שווה לסכום החיוב
  for (const u of upcoming) {
    const sum = r2(txns.filter((t) => t.card === u.card && t.chargeDate === u.date && t.abroad === u.abroad && t.chargeCurrency === "ILS")
      .reduce((a, t) => a - (t.amount || 0), 0));
    checks.push({ label: `כרטיס ${u.card}, חיוב ${u.date.slice(8, 10)}.${u.date.slice(5, 7)}${u.abroad ? ' (חו"ל)' : ""}: סכום העסקאות = סך החיוב`, ok: Math.abs(sum - u.amount) < 0.01, detail: `${sum} מול ${u.amount}` });
  }
  return { suffix: acctSuffix(rows), txns, checks, masked: 0, upcoming };
}

// ---------- כאל ----------
function parseCal(rows) {
  const title = s(rows[0][0]);
  const card = (title.match(/המסתיים ב-?(\d{4})/) || [])[1] || "";
  const hdr = rows.map((r) => s(r[0])).find((x) => /עסקאות לחיוב ב-/.test(x)) || "";
  const m = hdr.match(/ב-(\d{2}\/\d{2}\/\d{4}):\s*([\d,.]+)/);
  const chargeDate = m ? iso(m[1]) : null;
  const total = m ? num(m[2]) : null;
  const h = findRow(rows, (r) => r[0].startsWith("תאריך") && r.some((x) => x.startsWith("שם בית עסק")));
  const txns = [];
  for (let j = h + 1; j < rows.length; j++) {
    const r = rows[j]; const date = iso(r[0]);
    if (!date) continue;
    txns.push({ card, chargeDate, date, desc: s(r[1]), purchaseAmount: num(r[2]), purchaseCurrency: "ILS", amount: -(num(r[3]) || 0),
      chargeCurrency: "ILS", txType: s(r[4]), category: s(r[5]), notes: s(r[6]) });
  }
  const sum = r2(txns.reduce((a, t) => a - t.amount, 0));
  const checks = [{ label: "סכום העסקאות = סך החיוב בכותרת", ok: total != null && Math.abs(sum - total) < 0.01, detail: `${sum} מול ${total}` }];
  return { suffix: acctSuffix(rows), txns, checks, masked: 0, upcoming: chargeDate ? [{ card, date: chargeDate, amount: total }] : [] };
}

// ---------- מקס ----------
function parseMax(rows) {
  const h = findRow(rows, (r) => r.includes("תאריך עסקה") && r.includes("סכום חיוב"));
  const head = rows[h].map(s);
  const col = (n) => head.indexOf(n);
  const C = { date: col("תאריך עסקה"), merchant: col("שם בית העסק"), cat: col("קטגוריה"), card: col("4 ספרות אחרונות של כרטיס האשראי"),
    type: col("סוג עסקה"), amt: col("סכום חיוב"), orig: col("סכום עסקה מקורי"), charge: col("תאריך חיוב"), notes: col("הערות") };
  const txns = [];
  let j = h + 1;
  for (; j < rows.length; j++) {
    const r = rows[j]; const date = iso(r[C.date]);
    if (!date) break;
    txns.push({ card: s(r[C.card]), chargeDate: iso(r[C.charge]), date, desc: s(r[C.merchant]), category: s(r[C.cat]), txType: s(r[C.type]),
      amount: -(num(r[C.amt]) || 0), chargeCurrency: "ILS", purchaseAmount: num(r[C.orig]), purchaseCurrency: "ILS", notes: s(r[C.notes]) });
  }
  const ti = findRow(rows, (r) => r[0] === "סך הכל", j);
  const total = ti >= 0 ? num(s(rows[ti + 1]?.[0])) : null;
  const sum = r2(txns.reduce((a, t) => a - t.amount, 0));
  const checks = [{ label: "סכום העסקאות = סך הכל בקובץ", ok: total != null && Math.abs(sum - total) < 0.01, detail: `${sum} מול ${total}` }];
  const byDate = {};
  txns.forEach((t) => { const k = `${t.card}|${t.chargeDate}`; byDate[k] = r2((byDate[k] || 0) - t.amount); });
  const upcoming = Object.entries(byDate).map(([k, amount]) => ({ card: k.split("|")[0], date: k.split("|")[1], amount }));
  return { suffix: null, txns, checks, masked: 0, upcoming };
}

// מזהה קבוע לתנועה (למניעת כפילות בין קבצים חופפים)
export async function txnId(t, accountKey, occurrence) {
  const key = [accountKey, t.card || "", t.chargeDate || "", t.date, t.ref || "", t.desc, t.amount, t.balance ?? "", occurrence].join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- הדבקה ידנית מאתר חברת האשראי ----------
// מקבל טקסט שהועתק מטבלת עסקאות. כל עסקה מתחילה בתאריך. עובד גם כשהעמודות מופרדות בטאב וגם כשכל תא בשורה נפרדת.
const DATE_RE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/;
const AMT_RE = /^[-₪\s]*[\d,]+(\.\d{1,2})?[-₪\s]*$/;
const pasteAmt = (p) => { const n = num(p.replace(/[₪\s-]/g, "")); return n == null ? null : (p.includes("-") ? -n : n); };
// תגיות שמופיעות בטבלה ליד שם בית העסק ואינן השם עצמו
const TAGS = ["הוראת קבע", 'אתר חו"ל', "אתר חול", "עסקה בתשלומים", "תשלומים", "חיוב מיידי", "בקליטה", "עסקה רגילה", "עסקה טלפונית", "עסקת אינטרנט", 'חו"ל'];
export function parsePaste(text, card, chargeDate) {
  const cells = [];
  for (const line of String(text).split(/\r?\n/)) for (const c of line.split(/\t| {2,}|\s\|\s/)) { const v = s(c); if (v) cells.push(v); }
  const isAmt = (c) => AMT_RE.test(c) && /\d/.test(c);
  const isTag = (c) => /תשלום\s*\d+\s*מתוך\s*\d+/.test(c) || TAGS.includes(c);
  const firstDate = cells.findIndex((c) => DATE_RE.test(c)), firstAmt = cells.findIndex(isAmt);
  const recs = [];
  if (firstAmt >= 0 && firstAmt < firstDate) {
    // סדר "שם, סכום, תאריך, תגיות" (כמו באתר ישראכרט): עסקה נסגרת בתאריך ובתגיות שאחריו
    let buf = [];
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (/סה"?כ|סך הכל|סיכום/.test(c)) { buf = []; continue; }
      if (!DATE_RE.test(c)) { buf.push(c); continue; }
      const ai = buf.findIndex(isAmt);
      // שם = הטקסט שמיד לפני הסכום (מדלג על כותרות שהועתקו)
      const name = ai > 0 ? buf.slice(0, ai).filter((x) => !isAmt(x) && !isTag(x)).pop() : null;
      const parts = name ? [name, ...buf.slice(ai)] : buf.slice();
      while (i + 1 < cells.length && isTag(cells[i + 1])) parts.push(cells[++i]);
      recs.push({ dates: [c], parts });
      buf = [];
    }
  } else {
    let open = false;
    for (const c of cells) {
      if (DATE_RE.test(c)) { recs.push({ dates: [c], parts: [] }); open = true; }
      else if (/סה"?כ|סך הכל|סיכום/.test(c)) open = false; // שורת סיכום סוגרת את העסקה האחרונה
      else if (open) recs[recs.length - 1].parts.push(c);
    }
  }
  const txns = []; const skipped = [];
  for (const r of recs) {
    // תאריך חיוב בתוך השורה (אם יש) – נלקח כתאריך חיוב
    while (r.parts.length && DATE_RE.test(r.parts[0])) r.dates.push(r.parts.shift());
    let notes = "";
    const texts = []; const amts = [];
    const tags = [];
    for (let p of r.parts) {
      const inst = p.match(/תשלום\s*\d+\s*מתוך\s*\d+/);
      if (inst) { notes = inst[0]; p = p.replace(inst[0], "").trim(); if (!p) continue; }
      if (AMT_RE.test(p) && /\d/.test(p)) { amts.push(pasteAmt(p)); continue; }
      if (DATE_RE.test(p)) continue;
      // תגית בתחילת התא ("הוראת קבע מועצה...") מופרדת מהשם
      for (const t of TAGS) if (p === t || p.startsWith(t + " ")) { tags.push(t); p = p.slice(t.length).trim(); }
      if (p) texts.push(p);
    }
    if (!r.parts.length) continue; // תאריך בודד (למשל תאריך חיוב בעמודה נפרדת) – לא עסקה
    const desc = texts.sort((a, b) => b.length - a.length)[0] || tags[0] || "";
    if (!desc || !amts.length) { skipped.push([...r.dates, ...r.parts].join(" ")); continue; }
    const charged = amts[amts.length - 1];
    txns.push({ card, chargeDate: iso(r.dates[1]) || chargeDate, date: iso(r.dates[0]), desc, amount: -charged, chargeCurrency: "ILS",
      purchaseAmount: amts[0], purchaseCurrency: "ILS", notes, txType: tags.join(" · "), abroad: tags.some((t) => t.includes("חו")) });
  }
  return { kind: "paste", suffix: null, txns, checks: [], masked: 0, skipped };
}
