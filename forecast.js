// מנוע התחזית: זיהוי קבועים מהיסטוריית הבנק ובניית יתרה יומית בשני תרחישים.
// פונקציות טהורות, בלי גישה לרשת. תאריכים כמחרוזות YYYY-MM-DD.

const DAY = 86400000;
export const D = (iso) => new Date(iso + "T12:00:00");
export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (s, n) => iso(new Date(D(s).getTime() + n * DAY));
const diffDays = (a, b) => Math.round((D(a) - D(b)) / DAY);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (n) => Math.round(n * 100) / 100;
const monthKey = (s) => s.slice(0, 7);
const monthIndex = (s) => +s.slice(0, 4) * 12 + +s.slice(5, 7) - 1;

const CARD_RE = /מסטרקרד|ישראכרט|כרטיסי אשראי|^כאל|ויזה/;
export const TAX_KEYS = [/מס הכנסה/, /מע"?מ|מעמ/, /ביטוח לאומי/];

// ---------- זיהוי קבועים ----------
// קבוצה = חשבון + תיאור (+ מספר כרטיס במסטרקרד) + מוטב. בתוך קבוצה מפרידים לפי יום בחודש.
export function groupKey(t) {
  const desc = t.desc.replace(/[\d.,()]+/g, "").trim();
  return [t.account, desc, desc === "מסטרקרד" ? t.ref : "", t.counterparty || ""].join("|");
}
const isInternal = (t) => /^העברה/.test(t.desc) && (!t.counterparty || /שקלרש/.test(t.counterparty + (t.details || "")));

export function detectRecurring(bankTxns, today) {
  const groups = {};
  for (const t of bankTxns) {
    if (t.src !== "bank" || t.amount >= 0 || isInternal(t)) continue;
    (groups[groupKey(t)] ||= []).push(t);
  }
  const items = [];
  for (const [key, list] of Object.entries(groups)) {
    // אשכולות לפי יום בחודש: אשכול מכסה עד 4 ימים מתחילתו (כך חיוב חודשי ב-20 לא מתערבב בחיובים מיידיים קטנים)
    const sorted = list.slice().sort((a, b) => +a.date.slice(8) - +b.date.slice(8));
    const clusters = [];
    for (const t of sorted) {
      const day = +t.date.slice(8);
      const c = clusters[clusters.length - 1];
      if (c && day - c.firstDay <= 4) c.items.push(t); else clusters.push({ items: [t], firstDay: day });
    }
    clusters.forEach((c, ci) => {
      const byMonth = {};
      c.items.forEach((t) => { (byMonth[monthKey(t.date)] ||= { sum: 0, dates: [] }); byMonth[monthKey(t.date)].sum += -t.amount; byMonth[monthKey(t.date)].dates.push(t.date); });
      const months = Object.keys(byMonth).sort();
      const last = c.items.map((t) => t.date).sort().pop();
      if (diffDays(today, last) > 45) return; // הפסיק
      const idx = months.map(monthIndex);
      const gaps = idx.slice(1).map((v, i) => v - idx[i]);
      const period = gaps.length ? Math.max(1, Math.round(median(gaps))) : 1;
      const consecutive2 = months.length === 2 && gaps[0] === 1;
      if (months.length < 3 && !consecutive2) return;
      const recent = months.slice(-3).map((m) => byMonth[m].sum);
      const day = Math.round(median(c.items.map((t) => +t.date.slice(8))));
      const first = list[0];
      items.push({
        key: `${key}|${ci}`, account: first.account, desc: first.desc, ref: first.desc === "מסטרקרד" ? first.ref : "",
        counterparty: first.counterparty || "", day, period, amount: r2(median(recent)), last, months: months.length,
        weak: months.length < 3, card: CARD_RE.test(first.desc), varies: Math.max(...recent) - Math.min(...recent) > 0.05 * median(recent)
      });
    });
  }
  return items.sort((a, b) => a.account.localeCompare(b.account) || b.amount - a.amount);
}

// ---------- בניית אירועים ----------
// sheet: { cardCharges:[{card,amount,due,account}], expected:[{type,amount,early,late,account}], receivables:[...], timing:[...] }
export function buildEvents({ start, horizonEnd, recurring, sheet, overrides = {}, manual = [], today }) {
  const ev = [];
  const after = (acc, d) => d > start[acc].date && d <= horizonEnd;

  for (const c of sheet.cardCharges) if (start[c.account] && after(c.account, c.due))
    ev.push({ date: c.due, account: c.account, amount: -c.amount, label: c.card, type: "card", certainty: "measured", src: "גיליון: יתרות" });
  for (const e of sheet.expected) if (start[e.account] && e.early && after(e.account, e.early))
    ev.push({ date: e.early, account: e.account, amount: -e.amount, label: e.type, type: "tax", certainty: e.late && e.late !== e.early ? "range" : "estimate",
      range: e.late && e.late !== e.early ? [e.early, e.late] : null, src: `גיליון: חיובים צפויים (${e.basis || ""})` });
  // חיוב צפוי שמועדו עבר ועדיין "צפוי": לא שולם מבחינתנו, נספר מיד
  for (const e of sheet.expectedPast || []) if (start[e.account])
    ev.push({ date: addDays(start[e.account].date, 1), account: e.account, amount: -e.amount, label: `${e.type} (מועד עבר)`, type: "tax", certainty: "estimate", src: "גיליון: חיובים צפויים" });

  const mastercardCards = new Set(recurring.filter((r) => r.ref).map((r) => r.ref));
  for (const r of recurring) {
    if (overrides[r.key]?.off || !start[r.account]) continue;
    const amount = overrides[r.key]?.amount ?? r.amount;
    let m = monthIndex(r.last) + r.period;
    for (let k = 0; k < 6; k++, m += r.period) {
      const y = Math.floor(m / 12), mo = m % 12;
      const dim = new Date(y, mo + 1, 0).getDate();
      const date = `${y}-${String(mo + 1).padStart(2, "0")}-${String(Math.min(r.day, dim)).padStart(2, "0")}`;
      if (!after(r.account, date)) { if (date > horizonEnd) break; continue; }
      // בלי כפילות: חיוב כרטיס שכבר נמדד בגיליון באותו חשבון ±4 ימים
      if (r.card && sheet.cardCharges.some((c) => c.account === r.account && Math.abs(diffDays(c.due, date)) <= 4 &&
        (r.ref ? c.card.endsWith(r.ref) : ![...mastercardCards].some((x) => c.card.endsWith(x))))) continue;
      // בלי כפילות: מס שמופיע בחיובים צפויים
      const tk = TAX_KEYS.find((re) => re.test(r.desc));
      if (tk && sheet.expected.some((e) => e.account === r.account && tk.test(e.type) && e.early && Math.abs(diffDays(e.early, date)) <= 10)) continue;
      ev.push({ date, account: r.account, amount: -amount, label: r.counterparty ? `${r.desc} · ${r.counterparty}` : r.desc + (r.ref ? ` ${r.ref}` : ""),
        type: r.card ? "card" : TAX_KEYS.some((re) => re.test(r.desc)) ? "tax" : /הלו|מקס|ליסינג|אלבר/.test(r.desc) ? "loan" : /מטח|פנסיה|גמל/.test(r.desc) ? "saving" : "fixed",
        certainty: "estimate", basis: r.varies ? `חציון ${Math.min(3, r.months)} חודשים אחרונים` : "סכום קבוע", src: "זוהה מהבנק", key: r.key });
    }
  }
  for (const x of manual) {
    if (!start[x.account]) continue;
    const m0 = monthIndex(start[x.account].date);
    for (let k = 0; k < 5; k++) {
      const y = Math.floor((m0 + k) / 12), mo = (m0 + k) % 12;
      const date = `${y}-${String(mo + 1).padStart(2, "0")}-${String(Math.min(x.day, new Date(y, mo + 1, 0).getDate())).padStart(2, "0")}`;
      if (x.until && date > x.until) break;
      if (after(x.account, date)) ev.push({ date, account: x.account, amount: -x.amount, label: x.name, type: x.type || "fixed", certainty: "estimate", basis: "הוזן ידנית", src: "קבוע ידני", key: x.id });
    }
  }
  // כסף שכבר נכנס לבנק אחרי צילום היתרה (לשונית תשלומים, עם תאריך בנק וחשבון): נמדד, בשני התרחישים
  for (const p of sheet.receipts || []) if (start[p.account] && after(p.account, p.date))
    ev.push({ date: p.date, account: p.account, amount: p.amount, label: p.label, type: "receipt", certainty: "measured", src: "גיליון: תשלומים (אחרי צילום היתרה)" });
  // תקבולים: רק בתרחיש הצפוי
  for (const r of sheet.receivables) if (r.expected && start["עסקי 151"] && after("עסקי 151", r.expected) && r.expected >= today)
    ev.push({ date: r.expected, account: "עסקי 151", amount: r.open, label: r.client, type: "receipt", certainty: "estimate", basis: r.basis, src: "גיליון: חייבים לי", expectedOnly: true });
  return ev.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
}

// מועד צפוי לחוב לקוח: תאריך חשבון העסקה + חציון זמני התשלום (אישי מ-3 מקרים ומעלה, אחרת כללי)
export function expectReceivables(receivables, timing, today) {
  const general = timing.find((t) => /כללי/.test(t["לקוח"]));
  const gDays = general ? +general["חציון (ימים)"] : 46;
  return receivables.map((r) => {
    // הודעת תשלום מהלקוח: הכסף בדרך. צפוי תוך יומיים מההודעה (ולא לפני מחר), עד שהזיכוי יאומת בבנק
    if (r.noticeDate) {
      const exp = addDays(r.noticeDate, 2) > today ? addDays(r.noticeDate, 2) : addDays(today, 1);
      return { ...r, expected: exp, overdue: false, expectedRaw: exp, basis: `הודעת תשלום מ-${+r.noticeDate.slice(8)}.${+r.noticeDate.slice(5, 7)}, הזיכוי טרם אומת` };
    }
    if (!r.proformaDate) return { ...r, expected: null, basis: "אין בסיס להערכה" };
    const t = timing.find((x) => x["לקוח"] === r.client && +x["מספר שרשראות"] >= 3);
    const days = t ? +t["חציון (ימים)"] : gDays;
    const expected = addDays(r.proformaDate, Math.round(days));
    return { ...r, expected: expected >= today ? expected : null, overdue: expected < today, expectedRaw: expected,
      basis: t ? `אישי (${t["מספר שרשראות"]} מקרים, חציון ${t["חציון (ימים)"]} ימים)` : `כללי (${gDays} ימים)` };
  });
}

// ---------- יתרה יומית ----------
export function series(startBal, startDate, events, end, expectedScenario) {
  const out = []; let bal = startBal; let i = 0;
  const evs = events.filter((e) => expectedScenario || !e.expectedOnly);
  for (let d = startDate; d <= end; d = addDays(d, 1)) {
    while (i < evs.length && evs[i].date <= d) { if (evs[i].date > startDate) bal += evs[i].amount; i++; }
    out.push({ date: d, bal: r2(bal) });
  }
  return out;
}
export const lowPoint = (s) => s.reduce((m, p) => (p.bal < m.bal ? p : m), s[0]);

// המלצת העברה: כמה להעביר לחשבון שחוצה את הכרית, בלי שהחשבון השני יחצה (לפי התרחיש המחמיר)
export function transferAdvice(accts, limits, cushion) {
  const res = [];
  const [a, b] = accts;
  for (const [need, give] of [[a, b], [b, a]]) {
    const floorNeed = -(limits[need.limitKey] || 0) + cushion;
    const floorGive = -(limits[give.limitKey] || 0) + cushion;
    const shortfall = floorNeed - need.lowWorst.bal;
    if (shortfall <= 0) continue;
    const room = give.lowWorst.bal - floorGive;
    const amount = Math.ceil(shortfall / 500) * 500;
    const firstCross = need.worst.find((p) => p.bal < floorNeed);
    res.push({ from: give.key, to: need.key, amount, by: firstCross ? addDays(firstCross.date, -1) : need.lowWorst.date, enough: room >= amount, room: Math.floor(room / 100) * 100 });
  }
  return res;
}
