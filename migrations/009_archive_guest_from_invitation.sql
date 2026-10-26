-- Remove one attendee without cancelling the invitation of the other members.
-- Run after 008. This migration changes functions only; it archives no guests.
begin;

create or replace function public.revoke_archived_guest_invitation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invitation record;
  v_count integer;
  v_name text;
  v_review boolean;
begin
  if old.archived_at is not null or new.archived_at is null then return new; end if;

  for v_invitation in
    select i.id, i.display_name from public.invitations i
    join public.invitation_members im on im.invitation_id = i.id
    where im.guest_id = new.id and im.active and i.status = 'active'
    order by i.id for update of i
  loop
    update public.invitation_members im set active = false, removed_at = now()
     where im.invitation_id = v_invitation.id and im.guest_id = new.id and im.active;

    select count(*), string_agg(g.nombre, ' y ' order by im.position, g.id),
           coalesce(bool_or(g.cantidad_personas > 1), false)
      into v_count, v_name, v_review
      from public.invitation_members im join public.guests g on g.id = im.guest_id
     where im.invitation_id = v_invitation.id and im.active and g.archived_at is null;

    if v_count = 0 then
      update public.invitations i
         set status = 'revoked', token = gen_random_uuid(), pass_token = gen_random_uuid(),
             sent_at = null, replaced_at = now(), updated_at = now()
       where i.id = v_invitation.id;
    else
      -- Compact positions so adding new members after a removal stays ordered.
      with positions as (
        select im.guest_id, (row_number() over (order by im.position, im.guest_id) - 1)::integer as position
          from public.invitation_members im
         where im.invitation_id = v_invitation.id and im.active
      )
      update public.invitation_members im set position = p.position from positions p
       where im.invitation_id = v_invitation.id and im.guest_id = p.guest_id;

      update public.invitations i
         set group_type = case when v_count = 1 then 'individual' when v_count = 2 then 'couple' else 'family' end,
             display_name = case when v_count <= 2 then left(v_name, 120) else v_invitation.display_name end,
             needs_review = v_review, token = gen_random_uuid(), pass_token = gen_random_uuid(),
             sent_at = null, updated_at = now()
       where i.id = v_invitation.id;
      update public.guests g set invitacion_enviada = false, fecha_invitacion_enviada = null
       where g.archived_at is null and exists (
         select 1 from public.invitation_members im
          where im.invitation_id = v_invitation.id and im.guest_id = g.id and im.active
       );
    end if;
  end loop;
  -- Historical membership, responses and check-ins remain available for audit.
  update public.invitation_members im set active = false, removed_at = now()
   where im.guest_id = new.id and im.active;
  return new;
end;
$$;

create or replace function public.archive_invitation_guest(p_guest_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_guest public.guests%rowtype;
  v_invitation_id uuid;
  v_current_id uuid;
  v_remaining integer := 0;
  v_type text;
begin
  if p_guest_id is null or p_guest_id <= 0 then
    raise exception 'Invalid guest id' using errcode = '22023';
  end if;

  -- Serialize with public RSVP and QR check-in before changing membership.
  select i.id into v_invitation_id from public.invitations i
    join public.invitation_members im on im.invitation_id = i.id
   where im.guest_id = p_guest_id and im.active and i.status = 'active'
   for update of i;
  select * into v_guest from public.guests g where g.id = p_guest_id for update;
  if not found then raise exception 'Guest not found' using errcode = 'P0002'; end if;
  if v_guest.archived_at is not null then
    return jsonb_build_object('ok', true, 'archived', true, 'already_archived', true,
      'link_changed', false, 'remaining_members', 0);
  end if;

  select i.id into v_current_id from public.invitations i
    join public.invitation_members im on im.invitation_id = i.id
   where im.guest_id = p_guest_id and im.active and i.status = 'active';
  if v_current_id is distinct from v_invitation_id then
    raise exception 'Membership changed; retry removal' using errcode = '40001';
  end if;

  update public.guests g set archived_at = now(), token = gen_random_uuid(), updated_at = now()
   where g.id = p_guest_id;
  -- The archive trigger updates the group within this same transaction.
  select count(*) into v_remaining from public.invitation_members im
   where im.invitation_id = v_invitation_id and im.active;
  select i.group_type into v_type from public.invitations i
   where i.id = v_invitation_id and i.status = 'active';
  return jsonb_build_object('ok', true, 'archived', true, 'already_archived', false,
    'invitation_id', v_invitation_id, 'remaining_members', v_remaining,
    'invitation_type', v_type, 'link_changed', v_remaining > 0);
end;
$$;

revoke all on function public.revoke_archived_guest_invitation() from public, anon, authenticated;
revoke all on function public.archive_invitation_guest(bigint) from public, anon, authenticated;
grant execute on function public.archive_invitation_guest(bigint) to service_role;
notify pgrst, 'reload schema';
commit;
