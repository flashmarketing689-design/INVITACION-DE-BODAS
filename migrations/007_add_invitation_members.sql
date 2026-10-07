-- Adds individually identified guests to an existing invitation atomically.
-- Existing RSVP rows remain tied to each guest. The invitation and QR tokens
-- rotate so an old shared link cannot be used after its membership changes.

create or replace function public.add_invitation_members(
  p_invitation_id uuid,
  p_guest_ids bigint[] default '{}',
  p_new_members jsonb default '[]'::jsonb,
  p_display_name text default null
)
returns table(
  invitation_id uuid,
  token uuid,
  pass_token uuid,
  group_type text,
  display_name text,
  added_count integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invitation public.invitations%rowtype;
  v_guest public.guests%rowtype;
  v_member jsonb;
  v_name text;
  v_phone text;
  v_owner text;
  v_category text;
  v_new_guest_id bigint;
  v_guest_id bigint;
  v_source_invitation uuid;
  v_current_ids bigint[];
  v_added_ids bigint[] := '{}'::bigint[];
  v_current_count integer;
  v_new_count integer;
  v_added_count integer;
  v_total integer;
  v_position integer;
  v_group_type text;
  v_display_name text;
  v_token uuid;
  v_pass_token uuid;
begin
  if p_invitation_id is null
     or p_new_members is null
     or jsonb_typeof(p_new_members) <> 'array'
     or cardinality(coalesce(p_guest_ids, '{}'::bigint[])) > 99
     or jsonb_array_length(p_new_members) > 99
     or cardinality(coalesce(p_guest_ids, '{}'::bigint[]))
          <> (select count(distinct x) from unnest(coalesce(p_guest_ids, '{}'::bigint[])) x) then
    raise exception 'Invalid invitation members' using errcode = '22023';
  end if;

  select * into v_invitation
    from public.invitations
   where id = p_invitation_id and status = 'active'
   for update;
  if not found then
    raise exception 'Active invitation not found' using errcode = '22023';
  end if;
  if v_invitation.needs_review then
    raise exception 'Legacy invitation must be reviewed before adding members' using errcode = '22023';
  end if;

  select coalesce(array_agg(im.guest_id order by im.position), '{}'::bigint[])
    into v_current_ids
    from public.invitation_members im
    join public.guests g on g.id = im.guest_id and g.archived_at is null
   where im.invitation_id = p_invitation_id and im.active;
  v_current_count := cardinality(v_current_ids);
  if v_current_count < 1 then
    raise exception 'Invitation has no active members' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.guests g
     where g.id = any(v_current_ids) and g.cantidad_personas <> 1
  ) then
    raise exception 'Every invitation member must be individually identified' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.invitation_checkins c
     where c.invitation_id = p_invitation_id or c.guest_id = any(v_current_ids)
  ) then
    raise exception 'An invitation with recorded check-ins cannot be modified' using errcode = '23505';
  end if;

  v_new_count := jsonb_array_length(p_new_members);
  v_added_count := cardinality(coalesce(p_guest_ids, '{}'::bigint[])) + v_new_count;
  v_total := v_current_count + v_added_count;
  if v_added_count < 1 or v_total < 2 or v_total > 100 then
    raise exception 'An invitation must contain between two and one hundred people' using errcode = '22023';
  end if;

  -- Validate and lock existing invitees in a stable order before changing any
  -- invitation membership. Their current individual RSVP rows are untouched.
  for v_guest in
    select g.* from public.guests g
     where g.id = any(coalesce(p_guest_ids, '{}'::bigint[]))
     order by g.id
     for update
  loop
    if v_guest.archived_at is not null or v_guest.cantidad_personas <> 1
       or v_guest.id = any(v_current_ids) then
      raise exception 'Only active individual guests outside this invitation can be added' using errcode = '22023';
    end if;
    if exists (select 1 from public.invitation_checkins c where c.guest_id = v_guest.id) then
      raise exception 'An attendee who already checked in cannot be regrouped' using errcode = '23505';
    end if;

    v_source_invitation := null;
    select i.id into v_source_invitation
      from public.invitation_members im
      join public.invitations i on i.id = im.invitation_id
     where im.guest_id = v_guest.id and im.active and i.status = 'active'
     group by i.id, i.group_type, i.needs_review
    having count(*) = 1 and bool_and(i.group_type = 'individual' and not i.needs_review);
    if found and v_source_invitation = p_invitation_id then
      raise exception 'Guest is already in this invitation' using errcode = '23505';
    end if;
    if exists (
      select im.invitation_id
        from public.invitation_members im
        join public.invitations i on i.id = im.invitation_id
       where im.guest_id = v_guest.id and im.active and i.status = 'active'
       group by im.invitation_id, i.group_type, i.needs_review
      having count(*) <> 1 or i.group_type <> 'individual' or i.needs_review
    ) then
      raise exception 'Split an existing group before moving one of its members' using errcode = '23505';
    end if;
  end loop;
  if (select count(*) from public.guests g
       where g.id = any(coalesce(p_guest_ids, '{}'::bigint[]))
         and g.archived_at is null and g.cantidad_personas = 1)
       <> cardinality(coalesce(p_guest_ids, '{}'::bigint[])) then
    raise exception 'One or more selected guests are no longer available' using errcode = '23505';
  end if;

  -- A new person needs ownership and category for filtering and reporting.
  -- The UI pre-fills them from the invitation and lets the planner override.
  for v_member in select value from jsonb_array_elements(p_new_members)
  loop
    v_name := regexp_replace(btrim(coalesce(v_member->>'nombre', '')), '\s+', ' ', 'g');
    v_owner := v_member->>'pertenece';
    v_category := v_member->>'categoria';
    if length(v_name) < 2 or array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2
       or v_owner is null or v_owner not in ('novio', 'novia')
       or v_category is null or v_category not in ('familiares', 'amigos', 'companeros', 'iglesia', 'participantes')
       or length(v_name) > 120
       or length(coalesce(v_member->>'telefono', '')) > 30 then
      raise exception 'Invalid new guest details' using errcode = '22023';
    end if;
  end loop;

  v_position := v_current_count;
  for v_guest_id in select unnest(coalesce(p_guest_ids, '{}'::bigint[]))
  loop
    v_added_ids := array_append(v_added_ids, v_guest_id);
    v_source_invitation := null;
    select im.invitation_id into v_source_invitation
      from public.invitation_members im
      join public.invitations i on i.id = im.invitation_id
     where im.guest_id = v_guest_id and im.active and i.status = 'active'
     limit 1;
    if v_source_invitation is not null then
      update public.invitation_members set active = false, removed_at = now()
       where invitation_members.invitation_id = v_source_invitation
         and invitation_members.guest_id = v_guest_id and active;
      update public.invitations set status = 'replaced', replaced_by = p_invitation_id,
             replaced_at = now(), updated_at = now()
       where id = v_source_invitation and group_type = 'individual' and status = 'active';
    end if;
    update public.guests set token = gen_random_uuid(), invitacion_enviada = false,
           fecha_invitacion_enviada = null
     where id = v_guest_id;
    insert into public.invitation_members(invitation_id, guest_id, position)
      values (p_invitation_id, v_guest_id, v_position);
    v_position := v_position + 1;
  end loop;

  for v_member in select value from jsonb_array_elements(p_new_members)
  loop
    v_name := regexp_replace(btrim(coalesce(v_member->>'nombre', '')), '\s+', ' ', 'g');
    v_owner := v_member->>'pertenece';
    v_category := v_member->>'categoria';
    v_phone := nullif(left(btrim(coalesce(v_member->>'telefono', '')), 30), '');
    insert into public.guests(nombre, telefono, pertenece, categoria, cantidad_personas,
                              invitacion_enviada, estado)
      values (v_name, v_phone, v_owner, v_category, 1, false, 'pendiente')
      returning id into v_new_guest_id;

    -- The guest trigger creates a temporary individual invitation. Replace it
    -- in the same transaction before attaching the new member to the group.
    select im.invitation_id into v_source_invitation
      from public.invitation_members im
      join public.invitations i on i.id = im.invitation_id
     where im.guest_id = v_new_guest_id and im.active and i.status = 'active'
     limit 1;
    if v_source_invitation is not null then
      update public.invitation_members set active = false, removed_at = now()
       where invitation_members.invitation_id = v_source_invitation
         and invitation_members.guest_id = v_new_guest_id and active;
      update public.invitations set status = 'replaced', replaced_by = p_invitation_id,
             replaced_at = now(), updated_at = now()
       where id = v_source_invitation and status = 'active';
    end if;
    update public.guests set token = gen_random_uuid() where id = v_new_guest_id;
    insert into public.invitation_members(invitation_id, guest_id, position)
      values (p_invitation_id, v_new_guest_id, v_position);
    v_added_ids := array_append(v_added_ids, v_new_guest_id);
    v_position := v_position + 1;
  end loop;

  v_group_type := case when v_total = 2 then 'couple' else 'family' end;
  if nullif(btrim(coalesce(p_display_name, '')), '') is not null then
    v_display_name := btrim(p_display_name);
  elsif v_group_type = 'couple' then
    select string_agg(g.nombre, ' y ' order by im.position) into v_display_name
      from public.invitation_members im
      join public.guests g on g.id = im.guest_id
     where im.invitation_id = p_invitation_id and im.active;
  elsif v_invitation.group_type = 'family' then
    v_display_name := v_invitation.display_name;
  else
    select 'Familia ' || split_part(btrim(g.nombre), ' ',
      array_length(string_to_array(btrim(g.nombre), ' '), 1)) into v_display_name
      from public.invitation_members im
      join public.guests g on g.id = im.guest_id
     where im.invitation_id = p_invitation_id and im.active
     order by im.position limit 1;
  end if;

  update public.guests set invitacion_enviada = false, fecha_invitacion_enviada = null
   where id = any(v_current_ids || v_added_ids);
  update public.invitations i
     set group_type = v_group_type,
         display_name = left(v_display_name, 120),
         token = gen_random_uuid(),
         pass_token = gen_random_uuid(),
         sent_at = null,
         updated_at = now()
   where i.id = p_invitation_id
   returning i.token, i.pass_token into v_token, v_pass_token;

  return query select p_invitation_id, v_token, v_pass_token,
                      v_group_type, left(v_display_name, 120), v_added_count;
end;
$$;

revoke all on function public.add_invitation_members(uuid, bigint[], jsonb, text)
  from public, anon, authenticated;
grant execute on function public.add_invitation_members(uuid, bigint[], jsonb, text)
  to service_role;
