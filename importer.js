// מסך ייבוא: קריאת קבצים בדפדפן, בדיקות, ושמירת תנועות מעובדות בלבד ב-Firestore.
// הקובץ עצמו לא עולה לשום מקום.

import {
  collection, doc, getDocs, query, where, orderBy, limit, writeBatch, setDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { parse, parsePaste, txnId, TYPE_LABEL } from "./parsers.js";

const XLSX_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const ALIASES = ["פרטי", "עסקי 151"];
const FX_ACCOUNT = 'מט"ח עסקי';

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
const money = (n) => n == null ? "—" : `<span class="num ${n < 0 ? "neg" : ""}">${n < 0 ? "-" : ""}${nf.format(Math.abs(n))} ₪</span>`;
const dd = (iso) => iso ? `${+iso.slice(8, 10)}.${+iso.slice(5, 7)}.${iso.slice(2, 4)}` : "—";

let XLSX = null;
let pending = []; // קבצים שנקראו וממתינים לקליטה
const pasteForm = { card: "", date: "", account: "פרטי" };

export async function loadImports(db) {
  const snap = await getDocs(query(collection(db, "imports"), orderBy("at", "desc"), limit(100)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// עדכניות לפי מקור: התאריך האחרון שנקלט לכל חשבון/כרטיס
export function freshness(imports) {
  const out = {};
  for (const im of imports) {
    const key = im.kind === "bank" ? im.account : im.kind === "fx" ? FX_ACCOUNT : "כרטיסים";
    if (im.to && (!out[key] || im.to > out[key])) out[key] = im.to;
  }
  return out;
}

export function viewImport(ctx) {
  const { imports } = ctx;
  let html = `<div class="card"><button class="btn secondary small-btn" data-sub="">→ חזרה</button>
    <h2 style="margin-top:10px">ייבוא קבצים</h2>
    <div class="muted small">אקסל של עו"ש, מט"ח, ישראכרט, כאל או מקס. הקובץ נקרא כאן במכשיר ולא נשמר. נשמרות רק התנועות, בלי מספרי חשבון ות"ז.</div>
    <label class="btn block" style="display:block;text-align:center;margin-top:12px">בחר קבצים
      <input type="file" id="fileInput" accept=".xlsx,.xls" multiple hidden></label></div>`;
  html += `<div class="card"><h2>הדבקת פירוט מאתר האשראי</h2>
    <div class="muted small">לכרטיס בלי ייצוא לאקסל: באתר מסמנים את טבלת העסקאות של חודש אחד, מעתיקים ומדביקים כאן.</div>
    <label class="field"><span>4 ספרות של הכרטיס</span><input id="pCard" inputmode="numeric" maxlength="4" value="${esc(pasteForm.card)}"></label>
    <label class="field"><span>תאריך החיוב בבנק</span><input id="pDate" type="date" value="${esc(pasteForm.date)}"></label>
    <label class="field"><span>מאיזה חשבון יורד</span><select id="pAcct">${ALIASES.map((a) => `<option ${a === pasteForm.account ? "selected" : ""}>${a}</option>`).join("")}</select></label>
    <label class="field"><span>הטבלה שהועתקה</span><textarea id="pText" rows="6" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit"></textarea></label>
    <button class="btn" id="pGo">פענח</button></div>`;
  html += `<div id="stored"><div class="card muted small">טוען סיכום…</div></div>`;
  html += `<div id="previews">${pending.map((p, i) => previewCard(p, i, ctx)).join("")}</div>`;
  html += `<div class="card"><h2>היסטוריית ייבואים</h2>` + (imports.length ? imports.map((im) => `
    <div class="row"><div class="main"><div class="title">${esc(TYPE_LABEL[im.kind] || im.kind)} · ${esc(im.account || "")}${im.cards?.length ? " · " + esc(im.cards.join(", ")) : ""}</div>
      <div class="sub">${esc(im.fileName)} · ${dd(im.from)}–${dd(im.to)} · ${im.added} חדשות${im.existing ? `, ${im.existing} כבר היו` : ""}</div></div>
      <button class="btn secondary small-btn" data-undo="${esc(im.id)}">בטל</button></div>`).join("") : `<div class="muted small">עוד לא נקלטו קבצים.</div>`) + `</div>`;
  return html;
}

function previewCard(p, i, ctx) {
  if (p.error) return `<div class="card"><div class="error">${esc(p.fileName)}: ${esc(p.error)}</div><button class="btn secondary small-btn" data-drop="${i}">הסר</button></div>`;
  const allOk = p.checks.every((c) => c.ok);
  const needsAccount = !p.account;
  const sel = needsAccount ? `<label class="field"><span>${p.kind === "max" ? `לאיזה חשבון יורד כרטיס ${esc(p.cards[0])}?` : `לאיזה חשבון שייך הקובץ (מסתיים ב-${esc(p.suffix)})?`}</span>
      <select data-acct="${i}"><option value="">בחר…</option>${ALIASES.map((a) => `<option>${a}</option>`).join("")}</select></label>` : "";
  const extra = [];
  if (p.kind === "paste") {
    extra.push(`כרטיס ${esc(p.cards[0])}, חיוב ${dd(p.chargeDate)} · סך העסקאות: ${money(p.sum)}`);
    if (p.skipped?.length) extra.push(`<span class="neg">שורות שלא זוהו (${p.skipped.length}): ${esc(p.skipped.slice(0, 3).join(" | "))}</span>`);
    extra.push(p.txns.map((t) => `${dd(t.date)} ${esc(t.desc)} ${money(t.amount)}${t.notes ? " (" + esc(t.notes) + ")" : ""}`).join("<br>"));
  }
  if (p.lastBalance) extra.push(`יתרה בשורה האחרונה: ${money(p.lastBalance.amount)} (${dd(p.lastBalance.date)})`);
  if (p.fxBalance) extra.push(`יתרה: ${nf.format(p.fxBalance.amount)} ${esc(p.fxBalance.currency)} (שווי ${money(p.fxBalance.ils)})`);
  if (p.upcoming?.length) extra.push("חיובים: " + p.upcoming.map((u) => `${esc(u.card)} ${dd(u.date)} ${money(u.amount)}`).join(" · "));
  return `<div class="card"><h3>${esc(TYPE_LABEL[p.kind])}${p.account ? " · " + esc(p.account) : ""}</h3>
    <div class="muted small">${esc(p.fileName)} · ${dd(p.from)}–${dd(p.to)}</div>
    ${sel}
    <div class="small" style="margin-top:8px">${p.txns.length} תנועות${p.newCount != null ? ` · <b>${p.newCount} חדשות</b>, ${p.txns.length - p.newCount} כבר נקלטו` : ""}</div>
    ${p.masked ? `<div class="small">מספרי חשבון ות"ז שהוסוו: ${p.masked}</div>` : ""}
    ${extra.map((x) => `<div class="small">${x}</div>`).join("")}
    <div style="margin-top:8px">${p.checks.map((c) => `<div class="small">${c.ok ? "✅" : "❌"} ${esc(c.label)}${c.ok ? "" : `<div class="error small">${esc(c.detail)}</div>`}</div>`).join("")}</div>
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="btn" data-commit="${i}" ${!allOk || needsAccount || p.newCount === 0 ? "disabled" : ""}>${p.newCount === 0 ? "אין מה לקלוט" : "קלוט"}</button>
      <button class="btn secondary" data-drop="${i}">הסר</button></div>
    ${!allOk ? `<div class="muted small" style="margin-top:6px">הקליטה חסומה עד שכל הבדיקות עוברות.</div>` : ""}</div>`;
}

export function bindImport(root, ctx) {
  viewStored(ctx).then((h) => { const el = root.querySelector("#stored"); if (el) el.innerHTML = h; }).catch(() => {});
  root.querySelector("#fileInput")?.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    if (!XLSX) XLSX = await import(XLSX_URL);
    for (const f of files) pending.push(await readFile(f, ctx));
    await countNew(ctx);
    ctx.rerender();
  });
  ["pCard", "pDate", "pAcct"].forEach((id) => root.querySelector("#" + id)?.addEventListener("change", (e) => { pasteForm[{ pCard: "card", pDate: "date", pAcct: "account" }[id]] = e.target.value; }));
  root.querySelector("#pGo")?.addEventListener("click", async () => {
    pending.push(await buildPaste(ctx));
    await countNew(ctx);
    ctx.rerender();
  });
  root.querySelectorAll("[data-drop]").forEach((b) => b.addEventListener("click", () => { pending.splice(+b.dataset.drop, 1); ctx.rerender(); }));
  root.querySelectorAll("[data-acct]").forEach((s) => s.addEventListener("change", async () => {
    const p = pending[+s.dataset.acct]; if (!s.value) return;
    const settings = ctx.getSettings() || {};
    if (p.kind === "max") settings.cardMap = { ...(settings.cardMap || {}), [p.cards[0]]: s.value };
    else settings.accountMap = { ...(settings.accountMap || {}), [p.suffix]: s.value };
    await ctx.saveSettings(settings);
    pending.forEach((q) => resolveAccount(q, settings));
    await countNew(ctx);
    ctx.rerender();
  }));
  root.querySelectorAll("[data-commit]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "קולט…";
    try {
      await commit(pending[+b.dataset.commit], ctx);
      pending.splice(+b.dataset.commit, 1);
      await ctx.reloadImports();
      await countNew(ctx);
    } catch (e) { alertBox(root, "הקליטה נכשלה. שום דבר לא נשמר חלקית מעבר למה שמופיע בהיסטוריה."); }
    ctx.rerender();
  }));
  root.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "בטוח?"; return; }
    b.disabled = true; b.textContent = "מבטל…";
    await undo(b.dataset.undo, ctx);
    await ctx.reloadImports();
    await countNew(ctx);
    ctx.rerender();
  }));
}

async function buildPaste(ctx) {
  const card = pasteForm.card.trim(), date = pasteForm.date;
  if (!/^\d{4}$/.test(card) || !date) return { fileName: "הדבקה", error: "צריך 4 ספרות של הכרטיס ותאריך חיוב" };
  const p = parsePaste(document.getElementById("pText").value, card, date);
  if (!p.txns.length) return { fileName: "הדבקה", error: "לא זוהו עסקאות. אפשר לנסות לסמן רק את שורות הטבלה." };
  p.fileName = `הדבקה · כרטיס ${card} · ${dd(date)}`; p.cards = [card]; p.chargeDate = date; p.account = pasteForm.account;
  const ds = p.txns.map((t) => t.date).filter(Boolean).sort(); p.from = ds[0]; p.to = ds[ds.length - 1];
  p.sum = Math.round(p.txns.reduce((a, t) => a - t.amount, 0) * 100) / 100;
  p.upcoming = [{ card, date, amount: p.sum }];
  // בדיקה מול החיוב בבנק: תנועת עו"ש עם אסמכתא = מספר הכרטיס, עד 3 ימים מתאריך החיוב
  const lo = new Date(date); lo.setDate(lo.getDate() - 3); const hi = new Date(date); hi.setDate(hi.getDate() + 3);
  const snap = await getDocs(query(collection(ctx.db, "txns"), where("date", ">=", lo.toISOString().slice(0, 10))));
  const bank = snap.docs.map((d) => d.data()).filter((t) => t.src === "bank" && t.ref === card && t.date <= hi.toISOString().slice(0, 10));
  const bankSum = Math.round(bank.reduce((a, t) => a - t.amount, 0) * 100) / 100;
  p.checks = [bank.length
    ? { label: `סך העסקאות = החיוב בבנק (${bankSum} ב-${dd(bank[0].date)})`, ok: Math.abs(bankSum - p.sum) < 0.01, detail: `${p.sum} מול ${bankSum}. אולי חסרה שורה או שהועתק חודש אחר.` }
    : { label: "לא נמצא חיוב תואם בעו\"ש שנקלט (אולי החיוב עוד לא ירד, או שקובץ העו\"ש לא עדכני)", ok: p.skipped.length === 0, detail: "יש שורות שלא זוהו" }];
  if (p.skipped.length) p.checks.push({ label: "כל השורות זוהו", ok: false, detail: p.skipped.join(" | ") });
  return p;
}

function alertBox(root, msg) { const d = document.createElement("div"); d.className = "error"; d.textContent = msg; root.prepend(d); }

async function readFile(file, ctx) {
  try {
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
    const p = parse(rows);
    if (!p.kind) return { fileName: file.name, error: p.error };
    p.fileName = file.name;
    p.cards = [...new Set(p.txns.map((t) => t.card).filter(Boolean))];
    if (p.kind === "isracard" || p.kind === "cal") p.upcoming?.forEach((u) => p.cards.includes(u.card) || p.cards.push(u.card));
    resolveAccount(p, ctx.getSettings() || {});
    return p;
  } catch (e) {
    return { fileName: file.name, error: "הקובץ לא נקרא. האם זה אקסל מהבנק או מחברת האשראי?" };
  }
}

function resolveAccount(p, settings) {
  if (p.error) return;
  if (p.kind === "fx") p.account = FX_ACCOUNT;
  else if (p.kind === "max") p.account = settings.cardMap?.[p.cards[0]] || null;
  else p.account = settings.accountMap?.[p.suffix] || null;
}

async function idsFor(p) {
  const acct = p.kind === "bank" || p.kind === "fx" ? p.account : "card";
  const seen = {};
  const ids = [];
  for (const t of p.txns) {
    const base = [t.card, t.chargeDate, t.date, t.ref, t.desc, t.amount, t.balance].join("|");
    seen[base] = (seen[base] || 0) + 1;
    ids.push(await txnId(t, acct, seen[base]));
  }
  return ids;
}

async function countNew(ctx) {
  for (const p of pending) {
    if (p.error || !p.account) { if (p) p.newCount = null; continue; }
    p.ids = await idsFor(p);
    const snap = await getDocs(query(collection(ctx.db, "txns"), where("date", ">=", p.from)));
    const have = new Set(snap.docs.map((d) => d.id));
    p.newFlags = p.ids.map((id) => !have.has(id));
    p.newCount = p.newFlags.filter(Boolean).length;
  }
}

async function commit(p, ctx) {
  const importRef = doc(collection(ctx.db, "imports"));
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const toWrite = p.txns.map((t, i) => [p.ids[i], t]).filter((_, i) => p.newFlags[i]);
  for (let k = 0; k < toWrite.length; k += 400) {
    const batch = writeBatch(ctx.db);
    for (const [id, t] of toWrite.slice(k, k + 400)) {
      batch.set(doc(ctx.db, "txns", id), clean({ ...t, src: p.kind, account: p.account, importId: importRef.id }));
    }
    await batch.commit();
  }
  await setDoc(importRef, clean({
    fileName: p.fileName, kind: p.kind, account: p.account, cards: p.cards, from: p.from, to: p.to,
    added: toWrite.length, existing: p.txns.length - toWrite.length, at: serverTimestamp(),
    lastBalance: p.lastBalance, fxBalance: p.fxBalance, upcoming: p.upcoming
  }));
}

async function undo(importId, ctx) {
  const snap = await getDocs(query(collection(ctx.db, "txns"), where("importId", "==", importId)));
  for (let k = 0; k < snap.docs.length; k += 400) {
    const batch = writeBatch(ctx.db);
    snap.docs.slice(k, k + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(doc(ctx.db, "imports", importId));
}

// ---------- סיכום מה שנשמר (לבדיקה) ----------
export async function viewStored(ctx) {
  const snap = await getDocs(collection(ctx.db, "txns"));
  const g = {};
  snap.docs.forEach((d) => {
    const t = d.data();
    const key = t.src === "bank" || t.src === "fx" ? `${TYPE_LABEL[t.src]} · ${t.account}` : `${TYPE_LABEL[t.src]} · כרטיס ${t.card} → ${t.account}`;
    const x = g[key] || (g[key] = { n: 0, from: t.date, to: t.date, last: null, imports: new Set() });
    x.n++; if (t.date < x.from) x.from = t.date; if (t.date > x.to) x.to = t.date; x.imports.add(t.importId);
    if (t.src === "bank" && t.balance != null && (!x.last || t.date > x.last.date)) x.last = { date: t.date, amount: t.balance };
  });
  const st = ctx.getSettings() || {};
  const maps = [...Object.entries(st.accountMap || {}).map(([k, v]) => `חשבון שמסתיים ב-${k} → ${v}`), ...Object.entries(st.cardMap || {}).map(([k, v]) => `כרטיס ${k} → ${v}`)];
  return `<div class="card"><h2>מה נשמר (${snap.size} תנועות)</h2>` +
    Object.entries(g).sort().map(([k, x]) => `<div class="row"><div class="main"><div class="title">${esc(k)}</div>
      <div class="sub">${dd(x.from)}–${dd(x.to)}${x.last ? ` · יתרה אחרונה ${money(x.last.amount)}` : ""}</div></div><div>${x.n}</div></div>`).join("") +
    `<div class="muted small" style="margin-top:8px">שיוכים: ${maps.map(esc).join(" · ") || "אין"}</div></div>`;
}

// ---------- רשימת תנועות ----------
let txFilter = { account: "", q: "" };
export async function viewTxns(ctx) {
  const snap = await getDocs(query(collection(ctx.db, "txns"), orderBy("date", "desc"), limit(500)));
  let list = snap.docs.map((d) => d.data());
  const accounts = [...new Set(list.map((t) => t.src === "bank" || t.src === "fx" ? t.account : `כרטיס ${t.card}`))];
  if (txFilter.account) list = list.filter((t) => (t.src === "bank" || t.src === "fx" ? t.account : `כרטיס ${t.card}`) === txFilter.account);
  if (txFilter.q) list = list.filter((t) => [t.desc, t.details, t.counterparty, t.notes].join(" ").includes(txFilter.q));
  return `<div class="card"><button class="btn secondary small-btn" data-sub="">→ חזרה</button>
    <h2 style="margin-top:10px">תנועות (${list.length})</h2>
    <select id="txAcct"><option value="">הכול</option>${accounts.map((a) => `<option ${a === txFilter.account ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>
    <label class="field"><input id="txQ" placeholder="חיפוש" value="${esc(txFilter.q)}" style="direction:rtl;text-align:right"></label>
    ${list.slice(0, 300).map((t) => `<div class="row"><div class="main">
      <div class="title">${esc(t.desc)}${t.pending ? ' <span class="tag estimate">ממתין</span>' : ""}</div>
      <div class="sub">${dd(t.date)} · ${esc(t.src === "bank" || t.src === "fx" ? t.account : `כרטיס ${t.card}${t.chargeDate ? `, חיוב ${dd(t.chargeDate)}` : ""}`)}${t.counterparty ? " · " + esc(t.counterparty) : ""}${t.notes ? " · " + esc(t.notes) : ""}</div>
      </div><div>${t.src === "fx" ? `<span class="num">${nf.format(t.amount)} ${esc(t.currency)}</span>` : money(t.amount)}</div></div>`).join("")}
    ${list.length > 300 ? `<div class="muted small">מוצגות 300 הראשונות. אפשר לצמצם בחיפוש.</div>` : ""}</div>`;
}
export function bindTxns(root, ctx) {
  root.querySelector("#txAcct")?.addEventListener("change", (e) => { txFilter.account = e.target.value; ctx.rerender(); });
  root.querySelector("#txQ")?.addEventListener("change", (e) => { txFilter.q = e.target.value.trim(); ctx.rerender(); });
}
