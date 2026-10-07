-- Invitaciones compartidas, respuestas por persona y recepción multi-dispositivo.
-- Ejecutar después de 001, 002 y 003. No elimina ni reescribe respuestas existentes.

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  pass_token uuid not null default gen_random_uuid(),
  group_type text not null default 'individual'
    check (group_type in ('individual', 'couple', 'family')),
  display_name text not null,
  status text not null default 'active'
    check (status in ('active', 'replaced', 'revoked')),
  needs_review boolean not null default false,
  sent_at timestamptz,
  replaced_by uuid references public.invitations(id),
  replaced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Safe when re-running after an interrupted SQL Editor execution.
alter table public.invitations add column if not exists pass_token uuid;
update public.invitations set pass_token = gen_random_uuid() where pass_token is null;
alter table public.invitations alter column pass_token set default gen_random_uuid();
alter table public.invitations alter column pass_token set not null;
create unique index if not exists invitations_pass_token_key on public.invitations(pass_token);

create table if not exists public.invitation_members (
  invitation_id uuid not null references public.invitations(id),
  guest_id bigint not null references public.guests(id),
  public_id uuid not null default gen_random_uuid() unique,
  position integer not null default 0 check (position >= 0),
  active boolean not null default true,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (invitation_id, guest_id)
);

create unique index if not exists invitation_members_one_active_guest_idx
  on public.invitation_members(guest_id) where active;
create index if not exists invitation_members_invitation_active_idx
  on public.invitation_members(invitation_id, position) where active;

-- Preserve each existing URL by using the current guest token for its new
-- individual invitation. Aggregated legacy entries remain usable for RSVP,
-- but are flagged so they cannot be grouped or issued a misleading QR pass.
insert into public.invitations(token, group_type, display_name, needs_review, sent_at)
select g.token, 'individual', g.nombre, g.cantidad_personas > 1,
       case when g.invitacion_enviada then g.fecha_invitacion_enviada else null end
  from public.guests g
 where g.archived_at is null
   and not exists (
     select 1 from public.invitation_members im
      where im.guest_id = g.id and im.active
   )
on conflict (token) do nothing;

insert into public.invitation_members(invitation_id, guest_id, position)
select i.id, g.id, 0
  from public.guests g
  join public.invitations i on i.token = g.token and i.status = 'active'
 where g.archived_at is null
   and not exists (
     select 1 from public.invitation_members im
      where im.guest_id = g.id and im.active
   )
on conflict (invitation_id, guest_id) do nothing;

create or replace function public.create_guest_invitation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  insert into public.invitations(token, display_name, needs_review, sent_at)
  values (
    new.token,
    new.nombre,
    new.cantidad_personas > 1,
    case when new.invitacion_enviada then new.fecha_invitacion_enviada else null end
  )
  returning id into v_invitation_id;

  insert into public.invitation_members(invitation_id, guest_id, position)
  values (v_invitation_id, new.id, 0);
  return new;
end;
$$;

drop trigger if exists trg_create_guest_invitation on public.guests;
create trigger trg_create_guest_invitation
  after insert on public.guests
  for each row execute function public.create_guest_invitation();

create or replace function public.update_invitation_legacy_review()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.invitations i
     set needs_review = (new.cantidad_personas > 1), updated_at = now()
   where i.status = 'active'
     and exists (
       select 1 from public.invitation_members im
        where im.invitation_id = i.id and im.guest_id = new.id and im.active
     );
  return new;
end;
$$;

drop trigger if exists trg_update_invitation_legacy_review on public.guests;
create trigger trg_update_invitation_legacy_review
  after update of cantidad_personas on public.guests
  for each row when (old.cantidad_personas is distinct from new.cantidad_personas)
  execute function public.update_invitation_legacy_review();

create or replace function public.revoke_archived_guest_invitation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.archived_at is null and new.archived_at is not null then
    update public.invitations i set status = 'revoked', replaced_at = now(), updated_at = now()
     where i.status = 'active' and exists (
       select 1 from public.invitation_members im
        where im.invitation_id = i.id and im.guest_id = new.id and im.active
     );
    update public.invitation_members set active = false, removed_at = now()
     where guest_id = new.id and active;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_revoke_archived_guest_invitation on public.guests;
