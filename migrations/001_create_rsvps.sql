-- Migration: 001_create_rsvps.sql
-- Crea la tabla `rsvps` usada por la API

create table if not exists rsvps (
  id bigint primary key,
  nombre text,
  telefono text,
  asistencia text,
  mensaje text,
  fecha timestamptz
);
