// Off The Map: reminder notifications.
// Called every 5 minutes by a pg_cron job (with a shared secret), and by the app to send a test.
// Builds each person's message from the plan in public.items and sends it with Web Push.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const APP = "https://ransdell91.github.io/Off-the-Map-App/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHORT: Record<string, string> = {
  salmon: "Salmon", "rancho-seco": "Rancho Seco", japantown: "Japantown", locke: "Locke", "port-chicago": "Port Chicago",
  "butterfly-town": "Butterfly Town", "delta-islands": "Delta islands", "tulare-lake": "Tulare Lake", allensworth: "Allensworth",
  malakoff: "Malakoff Diggins", "owens-manzanar": "Owens Valley", "hetch-hetchy": "Hetch Hetchy", sequoias: "Sequoias",
  "black-star": "Black Star Canyon", lassen: "Lassen", "tule-lake": "Tule Lake", "modoc-war": "Modoc War",
  wiyot: "Tuluwat & the Wiyot", "fog-redwoods": "Fog & Redwoods", cascadia: "Cascadia",
};
const WINDOW = 120; // minutes after the set time during which a missed reminder is still sent

type Task = { id: string; title: string; day: string; done?: boolean; who?: string; episode?: string; stage?: string; mins?: number };
type Msg = { title: string; body: string; url: string; tag: string };

