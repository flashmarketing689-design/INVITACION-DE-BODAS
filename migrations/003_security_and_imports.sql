-- Migration 003: lock down direct API access and make legacy imports retry-safe.
-- Does not delete any existing guest, RSVP, or history data; estado is
-- recalculated from the existing invitation and RSVP facts below.

-- Keep deleted invitations recoverable: their RSVP and history remain linked.
alter table public.guests add column if not exists archived_at timestamptz;
-- guests.token is already indexed by its UNIQUE constraint; remove the
-- redundant non-unique index created by the previous migration.
drop index if exists public.guests_token_idx;
create index if not exists guests_active_created_at_idx
  on public.guests (created_at) where archived_at is null;

-- Keep the consolidated guest state aligned with the two independent facts:
-- whether the invitation was sent and the RSVP response, if one exists.
create or replace function public.derive_guest_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.estado := case
    when new.estado_rsvp = 'confirmado' then 'confirmado'
    when new.estado_rsvp = 'no_asiste' then 'no_asiste'
    when new.invitacion_enviada then 'enviada'
    else 'pendiente'
  end;
  return new;
end;
$$;

drop trigger if exists trg_guests_derive_state on public.guests;
create trigger trg_guests_derive_state
  before insert or update on public.guests
  for each row execute function public.derive_guest_state();

update public.guests
   set estado = case
     when estado_rsvp = 'confirmado' then 'confirmado'
     when estado_rsvp = 'no_asiste' then 'no_asiste'
     when invitacion_enviada then 'enviada'
     else 'pendiente'
   end;

-- The legacy RSVP table and admin view can contain names and phone numbers.
-- They are consumed only through the server API using the service role.
alter table if exists public.rsvps enable row level security;
revoke all on table public.rsvps from anon, authenticated;
revoke all on table public.guests from anon, authenticated;
revoke all on table public.rsvp_respuestas from anon, authenticated;
revoke all on table public.rsvp_historial from anon, authenticated;
revoke all on table public.admin_resumen from anon, authenticated;

-- This staging table is retained for compatibility, but must never expose an
-- uploaded legacy list through Supabase's public Data API.
alter table if exists public.tmp_guests_import enable row level security;
revoke all on table public.tmp_guests_import from anon, authenticated;
revoke all on function public.derive_guest_state() from public, anon, authenticated;

-- The old token-assignment helper was created as SECURITY DEFINER. It is no
-- longer needed by the app and must not be callable by public API roles.
revoke all on function public.assign_guest_tokens() from public, anon, authenticated;
grant execute on function public.assign_guest_tokens() to service_role;
revoke all on function public.sync_rsvp_to_guest() from public, anon, authenticated;
grant execute on function public.sync_rsvp_to_guest() to service_role;
grant execute on function public.derive_guest_state() to service_role;

-- A durable idempotency key closes the lost-response/retry duplicate-import
-- case. Batch creation, guest inserts, and completion are one DB transaction.
create table if not exists public.guest_import_batches (
  batch_id uuid primary key,
  payload_hash text not null,
  imported_count integer not null default 0 check (imported_count >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.guest_import_batches enable row level security;
revoke all on table public.guest_import_batches from anon, authenticated;

create or replace function public.import_legacy_guests(p_batch_id uuid, p_guests jsonb)
returns table(imported integer, replayed boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_hash text;
  v_batch public.guest_import_batches%rowtype;
  v_imported integer;
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

  insert into public.guests (
    nombre, telefono, pertenece, categoria, cantidad_personas, notas,
    invitacion_enviada, fecha_invitacion_enviada, estado
  )
  select
    nombre, telefono, pertenece, categoria, cantidad_personas, notas,
    coalesce(invitacion_enviada, false), fecha_invitacion_enviada,
    case when coalesce(invitacion_enviada, false) then 'enviada' else 'pendiente' end
  from jsonb_to_recordset(p_guests) as item(
    nombre text,
    telefono text,
    pertenece text,
    categoria text,
    cantidad_personas integer,
    notas text,
    invitacion_enviada boolean,
    fecha_invitacion_enviada timestamptz
  );
  get diagnostics v_imported = row_count;

  update public.guest_import_batches
     set imported_count = v_imported,
         completed_at = now()
   where batch_id = p_batch_id;

  return query select v_imported, false;
end;
$$;

revoke all on function public.import_legacy_guests(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_legacy_guests(uuid, jsonb) to service_role;
