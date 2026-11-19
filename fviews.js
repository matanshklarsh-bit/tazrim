// מסכי התחזית והקבועים
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });
export const money = (n) => (n == null || isNaN(n)) ? "—" : `<span class="num ${n < 0 ? "neg" : ""}">${n < 0 ? "-" : ""}${nf.format(Math.abs(n))} ₪</span>`;
export const dmy = (s) => s ? `${+s.slice(8, 10)}.${+s.slice(5, 7)}` : "—";
const CERT = { measured: ["measured", "נמדד"], estimate: ["estimate", "מוערך"], range: ["estimate", "טווח"] };
const TYPE_ICON = { card: "💳", tax: "🏛️", loan: "🚗", saving: "🐷", fixed: "🔁", receipt: "📥", supplier: "🧾" };

export const fstate = { acct: "פרטי", horizon: 60 };

// ---------- גרף ----------
function chart(lines, refs, w = 360, h = 190) {
  const pts = lines.flatMap((l) => l.data);
  if (!pts.length) return "";
  const vals = pts.map((p) => p.bal).concat(refs.map((r) => r.y));
  let min = Math.min(...vals), max = Math.max(...vals);
  const pad = (max - min) * 0.08 || 1000; min -= pad; max += pad;
  const n = lines[0].data.length;
  const L = 44, R = 6, T = 8, B = 22;
  const x = (i) => L + (i / Math.max(1, n - 1)) * (w - L - R);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (h - T - B);
  const path = (d) => d.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.bal).toFixed(1)}`).join("");
  const ticks = [max - pad, (max + min) / 2, min + pad].map((v) => `<text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" class="ax">${Math.round(v / 1000)}K</text>`).join("");
  const step = Math.max(1, Math.round(n / 4));
  const xt = lines[0].data.map((p, i) => i % step === 0 ? `<text x="${x(i)}" y="${h - 6}" text-anchor="middle" class="ax">${dmy(p.date)}</text>` : "").join("");
  const zero = min < 0 && max > 0 ? `<line x1="${L}" x2="${w - R}" y1="${y(0)}" y2="${y(0)}" stroke="#c9ced6" stroke-width="1"/>` : "";
  const refL = refs.map((r) => `<line x1="${L}" x2="${w - R}" y1="${y(r.y)}" y2="${y(r.y)}" stroke="${r.color}" stroke-width="1.3" stroke-dasharray="${r.dash || ""}"/>
    <text x="${L + 4}" y="${y(r.y) - 3}" text-anchor="start" class="ax" fill="${r.color}">${esc(r.label)}</text>`).join("");
  const ln = lines.map((l) => `<path d="${path(l.data)}" fill="none" stroke="${l.color}" stroke-width="2" stroke-dasharray="${l.dash || ""}"/>`).join("");
  const marks = lines.filter((l) => l.mark).map((l) => {
    const i = l.data.findIndex((p) => p.date === l.mark.date);
    return i < 0 ? "" : `<circle cx="${x(i)}" cy="${y(l.mark.bal)}" r="4" fill="${l.color}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" direction="ltr" style="direction:ltr" role="img" aria-label="יתרה יומית צפויה">${zero}${refL}${ln}${marks}${ticks}${xt}</svg>`;
}

const sumSeries = (a, b) => a.map((p, i) => ({ date: p.date, bal: p.bal + (b[i]?.bal || 0) }));
const low = (s) => s.reduce((m, p) => (p.bal < m.bal ? p : m), s[0]);

// ---------- מסך תחזית ----------
export function viewForecast(F, settings) {
  const lim = settings?.limits || {}, cushion = settings?.cushion || 0;
  let html = `<div class="card"><div class="seg">${["פרטי", "עסקי 151", "מאוחד"].map((a) => `<button data-facct="${a}" class="${fstate.acct === a ? "on" : ""}">${a}</button>`).join("")}</div>
    <div class="seg" style="margin-top:6px">${[30, 60, 90].map((h) => `<button data-fhor="${h}" class="${fstate.horizon === h ? "on" : ""}">${h} יום</button>`).join("")}</div></div>`;
  const cut = (s) => s.slice(0, fstate.horizon + 1);
  let exp, worst, refs = [], accKeys;
  if (fstate.acct === "מאוחד") {
    const [a, b] = F.accts;
    exp = cut(sumSeries(a.expected, b.expected)); worst = cut(sumSeries(a.worst, b.worst)); accKeys = [a.key, b.key];
  } else {
    const a = F.accts.find((x) => x.key === fstate.acct);
    exp = cut(a.expected); worst = cut(a.worst); accKeys = [a.key];
    const l = lim[a.limitKey];
    if (l) { refs.push({ y: -l, color: "#c0392b", label: "מסגרת" }); if (cushion) refs.push({ y: -l + cushion, color: "#b7791f", label: "כרית", dash: "4 3" }); }
  }
  const lw = low(worst), le = low(exp);
  html += `<div class="card">
    ${chart([{ data: exp, color: "#1f3a5f", mark: le }, { data: worst, color: "#c0392b", dash: "5 4", mark: lw }], refs)}
    <div class="legend small"><span><i style="background:#1f3a5f"></i>צפוי (עם תקבולים)</span><span><i class="dash"></i>מחמיר (בלי תקבולים)</span></div>
    <div class="row"><div class="main">נקודה נמוכה, מחמיר</div><div>${money(lw.bal)} <span class="muted small">${dmy(lw.date)}</span></div></div>
    <div class="row"><div class="main">נקודה נמוכה, צפוי</div><div>${money(le.bal)} <span class="muted small">${dmy(le.date)}</span></div></div>
    ${fstate.acct === "מאוחד" ? `<div class="muted small">במאוחד אין קו מסגרת, כי כל חשבון נבדק מול המסגרת שלו.</div>` : ""}
    <div class="muted small">נקודת התחלה: ${accKeys.map((k) => `${esc(k)} ${money(F.start[k].bal)} (${esc(F.start[k].src)}, ${dmy(F.start[k].date)})`).join(" · ")}</div></div>`;

  const end = exp[exp.length - 1]?.date;
  const evs = F.events.filter((e) => accKeys.includes(e.account) && e.date <= end);
  // יתרה אחרי כל אירוע (תרחיש צפוי) לחשבון של האירוע
  const run = {}; accKeys.forEach((k) => { run[k] = F.start[k].bal; });
  html += `<div class="card"><h2>אירועים (${evs.length})</h2>` + (evs.length ? evs.map((e) => {
    run[e.account] += e.amount;
    const [cls, txt] = CERT[e.certainty] || ["", ""];
    return `<div class="row"><div class="main"><div class="title">${TYPE_ICON[e.type] || ""} ${esc(e.label)} <span class="tag ${cls}">${e.range ? `${dmy(e.range[0])}–${dmy(e.range[1])}` : txt}</span>${e.expectedOnly ? ' <span class="tag">רק בצפוי</span>' : ""}</div>
      <div class="sub">${dmy(e.date)} · ${esc(e.account)}${e.basis ? " · " + esc(e.basis) : ""} · ${esc(e.src)}</div></div>
      <div style="text-align:left">${money(e.amount)}<div class="muted small">${money(run[e.account])}</div></div></div>`;
  }).join("") : `<div class="muted small">אין אירועים בטווח.</div>`) + `<div class="muted small" style="margin-top:6px">המספר הקטן = היתרה אחרי האירוע בתרחיש הצפוי.</div></div>`;
  return html;
}

export function bindForecast(root, rerender) {
  root.querySelectorAll("[data-facct]").forEach((b) => b.addEventListener("click", () => { fstate.acct = b.dataset.facct; rerender(); }));
  root.querySelectorAll("[data-fhor]").forEach((b) => b.addEventListener("click", () => { fstate.horizon = +b.dataset.fhor; rerender(); }));
}

// ---------- מסך קבועים ----------
export function viewRecurring(F, settings) {
  const ov = settings?.recurringOverrides || {};
  const manual = settings?.manualRecurring || [];
  let html = `<div class="card"><button class="btn secondary small-btn" data-sub="">→ חזרה</button>
    <h2 style="margin-top:10px">קבועים</h2>
    <div class="muted small">זוהו מהיסטוריית הבנק: חיוב שחוזר לפחות 3 חודשים (או חודשיים ברצף) בערך באותו יום, והופיע ב-45 הימים האחרונים. מה שמסומן נכנס לתחזית. חיובי כרטיס שכבר רשומים בגיליון לא נספרים פעמיים.</div></div>`;
  for (const acct of ["פרטי", "עסקי 151"]) {
    const list = F.recurring.filter((r) => r.account === acct);
    const sum = list.filter((r) => !ov[r.key]?.off).reduce((t, r) => t + (ov[r.key]?.amount ?? r.amount) / r.period, 0);
    html += `<div class="card"><h2>${esc(acct)} · ${money(-sum)} בחודש</h2>` + list.map((r) => `
      <div class="row"><div class="main">
        <label class="chk"><input type="checkbox" data-rec="${esc(r.key)}" ${ov[r.key]?.off ? "" : "checked"}>
          <span class="title">${esc(r.desc)}${r.ref ? " " + esc(r.ref) : ""}${r.counterparty ? " · " + esc(r.counterparty) : ""}</span></label>
        <div class="sub">ב-${r.day} ${r.period > 1 ? `כל ${r.period} חודשים` : "לחודש"} · ${r.months} חודשים בהיסטוריה${r.weak ? ' · <span class="tag estimate">רק חודשיים</span>' : ""}${r.varies ? ' · <span class="tag">משתנה</span>' : ""}${r.card ? ' · <span class="tag">כרטיס</span>' : ""}</div>
      </div><input class="amt" data-recamt="${esc(r.key)}" inputmode="decimal" value="${ov[r.key]?.amount ?? r.amount}"></div>`).join("") + `</div>`;
  }
  html += `<div class="card"><h2>קבועים שהוספת ידנית</h2>` + (manual.length ? manual.map((m, i) => `<div class="row"><div class="main"><div class="title">${esc(m.name)}</div>
      <div class="sub">${esc(m.account)} · ב-${m.day} לחודש${m.until ? ` · עד ${dmy(m.until)}.${m.until.slice(2, 4)}` : ""}</div></div><div>${money(-m.amount)} <button class="btn secondary small-btn" data-mdel="${i}">מחק</button></div></div>`).join("") : `<div class="muted small">אין. למשל הלוואה שהתחילה לאחרונה ועוד לא זוהתה.</div>`) + `
    <label class="field"><span>שם</span><input id="mName" style="direction:rtl;text-align:right"></label>
    <label class="field"><span>חשבון</span><select id="mAcct"><option>פרטי</option><option>עסקי 151</option></select></label>
    <label class="field"><span>יום בחודש</span><input id="mDay" inputmode="numeric"></label>
    <label class="field"><span>סכום חודשי (₪)</span><input id="mAmt" inputmode="decimal"></label>
    <label class="field"><span>עד תאריך (לא חובה)</span><input id="mUntil" type="date"></label>
    <button class="btn" id="mAdd">הוסף</button></div>`;
  return html;
}

export function bindRecurring(root, settings, save) {
  const st = () => ({ ...settings(), recurringOverrides: { ...(settings()?.recurringOverrides || {}) }, manualRecurring: [...(settings()?.manualRecurring || [])] });
  root.querySelectorAll("[data-rec]").forEach((c) => c.addEventListener("change", async () => {
    const s = st(); s.recurringOverrides[c.dataset.rec] = { ...(s.recurringOverrides[c.dataset.rec] || {}), off: !c.checked }; await save(s);
  }));
  root.querySelectorAll("[data-recamt]").forEach((c) => c.addEventListener("change", async () => {
    const v = parseFloat(c.value.replace(/[,₪\s]/g, "")); if (isNaN(v)) return;
    const s = st(); s.recurringOverrides[c.dataset.recamt] = { ...(s.recurringOverrides[c.dataset.recamt] || {}), amount: Math.abs(v) }; await save(s);
  }));
  root.querySelectorAll("[data-mdel]").forEach((b) => b.addEventListener("click", async () => { const s = st(); s.manualRecurring.splice(+b.dataset.mdel, 1); await save(s); }));
  root.querySelector("#mAdd")?.addEventListener("click", async () => {
    const name = root.querySelector("#mName").value.trim(), day = parseInt(root.querySelector("#mDay").value), amount = parseFloat(root.querySelector("#mAmt").value.replace(/[,₪\s]/g, ""));
    if (!name || !(day >= 1 && day <= 31) || !(amount > 0)) return;
    const s = st(); s.manualRecurring.push({ id: "m" + Date.now(), name, account: root.querySelector("#mAcct").value, day, amount, until: root.querySelector("#mUntil").value || null }); await save(s);
  });
}