create trigger trg_revoke_archived_guest_invitation
  after update of archived_at on public.guests
  for each row execute function public.revoke_archived_guest_invitation();

create or replace function public.sync_invitation_display_name()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invitation record;
  v_name text;
begin
  for v_invitation in
    select i.id, i.group_type from public.invitations i
    join public.invitation_members im on im.invitation_id = i.id
    where im.guest_id = new.id and im.active and i.status = 'active'
  loop
    if v_invitation.group_type = 'individual' then
      update public.invitations set display_name = new.nombre, updated_at = now() where id = v_invitation.id;
    elsif v_invitation.group_type = 'couple' then
      select string_agg(g.nombre, ' y ' order by im.position) into v_name
        from public.invitation_members im join public.guests g on g.id = im.guest_id
       where im.invitation_id = v_invitation.id and im.active and g.archived_at is null;
      update public.invitations set display_name = coalesce(v_name, new.nombre), updated_at = now()
       where id = v_invitation.id;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_sync_invitation_display_name on public.guests;
create trigger trg_sync_invitation_display_name
  after update of nombre on public.guests
  for each row when (old.nombre is distinct from new.nombre)
  execute function public.sync_invitation_display_name();

create table if not exists public.invitation_checkins (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.invitations(id),
  guest_id bigint not null unique references public.guests(id),
  public_id uuid not null,
  operator_name text not null check (length(operator_name) between 2 and 60),
  request_id uuid not null,
  checked_in_at timestamptz not null default now()
);
create index if not exists invitation_checkins_invitation_idx
  on public.invitation_checkins(invitation_id, checked_in_at);

alter table public.invitations enable row level security;
alter table public.invitation_members enable row level security;
alter table public.invitation_checkins enable row level security;
revoke all on table public.invitations from public, anon, authenticated;
revoke all on table public.invitation_members from public, anon, authenticated;
revoke all on table public.invitation_checkins from public, anon, authenticated;
grant all on table public.invitations, public.invitation_members,
  public.invitation_checkins to service_role;

