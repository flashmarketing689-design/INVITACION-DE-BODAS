-- Migration: 002_guests_system.sql
-- Sistema de invitaciones personalizadas + reconfirmación de asistencia.
-- Cada invitado tiene un token único, aleatorio y no predecible.
-- El RSVP queda ligado al invitado (una persona = una invitación = un RSVP).
--
-- Ejecutar en el SQL Editor de Supabase. Al final se explica cómo generar
-- tokens para los invitados existentes (función assign_guest_tokens).

-- ══ TABLA PRINCIPAL: guests ══
create table if not exists guests (
  id                        bigint generated always as identity primary key,
  nombre                    text not null,
  telefono                  text,
  pertenece                 text not null default 'novio'
                            check (pertenece in ('novio','novia')),
  categoria                 text not null default 'familiares'
                            check (categoria in ('familiares','amigos','companeros','iglesia')),
  cantidad_personas         int  not null default 1 check (cantidad_personas between 1 and 10),
  notas                     text,

  -- Enlace único e intransferible
  token                     uuid not null unique default gen_random_uuid(),

  -- Envío de invitación (WhatsApp)
  invitacion_enviada        boolean not null default false,
  fecha_invitacion_enviada  timestamptz,

  -- Estado consolidado del invitado (source of truth para el panel)
  estado                    text not null default 'pendiente'
                            check (estado in ('pendiente','enviada','confirmado','no_asiste')),

  -- RSVP actual (desnormalizado para estadísticas rápidas)
  estado_rsvp               text check (estado_rsvp in ('confirmado','no_asiste')),
  fecha_rsvp                timestamptz,
  mensaje_rsvp              text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists guests_pertenece_idx  on guests (pertenece);
create index if not exists guests_categoria_idx  on guests (categoria);
create index if not exists guests_estado_idx     on guests (estado);
create index if not exists guests_token_idx      on guests (token);

-- updated_at automático
drop trigger if exists trg_guests_updated_at on guests;
create trigger trg_guests_updated_at
  before update on guests
  for each row execute function moddatetime(updated_at);

-- ══ RSVP: un registro por invitado (upsert por guest_id) ══
-- Conserva la tabla legacy `rsvps` intacta (datos históricos), pero el
-- sistema nuevo escribe aquí. El guest_id es la llave: reconfirmar
-- ACTUALIZA en lugar de insertar.
create table if not exists rsvp_respuestas (
  id                  bigint generated always as identity primary key,
  guest_id            bigint not null references guests(id) on delete cascade,
  estado              text not null check (estado in ('confirmado','no_asiste')),
  telefono            text,
  mensaje             text,
  fecha_respuesta     timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Una persona = una invitación = una respuesta. Reconfirmar hace UPDATE.
  constraint rsvp_respuestas_guest_id_key unique (guest_id)
);

create index if not exists rsvp_respuestas_estado_idx on rsvp_respuestas (estado);

drop trigger if exists trg_rsvp_respuestas_updated_at on rsvp_respuestas;
create trigger trg_rsvp_respuestas_updated_at
  before update on rsvp_respuestas
  for each row execute function moddatetime(updated_at);

-- ══ HISTORIAL DE CAMBIOS (auditoría de reconfirmaciones) ══
create table if not exists rsvp_historial (
  id                  bigint generated always as identity primary key,
  guest_id            bigint not null references guests(id) on delete cascade,
  estado_anterior     text,
  estado_nuevo        text not null,
  fuente              text not null default 'invitado'
                      check (fuente in ('invitado','admin')),
  fecha_cambio        timestamptz not null default now()
);

create index if not exists rsvp_historial_guest_idx on rsvp_historial (guest_id, fecha_cambio desc);

-- ══ SINCRONIZACIÓN: respuesta → guests + historial ══
drop trigger if exists trg_rsvp_sync_guest on rsvp_respuestas;
create or replace function sync_rsvp_to_guest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_anterior text;
  v_nuevo_estado guests.estado%type;
begin
  if tg_op = 'DELETE' then
    update guests
       set estado_rsvp  = null,
           fecha_rsvp   = null,
           mensaje_rsvp = null,
           estado       = case when invitacion_enviada then 'enviada' else 'pendiente' end
     where id = old.guest_id;
    insert into rsvp_historial (guest_id, estado_anterior, estado_nuevo, fuente)
    values (old.guest_id, old.estado, 'eliminado', 'admin');
    return old;
  end if;

  select estado_rsvp into v_anterior
    from guests where id = new.guest_id;

  v_nuevo_estado := case when new.estado = 'confirmado' then 'confirmado' else 'no_asiste' end;

  insert into rsvp_historial (guest_id, estado_anterior, estado_nuevo, fuente)
  values (new.guest_id, v_anterior, new.estado,
          case when v_anterior is null then 'invitado' else 'invitado' end);

  update guests
     set estado_rsvp  = new.estado,
         fecha_rsvp   = new.fecha_respuesta,
         mensaje_rsvp = new.mensaje,
         estado       = v_nuevo_estado
   where id = new.guest_id;

  return new;
end;
$$;

drop trigger if exists trg_rsvp_respuestas_sync on rsvp_respuestas;
create trigger trg_rsvp_respuestas_sync
  after insert or update or delete on rsvp_respuestas
  for each row execute function sync_rsvp_to_guest();

-- ══ MIGRACIÓN DE DATOS LOCALSTORAGE → SUPABASE (opcional, una vez) ══
-- Si exportaste el localStorage `boda_sr_invitados` a JSON, cárgalo con:
--   \copy tmp_guests_import from 'invitados.json' ...
-- o usa el endpoint POST /api/guests/import descrito en el README.
-- Aquí solo preparamos la tabla temporal.
create table if not exists tmp_guests_import (
  legacy_id  text,
  nombre     text,
  telefono   text,
  pertenece  text,
  categoria  text,
  cantidad   int,
  notas      text,
  enviada    boolean default false,
  fecha_enviada timestamptz
);

-- ══ TOKENS PARA INVITADOS EXISTENTES ══
-- gen_random_uuid() ya garantiza unicidad (UNIQUE constraint arriba).
create or replace function assign_guest_tokens()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create extension if not exists pgcrypto;
  end if;
  update guests set token = gen_random_uuid() where token is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ══ VISTA: PANEL ADMINISTRATIVO COMBINADO ══
-- Une invitados con su RSVP actual (legacy rsvps se mantiene visible aparte).
create or replace view admin_resumen as
select
  g.id,
  g.nombre,
  g.telefono,
  g.pertenece,
  g.categoria,
  g.cantidad_personas,
  g.token,
  g.invitacion_enviada,
  g.fecha_invitacion_enviada,
  g.estado,
  g.estado_rsvp,
  g.fecha_rsvp,
  g.mensaje_rsvp,
  coalesce(r.estado, 'sin_respuesta') as respuesta_actual,
  r.fecha_respuesta,
  h.cambios as cambios_respuesta
from guests g
left join rsvp_respuestas r on r.guest_id = g.id
left join lateral (
  select count(*)::int as cambios from rsvp_historial h2 where h2.guest_id = g.id
) h on true;

-- ══ SEGURIDAD: RLS ══
-- guests solo se manipula con SERVICE_ROLE (bypassea RLS desde las API routes).
-- El público NUNCA consulta la tabla directamente; solo usa /api/guest?token=
alter table guests            enable row level security;
alter table rsvp_respuestas   enable row level security;
alter table rsvp_historial    enable row level security;

-- Sin políticas => anónimo (anon key) no puede leer ni escribir nada.
-- Las API de Vercel usan SUPABASE_SERVICE_KEY que ignora RLS.

-- ══ NOTAS ══
-- 1. moddatetime es una extensión de Supabase ya habilitada por defecto.
--    Si no lo está: create extension if not exists moddatetime;
-- 2. gen_random_uuid() requiere pgcrypto (ya incluido en Supabase).
-- 3. Tras ejecutar, corre: select assign_guest_tokens();
