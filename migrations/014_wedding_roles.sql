-- Migration 014: cortejo y participantes (papeles del día de la boda).
-- Ejecutar después de 013. Solo crea tablas y funciones nuevas; no modifica
-- invitados, invitaciones, respuestas, entradas ni mesas, y el código anterior
-- la ignora, así que se puede ejecutar antes de desplegar.
--
-- Un "papel" es lo que hace una persona ese día: padres que participan,
-- padrinos, chambelanes, damas de honor, niña del cartel, portador de los
-- anillos... Una persona puede tener varios papeles (la misma niña anuncia a la
-- novia con el cartel y lleva los anillos) y los papeles se pueden crear,
-- renombrar y reordenar desde el panel.

create table if not exists public.wedding_roles (
  id bigint generated always as identity primary key,
  name text not null check (length(btrim(name)) between 1 and 60),
  description text check (description is null or length(description) <= 200),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sin nombres repetidos, aunque cambien mayúsculas o espacios.
create unique index if not exists wedding_roles_name_key on public.wedding_roles (lower(btrim(name)));

drop trigger if exists trg_wedding_roles_updated_at on public.wedding_roles;
create trigger trg_wedding_roles_updated_at
  before update on public.wedding_roles
  for each row execute function public.set_updated_at();

create table if not exists public.guest_roles (
  guest_id bigint not null references public.guests(id) on delete cascade,
  role_id bigint not null references public.wedding_roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (guest_id, role_id)
);
create index if not exists guest_roles_role_idx on public.guest_roles(role_id);

-- Quien se elimina de la lista deja libres sus papeles.
create or replace function public.release_archived_guest_roles()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.archived_at is null and new.archived_at is not null then
    delete from public.guest_roles where guest_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_release_archived_guest_roles on public.guests;
create trigger trg_release_archived_guest_roles
  after update of archived_at on public.guests
  for each row execute function public.release_archived_guest_roles();

-- Reordena los papeles en una sola operación: la posición es el lugar en la lista.
create or replace function public.reorder_wedding_roles(p_ids bigint[])
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_ids is null or cardinality(p_ids) < 1 or cardinality(p_ids) > 100
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'Invalid role list' using errcode = '22023';
  end if;
  update public.wedding_roles r
     set sort_order = x.position
    from unnest(p_ids) with ordinality as x(id, position)
   where r.id = x.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Papeles iniciales (solo si todavía no hay ninguno; repetir la migración no los duplica).
insert into public.wedding_roles (name, description, sort_order)
select v.name, v.description, v.sort_order
  from (values
    ('Padres que participan',      'Los padres que acompañan a los novios en la ceremonia.', 1),
    ('Padrinos',                   'Padrinos y madrinas de la boda.', 2),
    ('Chambelanes',                'Acompañan a las damas de honor.', 3),
    ('Damas de honor',             'Acompañan a la novia.', 4),
    ('Niña del cartel',            'Anuncia la llegada de la novia con un cartel: «Ya viene la novia».', 5),
    ('Portador(a) de los anillos', 'Lleva los anillos hasta el altar.', 6)
  ) as v(name, description, sort_order)
 where not exists (select 1 from public.wedding_roles);

-- Solo el servidor (service_role) toca estas tablas, igual que el resto del panel.
alter table public.wedding_roles enable row level security;
alter table public.guest_roles enable row level security;
revoke all on table public.wedding_roles from public, anon, authenticated;
revoke all on table public.guest_roles from public, anon, authenticated;
grant select, insert, update, delete on table public.wedding_roles, public.guest_roles to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on function public.release_archived_guest_roles() from public, anon, authenticated;
revoke all on function public.reorder_wedding_roles(bigint[]) from public, anon, authenticated;
grant execute on function public.release_archived_guest_roles() to service_role;
grant execute on function public.reorder_wedding_roles(bigint[]) to service_role;

notify pgrst, 'reload schema';
