// תזרים – שלב 1: כניסה, בדיקת הרשאה, קריאת הגיליון של נועה והצגתו.
// אין בקוד הזה נתונים כספיים. הכול נקרא בזמן ריצה מהגיליון ומ-Firestore.
// אין שליחת לוגים לשום שירות חיצוני.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, signInWithCredential
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, getDocs, collection, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { viewImport, bindImport, loadImports, freshness, viewTxns, bindTxns } from "./importer.js";
import { detectRecurring, buildEvents, series, lowPoint, expectReceivables, transferAdvice, iso as isoD, addDays } from "./forecast.js";
import { viewForecast, bindForecast, viewRecurring, bindRecurring } from "./fviews.js";

const firebaseConfig = {
  apiKey: "AIzaSyBxOsOGAgVoQkWAu2Qx6lsrFbfAJo6u5RQ",
  authDomain: "tazrim-6f509.firebaseapp.com",
  projectId: "tazrim-6f509",
  storageBucket: "tazrim-6f509.firebasestorage.app",
  messagingSenderId: "1017969263066",
  appId: "1:1017969263066:web:f69d73d4bb2fd1473d80e3"
};

// אפליקציית הרכב (niro903): קוראים רק את רשימת התשלומים הגדולים הצפויים שהיא מפרסמת
const NIRO_CONFIG = { apiKey: "AIzaSyDfKga2DSpCfnm8T8HKZWBEqSZXLmZLCJs", authDomain: "niro903.firebaseapp.com", projectId: "niro903", appId: "1:82448186668:web:2578f5d94d2eec39114089" };
const INSURANCE_PAYMENTS = 12; // ביטוח משולם בתשלומים; ההנחה: 12 תשלומים חודשיים מיום החידוש
const SHEET_ID = "1JpEHYmGRkkhvRZKCDXQjJ67uHyFetXwTHvrbpEeRhBg";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TABS = {
  balances: "יתרות",
  owe: "אני חייב",
  supplierPayments: "תשלומים לספקים",
  owed: "חייבים לי",
  payments: "תשלומים",
  allocations: "שיוכים",
  expected: "חיובים צפויים",
  timing: "זמני תשלום"
};
const ACCOUNTS = [
  { key: "פרטי", label: "פרטי", limitKey: "private" },
  { key: "עסקי 151", label: "עסקי 151", limitKey: "business" }
];
const TOKEN_KEY = "tazrim.sheetsToken";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.addScope(SHEETS_SCOPE);
provider.setCustomParameters({ prompt: "select_account" });

const state = { user: null, settings: null, data: null, loadedAt: null, tab: "home", sub: "", imports: [], bank: [], niro: null, F: null, error: null };
const $view = document.getElementById("view");
const $tabs = document.getElementById("tabs");
const $fresh = document.getElementById("freshness");
const $refresh = document.getElementById("refreshBtn");

// ---------- כלים ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });
const money = (n) => (n == null || isNaN(n)) ? "—" : `<span class="num ${n < 0 ? "neg" : ""}">${n < 0 ? "-" : ""}${nf.format(Math.abs(n))} ₪</span>`;
const toNum = (v) => {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[,₪\s]/g, ""));
  return isNaN(n) ? null : n;
};
const toDate = (v) => {
  if (!v) return null;
  const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(v);
  return isNaN(d) ? null : d;
};
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const fmtDate = (d) => d ? `${d.getDate()}.${d.getMonth() + 1}${d.getFullYear() !== new Date().getFullYear() ? "." + String(d.getFullYear()).slice(2) : ""}` : "—";
const ago = (d) => {
  if (!d) return "לא ידוע";
  const n = dayDiff(new Date(), d);
  if (n <= 0) return "היום";
  if (n === 1) return "אתמול";
  return `לפני ${n} ימים`;
};

// ---------- טוקן לגיליון ----------
function saveToken(cred) {
  if (!cred?.accessToken) return;
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ t: cred.accessToken, exp: Date.now() + 55 * 60 * 1000 }));
}
function getToken() {
  try {
    const o = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    return o && o.exp > Date.now() ? o.t : null;
  } catch { return null; }
}
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

let signingIn = false;
async function signIn() {
  signingIn = true;
  try {
    const res = await signInWithPopup(auth, provider);
    saveToken(GoogleAuthProvider.credentialFromResult(res));
    handled = res.user.uid;
    await afterSignIn(res.user);
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      showError("הכניסה נכשלה: " + (e.code || "שגיאה לא ידועה"));
    }
  } finally {
    signingIn = false;
  }
}

// ---------- גיליון ----------
async function readSheet() {
  const token = getToken();
  if (!token) return { needToken: true };
  const params = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
  Object.values(TABS).forEach((t) => params.append("ranges", `'${t}'!A1:Z2000`));
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 401) { clearToken(); return { needToken: true }; }
  if (res.status === 403 || res.status === 404) return { noAccess: true };
  if (!res.ok) throw new Error("sheets_" + res.status);
  const json = await res.json();
  const out = {}, heads = {};
  Object.keys(TABS).forEach((k, i) => {
    const rows = json.valueRanges[i]?.values || [];
    heads[k] = (rows[0] || []).map((h) => norm(String(h)));
    out[k] = toObjects(rows);
  });
  return { data: out, heads };
}
// גרשיים עבריים (״ ׳) וסימני כיווון נראים זהים לעין אבל שונים למחשב. מאחדים לפני כל השוואה.
const norm = (v) => typeof v === "string" ? v.replace(/\u05F4/g, '"').replace(/\u05F3/g, "'").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim() : v;
function toObjects(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h) => norm(String(h)));
  return rows.slice(1)
    .filter((r) => r.some((c) => c !== "" && c != null))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, norm(r[i] ?? "")])));
}

