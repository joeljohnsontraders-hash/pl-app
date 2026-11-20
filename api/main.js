/* Green Trends app server on Supabase (fast path). Logins and P&L book writing stay on Google Apps Script. */
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL"), { prepare: false, max: 4, idle_timeout: 30, connect_timeout: 10 });
const EXEC = "https://script.google.com/macros/s/AKfycbxm8jk6F32nN2UcBahKh_6RQl8j5xbIAD4j7qssGd_J5dZAfIE32sw5nm61mrdjwhjK/exec";
const BR = ["Potheri", "Guduvanchery", "Chengalpattu", "Urapakkam"];
const DEFAULTS = { slots: ["12:00", "14:00", "17:00", "19:00"], remindMin: 5, lateMin: 30, closingAlert: "11:00", gst: 5, woPer: 6, woMax: 4, templateVersion: 1 };
const DEN = [500, 200, 100, 50, 20, 10, 5, 2, 1];
const TZ = "Asia/Kolkata";
const J = (o) => sql.json(o == null ? null : o);
const N = (v) => { const x = parseFloat(String(v == null ? "" : v).replace(/[₹,\s]/g, "")); return isNaN(x) ? 0 : x; };
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const sp = (s) => s.replace(/[  ]/g, " ");
const istDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const istTime = () => sp(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date())).toLowerCase();
const istHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const stamp = () => { const d = new Date(), p = (o) => new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: TZ }, o)).format(d);
  return p({ day: "numeric" }) + " " + p({ month: "short" }) + ", " + sp(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(d)); };
const ydayOf = () => istDay(new Date(Date.now() - 864e5));
const role = (u) => u.role === "owner" ? "controller" : u.role === "viewer" ? "owner" : u.role;
const meOf = (u) => ({ id: u.id, name: u.name || "", role: role(u), branch: u.branch || "" });
const err = (m) => { throw new Error(m); };

/* ---------- Google side (logins, P&L books) ---------- */
async function gas(fn, args) {
  const r = await fetch(EXEC, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ fn, args }) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
/* who is calling: the login is checked with Google once, then kept here and re-checked in the background every 10 minutes */
async function who(tok) {
  tok = String(tok || ""); if (tok.length < 20) err("SESSION");
  const r = await sql`select u, checked from app_sessions where token = ${tok}`;
  const fresh = async () => { try { const u = await gas("appWho", [tok]); await sql`insert into app_sessions (token, u, checked) values (${tok}, ${J(u)}, now()) on conflict (token) do update set u = excluded.u, checked = now()`; return u; }
    catch (e) { if (e.message === "SESSION") await sql`delete from app_sessions where token = ${tok}`; throw e; } };
  if (r.length) { if (Date.now() - new Date(r[0].checked).getTime() > 6e5) { const p = fresh().catch(() => {}); try { EdgeRuntime.waitUntil(p); } catch (e) {} } return r[0].u; }
  return await fresh();
}
function can(u, b, write) {
  const r = role(u);
  if (r === "controller") return true;
  if (r === "owner") { if (write) err("The owner app is view only."); return true; }
  if (r === "manager") { if (u.branch !== b) err("You can only open your own branch."); return true; }
  err("No access.");
}
const ctrl = (u) => { if (u.role !== "owner") err("Only the controller can do this."); return u; };
const lock = (key, fn) => sql.begin(async (tx) => { await tx`select pg_advisory_xact_lock(hashtext(${key}))`; return fn(tx); });

/* ---------- data ---------- */
async function settings(q = sql) { const o = Object.assign({}, DEFAULTS); (await q`select key, value from app_settings`).forEach((r) => { o[r.key] = r.value; }); return o; }
async function staff(q = sql) { return (await q`select * from app_staff where status = 'active' order by ord`).map((x) => ({ id: x.id, branch: x.branch, name: x.name, g: x.section, t: x.target == null ? 0 : Number(x.target) || 0,
  isNew: x.added_by !== "set-up" && x.added_by !== "controller" && String(x.note || "").indexOf("new") === 0 })); }
async function stock(b, q = sql) { const rows = b ? await q`select * from app_stock where branch = ${b} order by ord` : await q`select * from app_stock order by ord`;
  return rows.map((x) => ({ branch: x.branch, n: x.product, mrp: Number(x.mrp) || 0, c: Number(x.count) || 0, locked: !!x.locked })); }
