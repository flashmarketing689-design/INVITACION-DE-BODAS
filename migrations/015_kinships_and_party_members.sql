-- Migration 015: parentescos editables y personas del cortejo sin invitación (los novios).
-- Ejecutar después de 014. Es aditiva: no borra ni reescribe invitados, respuestas,
-- mesas ni papeles existentes, y el código anterior la ignora.

-- ── Parentescos editables ─────────────────────────────────────────────────
-- Antes eran tres valores fijos (madre, padre, hermano) dentro de una restricción.
-- Ahora son filas que se pueden añadir, renombrar y quitar desde el panel.
create table if not exists public.wedding_kinships (
  key text primary key check (key ~ '^[a-z0-9_]{1,30}$'),
  name text not null check (length(btrim(name)) between 1 and 40),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists wedding_kinships_name_key on public.wedding_kinships (lower(btrim(name)));

insert into public.wedding_kinships (key, name, sort_order)
select v.key, v.name, v.sort_order
  from (values ('madre', 'Madre', 1), ('padre', 'Padre', 2), ('hermano', 'Hermano(a)', 3)) as v(key, name, sort_order)
 where not exists (select 1 from public.wedding_kinships);

-- La validez del parentesco la garantiza la clave foránea (quitar un parentesco deja
-- en nulo el de quienes lo tenían; siguen siendo familia cercana).
alter table public.guests drop constraint if exists guests_parentesco_check;
alter table public.guests
  add constraint guests_parentesco_check check (parentesco is null or cercana);
alter table public.guests drop constraint if exists guests_parentesco_fkey;
alter table public.guests
  add constraint guests_parentesco_fkey
  foreign key (parentesco) references public.wedding_kinships(key) on delete set null;

-- ── Personas del cortejo sin invitación (los novios y quien haga falta) ────
-- No son invitados: sin enlace, sin QR, sin lugar en las 150 personas ni en las mesas.
create table if not exists public.party_members (
  id bigint generated always as identity primary key,
  nombre text not null check (length(btrim(nombre)) between 2 and 120),
  pertenece text not null check (pertenece in ('novia', 'novio')),
  created_at timestamptz not null default now()
);

create table if not exists public.party_member_roles (
  member_id bigint not null references public.party_members(id) on delete cascade,
  role_id bigint not null references public.wedding_roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (member_id, role_id)
);
create index if not exists party_member_roles_role_idx on public.party_member_roles(role_id);

-- Los novios: solo la primera vez (si ya hay personas en el cortejo no se toca nada).
do $$
declare
  v_role bigint;
  v_novio bigint;
  v_novia bigint;
begin
  if exists (select 1 from public.party_members) then return; end if;
  select id into v_role from public.wedding_roles where lower(btrim(name)) = 'novios';
  if v_role is null then
    insert into public.wedding_roles (name, description, sort_order)
    values ('Novios', 'Los novios.', 0) returning id into v_role;
  end if;
  insert into public.party_members (nombre, pertenece) values ('Starlin Paulino Pérez', 'novio') returning id into v_novio;
  insert into public.party_members (nombre, pertenece) values ('Reneisy', 'novia') returning id into v_novia;
  insert into public.party_member_roles (member_id, role_id) values (v_novio, v_role), (v_novia, v_role);
end $$;

alter table public.wedding_kinships enable row level security;
alter table public.party_members enable row level security;
alter table public.party_member_roles enable row level security;
revoke all on table public.wedding_kinships, public.party_members, public.party_member_roles from public, anon, authenticated;
grant select, insert, update, delete on table public.wedding_kinships, public.party_members, public.party_member_roles to service_role;
grant usage, select on all sequences in schema public to service_role;

notify pgrst, 'reload schema';
