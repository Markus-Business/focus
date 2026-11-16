-- To-Do-App – Datenbank-Grundgerüst (Etappe 1)
-- Bereits angewendet (16.11.2026). Danach Migration 'harden_security_and_rls_performance':
-- Hilfsfunktion nach private.can_access_project verschoben, Policies mit (select auth.uid()), zusätzliche Indizes.

-- ---------- Projekte / Listen ----------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  color       text,
  area        text check (area in ('beruf', 'privat')),
  sort_order  double precision not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Mitglieder geteilter Listen (für die spätere gemeinsame Nutzung)
create table public.project_members (
  project_id  uuid not null references public.projects on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  role        text not null default 'editor' check (role in ('editor', 'viewer')),
  primary key (project_id, user_id)
);

-- Hilfsfunktion: darf der angemeldete Nutzer auf diese Liste zugreifen?
create or replace function public.can_access_project(p uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from projects where id = p and owner_id = auth.uid())
      or exists (select 1 from project_members where project_id = p and user_id = auth.uid());
$$;

-- ---------- Aufgaben ----------
create table public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null default auth.uid() references auth.users on delete cascade,
  project_id          uuid references public.projects on delete cascade,
  parent_id           uuid references public.tasks on delete cascade,   -- Unteraufgaben
  title               text not null,
  notes               text,
  priority            smallint not null default 0 check (priority between 0 and 3),
  due_date            date,
  due_time            time,
  estimate_pomodoros  smallint,
  estimate_minutes    integer,
  recurrence          text,                                             -- Wiederholregel, z. B. 'FREQ=WEEKLY;BYDAY=MO'
  tags                text[] not null default '{}',
  sort_order          double precision not null default 0,
  done                boolean not null default false,
  done_at             timestamptz,
  assigned_to         uuid references auth.users on delete set null,    -- Zuweisen (später)
  planned_date        date,                                             -- Tages-/Wochenplanung (später)
  planned_start       time,                                             -- Zeitblock im Kalender (später)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index tasks_project_idx on public.tasks (project_id);
create index tasks_parent_idx  on public.tasks (parent_id);
create index tasks_due_idx     on public.tasks (due_date);

-- ---------- Pomodoro-Einheiten ----------
create table public.pomodoro_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  task_id           uuid references public.tasks on delete set null,
  kind              text not null default 'focus' check (kind in ('focus', 'short_break', 'long_break')),
  started_at        timestamptz not null,
  ended_at          timestamptz,
  duration_minutes  integer,
  manual            boolean not null default false                      -- nachträglich erfasst
);

-- ---------- Wochenziele ----------
create table public.weekly_goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  week_start  date not null,
  title       text not null,
  done        boolean not null default false,
  sort_order  double precision not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- Einstellungen ----------
create table public.settings (
  user_id             uuid primary key default auth.uid() references auth.users on delete cascade,
  pomodoro_minutes    smallint not null default 25,
  short_break_minutes smallint not null default 5,
  long_break_minutes  smallint not null default 15,
  long_break_every    smallint not null default 4,
  auto_continue       boolean not null default false,                   -- Dauermodus
  sound               text not null default 'bell',
  work_start          time not null default '08:00',
  work_end            time not null default '18:00',
  work_days           smallint[] not null default '{1,2,3,4,5}',        -- 1 = Montag
  selected_calendars  text[] not null default '{}'
);

-- ---------- updated_at automatisch setzen ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tasks_touch before update on public.tasks
for each row execute function public.touch_updated_at();

-- ---------- Zugriffsschutz (jeder sieht nur seine bzw. geteilte Daten) ----------
alter table public.projects          enable row level security;
alter table public.project_members   enable row level security;
alter table public.tasks             enable row level security;
alter table public.pomodoro_sessions enable row level security;
alter table public.weekly_goals      enable row level security;
alter table public.settings          enable row level security;

-- Projekte
create policy projects_select on public.projects for select using (public.can_access_project(id));
create policy projects_insert on public.projects for insert with check (owner_id = auth.uid());
create policy projects_update on public.projects for update using (owner_id = auth.uid());
create policy projects_delete on public.projects for delete using (owner_id = auth.uid());

-- Mitglieder: sehen darf man eigene Mitgliedschaften und Mitglieder eigener Listen;
-- hinzufügen/entfernen darf nur der Eigentümer der Liste
create policy members_select on public.project_members for select
  using (user_id = auth.uid()
         or exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy members_insert on public.project_members for insert
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy members_delete on public.project_members for delete
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

-- Aufgaben: eigene Aufgaben oder Aufgaben in zugänglichen Listen
create policy tasks_select on public.tasks for select
  using (owner_id = auth.uid() or (project_id is not null and public.can_access_project(project_id)));
create policy tasks_insert on public.tasks for insert
  with check (owner_id = auth.uid() and (project_id is null or public.can_access_project(project_id)));
create policy tasks_update on public.tasks for update
  using (owner_id = auth.uid() or (project_id is not null and public.can_access_project(project_id)));
create policy tasks_delete on public.tasks for delete
  using (owner_id = auth.uid() or (project_id is not null and public.can_access_project(project_id)));

-- Persönliche Tabellen: nur eigene Zeilen
create policy pomodoro_own on public.pomodoro_sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy goals_own on public.weekly_goals for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy settings_own on public.settings for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Kalender (Etappe 4a, Migration 'add_calendars') ----------
-- create table public.calendars (id uuid pk, owner_id uuid -> auth.users, name text, url text (Freigabe-Link),
--   color text, enabled boolean, sort_order double precision, created_at timestamptz);
-- RLS: calendars_own (nur eigene Zeilen). Termine liefert die Edge Function 'calendar-events'
-- (supabase/functions/calendar-events/index.ts).