async function alerts(n, q = sql) { return (await q`select id, ts, branch, type, text, key, done from app_alerts order by seq desc limit ${n}`); }
async function getDay(b, d, q = sql) { const r = await q`select att, rep, clo, updated, by from app_days where branch = ${b} and date = ${d}`;
  return r.length ? { branch: b, date: d, att: r[0].att, rep: r[0].rep, clo: r[0].clo, updated: r[0].updated, by: r[0].by } : { branch: b, date: d, att: null, rep: null, clo: null }; }
async function putPart(q, b, d, part, obj, by) {
  if (["att", "rep", "clo"].indexOf(part) < 0) err("Unknown part.");
  if (JSON.stringify(obj).length > 250000) err("Too much in one day. Remove empty rows and try again.");
  const cur = await getDay(b, d, q); cur[part] = obj; const s = daySum(cur.att, cur.rep, cur.clo);
  await q`insert into app_days (branch, date, ${q(part)}, sum, updated, by) values (${b}, ${d}, ${J(obj)}, ${J(s)}, now(), ${by})
    on conflict (branch, date) do update set ${q(part)} = excluded.${q(part)}, sum = excluded.sum, updated = now(), by = excluded.by`;
}
async function alert(q, b, type, text, key) {
  if (key) { const r = await q`update app_alerts set ts = ${stamp()}, branch = ${b}, type = ${type}, text = ${text} where key = ${key} returning id`; if (r.length) return; }
  await q`insert into app_alerts (id, ts, branch, type, text, key, done) values (${uid()}, ${stamp()}, ${b}, ${type}, ${text}, ${key || ""}, false) on conflict do nothing`;
}
const doneKey = (q, key) => q`update app_alerts set done = true where key = ${key}`;
const log = (q, u, asName, b, d, what, detail) => q`insert into app_log (ts, who, in_app_of, branch, date, what, detail) values (${stamp()}, ${u.name || ""}, ${asName || ""}, ${b || ""}, ${d || ""}, ${what}, ${detail || ""})`;
async function setSetting(q, k, v) { await q`insert into app_settings (key, value) values (${k}, ${J(v)}) on conflict (key) do update set value = excluded.value`; }

/* the small summary of a branch-day (kept with every save) */
function daySum(att, rep, clo) {
  const sn = rep && rep.snaps && rep.snaps.cl, rws = (sn ? sn.data : rep && rep.rows) || {}, mc = N(sn ? sn.mcAmt : rep && rep.mcAmt);
  let svc = 0, bills = 0, prod = 0; const st = {}, stB = {}, prods = [];
  Object.keys(rws).forEach((n) => { const v = rws[n] || {}, s = N(v.svc), bl = N(v.bills); svc += s; bills += bl; if (s) st[n] = s; if (bl) stB[n] = bl;
    (Array.isArray(v.prod) ? v.prod : []).forEach((p) => { prod += N(p.q) * N(p.p); prods.push({ n: p.n, q: p.q, p: p.p, staff: n, pay: p.pay }); }); });
  const o = { svc, mc, net: svc + mc, bills, prod, prods, staff: st, staffB: stB, att: att && att.att || {}, status: clo && clo.status || "open", waived: !!(clo && clo.waived), sent: !!(clo && clo.sentAt), slots: Object.keys(rep && rep.snaps || {}) };
  if (clo) { const sumL = (a, f) => (a || []).reduce((t, r) => t + N(r[f]), 0);
    Object.assign(o, { hasClo: true, den: DEN.reduce((t, d) => t + d * N((clo.den || {})[d]), 0), openTyped: String(clo.openTyped || "").trim(), tot: String(clo.totSales || "").trim() !== "" ? N(clo.totSales) : 0,
      exp: sumL(clo.exp, "a"), gp: sumL(clo.gpay, "a"), cd: sumL(clo.card, "a"), accC: sumL(clo.acc, "c"), accD: sumL(clo.acc, "d"),
      adv: (clo.acc || []).filter((r) => r.s && N(r.d)).map((r) => ({ n: r.s, a: N(r.d), t: r.t || "" })), issues: clo.issues || [], note: clo.note || "", sentAt: clo.sentAt || "" }); }
  return o;
}
async function sums(ym, b, q = sql) {
  const rows = b ? await q`select branch, date, sum from app_days where branch = ${b} and date like ${ym + "%"}`
    : await q`select branch, date, sum from app_days where date like ${ym + "%"} or sum->>'status' in ('sent', 'changed')`;
  return rows.map((r) => Object.assign({}, r.sum || {}, { branch: r.branch, date: r.date }));
}
function monthSums(list0, b, ym, full) {
  const list = list0.filter((x) => x.branch === b && String(x.date).slice(0, 7) === ym).sort((p, q) => p.date < q.date ? -1 : 1); let prev = null;
  const cashKeys = ["den", "openTyped", "tot", "exp", "gp", "cd", "accC", "accD", "adv", "issues", "note", "sentAt"];
  return list.map((x) => { const o = Object.assign({}, x); delete o.branch; delete o.hasClo;
    if (x.hasClo) { if (full) { const open = x.openTyped !== "" ? N(x.openTyped) : (prev || 0), bal = open + x.tot + x.prod + x.accC - x.exp - x.accD - x.cd - x.gp;
        Object.assign(o, { open, opened: x.openTyped !== "", bal, ex: x.den ? x.den - bal : null }); } if (x.den) prev = x.den; }
    if (!full) cashKeys.forEach((k) => delete o[k]);
    return o; });
}

