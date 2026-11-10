-- Migration 011: módulo de mesas.
-- Ejecutar después de 010. Solo crea tablas y funciones nuevas; no modifica
-- invitados, invitaciones, respuestas ni entradas existentes.
--
-- 12 mesas de 10 lugares. Las mesas "principales" (is_main) son las reservadas
-- para familiares; por defecto las dos primeras, y se cambian desde el panel.

create table if not exists public.wedding_tables (
  id integer primary key check (id between 1 and 99),
  name text not null check (length(btrim(name)) between 1 and 40),
  capacity integer not null default 10 check (capacity between 1 and 30),
  is_main boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.wedding_tables (id, name, capacity, is_main)
select n, 'Mesa ' || n, 10, n <= 2
  from generate_series(1, 12) as n
on conflict (id) do nothing;

drop trigger if exists trg_wedding_tables_updated_at on public.wedding_tables;
create trigger trg_wedding_tables_updated_at
  before update on public.wedding_tables
  for each row execute function public.set_updated_at();

-- Una persona está sentada como máximo en una mesa (guest_id es la llave).
create table if not exists public.table_assignments (
  guest_id bigint primary key references public.guests(id) on delete cascade,
  table_id integer not null references public.wedding_tables(id),
  assigned_at timestamptz not null default now()
);
create index if not exists table_assignments_table_idx on public.table_assignments(table_id);

-- La capacidad se garantiza aquí, no solo en la pantalla: el bloqueo por mesa
-- evita que dos movimientos simultáneos llenen la misma mesa de más.
create or replace function public.enforce_table_capacity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_capacity integer;
  v_count integer;
begin
  perform pg_advisory_xact_lock(770002, new.table_id);
  select t.capacity into v_capacity from public.wedding_tables t where t.id = new.table_id;
  select count(*) into v_count from public.table_assignments a
   where a.table_id = new.table_id and a.guest_id <> new.guest_id;
  if v_count >= v_capacity then
    raise exception 'table_full' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_table_capacity on public.table_assignments;
create trigger trg_enforce_table_capacity
  before insert or update of table_id on public.table_assignments
  for each row execute function public.enforce_table_capacity();

-- No se puede reducir la capacidad de una mesa por debajo de quienes ya tiene.
create or replace function public.guard_table_capacity_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(770002, new.id);
  if (select count(*) from public.table_assignments a where a.table_id = new.id) > new.capacity then
    raise exception 'table_capacity_below_assigned' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_table_capacity_change on public.wedding_tables;
create trigger trg_guard_table_capacity_change
  before update of capacity on public.wedding_tables
  for each row execute function public.guard_table_capacity_change();

-- Quien se elimina de la lista libera su lugar.
create or replace function public.release_archived_guest_table()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.archived_at is null and new.archived_at is not null then
    delete from public.table_assignments where guest_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_release_archived_guest_table on public.guests;
create trigger trg_release_archived_guest_table
  after update of archived_at on public.guests
  for each row execute function public.release_archived_guest_table();

-- Sienta (o libera, con p_table_id nulo) a varias personas en una sola
-- transacción: si alguna no cabe, no se mueve ninguna.
create or replace function public.move_guests_to_table(p_guest_ids bigint[], p_table_id integer)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_guest_ids is null or cardinality(p_guest_ids) < 1 or cardinality(p_guest_ids) > 100
     or cardinality(p_guest_ids) <> (select count(distinct x) from unnest(p_guest_ids) x) then
    raise exception 'Invalid guest list' using errcode = '22023';
  end if;

  if p_table_id is null then
    delete from public.table_assignments where guest_id = any(p_guest_ids);
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  if not exists (select 1 from public.wedding_tables t where t.id = p_table_id) then
    raise exception 'Table not found' using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.guests g
   where g.id = any(p_guest_ids) and g.archived_at is null and g.cantidad_personas = 1;
  if v_count <> cardinality(p_guest_ids) then
    raise exception 'Every guest must be active and individually identified' using errcode = '22023';
  end if;

  insert into public.table_assignments (guest_id, table_id)
  select x, p_table_id from unnest(p_guest_ids) as x order by x
  on conflict (guest_id) do update
     set table_id = excluded.table_id, assigned_at = now()
   where public.table_assignments.table_id is distinct from excluded.table_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Aplica un plan completo [{guest_id, table_id}, ...] de forma atómica
-- (organización automática).
create or replace function public.apply_table_plan(p_plan jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item record;
  v_total integer;
  v_valid integer;
  v_count integer := 0;
  v_step integer;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) > 500 then
    raise exception 'Invalid plan' using errcode = '22023';
  end if;
  if jsonb_array_length(p_plan) = 0 then return 0; end if;

  select count(*), count(distinct x.guest_id) into v_total, v_valid
    from jsonb_to_recordset(p_plan) as x(guest_id bigint, table_id integer);
  if v_total <> v_valid or exists (
    select 1 from jsonb_to_recordset(p_plan) as x(guest_id bigint, table_id integer)
     where x.guest_id is null or x.table_id is null
        or not exists (select 1 from public.wedding_tables t where t.id = x.table_id)
  ) then
    raise exception 'Invalid plan' using errcode = '22023';
  end if;
  select count(*) into v_valid from public.guests g
   where g.archived_at is null and g.cantidad_personas = 1
     and g.id in (select x.guest_id from jsonb_to_recordset(p_plan) as x(guest_id bigint, table_id integer));
  if v_valid <> v_total then
    raise exception 'Every guest must be active and individually identified' using errcode = '22023';
  end if;

  for v_item in
    select x.guest_id, x.table_id
      from jsonb_to_recordset(p_plan) as x(guest_id bigint, table_id integer)
     order by x.table_id, x.guest_id
  loop
    insert into public.table_assignments (guest_id, table_id) values (v_item.guest_id, v_item.table_id)
    on conflict (guest_id) do update
       set table_id = excluded.table_id, assigned_at = now()
     where public.table_assignments.table_id is distinct from excluded.table_id;
    get diagnostics v_step = row_count;
    v_count := v_count + v_step;
  end loop;
  return v_count;
end;
$$;

-- Solo el servidor (service_role) toca estas tablas, igual que el resto del panel.
alter table public.wedding_tables enable row level security;
alter table public.table_assignments enable row level security;
revoke all on table public.wedding_tables from public, anon, authenticated;
revoke all on table public.table_assignments from public, anon, authenticated;
grant select, insert, update, delete on table public.wedding_tables, public.table_assignments to service_role;

revoke all on function public.enforce_table_capacity() from public, anon, authenticated;
revoke all on function public.guard_table_capacity_change() from public, anon, authenticated;
revoke all on function public.release_archived_guest_table() from public, anon, authenticated;
revoke all on function public.move_guests_to_table(bigint[], integer) from public, anon, authenticated;
revoke all on function public.apply_table_plan(jsonb) from public, anon, authenticated;
grant execute on function public.enforce_table_capacity() to service_role;
grant execute on function public.guard_table_capacity_change() to service_role;
grant execute on function public.release_archived_guest_table() to service_role;
grant execute on function public.move_guests_to_table(bigint[], integer) to service_role;
grant execute on function public.apply_table_plan(jsonb) to service_role;

notify pgrst, 'reload schema';
