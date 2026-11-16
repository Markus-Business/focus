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

function expandIcs(ICAL: any, text: string, from: Date, to: Date): any[] {
  const root = new ICAL.Component(ICAL.parse(text));
  // Zeitzonen aus der Datei bekannt machen
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(new ICAL.Timezone(tz)); } catch (_) { /* doppelt registriert */ }
  }
  const vevents = root.getAllSubcomponents('vevent');
  const masters = new Map();
  const exceptions = [];
  for (const ve of vevents) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex);
    else masters.set(ex.uid + '#' + ex.recurrenceId.toString(), ex); // Ausnahme ohne Serie
  }

  const out = [];
  const fromMs = from.getTime(), toMs = to.getTime();
  const push = (ev, start, end, comp) => {
    const s = start.toJSDate(), e = (end || start).toJSDate();
    if (e.getTime() <= fromMs || s.getTime() >= toMs) return;
    const status = (comp.getFirstPropertyValue('status') || '').toUpperCase();
    if (status === 'CANCELLED') return;
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
      while ((next = it.next()) && guard++ < 3000) {
        if (next.toJSDate().getTime() >= toMs) break;
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
    await Promise.all((cals || []).map(async (c) => {
      const url = safeUrl(c.url);
      if (!url) { errors.push({ calendar_id: c.id, name: c.name, message: 'Ungültiger Link' }); return; }
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Fokus-App/1.0' } });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Kalender antwortet mit ${res.status}`);
        const text = await res.text();
        if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Kein Kalender unter diesem Link');
        for (const e of expandIcs(ICAL, text, fromD, toD)) events.push({ ...e, calendar_id: c.id, calendar: c.name, color: c.color });
      } catch (e) {
        errors.push({ calendar_id: c.id, name: c.name, message: e instanceof Error ? e.message : String(e) });
      }
    }));
    return json({ events, errors });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