/* ================================================================== calls */
const API = {
  async appPing() { return { ok: true, at: istTime() }; },
  async appBoot(tok) {
    const u = await who(tok), me = meOf(u), today = istDay(), yday = ydayOf(), before = istDay(new Date(Date.now() - 2 * 864e5));
    const out = { me, today, yday, now: istTime(), branches: BR };
    if (me.role === "manager") {
      if (!me.branch) err("No branch is set for you yet. Ask the controller.");
      const [s, st, sk, d0, d1, d2, m] = await Promise.all([settings(), staff(), stock(me.branch), getDay(me.branch, today), getDay(me.branch, yday), getDay(me.branch, before), sums(today.slice(0, 7), me.branch)]);
      Object.assign(out, { settings: s, staff: st, stock: sk, day: d0, yesterday: d1, before: d2, month: monthSums(m, me.branch, today.slice(0, 7), false) });
    } else { const [s, st, sk, al] = await Promise.all([settings(), staff(), stock(), alerts(80)]); Object.assign(out, { settings: s, staff: st, stock: sk, alerts: al }); }
    return out;
  },
  async appDay(tok, b, d) { const u = await who(tok); can(u, b, false); return getDay(b, d); },
  async appSave(tok, b, d, part, obj, asName) {
    const u = await who(tok); can(u, b, true); if (["att", "rep", "clo"].indexOf(part) < 0) err("Unknown part."); obj = obj || {};
    return lock(b + "|" + d, async (tx) => {
      const cur = (await getDay(b, d, tx))[part], cv = cur && cur._v || 0;
      if ((obj._v || 0) !== cv) return { conflict: true, part, data: cur };
      if (role(u) === "manager" && part === "clo" && cur && cur.status === "approved") err("This day is already approved. Ask the controller to change it.");
      obj._v = cv + 1;
      if (role(u) === "manager" && part === "clo" && cur && (cur.status === "sent" || cur.status === "approved")) obj.status = "changed";
      await putPart(tx, b, d, part, obj, u.name || u.id);
      if (role(u) === "controller") await log(tx, u, asName || "", b, d, "edited " + part, "");
      return { ok: true, _v: obj._v };
    });
  },
  async appSendSlot(tok, b, d, slot) {
    const u = await who(tok); can(u, b, true); if (["s12", "s2", "s5", "s7"].indexOf(slot) < 0) err("Unknown report time.");
    return lock(b + "|" + d, async (tx) => {
      const rep = (await getDay(b, d, tx)).rep || {}; rep.snaps = rep.snaps || {}; const was = !!rep.snaps[slot];
      rep.snaps[slot] = { at: was ? rep.snaps[slot].at : istTime(), fixed: was, data: rep.rows || {}, mcAmt: rep.mcAmt || "", list: rep.list || [] };
      rep._v = (rep._v || 0) + 1; await putPart(tx, b, d, "rep", rep, u.name || u.id);
      return { ok: true, at: rep.snaps[slot].at, _v: rep._v };
    });
  },
  async appSendClosing(tok, b, d, issues) {
    const u = await who(tok); can(u, b, true);
    return lock(b + "|" + d, async (tx) => {
      const day = await getDay(b, d, tx), clo = day.clo || {}, rep = day.rep || {};
      if (clo.status === "approved") err("This day is already approved.");
      clo.status = "sent"; clo.issues = (issues || []).slice(0, 30).map(String); clo.late = d !== istDay();
      clo.sentAt = istTime() + (clo.late ? ", next day" : ""); clo._v = (clo._v || 0) + 1;
      rep.snaps = rep.snaps || {}; rep.snaps.cl = { at: istTime(), data: rep.rows || {}, mcAmt: rep.mcAmt || "", list: rep.list || [] }; rep._v = (rep._v || 0) + 1;
      await putPart(tx, b, d, "clo", clo, u.name || u.id); await putPart(tx, b, d, "rep", rep, u.name || u.id);
      await alert(tx, b, "closing", b + " sent the " + d + " closing" + (clo.late ? " late" : "") + (clo.issues.length ? " · " + clo.issues.length + " to check" : ""), "clo|" + b + "|" + d);
      return { ok: true, sentAt: clo.sentAt, _v: clo._v };
    });
  },
  async appStaffOp(tok, b, op, f) {
    const u = await who(tok); can(u, b, true); f = f || {};
    return lock("staff", async (tx) => {
      if (op === "add") {
        const n = String(f.name || "").trim(); if (!n) err("Write the name."); if (["G", "L", "O", "H"].indexOf(f.g) < 0) err("Pick the section.");
        await tx`insert into app_staff (id, branch, name, section, target, status, added_by, added_at, note) values (${uid()}, ${b}, ${n}, ${f.g}, null, 'active', ${u.name || u.id}, ${new Date().toISOString()}, 'new')`;
        if (role(u) === "manager") await alert(tx, b, "staff", b + " added new staff: " + n + " (" + ({ G: "Gents SSP", L: "Ladies SSP", O: "OM", H: "HK" })[f.g] + ")");
      } else if (op === "remove") {
        const r = (await tx`select * from app_staff where id = ${f.id || ""} and branch = ${b}`)[0]; if (!r) err("Not found."); if (!f.reason) err("Pick a reason.");
        await tx`update app_staff set status = 'removed', note = ${"removed: " + f.reason + (f.note ? " · " + f.note : "")} where id = ${r.id}`;
        if (role(u) === "manager") await alert(tx, b, "staff", b + " removed " + r.name + " from the staff list: " + f.reason + (f.note ? " · " + f.note : ""));
      } else if (op === "edit" && role(u) === "controller") {
        const r = (await tx`select * from app_staff where id = ${f.id || ""}`)[0]; if (!r) err("Not found.");
        const name = f.name ? String(f.name).trim() : r.name, sec = f.g || r.section, br = f.branch || r.branch, t = f.t === undefined ? r.target : (f.t === "" ? null : N(f.t));
        await tx`update app_staff set name = ${name}, section = ${sec}, branch = ${br}, target = ${t}, note = '' where id = ${r.id}`;
      } else err("Unknown change.");
      return staff(tx);
    });
  },
  async appStockOp(tok, b, op, f) {
    const u = await who(tok); can(u, b, true); f = f || {};
    return lock("stock|" + b, async (tx) => {
      const r = (await tx`select * from app_stock where branch = ${b} and product = ${f.n || ""}`)[0];
      const move = (qty, reason) => tx`insert into app_moves (ts, date, branch, product, qty, reason, by) values (${stamp()}, ${istDay()}, ${b}, ${f.n}, ${qty}, ${reason}, ${u.name || u.id})`;
      if (op === "ask") { const n = String(f.n || "").trim(); if (!n) err("Write the product name.");
        await alert(tx, b, "product", b + " asked to add \"" + n + "\" to the product list" + (f.mrp ? " · MRP ₹" + f.mrp : "") + (f.q ? " · " + f.q + " in hand" : "")); return stock(b, tx); }
      if (op === "add" && role(u) === "controller") { if (r) err("Already in the list.");
        await tx`insert into app_stock (branch, product, mrp, count, locked, updated) values (${b}, ${f.n}, ${N(f.mrp)}, ${Math.round(N(f.q))}, true, ${stamp()})`; await move(Math.round(N(f.q)), "Added by controller"); return stock(b, tx); }
      if (op === "lock" && role(u) === "controller") { await tx`update app_stock set locked = true where branch = ${b}`; return stock(b, tx); }
      if (!r) err("Product not found.");
      const c = Number(r.count) || 0, q = Math.round(N(f.q));
      if (op === "mrp" && role(u) === "controller") await tx`update app_stock set mrp = ${N(f.mrp)}, updated = ${stamp()} where branch = ${b} and product = ${r.product}`;
      else {
        if (q <= 0) err("Pieces must be a whole number.");
        if (op === "plus") { await tx`update app_stock set count = ${c + q}, updated = ${stamp()} where branch = ${b} and product = ${r.product}`; await move(q, "Received" + (f.bill ? " · bill " + f.bill : ""));
          await alert(tx, b, "stock", b + " received stock: " + f.n, "rcv|" + b + "|" + f.n + "|" + istDay()); }
        else if (op === "minus" || op === "sale") { if (q > c) err("Only " + c + " in stock."); if (op === "minus" && !f.reason) err("Pick a reason.");
          await tx`update app_stock set count = ${c - q}, updated = ${stamp()} where branch = ${b} and product = ${r.product}`; await move(-q, op === "sale" ? "Sold by " + (f.staff || "?") + (f.pay ? " · " + f.pay : "") : f.reason);
          if (op === "minus") await alert(tx, b, "stock", b + " took " + q + " × " + f.n + " out of stock: " + f.reason); }
        else if (op === "unsale") { await tx`update app_stock set count = ${c + q}, updated = ${stamp()} where branch = ${b} and product = ${r.product}`; await move(q, "Sale removed"); }
        else err("Unknown change.");
      }
      return stock(b, tx);
    });
  },
  async appMoves(tok, b) { const u = await who(tok); can(u, b, false); return sql`select ts, date, branch, product, qty, reason, by from app_moves where branch = ${b} order by id desc limit 60`; },
  async appMonthApi(tok, b, ym) { const u = await who(tok); can(u, b, false); return monthSums(await sums(ym, b), b, ym, false); },
  async appAlerts(tok) { const u = await who(tok); if (role(u) === "manager") err("No access."); return alerts(150); },
  async appPhoto(tok, b, d, op, x) {
    const u = await who(tok); can(u, b, op !== "list");
    if (op === "list") { const want = Array.isArray(x) ? x.map(String) : null, out = {};
      (want ? await sql`select id, data from app_photos where branch = ${b} and date = ${d} and id = any(${sql.array(want)})` : await sql`select id, data from app_photos where branch = ${b} and date = ${d}`).forEach((r) => { out[r.id] = r.data; });
      return out; }
    if (op === "add") { const s = String(x || ""); if (!/^data:image\/(jpeg|png|webp);base64,/.test(s) || s.length > 1500000) err("This photo could not be saved.");
      const id = uid(); await sql`insert into app_photos (id, branch, date, data, ts, by) values (${id}, ${b}, ${d}, ${s}, ${stamp()}, ${u.name || u.id})`; return { id }; }
    if (op === "remove") { await sql`delete from app_photos where id = ${String(x)} and branch = ${b}`; return { ok: true }; }
    err("Unknown change.");
  },
  async appTell(tok, b, type, f) {
    const u = await who(tok); can(u, b, true); f = f || {};
    if (type === "opening") await alert(sql, b, "opening", b + " changed the " + f.date + " opening cash" + (f.from !== "" && f.from != null ? " from ₹" + f.from : "") + " to ₹" + f.to, "open|" + b + "|" + f.date);
    else if (type === "noatt") await alert(sql, b, "noatt", b + ": the " + f.date + " report was started before attendance", "noatt|" + b + "|" + f.date);
    else err("Unknown.");
    return { ok: true };
  },
  /* controller + owner: everything for all four branches (the people list comes from Google separately) */
  async appAll(tok, ym) {
    const u = await who(tok), r = role(u); if (r === "manager") err("No access.");
    const today = istDay(), yday = ydayOf(); ym = ym || today.slice(0, 7);
    const [s, st, sk, sm, dd, all] = await Promise.all([settings(), staff(), stock(), sums(ym), sql`select branch, date, att, rep, clo from app_days where date in (${today}, ${yday})`, alerts(600)]);
    const out = { me: meOf(u), today, yday, now: istTime(), ym, branches: BR, settings: s, staff: st, stock: sk, month: {}, days: {}, review: [] };
    BR.forEach((b) => { out.month[b] = monthSums(sm, b, ym, true); });
    dd.forEach((x) => { out.days[x.branch + "|" + x.date] = { att: x.att, rep: x.rep, clo: x.clo }; });
    sm.forEach((x) => { if (x.status === "sent" || x.status === "changed") out.review.push({ b: x.branch, date: x.date, status: x.status, sentAt: x.sentAt || "", issues: x.issues || [] }); });
    out.review.sort((p, q) => p.date < q.date ? -1 : 1);
    const al = all.filter((a) => !a.done);
    out.alerts = (r === "controller" ? al : al.filter((a) => a.type === "opening" || a.type === "closing")).slice(0, 120).map((a) => ({ id: a.id, ts: a.ts, b: a.branch, type: a.type, text: a.text, key: a.key }));
    if (r === "controller") { out.noatt = {}; all.forEach((a) => { const k = String(a.key || ""); if (k.indexOf("noatt|") === 0 && String(k.split("|")[2]).slice(0, 7) === ym) out.noatt[a.branch] = (out.noatt[a.branch] || 0) + 1; }); }
    return out;
  },
  /* controller: preview / approve (Google writes the P&L book) / send back / clear a reminder */
  async appReview(tok, b, d, act, f) {
    const u = ctrl(await who(tok)); f = f || {}; if (BR.indexOf(b) < 0) err("Pick the branch.");
    if (act === "preview") { const [day, s] = await Promise.all([getDay(b, d), settings()]); const r = await gas("appBookPreview", [tok, b, d, day, s, f.fix || {}]); return { day, lines: r.lines, cats: r.cats }; }
    if (act === "approve") {
      const [day, s] = await Promise.all([getDay(b, d), settings()]);
      const r = await gas("appBookWrite", [tok, b, d, day, s, f.fix || {}, !!f.replace]); if (r.needReplace) return r;
      await lock(b + "|" + d, async (tx) => {
        const rules = Object.assign({}, s.catRules || {}); Object.keys(f.fix || {}).forEach((k) => { const t = k.split("|").slice(1).join("|"); if (t) rules[t] = f.fix[k]; });
        await setSetting(tx, "catRules", rules);
        const clo = (await getDay(b, d, tx)).clo || {}; clo.status = "approved"; clo.approvedAt = istTime(); clo.note = ""; clo._v = (clo._v || 0) + 1;
        await putPart(tx, b, d, "clo", clo, u.name); await doneKey(tx, "clo|" + b + "|" + d);
        await log(tx, u, "", b, d, "approved", (r.missing || []).length ? "not in STAFF SALES: " + r.missing.join(", ") : "");
      });
      return { ok: true, missing: r.missing || [], day: await getDay(b, d) };
    }
    if (act === "back" || act === "waive") {
      if (act === "back" && !String(f.note || "").trim()) err("Write what to fix.");
      await lock(b + "|" + d, async (tx) => {
        const clo = (await getDay(b, d, tx)).clo || {};
        if (act === "back") { clo.status = "back"; clo.note = String(f.note).trim(); } else clo.waived = true;
        clo._v = (clo._v || 0) + 1; await putPart(tx, b, d, "clo", clo, u.name);
        await doneKey(tx, (act === "back" ? "clo|" : "ycl|") + b + "|" + d);
        if (act === "back") await log(tx, u, "", b, d, "sent back", clo.note);
      });
      return { ok: true, day: await getDay(b, d) };
    }
    err("Unknown.");
  },
  async appAlertDone(tok, id) { ctrl(await who(tok)); await sql`update app_alerts set done = true where id = ${String(id)}`; return { ok: true }; },
  async appSetting(tok, k, v) {
    ctrl(await who(tok)); const ok = ["slots", "gst", "woPer", "woMax", "remindMin", "lateMin", "closingAlert", "catRules", "mcRate", "strictAtt"]; if (ok.indexOf(k) < 0) err("Unknown setting.");
    if (k === "slots" && (!Array.isArray(v) || v.length !== 4 || v.some((t) => !/^\d{2}:\d{2}$/.test(t)))) err("Four times like 12:00.");
    await setSetting(sql, k, v); return settings();
  },
  /* live view: which page every open app is on */
  async appBeat(tok, info) {
    const u = await who(tok); info = info || {};
    const o = { id: u.id, name: u.name || u.phone, role: role(u), branch: u.branch || "", page: String(info.page || ""), sub: String(info.sub || "").slice(0, 80), at: Date.now(), t: istTime() };
    const prev = (await sql`select data, cmd, cmd_at from app_beats where id = ${u.id}`)[0];
    await sql`insert into app_beats (id, data, at) values (${u.id}, ${J(o)}, now()) on conflict (id) do update set data = excluded.data, at = now()`;
    const pd = prev && prev.data || {};
    if (o.role === "owner" && (pd.page !== o.page || pd.sub !== o.sub)) await log(sql, u, "", o.sub || "", istDay(), "owner opened", o.page);
    if (prev && prev.cmd && prev.cmd_at && Date.now() - new Date(prev.cmd_at).getTime() < 6e5) { await sql`update app_beats set cmd = null where id = ${u.id}`; return { cmd: prev.cmd }; }
    return { ok: true };
  },
  async appWatch(tok) {
    ctrl(await who(tok));
    const [bt, lg] = await Promise.all([sql`select data from app_beats where at > now() - interval '15 minutes'`, sql`select ts, who, detail, branch from app_log where what = 'owner opened' order by id desc limit 40`]);
    return { beats: bt.map((r) => r.data).filter((b) => b && b.role !== "controller"), ownerLog: lg.map((r) => ({ ts: r.ts, who: r.who, page: r.detail, sub: r.branch })), now: Date.now() };
  },
  async appSend(tok, id, page) { ctrl(await who(tok)); await sql`insert into app_beats (id, cmd, cmd_at) values (${String(id)}, ${String(page || "").slice(0, 30)}, now()) on conflict (id) do update set cmd = excluded.cmd, cmd_at = now()`; return { ok: true }; },
  /* one-time copy of the Google sheet data (sent by the Apps Script with the controller's login) */
  async appImport(tok, data) {
    ctrl(await who(tok)); data = data || {};
    if ((await sql`select 1 from app_meta where key = 'imported'`).length && !data.again) err("Already imported.");
    const T = (v) => v === true || String(v).toUpperCase() === "TRUE", S = (v) => v == null ? "" : String(v), P = (s) => { try { return s ? (typeof s === "string" ? JSON.parse(s) : s) : null; } catch (e) { return null; } };
    const n = { staff: 0, stock: 0, settings: 0, days: 0, alerts: 0, moves: 0, photos: 0 };
    for (const s of data.staff || []) { if (!s.id || !s.name) continue; n.staff++;
      await sql`insert into app_staff (id, branch, name, section, target, status, added_by, added_at, note) values (${S(s.id)}, ${S(s.branch)}, ${S(s.name)}, ${S(s.section)}, ${s.target === "" || s.target == null ? null : N(s.target)}, ${S(s.status) || "active"}, ${S(s.added_by)}, ${S(s.added_at)}, ${S(s.note)}) on conflict (id) do nothing`; }
    for (const s of data.stock || []) { if (!s.product) continue; n.stock++;
      await sql`insert into app_stock (branch, product, mrp, count, locked, updated) values (${S(s.branch)}, ${S(s.product)}, ${N(s.mrp)}, ${Math.round(N(s.count))}, ${T(s.locked)}, ${S(s.updated)}) on conflict (branch, product) do update set mrp = excluded.mrp, count = excluded.count, locked = excluded.locked`; }
    for (const s of data.settings || []) { if (!s.key) continue; n.settings++; let v = s.value; try { v = JSON.parse(s.value); } catch (e) {} await setSetting(sql, S(s.key), v); }
    for (const d of data.days || []) { if (!d.branch || !d.date) continue; n.days++; const a = P(d.att), r = P(d.rep), c = P(d.clo);
      await sql`insert into app_days (branch, date, att, rep, clo, sum, by) values (${S(d.branch)}, ${S(d.date).replace(/^'/, "")}, ${J(a)}, ${J(r)}, ${J(c)}, ${J(daySum(a, r, c))}, ${S(d.by)}) on conflict (branch, date) do nothing`; }
    for (const x of (data.alerts || []).slice().reverse()) { if (!x.id) continue; n.alerts++;
      await sql`insert into app_alerts (id, ts, branch, type, text, key, done) values (${S(x.id)}, ${S(x.ts)}, ${S(x.branch)}, ${S(x.type)}, ${S(x.text)}, ${S(x.key)}, ${T(x.done)}) on conflict do nothing`; }
    for (const x of (data.moves || []).slice().reverse()) { n.moves++;
      await sql`insert into app_moves (ts, date, branch, product, qty, reason, by) values (${S(x.ts)}, ${S(x.date)}, ${S(x.branch)}, ${S(x.product)}, ${Math.round(N(x.qty))}, ${S(x.reason)}, ${S(x.by)})`; }
    const ph = {}; (data.photos || []).forEach((x) => { (ph[x.id] = ph[x.id] || { x, parts: [] }).parts.push(x); });
    for (const id of Object.keys(ph)) { const x = ph[id].x, s = ph[id].parts.sort((p, q) => N(p.part) - N(q.part)).map((p) => S(p.data)).join(""); n.photos++;
      await sql`insert into app_photos (id, branch, date, data, ts, by) values (${S(id)}, ${S(x.branch)}, ${S(x.date).replace(/^'/, "")}, ${s}, ${S(x.ts)}, ${S(x.by)}) on conflict (id) do nothing`; }
    await sql`insert into app_meta (key, value) values ('imported', ${new Date().toISOString()}) on conflict (key) do update set value = excluded.value`;
    return n;
  },
  /* reminders: run every 10 minutes by the database clock */
  async appTick() {
    const s = await settings(), today = istDay(), yday = ydayOf(), late = Number(s.lateMin) || 30, toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; }, nowM = toMin(istHM());
    for (const b of BR) {
      const d = await getDay(b, today), snaps = (d.rep || {}).snaps || {}, started = !!(d.att && d.att.attDone);
      if (started) for (let i = 0; i < (s.slots || []).length; i++) { const t = s.slots[i], key = ["s12", "s2", "s5", "s7"][i];
        if (!snaps[key] && nowM >= toMin(t) + late && nowM < toMin(t) + late + 120) await alert(sql, b, "late", b + ": the " + t + " report is " + late + " minutes late", "late|" + b + "|" + today + "|" + key); }
      if (nowM >= toMin(s.closingAlert || "11:00")) { const yd = await getDay(b, yday), c = yd.clo;
        if ((yd.att || yd.rep || c) && (!c || ["open", "back", "changed"].indexOf(c.status) >= 0) && !(c && c.waived)) await alert(sql, b, "ycl", b + ": the " + yday + " closing is not sent yet", "ycl|" + b + "|" + yday); }
    }
    await sql`delete from app_alerts where seq < (select coalesce(min(seq), 0) from (select seq from app_alerts order by seq desc limit 600) t)`;
    await sql`delete from app_sessions where checked < now() - interval '40 days'`;
    return { ok: true };
  }
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let out;
  try {
    const q = JSON.parse(await req.text() || "{}");
    if (!Object.prototype.hasOwnProperty.call(API, q.fn)) throw new Error("Unknown call");
    out = { result: await API[q.fn].apply(null, q.args || []) };
  } catch (e) { out = { error: String(e && e.message || e) }; if (!/^(SESSION|Unknown|Only|This|Pick|Write|No |You |Too|Product|Pieces|Already|Not found|Four|The )/.test(out.error)) console.error(e); }
  return new Response(JSON.stringify(out), { headers: CORS });
});