// ---------- חוזה קריאה (LOG-0009, אושר ע"י מתן 18.11.2026) ----------
// כותרות חובה לכל לשונית. כותרת חסרה או כפולה עוצרת את האפליקציה עם הודעה גלויה.
const REQUIRED = {
  balances: ["מזהה קבוע", "תאריך ושעת הצילום", "חשבון או כרטיס", "סוג", "סכום (₪)", "מועד החיוב", 'אושר ע"י מתן', "סטטוס רישום", "חשבון לחיוב"],
  owe: ["מזהה קבוע", "ספק", "סוג חיוב", "סכום (₪)", "תאריך המסמך", "חשבון לתשלום", "סטטוס", "סטטוס רישום"],
  supplierPayments: ["מזהה קבוע", "מזהה חוב", "תאריך תשלום", "סכום ששולם (₪)", "חשבון", "סטטוס רישום"],
  owed: ["מזהה קבוע", "מספר חשבונית", "לקוח", 'סכום כולל מע"מ (₪)', "סטטוס", "סטטוס רישום", "מספר חשבון עסקה", "תאריך חשבון עסקה"],
  payments: ["מזהה קבוע", "תאריך כניסה לבנק", "סכום שנכנס (₪)", "חשבון", "סטטוס רישום"],
  allocations: ["מזהה קבוע", "מזהה תשלום", "מזהה חשבונית", "סכום משויך (₪)", "ניכוי במקור (₪)", "סטטוס רישום"],
  expected: ["מזהה קבוע", "סוג", "תקופה", "סכום (₪)", "מועד מוקדם", "מועד מאוחר", "בסיס המועד", "חשבון לתשלום", "סטטוס", "סטטוס רישום"],
  timing: ["לקוח", "מספר שרשראות", "חציון (ימים)"]
};
const RECEIVABLE_ACTIVE = ["פתוחה", "שולמה חלקית"];
const RECEIVABLE_CLOSED = ["שולמה", "בוטל", "חוב אבוד"]; // היסטוריה: לא נפתחת מחדש ולא נכנסת לגבייה
const DEBT_ACTIVE = ["פתוח"];
const DEBT_CLOSED = ["שולם"];
const EXPECTED_ACTIVE = ["צפוי"];
const EXPECTED_CLOSED = ["שולם", "בוטל"];
const APPROVED = ["כן", "לא נדרש"];
const regOk = (r) => (r["סטטוס רישום"] || "").trim() === "תקין";

function checkHeaders(heads) {
  const problems = [];
  for (const [k, req] of Object.entries(REQUIRED)) {
    const h = heads[k] || [];
    for (const name of req) if (!h.includes(name)) problems.push(`בלשונית "${TABS[k]}" חסרה הכותרת "${name}"`);
    const dup = h.filter((x, i) => x && h.indexOf(x) !== i);
    for (const name of new Set(dup)) problems.push(`בלשונית "${TABS[k]}" הכותרת "${name}" מופיעה פעמיים`);
  }
  return problems;
}

