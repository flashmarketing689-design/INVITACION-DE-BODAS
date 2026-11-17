-- Migration 017: intercambiar dos mesas de lugar (arrastrar una mesa sobre otra).
-- Ejecutar después de 016. Solo agrega una función; no modifica datos existentes.
--
-- La mesa que sube o baja se lleva consigo su sección, su capacidad, su marca de
-- "principal" y a sus invitados. El nombre "Mesa N" toma el número del lugar nuevo;
-- un nombre personalizado (por ejemplo "Mesa de honor") viaja con la mesa.
-- Todo ocurre en una sola transacción: si algo falla, no cambia nada.

create or replace function public.swap_tables(p_a integer, p_b integer)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  ta public.wedding_tables;
  tb public.wedding_tables;
  v_ga bigint[];
  v_ta timestamptz[];
  v_gb bigint[];
  v_tb timestamptz[];
begin
  if p_a is null or p_b is null or p_a = p_b then
    raise exception 'Invalid tables' using errcode = '22023';
  end if;
  -- Mismo bloqueo que usa la capacidad, siempre en el mismo orden para evitar bloqueos cruzados.
  perform pg_advisory_xact_lock(770002, least(p_a, p_b));
  perform pg_advisory_xact_lock(770002, greatest(p_a, p_b));

  select * into ta from public.wedding_tables where id = p_a;
  if not found then raise exception 'Table not found' using errcode = 'P0002'; end if;
  select * into tb from public.wedding_tables where id = p_b;
  if not found then raise exception 'Table not found' using errcode = 'P0002'; end if;

  select coalesce(array_agg(guest_id order by guest_id), '{}'), coalesce(array_agg(assigned_at order by guest_id), '{}')
    into v_ga, v_ta from public.table_assignments where table_id = p_a;
  select coalesce(array_agg(guest_id order by guest_id), '{}'), coalesce(array_agg(assigned_at order by guest_id), '{}')
    into v_gb, v_tb from public.table_assignments where table_id = p_b;

  -- Con las dos mesas vacías, el cambio de capacidad y de invitados nunca choca con los controles de cupo.
  delete from public.table_assignments where table_id in (p_a, p_b);

  update public.wedding_tables
     set name = case when tb.name = 'Mesa ' || tb.id then 'Mesa ' || p_a else tb.name end,
         capacity = tb.capacity, is_main = tb.is_main, category = tb.category, side = tb.side
   where id = p_a;
  update public.wedding_tables
     set name = case when ta.name = 'Mesa ' || ta.id then 'Mesa ' || p_b else ta.name end,
         capacity = ta.capacity, is_main = ta.is_main, category = ta.category, side = ta.side
   where id = p_b;

  insert into public.table_assignments (guest_id, table_id, assigned_at)
  select g, p_a, t from unnest(v_gb, v_tb) as u(g, t);
  insert into public.table_assignments (guest_id, table_id, assigned_at)
  select g, p_b, t from unnest(v_ga, v_ta) as u(g, t);
end;
$$;

revoke all on function public.swap_tables(integer, integer) from public, anon, authenticated;
grant execute on function public.swap_tables(integer, integer) to service_role;

notify pgrst, 'reload schema';