let secrets: Record<string, string> | null = null;
async function getSecrets() {
  if (secrets) return secrets;
  const { data, error } = await db.rpc("otm_push_secrets");
  if (error) throw error;
  secrets = data as Record<string, string>;
  webpush.setVapidDetails(APP, secrets.otm_vapid_public, secrets.otm_vapid_private);
  return secrets;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function localNow(tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value || "0";
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  return { date, min: (+g("hour") % 24) * 60 + +g("minute"), dow: DOW[new Date(date + "T12:00:00Z").getUTCDay()] };
}
const addD = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dowOf = (d: string) => DOW[new Date(d + "T12:00:00Z").getUTCDay()];
const fmtD = (d: string) => { const x = new Date(d + "T12:00:00Z"); return `${DOW[x.getUTCDay()]} ${MON[x.getUTCMonth()]} ${x.getUTCDate()}`; };
const toMin = (t: string) => { const [h, m] = (t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const dur = (m: number) => { const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const forRole = (ts: Task[], role: string) => ts.filter((t) => role === "all" || !t.who || t.who === "both" || t.who === role);
const label = (t: Task) => (t.episode && SHORT[t.episode] ? SHORT[t.episode] + ": " : "") + t.title;
function lines(ts: Task[], max = 3) {
  const out = ts.slice(0, max).map((t) => "• " + label(t));
  if (ts.length > max) out.push(`+ ${ts.length - max} more`);
  return out;
}

// deno-lint-ignore no-explicit-any
function buildJobs(rows: any[], now: ReturnType<typeof localNow>, force?: string) {
  // deno-lint-ignore no-explicit-any
  const settings = (rows.find((r) => r.col === "config" && r.id === "settings")?.data || {}) as any;
  const P = settings.prompts || {};
  const start = (settings.rampUp && settings.rampUp.start) || "2026-11-02";
  const tasks: Task[] = rows.filter((r) => r.col === "tasks").map((r) => ({ ...r.data, id: r.id }));
  // deno-lint-ignore no-explicit-any
  const eps: any[] = rows.filter((r) => r.col === "episodes").map((r) => ({ ...r.data, id: r.id }));
  // deno-lint-ignore no-explicit-any
  const rems: any[] = rows.filter((r) => r.col === "reminders").map((r) => ({ ...r.data, id: r.id }));
  const due = (t: string) => force ? false : now.min >= toMin(t) && now.min < toMin(t) + WINDOW;
  const open = (d: string) => tasks.filter((t) => t.day === d && !t.done).sort((a, b) => (b.mins || 0) - (a.mins || 0));
  const jobs: { key: string; who: string; make: (role: string) => Msg | null }[] = [];

  const morning = (role: string): Msg | null => {
    const ts = forRole(open(now.date), role);
    const late = P.behind ? forRole(tasks.filter((t) => !t.done && t.day < now.date && t.day >= start), role) : [];
    if (!ts.length && !late.length) return null;
    const shoot = ts.some((t) => t.stage === "Shoot");
    const mins = ts.reduce((s, t) => s + (t.mins || 0), 0);
    const title = ts.length ? `${shoot ? "Shoot day" : "Today"}: ${plural(ts.length, "task")} · ${dur(mins)}` : "Catch-up";
    const body = [...lines(ts), ...(late.length ? [`${plural(late.length, "task")} still open from earlier days`] : [])].join("\n");
    return { title, body, url: "./#today", tag: "morning-" + now.date };
  };
  const night = (role: string): Msg | null => {
    const d = addD(now.date, 1), ts = forRole(open(d), role);
    if (!ts.length) return null;
    const mins = ts.reduce((s, t) => s + (t.mins || 0), 0);
    const shoot = ts.some((t) => t.stage === "Shoot");
    return { title: `Tomorrow${shoot ? " is a shoot day" : ""} (${dowOf(d)}): ${plural(ts.length, "task")} · ${dur(mins)}`, body: [...lines(ts), shoot ? "Charge batteries and pack tonight." : ""].filter(Boolean).join("\n"), url: "./#today", tag: "night-" + now.date };
  };
  const weekly = (role: string): Msg | null => {
    const days = Array.from({ length: 7 }, (_, i) => addD(now.date, i + (now.dow === "Sun" ? 1 : 0)));
    const out: string[] = [];
    let n = 0, mins = 0;
    for (const d of days) {
      const ts = forRole(open(d), role);
      if (!ts.length) continue;
      const m = ts.reduce((s, t) => s + (t.mins || 0), 0);
      n += ts.length; mins += m;
      out.push(`${fmtD(d)}: ${plural(ts.length, "task")} · ${dur(m)}${ts.some((t) => t.stage === "Shoot") ? " · shoot" : ""}`);
    }
    const rel = eps.filter((e) => e.release >= days[0] && e.release <= days[6]).map((e) => `Release ${fmtD(e.release)}: ${SHORT[e.id] || e.title}`);
    const late = P.behind ? forRole(tasks.filter((t) => !t.done && t.day < now.date && t.day >= start), role).length : 0;
    if (!n && !rel.length && !late) return null;
    return { title: `This week: ${plural(n, "task")} · ${dur(mins)}`, body: [...out, ...rel, ...(late ? [`${plural(late, "task")} carried over`] : [])].join("\n"), url: "./#calendar", tag: "weekly-" + now.date };
  };

  if (force === "morning" || (P.morning && due(P.morningTime || "08:00"))) jobs.push({ key: "morning", who: "all", make: morning });
  if (force === "night" || (P.night && due(P.nightTime || "19:00"))) jobs.push({ key: "night", who: "all", make: night });
  if (force === "weekly" || (P.weekly && now.dow === (P.weeklyDay || "Sun") && due(P.weeklyTime || "18:00"))) jobs.push({ key: "weekly", who: "all", make: weekly });
  for (const r of rems) {
    if (r.on === false || !r.time) continue;
    const today = r.date ? r.date === now.date : Array.isArray(r.days) && r.days.includes(now.dow);
    if (!today || !due(r.time)) continue;
    jobs.push({ key: "rem-" + r.id, who: r.who || "all", make: () => ({ title: r.title || "Reminder", body: r.text || "", url: "./#today", tag: "rem-" + r.id + "-" + now.date }) });
  }
  return jobs;
}

// deno-lint-ignore no-explicit-any
async function send(sub: any, msg: Msg) {
  try {
    await webpush.sendNotification(sub.sub, JSON.stringify(msg), { TTL: 6 * 3600, urgency: "normal" });
    await db.from("push_subs").update({ last_ok: new Date().toISOString() }).eq("id", sub.id);
    return true;
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    const code = (e as any)?.statusCode;
    if (code === 404 || code === 410) await db.from("push_subs").delete().eq("id", sub.id);
    console.error("push failed", code, (e as Error)?.message);
    return false;
  }
}
async function claim(key: string) {
  const { error } = await db.from("push_log").insert({ key });
  return !error; // a duplicate key means it was already sent
}

async function tick(force?: string, onlyEmail?: string) {
  await getSecrets();
  const { data: rows, error } = await db.from("items").select("col,id,data").in("col", ["tasks", "episodes", "reminders", "config"]).limit(10000);
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  const settings = (rows!.find((r: any) => r.col === "config" && r.id === "settings")?.data || {}) as any;
  const tz = (settings.prompts && settings.prompts.tz) || "America/Los_Angeles";
  const now = localNow(tz);
  const jobs = buildJobs(rows!, now, force);
  if (!jobs.length) return { now, jobs: 0, sent: 0 };
  let q = db.from("push_subs").select("*");
  if (onlyEmail) q = q.eq("email", onlyEmail);
  const { data: subs } = await q;
  let sent = 0;
  for (const j of jobs) {
    // Keep a copy in the app's Prompts list (once per job per day).
    const all = j.make("all");
    if (all && !force && await claim(`prompt:${j.key}:${now.date}`)) {
      await db.from("items").upsert({ col: "prompts", id: `${j.key}-${now.date}`, data: { title: all.title, body: all.body, at: new Date().toISOString(), read: false } }, { onConflict: "col,id", ignoreDuplicates: true });
    }
    for (const s of subs || []) {
      if (j.who !== "all" && s.role !== "all" && s.role !== j.who) continue;
      const msg = j.make(s.role);
      if (!msg) continue;
      if (!force && !(await claim(`${j.key}:${now.date}:${s.id}`))) continue;
      if (await send(s, msg)) sent++;
    }
  }
  return { now, jobs: jobs.map((j) => j.key), sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // deno-lint-ignore no-explicit-any
    const body: any = await req.json().catch(() => ({}));
    const sec = await getSecrets();
    if (req.headers.get("x-cron-secret") && req.headers.get("x-cron-secret") === sec.otm_cron_secret) {
      return json(await tick());
    }
    // Calls from the app: must be a signed-in member.
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(token);
    const email = u?.user?.email?.toLowerCase();
    if (!email) return json({ error: "Sign in first." }, 401);
    const { data: m } = await db.from("members").select("email").eq("email", email).maybeSingle();
    if (!m) return json({ error: "Not on the member list." }, 403);
    if (body.action === "test") {
      const { data: subs } = await db.from("push_subs").select("*").eq("email", email);
      if (!subs || !subs.length) return json({ error: "This phone isn't set up for notifications yet." }, 400);
      let sent = 0;
      for (const s of subs) if (await send(s, { title: "Notifications are on", body: "Off The Map will remind you here. Tap to open the app.", url: "./#settings", tag: "test" })) sent++;
      return json({ sent });
    }
    if (body.action === "preview" && ["morning", "night", "weekly"].includes(body.kind)) {
      // Send today's version of a reminder now, to this person's phones only.
      return json(await tick(body.kind, email));
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error)?.message || "Server error" }, 500);
  }
});