// ---------- חישובים (נתונים מדודים בלבד, בלי הערכות) ----------
function compute(d) {
  const today = startOfToday();
  const review = []; // שורות לבירור: לא מנחשים ולא משמיטים בשקט
  const flag = (tab, r, why) => review.push({ tab, id: r["מזהה קבוע"] || "(ללא מזהה)", why });

  // יתרות: רק רישום תקין ואישור "כן"/"לא נדרש". 2165 ושאר הכרטיסים לא נכנסים ליתרות העו"ש.
  const pendingApproval = [];
  const BALANCE_TYPES = ['יתרת עו"ש', "חיוב הבא", 'יתרת מט"ח'];
  const balances = d.balances.filter((r) => {
    if (!BALANCE_TYPES.includes(r["סוג"])) { flag(TABS.balances, r, `סוג "${r["סוג"] || "ריק"}" לא מוכר`); return false; }
    if (!regOk(r)) { flag(TABS.balances, r, `סטטוס רישום "${r["סטטוס רישום"] || "ריק"}"`); return false; }
    const ap = (r['אושר ע"י מתן'] || "").trim();
    if (!APPROVED.includes(ap)) { pendingApproval.push(r); return false; }
    return true;
  });
  const accounts = ACCOUNTS.map((a) => {
    const snaps = balances
      .filter((r) => r["חשבון או כרטיס"] === a.key && r["סוג"] === 'יתרת עו"ש')
      .map((r) => ({ amount: toNum(r["סכום (₪)"]), at: toDate(r["תאריך ושעת הצילום"]), id: r["מזהה קבוע"] }))
      .filter((s) => s.amount != null && s.at)
      .sort((x, y) => y.at - x.at);
    return { ...a, latest: snaps[0] || null };
  });
  // מידע בלבד: כרטיס נטען 2165 ויתרת המט"ח (חיסכון לטיול) לא נכנסים ליתרות העו"ש ולתחזית
  const infoOnly = balances.filter((r) => (r["סוג"] === 'יתרת עו"ש' || r["סוג"] === 'יתרת מט"ח') && !ACCOUNTS.some((a) => a.key === r["חשבון או כרטיס"]))
    .map((r) => ({ name: r["חשבון או כרטיס"], amount: toNum(r["סכום (₪)"]) }));

  // חיובי כרטיסים: אותו כרטיס + אותו מועד חיוב נספר פעם אחת, לפי הצילום העדכני
  const cycles = new Map();
  balances.filter((r) => r["סוג"] === "חיוב הבא").forEach((r) => {
    const due = toDate(r["מועד החיוב"]);
    const at = toDate(r["תאריך ושעת הצילום"]);
    const key = `${r["חשבון או כרטיס"]}|${r["מועד החיוב"]}`;
    const prev = cycles.get(key);
    if (!prev || (at && (!prev.at || at > prev.at))) {
      cycles.set(key, { card: r["חשבון או כרטיס"], amount: Math.abs(toNum(r["סכום (₪)"]) || 0), // חיוב הוא תמיד יציאה, גם אם נרשם עם מינוס
         due, at, account: r["חשבון לחיוב"] });
    }
  });
  const cardCharges = [...cycles.values()].filter((c) => c.due && c.due >= today).sort((a, b) => a.due - b.due);
  const pendingCards = pendingApproval.filter((r) => r["סוג"] === "חיוב הבא" && toDate(r["מועד החיוב"]) >= today);

  // חיובים צפויים: נכנסים במועד המוקדם. מועד שעבר לא נחשב ששולם.
  const expectedAll = [];
  d.expected.forEach((r) => {
    const st = (r["סטטוס"] || "").trim();
    if (EXPECTED_CLOSED.includes(st)) return;
    if (!EXPECTED_ACTIVE.includes(st)) { flag(TABS.expected, r, `סטטוס "${st || "ריק"}" לא מוכר`); return; }
    if (!regOk(r)) { flag(TABS.expected, r, `סטטוס רישום "${r["סטטוס רישום"] || "ריק"}"`); return; }
    expectedAll.push({
      type: r["סוג"], period: r["תקופה"], amount: toNum(r["סכום (₪)"]),
      early: toDate(r["מועד מוקדם"]), late: toDate(r["מועד מאוחר"]), basis: r["בסיס המועד"], account: r["חשבון לתשלום"]
    });
  });
  expectedAll.sort((a, b) => (a.early || 0) - (b.early || 0));
  const expected = expectedAll.filter((e) => e.early && (!e.late || e.late >= today));
  const expectedPast = expectedAll.filter((e) => e.late && e.late < today);
  const expectedNoDate = expectedAll.filter((e) => !e.early);

  // חובות לספקים: יתרה = סכום פחות תשלומי ספקים תקינים שנרשמו בפועל
  const paidByDebt = {};
  d.supplierPayments.forEach((p) => {
    if (!regOk(p)) { flag(TABS.supplierPayments, p, `סטטוס רישום "${p["סטטוס רישום"] || "ריק"}"`); return; }
    const id = p["מזהה חוב"]; const a = toNum(p["סכום ששולם (₪)"]);
    if (id && a) paidByDebt[id] = (paidByDebt[id] || 0) + a;
  });
  const debts = [];
  d.owe.forEach((r) => {
    const st = (r["סטטוס"] || "").trim();
    if (DEBT_CLOSED.includes(st)) return;
    if (!DEBT_ACTIVE.includes(st)) { flag(TABS.owe, r, `סטטוס "${st || "ריק"}" לא מוכר`); return; }
    if (!regOk(r)) { flag(TABS.owe, r, `סטטוס רישום "${r["סטטוס רישום"] || "ריק"}"`); return; }
    const amount = toNum(r["סכום (₪)"]) || 0;
    const paid = paidByDebt[r["מזהה קבוע"]] || 0;
    const docDate = toDate(r["תאריך המסמך"]);
    if (amount - paid > 0) debts.push({
      id: r["מזהה קבוע"], supplier: r["ספק"], kind: r["סוג חיוב"], docNo: r["מספר מסמך של הספק"],
      amount, paid, open: amount - paid, docDate, age: docDate ? dayDiff(today, docDate) : null, account: r["חשבון לתשלום"]
    });
  });
  debts.sort((a, b) => (a.docDate ? a.docDate.getTime() : Infinity) - (b.docDate ? b.docDate.getTime() : Infinity));

  // חובות לקוחות: רק "פתוחה"/"שולמה חלקית". שולמה/בוטל/חוב אבוד הם היסטוריה ולא נפתחים מחדש.
  // יתרה = סכום פחות שיוכים תקינים (שיוך "ראיה בלבד" אינו שיוך כספי).
  const allocByInv = {};
  d.allocations.forEach((a) => {
    if (!regOk(a)) return;
    const id = a["מזהה חשבונית"];
    const s = (toNum(a["סכום משויך (₪)"]) || 0) + (toNum(a["ניכוי במקור (₪)"]) || 0);
    if (id) allocByInv[id] = (allocByInv[id] || 0) + s;
  });
  const receivables = [];
  d.owed.forEach((r) => {
    const st = (r["סטטוס"] || "").trim();
    if (RECEIVABLE_CLOSED.includes(st)) return;
    if (!RECEIVABLE_ACTIVE.includes(st)) { flag(TABS.owed, r, `סטטוס "${st || "ריק"}" לא מוכר`); return; }
    if (!regOk(r)) { flag(TABS.owed, r, `סטטוס רישום "${r["סטטוס רישום"] || "ריק"}"`); return; }
    const amount = toNum(r['סכום כולל מע"מ (₪)']) || 0;
    const open = amount - (allocByInv[r["מזהה קבוע"]] || 0);
    const proformaDate = toDate(r["תאריך חשבון עסקה"]);
    if (open <= 0) { flag(TABS.owed, r, "מסומנת פתוחה אבל השיוכים מכסים את הסכום"); return; }
    receivables.push({
      id: r["מזהה קבוע"], client: r["לקוח"], invoice: r["מספר חשבונית"], proforma: r["מספר חשבון עסקה"],
      amount, open, proformaDate, age: proformaDate ? dayDiff(today, proformaDate) : null, status: st, noticeDate: toDate(r["תאריך הודעת תשלום"])
    });
  });
  receivables.sort((a, b) => (a.proformaDate ? a.proformaDate.getTime() : Infinity) - (b.proformaDate ? b.proformaDate.getTime() : Infinity));

  // חיובים ידועים ב-30 הימים הקרובים לכל חשבון (כרטיסים וחיובים צפויים מהגיליון בלבד)
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + 30);
  const known30 = {};
  cardCharges.filter((c) => c.due <= horizon).forEach((c) => { known30[c.account] = (known30[c.account] || 0) + (c.amount || 0); });
  expected.filter((e) => e.early <= horizon).forEach((e) => { known30[e.account] = (known30[e.account] || 0) + (e.amount || 0); });
  // חיוב צפוי שמועדו עבר ועדיין "צפוי" לא נחשב ששולם: נספר כחיוב מיידי
  expectedPast.forEach((e) => { known30[e.account] = (known30[e.account] || 0) + (e.amount || 0); });

  // תשלומים שנכנסו בפועל: רק עם תאריך כניסה לבנק וחשבון (אסמכתא בלי אלה אינה תנועת מזומן)
  const receipts = d.payments.filter((p) => regOk(p) && toDate(p["תאריך כניסה לבנק"]) && ACCOUNTS.some((a) => a.key === p["חשבון"]))
    .map((p) => ({ date: toDate(p["תאריך כניסה לבנק"]), account: p["חשבון"], amount: toNum(p["סכום שנכנס (₪)"]) || 0, label: `תקבול ${p["מזהה קבוע"]}` }));

  return { receipts, accounts, infoOnly, cardCharges, pendingCards, expected, expectedPast, expectedNoDate, debts, receivables, known30, review, timing: d.timing };
}