create or replace function public.group_guests(
  p_guest_ids bigint[], p_group_type text, p_display_name text
)
returns table(invitation_id uuid, token uuid, group_type text, display_name text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
  v_invitation_id uuid;
  v_token uuid;
  v_name text;
  v_guest_id bigint;
  v_old_invitation uuid;
begin
  if p_guest_ids is null or p_group_type is null or p_group_type not in ('couple', 'family')
     or p_display_name is null or length(btrim(p_display_name)) < 2
     or length(p_display_name) > 120 then
    raise exception 'Invalid invitation group' using errcode = '22023';
  end if;
  if cardinality(p_guest_ids) < 2 or cardinality(p_guest_ids) > 100
     or cardinality(p_guest_ids) <> (select count(distinct x) from unnest(p_guest_ids) x) then
    raise exception 'Invalid group size or duplicate guests' using errcode = '22023';
  end if;
  if p_group_type = 'couple' and cardinality(p_guest_ids) <> 2 then
    raise exception 'A couple invitation must contain exactly two people' using errcode = '22023';
  end if;

  -- Stable lock order prevents simultaneous grouping requests from deadlocking.
  perform 1 from public.guests g
   where g.id = any(p_guest_ids) order by g.id for update;
  select count(*) into v_count from public.guests g
   where g.id = any(p_guest_ids) and g.archived_at is null
     and g.cantidad_personas = 1;
  if v_count <> cardinality(p_guest_ids) then
    raise exception 'Every person must be active and individually identified' using errcode = '22023';
  end if;

  select count(*) into v_count
    from public.invitation_members im
    join public.invitations i on i.id = im.invitation_id
   where im.guest_id = any(p_guest_ids) and im.active
     and i.status = 'active' and not i.needs_review;
  if v_count <> cardinality(p_guest_ids) then
    raise exception 'A guest is already grouped or requires legacy review' using errcode = '23505';
  end if;
  if exists (
    select im.invitation_id
      from public.invitation_members im
      join public.invitations i on i.id = im.invitation_id
     where im.guest_id = any(p_guest_ids) and im.active and i.status = 'active'
     group by im.invitation_id having count(*) <> 1
  ) then
    raise exception 'Split existing groups before creating a new group' using errcode = '23505';
  end if;

  if exists (
    select 1 from public.invitation_checkins c where c.guest_id = any(p_guest_ids)
  ) then
    raise exception 'An attendee who already checked in cannot be regrouped' using errcode = '23505';
  end if;

  insert into public.invitations(group_type, display_name)
  values (p_group_type, btrim(p_display_name))
  returning id, invitations.token, invitations.display_name
    into v_invitation_id, v_token, v_name;

  for v_guest_id in select unnest(p_guest_ids) order by 1 loop
    select im.invitation_id into v_old_invitation
      from public.invitation_members im
     where im.guest_id = v_guest_id and im.active for update;
    update public.invitation_members set active = false, removed_at = now()
     where guest_id = v_guest_id and active;
    update public.invitations set status = 'replaced', replaced_by = v_invitation_id,
           replaced_at = now(), updated_at = now()
     where id = v_old_invitation;
    update public.guests set token = gen_random_uuid(), invitacion_enviada = false,
           fecha_invitacion_enviada = null
     where id = v_guest_id;
    insert into public.invitation_members(invitation_id, guest_id, position)
    values (v_invitation_id, v_guest_id, (select array_position(p_guest_ids, v_guest_id) - 1));
  end loop;

  return query select v_invitation_id, v_token, p_group_type, v_name;
end;
$$;

create or replace function public.split_invitation(p_invitation_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invitation public.invitations%rowtype;
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

  update public.invitations set status = 'replaced', replaced_at = now(), updated_at = now()
   where id = p_invitation_id;
  update public.invitation_members set active = false, removed_at = now()
   where invitation_id = p_invitation_id and active;

  for v_guest_id in
    select guest_id from public.invitation_members
     where invitation_id = p_invitation_id order by position for update
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

create or replace function public.rotate_invitation_token(p_invitation_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_token uuid;
begin
  perform 1 from public.invitations
   where id = p_invitation_id and status = 'active' for update;
  if not found then raise exception 'Active invitation not found' using errcode = '22023'; end if;
  if exists (select 1 from public.invitation_checkins where invitation_id = p_invitation_id) then
    raise exception 'An invitation with recorded check-ins cannot be rotated' using errcode = '23505';
  end if;
  update public.invitations set token = gen_random_uuid(), pass_token = gen_random_uuid(),
         sent_at = null, updated_at = now()
   where id = p_invitation_id returning token into v_token;
  update public.guests set token = gen_random_uuid(), invitacion_enviada = false,
         fecha_invitacion_enviada = null
   where id in (select guest_id from public.invitation_members
                 where invitation_id = p_invitation_id and active);
  return v_token;
end;
$$;

create or replace function public.mark_invitation_sent(p_invitation_id uuid, p_value boolean)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sent_at timestamptz := case when p_value then now() else null end;
begin
  update public.invitations set sent_at = v_sent_at, updated_at = now()
   where id = p_invitation_id and status = 'active';
  if not found then raise exception 'Active invitation not found' using errcode = '22023'; end if;
  update public.guests set invitacion_enviada = p_value, fecha_invitacion_enviada = v_sent_at
   where id in (select guest_id from public.invitation_members
                 where invitation_id = p_invitation_id and active);
  return v_sent_at;
end;
$$;

create or replace function public.save_invitation_responses(
  p_token uuid, p_responses jsonb, p_message text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invitation public.invitations%rowtype;
  v_member record;
  v_total integer;
  v_allowed integer;
begin
  select * into v_invitation from public.invitations
   where token = p_token and status = 'active' for update;
  if not found or v_invitation.needs_review then
    raise exception 'Invitation is not available for per-person RSVP' using errcode = '22023';
  end if;
  if p_responses is null or jsonb_typeof(p_responses) <> 'array'
     or jsonb_array_length(p_responses) < 1 or jsonb_array_length(p_responses) > 100 then
    raise exception 'Invalid RSVP payload' using errcode = '22023';
  end if;
  select count(*), count(distinct x.member_id)
    into v_total, v_allowed
    from jsonb_to_recordset(p_responses) as x(member_id uuid, estado text, expected_estado text);
  if v_total <> v_allowed or exists (
    select 1 from jsonb_to_recordset(p_responses) as x(member_id uuid, estado text, expected_estado text)
     where x.member_id is null or x.estado is null or x.estado not in ('confirmado', 'no_asiste')
        or (x.expected_estado is not null and x.expected_estado not in ('confirmado', 'no_asiste'))
  ) then
    raise exception 'Invalid or duplicate RSVP member' using errcode = '22023';
  end if;
  select count(*) into v_allowed
    from public.invitation_members im join public.guests g on g.id = im.guest_id
   where im.invitation_id = v_invitation.id and im.active and g.archived_at is null
     and im.public_id in (
       select x.member_id from jsonb_to_recordset(p_responses) as x(member_id uuid, estado text, expected_estado text)
     );
  if v_allowed <> v_total then
    raise exception 'RSVP contains a person outside this invitation' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(p_responses) as x(member_id uuid, estado text, expected_estado text)
      join public.invitation_members im on im.public_id = x.member_id
        and im.invitation_id = v_invitation.id and im.active
      left join public.rsvp_respuestas r on r.guest_id = im.guest_id
     where r.estado is distinct from x.expected_estado
  ) then
    raise exception 'An RSVP changed after the invitation was opened' using errcode = '40001';
  end if;

  for v_member in
    select im.guest_id, g.telefono, x.estado
      from jsonb_to_recordset(p_responses) as x(member_id uuid, estado text, expected_estado text)
      join public.invitation_members im on im.public_id = x.member_id
        and im.invitation_id = v_invitation.id and im.active
      join public.guests g on g.id = im.guest_id and g.archived_at is null
     order by g.id
  loop
    insert into public.rsvp_respuestas(guest_id, estado, telefono, mensaje, fecha_respuesta)
    values (v_member.guest_id, v_member.estado, v_member.telefono,
            left(nullif(btrim(p_message), ''), 500), now())
    on conflict (guest_id) do update set estado = excluded.estado,
      telefono = excluded.telefono, mensaje = excluded.mensaje,
      fecha_respuesta = now(), updated_at = now();
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

-- A pass stops being valid when its invitation has no confirmed people. A
-- later confirmation will therefore require a newly issued QR credential.
create or replace function public.revoke_unused_invitation_pass()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_guest_id bigint;
  v_invitation_id uuid;
  v_confirmed integer;
begin
  if tg_op = 'DELETE' then
    v_guest_id := old.guest_id;
  else
    v_guest_id := new.guest_id;
  end if;

  select i.id into v_invitation_id
    from public.invitation_members im
    join public.invitations i on i.id = im.invitation_id
   where im.guest_id = v_guest_id and im.active and i.status = 'active'
   limit 1;
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- Serialize against check-in and other RSVP writes for this invitation.
  perform 1 from public.invitations where id = v_invitation_id for update;
  select count(*) into v_confirmed
    from public.invitation_members im
    join public.guests g on g.id = im.guest_id and g.archived_at is null
    join public.rsvp_respuestas r on r.guest_id = g.id and r.estado = 'confirmado'
   where im.invitation_id = v_invitation_id and im.active;

  if v_confirmed = 0 then
    update public.invitations
       set pass_token = gen_random_uuid(), updated_at = now()
     where id = v_invitation_id and status = 'active';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists trg_revoke_unused_invitation_pass on public.rsvp_respuestas;
create trigger trg_revoke_unused_invitation_pass
  after insert or update or delete on public.rsvp_respuestas
  for each row execute function public.revoke_unused_invitation_pass();

create or replace function public.register_invitation_checkins(
  p_token uuid, p_member_ids uuid[], p_operator_name text, p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invitation public.invitations%rowtype;
  v_member record;
  v_existing public.invitation_checkins%rowtype;
  v_rows jsonb := '[]'::jsonb;
  v_id uuid;
  v_total integer;
  v_valid integer;
begin
  select * into v_invitation from public.invitations
   where pass_token = p_token and status = 'active' for update;
  if not found or v_invitation.needs_review then
    raise exception 'Invalid, revoked, or unresolved invitation' using errcode = '22023';
  end if;
  if p_operator_name is null or length(btrim(p_operator_name)) < 2
     or length(p_operator_name) > 60 or p_request_id is null
     or p_member_ids is null or cardinality(p_member_ids) < 1
     or cardinality(p_member_ids) > 100
     or cardinality(p_member_ids) <> (select count(distinct x) from unnest(p_member_ids) x) then
    raise exception 'Invalid check-in request' using errcode = '22023';
  end if;

  select count(*) into v_valid
    from public.invitation_members im
    join public.guests g on g.id = im.guest_id and g.archived_at is null
    join public.rsvp_respuestas r on r.guest_id = g.id and r.estado = 'confirmado'
   where im.invitation_id = v_invitation.id and im.active
     and im.public_id = any(p_member_ids);
  if v_valid <> cardinality(p_member_ids) then
    raise exception 'One or more selected people are not confirmed in this invitation' using errcode = '22023';
  end if;

  for v_member in
    select im.public_id, g.id guest_id, g.nombre
      from public.invitation_members im
      join public.guests g on g.id = im.guest_id and g.archived_at is null
      join public.rsvp_respuestas r on r.guest_id = g.id and r.estado = 'confirmado'
     where im.invitation_id = v_invitation.id and im.active
       and im.public_id = any(p_member_ids)
     order by g.id
  loop
    v_id := null;
    insert into public.invitation_checkins(invitation_id, guest_id, public_id, operator_name, request_id)
    values (v_invitation.id, v_member.guest_id, v_member.public_id,
            btrim(p_operator_name), p_request_id)
    on conflict (guest_id) do nothing returning id into v_id;

    if v_id is not null then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'member_id', v_member.public_id, 'nombre', v_member.nombre,
        'status', 'registered', 'checked_in_at', now(), 'operator_name', btrim(p_operator_name)
      ));
    else
      select * into v_existing from public.invitation_checkins
       where guest_id = v_member.guest_id;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'member_id', v_member.public_id, 'nombre', v_member.nombre,
        'status', case when v_existing.request_id = p_request_id then 'registered' else 'already' end,
        'checked_in_at', v_existing.checked_in_at, 'operator_name', v_existing.operator_name
      ));
    end if;
  end loop;
  return jsonb_build_object('results', v_rows);
