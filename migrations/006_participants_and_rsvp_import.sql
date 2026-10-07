-- Preserves the workbook's Participants category and imports existing RSVP
-- decisions atomically with each guest batch.

alter table public.guests drop constraint if exists guests_categoria_check;
alter table public.guests
  add constraint guests_categoria_check
  check (categoria in ('familiares', 'amigos', 'companeros', 'iglesia', 'participantes'));

-- Imported confirmations are administrative imports, not actions submitted by
-- guests. Keep that source in the audit history while preserving normal behavior.
create or replace function public.sync_rsvp_to_guest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_anterior text;
  v_nuevo_estado public.guests.estado%type;
  v_fuente text := coalesce(nullif(current_setting('app.rsvp_source', true), ''), 'invitado');
begin
  if tg_op = 'DELETE' then
    update public.guests
       set estado_rsvp = null,
           fecha_rsvp = null,
           mensaje_rsvp = null,
           estado = case when invitacion_enviada then 'enviada' else 'pendiente' end
     where id = old.guest_id;
    insert into public.rsvp_historial (guest_id, estado_anterior, estado_nuevo, fuente)
    values (old.guest_id, old.estado, 'eliminado', 'admin');
    return old;
  end if;

  select estado_rsvp into v_anterior
    from public.guests where id = new.guest_id;

  v_nuevo_estado := case when new.estado = 'confirmado' then 'confirmado' else 'no_asiste' end;
  insert into public.rsvp_historial (guest_id, estado_anterior, estado_nuevo, fuente)
  values (new.guest_id, v_anterior, new.estado, v_fuente);

  update public.guests
     set estado_rsvp = new.estado,
         fecha_rsvp = new.fecha_respuesta,
         mensaje_rsvp = new.mensaje,
         estado = v_nuevo_estado
   where id = new.guest_id;

  return new;
end;
$$;

revoke all on function public.sync_rsvp_to_guest() from public, anon, authenticated;
grant execute on function public.sync_rsvp_to_guest() to service_role;

create or replace function public.import_legacy_guests(p_batch_id uuid, p_guests jsonb)
returns table(imported integer, replayed boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_hash text;
  v_batch public.guest_import_batches%rowtype;
  v_item jsonb;
  v_nombre text;
  v_pertenece text;
  v_categoria text;
  v_cantidad integer;
  v_invitacion_enviada boolean;
  v_fecha_invitacion timestamptz;
  v_estado_rsvp text;
  v_fecha_rsvp timestamptz;
  v_telefono text;
  v_notas text;
  v_guest_id bigint;
  v_imported integer := 0;
begin
  if p_batch_id is null or p_guests is null
     or jsonb_typeof(p_guests) is distinct from 'array' then
    raise exception 'Invalid import batch' using errcode = '22023';
  end if;
  if jsonb_array_length(p_guests) < 1 or jsonb_array_length(p_guests) > 1000 then
    raise exception 'Invalid import batch' using errcode = '22023';
  end if;

  v_hash := md5(p_guests::text);
  insert into public.guest_import_batches(batch_id, payload_hash)
  values (p_batch_id, v_hash)
  on conflict (batch_id) do nothing;

  select * into v_batch
    from public.guest_import_batches
   where batch_id = p_batch_id
   for update;

  if v_batch.payload_hash <> v_hash then
    raise exception 'Import batch key reused with different data' using errcode = '22023';
  end if;
  if v_batch.completed_at is not null then
    return query select v_batch.imported_count, true;
    return;
  end if;

  -- The RSVP trigger records imported responses as administrative changes.
  perform set_config('app.rsvp_source', 'admin', true);

  for v_item in
    select value from jsonb_array_elements(p_guests) as item(value)
  loop
    v_nombre := nullif(trim(v_item->>'nombre'), '');
    v_pertenece := v_item->>'pertenece';
    v_categoria := v_item->>'categoria';
    v_cantidad := coalesce(nullif(v_item->>'cantidad_personas', '')::integer, 1);
    v_invitacion_enviada := coalesce(nullif(v_item->>'invitacion_enviada', '')::boolean, false);
    v_fecha_invitacion := nullif(v_item->>'fecha_invitacion_enviada', '')::timestamptz;
    v_estado_rsvp := nullif(v_item->>'estado_rsvp', '');
    v_fecha_rsvp := nullif(v_item->>'fecha_rsvp', '')::timestamptz;
    v_telefono := nullif(trim(v_item->>'telefono'), '');
    v_notas := nullif(trim(v_item->>'notas'), '');

    if v_nombre is null
       or v_pertenece is null or v_pertenece not in ('novio', 'novia')
       or v_categoria is null or v_categoria not in ('familiares', 'amigos', 'companeros', 'iglesia', 'participantes')
       or v_cantidad not between 1 and 10
       or (v_estado_rsvp is not null and v_estado_rsvp not in ('confirmado', 'no_asiste')) then
      raise exception 'Invalid guest in import batch' using errcode = '22023';
    end if;

    insert into public.guests (
      nombre, telefono, pertenece, categoria, cantidad_personas, notas,
      invitacion_enviada, fecha_invitacion_enviada, estado
    ) values (
      v_nombre, v_telefono, v_pertenece, v_categoria, v_cantidad, v_notas,
      v_invitacion_enviada, v_fecha_invitacion,
      case when v_invitacion_enviada then 'enviada' else 'pendiente' end
    ) returning id into v_guest_id;

    if v_estado_rsvp is not null then
      insert into public.rsvp_respuestas (guest_id, estado, telefono, fecha_respuesta)
      values (v_guest_id, v_estado_rsvp, v_telefono, coalesce(v_fecha_rsvp, now()));
    end if;
    v_imported := v_imported + 1;
  end loop;

  update public.guest_import_batches
     set imported_count = v_imported,
         completed_at = now()
   where batch_id = p_batch_id;

  return query select v_imported, false;
end;
$$;

revoke all on function public.import_legacy_guests(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_legacy_guests(uuid, jsonb) to service_role;

-- RLS bypass does not replace PostgreSQL object privileges. The server uses
-- the service_role key, so grant it the required access explicitly while
-- keeping anon and authenticated revoked by migration 003.
grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.guests,
  public.rsvp_respuestas,
  public.rsvp_historial,
  public.invitations,
  public.invitation_members,
  public.invitation_checkins,
  public.guest_import_batches
to service_role;
grant usage, select on all sequences in schema public to service_role;