// ---------- תצוגה ----------
// ---------- תחזית ----------
const ADVICE_DAYS = 30;
async function loadBank() {
  const snap = await getDocs(query(collection(db, "txns"), where("src", "==", "bank")));
  state.bank = snap.docs.map((d) => d.data());
}
let niroApp = null;
async function loadNiro(popup = false) {
  try {
    niroApp ||= initializeApp(NIRO_CONFIG, "niro");
    const auth2 = getAuth(niroApp);
    await auth2.authStateReady();
    if (!auth2.currentUser) {
      if (popup) await signInWithPopup(auth2, new GoogleAuthProvider());
      else {
        const token = getToken();
        if (!token) { state.niro = { error: "צריך חיבור מחדש", needLogin: true }; return; }
        try { await signInWithCredential(auth2, GoogleAuthProvider.credential(null, token)); }
        catch (e) { state.niro = { error: "צריך להתחבר פעם אחת ל-niro903", needLogin: true }; return; }
      }
    }
    const app2 = niroApp;
    const snap = await getDoc(doc(getFirestore(app2), "users", auth2.currentUser.uid, "meta", "forecast"));
    state.niro = snap.exists() ? snap.data() : { error: "עוד לא פורסם צפי. צריך לפתוח את niro903 פעם אחת." };
  } catch (e) {
    state.niro = { error: "לא הצלחתי לקרוא את niro903 (" + (e.code || "שגיאה") + ")" };
  }
}
function carEvents(today, horizonEnd) {
  const out = [];
  for (const x of state.niro?.items || []) {
    const name = `${x.title} (${x.car})`;
    if (x.cat === "insurance") {
      const per = Math.round(x.amount / INSURANCE_PAYMENTS);
      for (let k = 0; k < INSURANCE_PAYMENTS; k++) {
        const d = new Date(x.date + "T12:00:00"); d.setMonth(d.getMonth() + k);
        const date = isoD(d);
        if (date >= today && date <= horizonEnd) out.push({ date, account: "רכב", amount: -per, label: `${name}, תשלום ${k + 1}/${INSURANCE_PAYMENTS}`, type: "loan", certainty: "estimate", basis: `לפי השנה האחרונה, בהנחה של ${INSURANCE_PAYMENTS} תשלומים`, src: "niro903" });
      }
    } else if (x.date >= today && x.date <= horizonEnd) {
      out.push({ date: x.date, account: "רכב", amount: -x.amount, label: name, type: "loan", certainty: "estimate", basis: x.cat === "tires" || x.cat === "service" ? "לפי קצב הנסיעה" : "לפי השנה האחרונה", src: "niro903" });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function computeForecast(c) {
  const today = isoD(new Date());
  const horizonEnd = addDays(today, 90);
  const st = state.settings || {};
  // נקודת התחלה: צילום היתרה של נועה, או היתרה בקובץ הבנק אם הוא חדש יותר
  const start = {};
  for (const a of c.accounts) {
    if (a.latest) start[a.key] = { date: isoD(a.latest.at), bal: a.latest.amount, src: "צילום נועה" };
    const bankImp = state.imports.filter((im) => im.kind === "bank" && im.account === a.key && im.lastBalance).sort((x, y) => (y.to > x.to ? 1 : -1))[0];
    if (bankImp && (!start[a.key] || bankImp.lastBalance.date > start[a.key].date)) start[a.key] = { date: bankImp.lastBalance.date, bal: bankImp.lastBalance.amount, src: "קובץ בנק" };
  }
  const recurring = detectRecurring(state.bank, today);
  const receivables = expectReceivables(c.receivables.map((r) => ({ ...r, proformaDate: r.proformaDate ? isoD(r.proformaDate) : null, noticeDate: r.noticeDate ? isoD(r.noticeDate) : null })), c.timing, today);
  const sheet = {
    cardCharges: c.cardCharges.map((x) => ({ card: x.card, amount: x.amount, due: isoD(x.due), account: x.account })),
    expected: c.expected.map((e) => ({ ...e, early: e.early ? isoD(e.early) : null, late: e.late ? isoD(e.late) : null })),
    expectedPast: c.expectedPast.map((e) => ({ ...e, early: e.early ? isoD(e.early) : null })),
    receipts: c.receipts.map((p) => ({ ...p, date: isoD(p.date) })),
    receivables
  };
  const events = buildEvents({ start, horizonEnd, recurring, sheet, overrides: st.recurringOverrides || {}, manual: st.manualRecurring || [], today });
  const accts = ACCOUNTS.filter((a) => start[a.key]).map((a) => {
    const evs = events.filter((e) => e.account === a.key);
    // הסדרה מתחילה היום (אירועים שבין הצילום להיום כבר נכללים בה)
    const full = (exp) => series(start[a.key].bal, start[a.key].date, evs, horizonEnd, exp).filter((p) => p.date >= today);
    const expected = full(true), worst = full(false);
    // ההמלצות והנקודה הנמוכה במסך הבית: 30 יום. רחוק מזה התחזית נשלטת ע"י הכנסות שעוד לא ידועות.
    const inH = (sr) => sr.filter((p) => p.date <= addDays(today, ADVICE_DAYS));
    return { ...a, expected, worst, lowExp: lowPoint(inH(expected)), lowWorst: lowPoint(inH(worst)) };
  });
  const advice = st.limits && accts.length === 2 ? transferAdvice(accts.map((a) => ({ ...a, worst: a.worst.filter((p) => p.date <= addDays(today, ADVICE_DAYS)) })), st.limits, st.cushion || 0) : [];
  return { today, start, events, recurring, accts, advice, receivables, car: carEvents(today, horizonEnd), niroError: state.niro?.error || null };
}

const importCtx = {
  db,
  get imports() { return state.imports; },
  getSettings: () => state.settings,
  saveSettings: async (settings) => { await setDoc(doc(db, "settings", "main"), settings); state.settings = settings; state.F = state.data ? computeForecast(state.data) : null; },
  reloadImports: async () => { state.imports = await loadImports(db); await loadBank(); state.F = state.data ? computeForecast(state.data) : null; },
  rerender: () => render()
};

async function render() {
  $tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  const c = state.data;
  if (!c) return;
  renderFreshness(c);
  if (state.tab === "more" && state.sub === "import") {
    $view.innerHTML = viewImport(importCtx); bindImport($view, importCtx); bindViewEvents(); return;
  }
  if (state.tab === "more" && state.sub === "recurring") {
    $view.innerHTML = viewRecurring(state.F, state.settings);
    bindRecurring($view, () => state.settings, async (st) => { await importCtx.saveSettings(st); render(); }); bindViewEvents(); return;
  }
  if (state.tab === "forecast") {
    $view.innerHTML = state.F && state.F.accts.length ? viewForecast(state.F, state.settings) : `<div class="card muted">אין נקודת התחלה: חסר צילום יתרה.</div>`;
    bindForecast($view, render); return;
  }
  if (state.tab === "more" && state.sub === "txns") {
    $view.innerHTML = `<div class="center muted">טוען תנועות…</div>`;
    $view.innerHTML = await viewTxns(importCtx); bindTxns($view, importCtx); bindViewEvents(); return;
  }
  const views = { home: viewHome,
    decide: viewDecide, insights: viewSoon("תובנות", "קטגוריות, מינויים, ביטוחים ועלות הכסף. נבנה בשלב 5, אחרי ייבוא הקבצים."), more: viewMore };
  $view.innerHTML = (state.error ? `<div class="error">${esc(state.error)}</div>` : "") + views[state.tab](c);
  bindViewEvents();
}

function renderFreshness(c) {
  const latest = c.accounts.map((a) => a.latest?.at).filter(Boolean).sort((a, b) => a - b)[0];
  const stale = latest && dayDiff(new Date(), latest) > 7;
  $fresh.hidden = false;
  const fr = freshness(state.imports);
  const frTxt = Object.entries(fr).map(([k, v]) => { const d = toDate(v); return `${esc(k)}: <span class="${dayDiff(new Date(), d) > 7 ? "stale" : ""}">${fmtDate(d)}</span>`; }).join(" · ");
  $fresh.innerHTML = `${frTxt ? `קבצים: ${frTxt}<br>` : ""}יתרות: <span class="${stale ? "stale" : ""}">${ago(latest)}</span> · גיליון נועה: נקרא ${state.loadedAt ? state.loadedAt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "—"}`;
}

function acctColor(bal, limit, cushion) {
  if (bal == null || !limit) return "";
  const room = bal + limit;
  if (room < 0) return "red";
  if (room < (cushion || 0)) return "yellow";
  return "green";
}

function viewHome(c) {
  const s = state.settings;
  const F = state.F;
  let html = "";
  if (!s?.limits) html += `<div class="notice">עוד לא הוגדרו מסגרות. <a href="#" data-goto="more">להגדרה</a></div>`;
  if (c.expectedPast.length) html += `<div class="notice">${c.expectedPast.map((e) => `${esc(e.type)} (${money(e.amount)}, ${fmtDate(e.late)})`).join(", ")}: המועד עבר והשורה עדיין מסומנת "צפוי" בגיליון. עד שנועה תעדכן, זה נספר כחיוב שעוד לא ירד.</div>`;
  if (c.review.length) html += `<div class="notice">${c.review.length} שורות בגיליון מחכות לבירור ולא נכללו. <a href="#" data-goto="more">לפרטים</a></div>`;
  if (c.pendingCards.length) html += `<div class="notice">${c.pendingCards.map((r) => esc(r["חשבון או כרטיס"])).join(", ")}: יש חיוב קרוב שעוד לא אושר, ולכן הוא לא נספר.</div>`;
  if (c.expectedNoDate.length) html += `<div class="notice">${c.expectedNoDate.map((e) => esc(e.type)).join(", ")}: חיוב צפוי בלי מועד. מוצג כחסר.</div>`;

  const total = c.accounts.reduce((t, a) => t + (a.latest?.amount || 0), 0);
  const lowW = F?.accts.length === 2 ? F.accts[0].lowWorst.bal + 0 : null;
  html += `<div class="card"><div class="muted small">סך היתרות (פרטי + עסקי)</div>
    <div class="big">${c.accounts.every((a) => a.latest) ? money(total) : "חסר"}</div>
    <div class="muted small">המסגרות לא מצטברות, כל חשבון נבדק מול המסגרת שלו.</div></div>`;

  // מה לעשות
  const todo = [];
  if (F && s?.limits) {
    const both = F.advice.length === 2;
    if (both) todo.push(`<span class="neg">בלי תקבולים חדשים, שני החשבונות צפויים לחצות את הכרית ב-${ADVICE_DAYS} הימים הקרובים. העברה ביניהם לא תפתור את זה: צריך לזרז גבייה או לדחות תשלומים.</span>`);
    for (const t of both ? [] : F.advice) {
      todo.push(t.enough
        ? `להעביר <b>${money(t.amount)}</b> מ${esc(t.from)} ל${esc(t.to)} עד ${fmtDate(toDate(t.by))}. בלי זה ${esc(t.to)} יחצה את הכרית.`
        : `<span class="neg">${esc(t.to)} צפוי לחצות את הכרית, וב${esc(t.from)} אין מספיק מרווח (${money(t.room)}). צריך לדחות תשלום או לזרז גבייה.</span>`);
    }
    for (const a of F.accts) {
      const floor = -(s.limits[a.limitKey] || 0) + (s.cushion || 0);
      const room = a.lowWorst.bal - floor - (F.advice.find((t) => t.from === a.key && t.enough)?.amount || 0);
      const debts = c.debts.filter((d) => d.account === a.key);
      if (room > 0 && debts.length) {
        let left = room; const can = [];
        for (const d of debts) { if (d.open <= left) { can.push(d); left -= d.open; } else break; }
        if (can.length) todo.push(`אפשר לשלם מ${esc(a.key)} בלי לחצות את הכרית: ${can.map((d) => `${esc(d.supplier)}${d.docDate ? " " + (d.docDate.getMonth() + 1) + "/" + String(d.docDate.getFullYear()).slice(2) : ""} ${money(d.open)}`).join(", ")}.`);
        else todo.push(`מ${esc(a.key)} אפשר לשלם עד ${money(Math.floor(room / 100) * 100)} בלי לחצות את הכרית. החוב הישן ביותר (${esc(debts[0].supplier)}, ${money(debts[0].open)}) גדול מזה, אז אפשר לשלם ממנו חלק.`);
      }
    }
  }
  const overdue = F ? F.receivables.filter((r) => r.overdue) : [];
  if (overdue.length) todo.push(`<a href="#" data-goto="more">${overdue.length} חובות לקוחות באיחור, ${money(overdue.reduce((t, r) => t + r.open, 0))}. זו רשימת הגבייה.</a>`);
  if (todo.length) html += `<div class="card"><h2>מה לעשות</h2>${todo.map((t) => `<div class="row"><div class="main small">${t}</div></div>`).join("")}<div class="muted small">לפי התרחיש המחמיר (בלי תקבולים), ${ADVICE_DAYS} יום קדימה. ההמלצה לא מבצעת כלום.</div></div>`;

  html += `<div class="accounts">` + c.accounts.map((a) => {
    const limit = s?.limits?.[a.limitKey];
    const fa = F?.accts.find((x) => x.key === a.key);
    const bal = a.latest?.amount;
    const color = fa && limit ? acctColor(fa.lowWorst.bal, limit, s?.cushion) : acctColor(bal, limit, s?.cushion);
    const used = bal != null && limit ? Math.min(100, Math.max(0, (-bal / limit) * 100)) : 0;
    return `<div class="card acct ${color}">
      <h3>${esc(a.label)}</h3>
      <div class="bal">${bal == null ? "חסר" : money(bal)}</div>
      <div class="muted small">${a.latest ? `נכון ל-${fmtDate(a.latest.at)} (${ago(a.latest.at)})` : "אין צילום יתרה"}</div>
      ${limit ? `<div class="bar ${color}"><div style="width:${used}%"></div></div>
        <div class="muted small">${bal < 0 ? `נוצל ${money(-bal)} מתוך ${money(limit)}` : `מסגרת ${money(limit)} לא בשימוש`}</div>` : ""}
      ${fa ? `<div class="small" style="margin-top:8px">נקודה נמוכה ב-${ADVICE_DAYS} יום:</div>
        <div class="small">מחמיר: ${money(fa.lowWorst.bal)} ב-${fmtDate(toDate(fa.lowWorst.date))}</div>
        <div class="small">צפוי: ${money(fa.lowExp.bal)} ב-${fmtDate(toDate(fa.lowExp.date))}</div>
        ${limit ? `<div class="small muted">מרווח מהמסגרת במחמיר: ${money(fa.lowWorst.bal + limit)}</div>` : ""}` : ""}
    </div>`;
  }).join("") + `</div>`;

  if (F && F.car.length) {
    const in90 = F.car.filter((e) => e.date <= addDays(F.today, 90));
    html += `<div class="card"><h2>רכב, 90 יום קדימה · ${money(in90.reduce((t, e) => t + e.amount, 0))}</h2>
      <div class="muted small">מ-niro903. לא משויך לחשבון, ולכן נספר רק בתחזית המאוחדת.</div>
      ${in90.map((e) => `<div class="row"><div class="main"><div class="title">${esc(e.label)}</div><div class="sub">${fmtDate(toDate(e.date))} · ${esc(e.basis)}</div></div><div>${money(e.amount)}</div></div>`).join("")}</div>`;
  } else if (F?.niroError) html += `<div class="card small">רכב (niro903): ${esc(F.niroError)} ${state.niro?.needLogin ? `<button class="btn secondary small-btn" id="niroLogin">התחבר</button>` : ""}</div>`;
  if (F) {
    const until = addDays(F.today, 14);
    const next = F.events.filter((e) => e.date >= F.today && e.date <= until);
    html += `<div class="card"><h2>14 הימים הקרובים</h2>` + (next.length ? next.map((e) => `<div class="row"><div class="main"><div class="title">${esc(e.label)} <span class="tag ${e.certainty === "measured" ? "measured" : "estimate"}">${e.certainty === "measured" ? "נמדד" : e.certainty === "range" ? "טווח" : "מוערך"}</span></div>
      <div class="sub">${fmtDate(toDate(e.date))} · ${esc(e.account)}</div></div><div>${money(e.amount)}</div></div>`).join("") : `<div class="muted small">אין.</div>`) +
      `<div class="row link" data-goto="forecast"><div class="main small">לתחזית המלאה</div><span class="chev">‹</span></div></div>`;
  }

  html += `<button class="btn secondary block" data-sub="import" style="margin-bottom:12px">ייבוא קבצים</button>`;
  const debtTotal = c.debts.reduce((t, x) => t + x.open, 0);
  const recTotal = c.receivables.reduce((t, x) => t + x.open, 0);
  html += `<div class="card"><div class="row link" data-goto="decide"><div class="main"><div class="title">חובות פתוחים לספקים</div>
      <div class="sub">${c.debts.length} חובות · הישן ביותר: ${c.debts[0]?.age != null ? c.debts[0].age + " ימים" : "—"}</div></div>
      <div>${money(debtTotal)} <span class="chev">‹</span></div></div>
    <div class="row link" data-goto="more"><div class="main"><div class="title">חובות לקוחות פתוחים</div>
      <div class="sub">${c.receivables.length} חשבונות · ${overdue.length} באיחור</div></div><div>${money(recTotal)} <span class="chev">‹</span></div></div></div>`;
  return html;
}

function viewDecide(c) {
  let html = `<div class="notice">הסימולטור ("עכשיו / בתאריך / חלקי" והצע תוכנית) נבנה בשלב 4. כאן בינתיים רשימת החובות, מהישן לחדש.</div>`;
  for (const a of ACCOUNTS) {
    const list = c.debts.filter((x) => x.account === a.key);
    if (!list.length) continue;
    const sum = list.reduce((t, x) => t + x.open, 0);
    html += `<div class="card"><h2>מחשבון ${esc(a.label)} · ${money(sum)}</h2>` + list.map((x) => `
      <div class="row"><div class="main">
        <div class="title">${esc(x.supplier)} ${x.age != null ? `<span class="tag ${x.age > 60 ? "old" : ""}">${x.age} ימים</span>` : `<span class="tag">ללא תאריך</span>`}</div>
        <div class="sub">${esc(x.kind)}${x.docNo ? " · " + esc(x.docNo) : ""}${x.docDate ? " · " + fmtDate(x.docDate) : ""}${x.paid ? ` · שולם ${money(x.paid)} מתוך ${money(x.amount)}` : ""}</div>
      </div><div>${money(x.open)}</div></div>`).join("") + `</div>`;
  }
  const other = c.debts.filter((x) => !ACCOUNTS.some((a) => a.key === x.account));
  if (other.length) html += `<div class="card"><h2>בלי חשבון לתשלום</h2>${other.map((x) => `<div class="row"><div class="main"><div class="title">${esc(x.supplier)}</div></div><div>${money(x.open)}</div></div>`).join("")}</div>`;
  return html;
}

function viewMore(c) {
  const s = state.settings || {};
  const recTotal = c.receivables.reduce((t, x) => t + x.open, 0);
  let html = `<div class="card" style="display:flex;gap:8px"><button class="btn" data-sub="import" style="flex:1">ייבוא קבצים</button>
    <button class="btn secondary" data-sub="txns" style="flex:1">תנועות</button></div>`;
  html += `<div class="card"><button class="btn secondary block" data-sub="recurring">קבועים (הוראות קבע, הלוואות, מינויים)</button></div>`;
  const R = state.F?.receivables || [];
  const recRow = (x, extra) => `<div class="row"><div class="main">
      <div class="title">${esc(x.client)}</div>
      <div class="sub">${x.proforma ? `חשבון עסקה ${esc(x.proforma)} · ${fmtDate(toDate(x.proformaDate))}` : `<span class="tag">אין חשבון עסקה</span>`}${x.invoice ? ` · חשבונית ${esc(x.invoice)}` : ""} · ${esc(x.basis)}${extra}</div>
      </div><div>${money(x.open)}</div></div>`;
  const exp = R.filter((x) => x.expected).sort((a, b) => a.expected.localeCompare(b.expected));
  const late = R.filter((x) => x.overdue).sort((a, b) => a.expectedRaw.localeCompare(b.expectedRaw));
  const nob = R.filter((x) => !x.expected && !x.overdue);
  const sum = (l) => l.reduce((t, x) => t + x.open, 0);
  html += `<div class="card"><h2>תקבולים פתוחים · ${money(recTotal)}</h2>
    <div class="muted small">חובות לקוחות ישנים עדיין מחכים לאישור, ולכן הרשימה לא שלמה.</div>
    <h3 style="margin-top:12px">צפויים · ${money(sum(exp))}</h3>${exp.map((x) => recRow(x, ` · <b>צפוי ${fmtDate(toDate(x.expected))}</b>`)).join("") || '<div class="muted small">אין.</div>'}
    <h3 style="margin-top:12px">באיחור · ${money(sum(late))}</h3>
    <div class="muted small">לא נכנסים לתחזית, לא נמחקים, והמועד שלהם לא מתגלגל. זו רשימת הגבייה.</div>
    ${late.map((x) => recRow(x, ` · <span class="neg">איחור ${dayDiff(new Date(), toDate(x.expectedRaw))} ימים</span>`)).join("") || '<div class="muted small">אין.</div>'}
    ${nob.length ? `<h3 style="margin-top:12px">אין בסיס להערכה · ${money(sum(nob))}</h3>${nob.map((x) => recRow(x, "")).join("")}` : ""}</div>`;

  html += `<div class="card"><h2>הגדרות</h2>
    <label class="field"><span>מסגרת חשבון פרטי (₪)</span><input id="limPrivate" inputmode="numeric" value="${esc(s.limits?.private ?? "")}"></label>
    <label class="field"><span>מסגרת חשבון עסקי (₪)</span><input id="limBusiness" inputmode="numeric" value="${esc(s.limits?.business ?? "")}"></label>
    <label class="field"><span>כרית ביטחון: כמה מרווח להשאיר מהמסגרת (₪)</span><input id="cushion" inputmode="numeric" value="${esc(s.cushion ?? "")}"></label>
    <button class="btn" id="saveSettings">שמירה</button> <span id="savedMsg" class="muted small"></span>
    <div class="muted small" style="margin-top:8px">נשמר בענן שלך בלבד, לא בקוד.</div></div>`;

  html += `<div class="card"><h2>שורות לבירור (${c.review.length})</h2>` +
    (c.review.length ? c.review.map((x) => `<div class="row"><div class="main"><div class="title">${esc(x.tab)} · ${esc(x.id)}</div><div class="sub">${esc(x.why)}</div></div></div>`).join("")
      : `<div class="muted small">אין. כל השורות הפעילות נקראו לפי החוזה.</div>`) + `</div>`;
  if (c.infoOnly.length) html += `<div class="card"><h2>מידע בלבד, לא נכנס ליתרות ולתחזית</h2>` +
    c.infoOnly.map((x) => `<div class="row"><div class="main">${esc(x.name)}</div><div>${money(x.amount)}</div></div>`).join("") + `</div>`;
  html += `<div class="card"><h2>חשבון ומקורות</h2>
    <div class="small">מחובר: ${esc(state.user?.email || "")}</div>
    <div class="small muted" style="margin-top:6px">כללי הקריאה לפי חוזה v1 של נועה (LOG-0009).</div>
    <div style="margin-top:12px"><button class="btn secondary" id="signOutBtn">יציאה</button></div></div>
    <div class="muted small center">גרסה 0.1 · שלב 1</div>`;
  return html;
}

const viewSoon = (title, text) => () => `<div class="card center"><h2>${esc(title)}</h2><div class="muted">${esc(text)}</div></div>`;

function bindViewEvents() {
  document.getElementById("niroLogin")?.addEventListener("click", async () => { await loadNiro(true); state.F = computeForecast(state.data); render(); });
  $view.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); state.tab = a.dataset.goto; state.sub = a.dataset.sub || ""; render(); window.scrollTo(0, 0); }));
  $view.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); state.tab = "more"; state.sub = b.dataset.sub; render(); window.scrollTo(0, 0); }));
  document.getElementById("signOutBtn")?.addEventListener("click", async () => { clearToken(); await signOut(auth); });
  document.getElementById("saveSettings")?.addEventListener("click", async () => {
    const n = (id) => { const v = toNum(document.getElementById(id).value); return v == null ? null : Math.abs(v); };
    const settings = { ...(state.settings || {}), limits: { private: n("limPrivate"), business: n("limBusiness") }, cushion: n("cushion") || 0 };
    try {
      await importCtx.saveSettings(settings);
      document.getElementById("savedMsg").textContent = "נשמר ✓";
    } catch (e) {
      document.getElementById("savedMsg").textContent = "השמירה נכשלה";
    }
  });
}

