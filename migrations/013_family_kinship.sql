-- Migration 013: parentesco de los familiares (madre, padre, hermano/a).
-- Ejecutar después de 012. Es aditiva: no modifica ni borra datos existentes y el
-- código anterior la ignora, así que se puede ejecutar antes de desplegar.
--
-- El lado (novia / novio) no se guarda aquí: sale de guests.pertenece, de modo que
-- "madre" + "novia" = "Madre de la novia". Tener parentesco implica ser familia
-- cercana (guests.cercana), que a su vez solo aplica a la categoría "familiares".

alter table public.guests add column if not exists parentesco text;

alter table public.guests drop constraint if exists guests_parentesco_check;
alter table public.guests
  add constraint guests_parentesco_check
  check (parentesco is null or (parentesco in ('madre', 'padre', 'hermano') and cercana));

notify pgrst, 'reload schema';
