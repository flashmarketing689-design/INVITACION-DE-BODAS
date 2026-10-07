-- Enforce a hard limit of 150 confirmed attendees, counting people rather
-- than RSVP rows. The transaction advisory lock makes concurrent RSVP writes
-- see each other's committed capacity changes.

create or replace function public.enforce_wedding_rsvp_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed_people integer;
  v_guest_people integer;
begin
  if new.estado <> 'confirmado' then
    return new;
  end if;

  perform pg_advisory_xact_lock(7700015001::bigint);

  select greatest(coalesce(g.cantidad_personas, 1), 1)
    into v_guest_people
    from public.guests g
   where g.id = new.guest_id and g.archived_at is null;
  if not found then
    return new;
  end if;

  select coalesce(sum(greatest(coalesce(g.cantidad_personas, 1), 1)), 0)
    into v_confirmed_people
    from public.rsvp_respuestas r
    join public.guests g on g.id = r.guest_id and g.archived_at is null
   where r.estado = 'confirmado' and g.id <> new.guest_id;

  if v_confirmed_people + v_guest_people > 150 then
    raise exception 'wedding_capacity_reached' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_wedding_rsvp_capacity on public.rsvp_respuestas;
create trigger trg_enforce_wedding_rsvp_capacity
  before insert or update of estado, guest_id on public.rsvp_respuestas
  for each row execute function public.enforce_wedding_rsvp_capacity();

-- Quantity edits and reactivations must not take already confirmed attendance
-- over the event limit either.
create or replace function public.enforce_wedding_guest_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed_people integer;
  v_guest_confirmed boolean;
begin
  if tg_op <> 'UPDATE'
     or (old.cantidad_personas is not distinct from new.cantidad_personas
         and old.archived_at is not distinct from new.archived_at) then
    return new;
  end if;

  perform pg_advisory_xact_lock(7700015001::bigint);

  select exists (
    select 1 from public.rsvp_respuestas r
     where r.guest_id = new.id and r.estado = 'confirmado'
  ) into v_guest_confirmed;

  select coalesce(sum(greatest(coalesce(g.cantidad_personas, 1), 1)), 0)
    into v_confirmed_people
    from public.rsvp_respuestas r
    join public.guests g on g.id = r.guest_id and g.archived_at is null
   where r.estado = 'confirmado' and g.id <> new.id;

  if new.archived_at is null and v_guest_confirmed then
    v_confirmed_people := v_confirmed_people + greatest(coalesce(new.cantidad_personas, 1), 1);
  end if;

  if v_confirmed_people > 150 then
    raise exception 'wedding_capacity_reached' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_wedding_guest_capacity on public.guests;
create trigger trg_enforce_wedding_guest_capacity
  before update of cantidad_personas, archived_at on public.guests
  for each row execute function public.enforce_wedding_guest_capacity();

revoke all on function public.enforce_wedding_rsvp_capacity() from public, anon, authenticated;
revoke all on function public.enforce_wedding_guest_capacity() from public, anon, authenticated;