end;
$$;

revoke all on function public.create_guest_invitation() from public, anon, authenticated;
revoke all on function public.update_invitation_legacy_review() from public, anon, authenticated;
revoke all on function public.revoke_archived_guest_invitation() from public, anon, authenticated;
revoke all on function public.sync_invitation_display_name() from public, anon, authenticated;
revoke all on function public.revoke_unused_invitation_pass() from public, anon, authenticated;
revoke all on function public.group_guests(bigint[], text, text) from public, anon, authenticated;
revoke all on function public.split_invitation(uuid) from public, anon, authenticated;
revoke all on function public.rotate_invitation_token(uuid) from public, anon, authenticated;
revoke all on function public.mark_invitation_sent(uuid, boolean) from public, anon, authenticated;
revoke all on function public.save_invitation_responses(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.register_invitation_checkins(uuid, uuid[], text, uuid) from public, anon, authenticated;
grant execute on function public.create_guest_invitation() to service_role;
grant execute on function public.revoke_unused_invitation_pass() to service_role;
grant execute on function public.group_guests(bigint[], text, text) to service_role;
grant execute on function public.split_invitation(uuid) to service_role;
grant execute on function public.rotate_invitation_token(uuid) to service_role;
grant execute on function public.mark_invitation_sent(uuid, boolean) to service_role;
grant execute on function public.save_invitation_responses(uuid, jsonb, text) to service_role;
grant execute on function public.register_invitation_checkins(uuid, uuid[], text, uuid) to service_role;