function showLogin(msg) {
  $tabs.hidden = true; $fresh.hidden = true; $refresh.hidden = true;
  $view.innerHTML = `<div class="login card"><h2>תזרים</h2><p>${msg || "כניסה עם חשבון הגוגל שלך"}</p>
    <button class="btn block" id="loginBtn">כניסה עם Google</button></div>`;
  document.getElementById("loginBtn").addEventListener("click", signIn);
}
function showError(msg) { state.error = msg; if (state.data) render(); else $view.innerHTML = `<div class="error">${esc(msg)}</div>`; }

async function load() {
  $view.innerHTML = `<div class="center muted">קורא את הגיליון…</div>`;
  state.error = null;
  try {
    const r = await readSheet();
    if (r.needToken) {
      $view.innerHTML = `<div class="login card"><p>כדי לקרוא את הגיליון של נועה צריך לאשר גישה מחדש (פעם בשעה).</p>
        <button class="btn block" id="reconnect">חיבור לגיליון</button></div>`;
      document.getElementById("reconnect").addEventListener("click", signIn);
      return;
    }
    if (r.noAccess) {
      $view.innerHTML = `<div class="error">לחשבון ${esc(state.user.email)} אין גישה לגיליון של נועה. צריך לשתף אותו עם החשבון הזה, לצפייה בלבד מספיק.</div>`;
      return;
    }
    const problems = checkHeaders(r.heads);
    if (problems.length) {
      $view.innerHTML = `<div class="error"><b>מבנה הגיליון השתנה, ולכן האפליקציה לא מציגה מספרים.</b><br>${problems.map(esc).join("<br>")}</div>
        <div class="muted small">צריך לבדוק עם נועה. אחרי התיקון, לרענן.</div>`;
      $refresh.hidden = false;
      return;
    }
    state.data = compute(r.data);
    try { state.F = computeForecast(state.data); } catch (e) { state.F = null; state.error = "חישוב התחזית נכשל."; }
    state.loadedAt = new Date();
    $tabs.hidden = false; $refresh.hidden = false;
    render();
  } catch (e) {
    showError("קריאת הגיליון נכשלה. נסה לרענן.");
  }
}

async function afterSignIn(user) {
  state.user = user;
  // בדיקת הרשאה: חוקי Firestore מאפשרים גישה רק לחשבון המורשה.
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    state.settings = snap.exists() ? snap.data() : null;
    state.imports = await loadImports(db);
    await loadBank();
    loadNiro().then(() => { if (state.data) { state.F = computeForecast(state.data); render(); } });
  } catch (e) {
    if (e.code === "permission-denied") {
      clearToken();
      await signOut(auth);
      showLogin(`החשבון ${esc(user.email)} לא מורשה להשתמש באפליקציה.`);
    } else {
      showError("אין חיבור לשרת. נסה שוב.");
    }
    return;
  }
  await load();
}

$tabs.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  state.sub = "";
  render();
  window.scrollTo(0, 0);
});
$refresh.addEventListener("click", load);

let handled = null;
getRedirectResult(auth)
  .then((res) => { if (res) saveToken(GoogleAuthProvider.credentialFromResult(res)); })
  .catch(() => {})
  .finally(() => {
    onAuthStateChanged(auth, (user) => {
      if (!user) { handled = null; state.user = null; state.data = null; showLogin(); return; }
      if (signingIn || handled === user.uid) return;
      handled = user.uid;
      afterSignIn(user);
    });
  });
