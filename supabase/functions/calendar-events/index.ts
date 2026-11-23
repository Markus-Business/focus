// @ts-nocheck
// Supabase Edge Function: liest die freigegebenen Kalender (ICS-Links) des angemeldeten Nutzers
// und liefert die Termine im gewünschten Zeitraum als JSON.
// Aufruf aus der App: db.functions.invoke('calendar-events', { body: { from, to } })
import ICAL from 'npm:ical.js@2';
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function publishableKey(): string {
  try { const k = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}'); if (k.default) return k.default; } catch (_) { /* */ }
  return Deno.env.get('SUPABASE_ANON_KEY') || '';
}

// Nur öffentliche https-Adressen zulassen (kein Zugriff auf interne Netze)
function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return u;
  } catch (_) { return null; }
}

function prefilterIcs(text: string, from: Date, to: Date) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');          // gefaltete Zeilen zusammenfügen
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const lo = ymd(new Date(from.getTime() - 2 * 864e5)), hi = ymd(new Date(to.getTime() + 2 * 864e5));
  const tzs = unfolded.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r?\n?/g) || [];
  const evs = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n?/g) || [];
  const keep = [];
  for (const b of evs) {
    if (/\n(RRULE|RDATE)[:;]/.test(b)) {                       // Serie: behalten, außer sie endete vor dem Zeitraum
      const until = (b.match(/UNTIL=(\d{8})/) || [])[1];
      if (!until || until >= lo) keep.push(b);
      continue;
    }
    const start = (b.match(/\nDTSTART[^:\n]*:(\d{8})/) || [])[1];
    const end = (b.match(/\nDTEND[^:\n]*:(\d{8})/) || [])[1] || start;
    const rid = (b.match(/\nRECURRENCE-ID[^:\n]*:(\d{8})/) || [])[1];
    if (!start) { keep.push(b); continue; }
    const inRange = end >= lo && start <= hi;
    const ridInRange = rid && rid >= lo && rid <= hi;          // verschobener Serientermin, dessen Original im Zeitraum lag
    if (inRange || ridInRange) keep.push(b);
  }
  return { text: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Fokus//DE\r\n' + tzs.join('') + keep.join('') + 'END:VCALENDAR\r\n', total: evs.length, kept: keep.length };
}

function expandIcs(ICAL: any, text: string, from: Date, to: Date): any[] {
  const root = new ICAL.Component(ICAL.parse(prefilterIcs(text, from, to).text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(new ICAL.Timezone(tz)); } catch (_) { /* doppelt registriert */ }
  }
  const masters = new Map();
  const exceptions = [];
  for (const ve of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex);
    else masters.set(ex.uid + '#' + ex.recurrenceId.toString(), ex);
  }

  const out = [];
  const fromMs = from.getTime(), toMs = to.getTime();
  const push = (ev, start, end, comp) => {
    const s = start.toJSDate(), e = (end || start).toJSDate();
    if (e.getTime() <= fromMs || s.getTime() >= toMs) return;
    if ((comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return;
    const transp = (comp.getFirstPropertyValue('transp') || '').toUpperCase();
    const allDay = start.isDate;
    out.push({
      title: ev.summary || '(ohne Titel)',
      start: allDay ? start.toString().slice(0, 10) : s.toISOString(),
      end: allDay ? (end ? end.toString().slice(0, 10) : start.toString().slice(0, 10)) : e.toISOString(),
      allDay,
      busy: transp !== 'TRANSPARENT',
      location: ev.location || null,
    });
  };

  for (const ev of masters.values()) {
    if (!ev.startDate) continue;
    if (ev.isRecurring()) {
      const it = ev.iterator();
      let next, guard = 0;
      while ((next = it.next()) && guard++ < 60000) {             // reicht z. B. für tägliche Serien seit über 100 Jahren
        if (next.toJSDate().getTime() >= toMs) break;
        if (next.toJSDate().getTime() < fromMs - 40 * 864e5) continue;   // weit vor dem Zeitraum: Details sparen
        const d = ev.getOccurrenceDetails(next);
        push(d.item, d.startDate, d.endDate, d.item.component);
      }
    } else {
      push(ev, ev.startDate, ev.endDate, ev.component);
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const auth = req.headers.get('Authorization') || '';
    const db = createClient(Deno.env.get('SUPABASE_URL')!, publishableKey(), { global: { headers: { Authorization: auth } } });
    const { from, to } = await req.json().catch(() => ({}));
    const fromD = new Date(from), toD = new Date(to);
    if (isNaN(+fromD) || isNaN(+toD) || toD <= fromD || +toD - +fromD > 120 * 864e5) return json({ error: 'Ungültiger Zeitraum' }, 400);

    // RLS sorgt dafür, dass nur die eigenen Kalender gelesen werden
    const { data: cals, error } = await db.from('calendars').select('id, name, url, color').eq('enabled', true);
    if (error) return json({ error: error.message }, 401);

    const events: unknown[] = [];
    const errors: { calendar_id: string; name: string; message: string }[] = [];
    // Kalender parallel herunterladen, aber nacheinander auswerten (spart Speicher)
    const texts = await Promise.all((cals || []).map(async (c) => {
      const url = safeUrl(c.url);
      if (!url) return { c, err: 'Ungültiger Link' };
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Fokus-App/1.0' } });
        clearTimeout(timer);
        if (!res.ok) return { c, err: `Kalender antwortet mit ${res.status}` };
        const text = await res.text();
        if (!text.includes('BEGIN:VCALENDAR')) return { c, err: 'Kein Kalender unter diesem Link' };
        return { c, text };
      } catch (e) { return { c, err: e instanceof Error ? e.message : String(e) }; }
    }));
    for (const r of texts) {
      if (r.err) { errors.push({ calendar_id: r.c.id, name: r.c.name, message: r.err }); continue; }
      try {
        for (const e of expandIcs(ICAL, r.text, fromD, toD)) events.push({ ...e, calendar_id: r.c.id, calendar: r.c.name, color: r.c.color });
      } catch (e) {
        errors.push({ calendar_id: r.c.id, name: r.c.name, message: 'Kalender konnte nicht gelesen werden' });
      }
      r.text = null;
    }
    return json({ events, errors });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
