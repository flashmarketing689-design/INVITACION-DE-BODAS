-- Migration 010: correcciones de la auditoría administrativa.
-- Ejecutar después de 009. Solo reemplaza funciones y agrega triggers; no
-- elimina ni reescribe invitados, respuestas ni entradas existentes.

-- 1) split_invitation recorría TODAS las filas de invitation_members del grupo,
--    incluidas las inactivas (personas archivadas o movidas a otra invitación).
--    Eso creaba invitaciones activas para personas archivadas o fallaba con un
--    conflicto de unicidad. Ahora solo separa a los integrantes activos y no
--    archivados, capturados antes de desactivar el grupo.
create or replace function public.split_invitation(p_invitation_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invitation public.invitations%rowtype;
  v_guest_ids bigint[];
  v_guest_id bigint;
  v_count integer := 0;
  v_single_id uuid;
begin
  select * into v_invitation from public.invitations
   where id = p_invitation_id and status = 'active' for update;
  if not found or v_invitation.group_type = 'individual' or v_invitation.needs_review then
    raise exception 'Active group not found' using errcode = '22023';
  end if;
  if exists (select 1 from public.invitation_checkins where invitation_id = p_invitation_id) then
    raise exception 'An invitation with recorded check-ins cannot be split' using errcode = '23505';
  end if;

  select coalesce(array_agg(im.guest_id order by im.position, im.guest_id), '{}'::bigint[])
    into v_guest_ids
    from public.invitation_members im
    join public.guests g on g.id = im.guest_id and g.archived_at is null
   where im.invitation_id = p_invitation_id and im.active;

  update public.invitations set status = 'replaced', replaced_at = now(), updated_at = now()
   where id = p_invitation_id;
  update public.invitation_members set active = false, removed_at = now()
   where invitation_id = p_invitation_id and active;

  for v_guest_id in
    select g.id from public.guests g where g.id = any(v_guest_ids)
     order by array_position(v_guest_ids, g.id) for update
  loop
    update public.guests set token = gen_random_uuid(), invitacion_enviada = false,
           fecha_invitacion_enviada = null where id = v_guest_id;
    insert into public.invitations(display_name)
      select nombre from public.guests where id = v_guest_id
      returning id into v_single_id;
    insert into public.invitation_members(invitation_id, guest_id, position)
      values (v_single_id, v_guest_id, 0);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.split_invitation(uuid) from public, anon, authenticated;
grant execute on function public.split_invitation(uuid) to service_role;

-- 2) Una persona con entrada registrada no puede perder ni cambiar su
--    confirmación: antes, borrar el RSVP desde el panel (o responder "no asiste"
--    desde el enlace público) dejaba el check-in huérfano y el conteo de
--    asistencia incoherente.
create or replace function public.guard_checked_in_rsvp()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (select 1 from public.invitation_checkins c where c.guest_id = old.guest_id)
     and (tg_op = 'DELETE' or new.estado is distinct from 'confirmado') then
    raise exception 'Guest already checked in' using errcode = '23505';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_checked_in_rsvp on public.rsvp_respuestas;
create trigger trg_guard_checked_in_rsvp
  before update of estado or delete on public.rsvp_respuestas
  for each row execute function public.guard_checked_in_rsvp();

revoke all on function public.guard_checked_in_rsvp() from public, anon, authenticated;
grant execute on function public.guard_checked_in_rsvp() to service_role;

-- 3) El teléfono copiado en rsvp_respuestas quedaba desactualizado al editar al
--    invitado.
create or replace function public.sync_guest_phone_to_rsvp()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.rsvp_respuestas set telefono = new.telefono
   where guest_id = new.id and telefono is distinct from new.telefono;
  return new;
end;
$$;

drop trigger if exists trg_sync_guest_phone_to_rsvp on public.guests;
create trigger trg_sync_guest_phone_to_rsvp
  after update of telefono on public.guests
  for each row when (old.telefono is distinct from new.telefono)
  execute function public.sync_guest_phone_to_rsvp();

revoke all on function public.sync_guest_phone_to_rsvp() from public, anon, authenticated;
grant execute on function public.sync_guest_phone_to_rsvp() to service_role;

notify pgrst, 'reload schema';
