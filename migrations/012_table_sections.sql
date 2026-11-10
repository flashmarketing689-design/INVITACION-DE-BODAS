-- Migration 012: cada mesa tiene una sección y se puede marcar a la familia cercana.
-- Ejecutar después de 011. Es aditiva: no borra ni reescribe invitados,
-- respuestas, entradas ni asignaciones de mesa, y el código anterior la ignora.
-- Se puede ejecutar antes de desplegar la versión nueva de la aplicación.

-- Sección de cada mesa: qué grupo de invitados se sienta ahí.
--   category: familia_cercana | familiares | participantes | iglesia | amigos (nulo = cualquiera)
--   side:     novia | novio (nulo = ambos lados)
alter table public.wedding_tables
  add column if not exists category text,
  add column if not exists side text;

alter table public.wedding_tables drop constraint if exists wedding_tables_category_check;
alter table public.wedding_tables
  add constraint wedding_tables_category_check
  check (category is null or category in ('familia_cercana', 'familiares', 'participantes', 'iglesia', 'amigos'));

alter table public.wedding_tables drop constraint if exists wedding_tables_side_check;
alter table public.wedding_tables
  add constraint wedding_tables_side_check
  check (side is null or side in ('novia', 'novio'));

-- Un lado sin categoría no tiene sentido: la sección es "categoría" o "categoría + lado".
alter table public.wedding_tables drop constraint if exists wedding_tables_side_needs_category_check;
alter table public.wedding_tables
  add constraint wedding_tables_side_needs_category_check
  check (side is null or category is not null);

-- Familia cercana: solo aplica a personas de la categoría "familiares".
alter table public.guests add column if not exists cercana boolean not null default false;

alter table public.guests drop constraint if exists guests_cercana_familiares_check;
alter table public.guests
  add constraint guests_cercana_familiares_check
  check (not cercana or categoria = 'familiares');

-- Orden pedido para las 12 mesas. Solo se aplica a las mesas que todavía no
-- tienen sección, así que repetir la migración no pisa cambios hechos desde el panel.
update public.wedding_tables t
   set category = v.category,
       side = v.side,
       is_main = v.category in ('familia_cercana', 'familiares')
  from (values
    (1,  'familia_cercana', 'novia'),
    (2,  'familia_cercana', 'novio'),
    (3,  'familiares',      'novia'),
    (4,  'familiares',      'novia'),
    (5,  'familiares',      'novio'),
    (6,  'familiares',      'novio'),
    (7,  'participantes',   null),
    (8,  'iglesia',         null),
    (9,  'iglesia',         null),
    (10, 'amigos',          'novia'),
    (11, 'amigos',          null),
    (12, 'amigos',          null)
  ) as v(id, category, side)
 where t.id = v.id and t.category is null;

notify pgrst, 'reload schema';
