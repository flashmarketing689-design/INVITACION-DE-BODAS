-- Migration 016: nombres y apellidos con la primera letra en mayúscula.
-- Ejecutar después de 015. Repetible.
--
-- 1) public.title_case_name(text): la misma regla que lib/names.js y admin-common.js
--    ("MARÍA pérez" → "María Pérez"; partículas como "de", "del", "la", "y" en minúscula
--    salvo al inicio). No depende del idioma del servidor: las letras con tilde y la ñ se
--    convierten con una tabla explícita.
-- 2) Disparadores en guests.nombre, invitations.display_name y party_members.nombre, para que
--    cualquier camino (la API, las funciones de agrupar, importar, agregar integrantes…) guarde
--    los nombres bien escritos.
-- 3) Corrige los nombres que ya están guardados. Solo cambia mayúsculas, minúsculas y espacios.

create or replace function public.title_case_name(p_text text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  c_low constant text := 'áéíóúüñàèìòùâêîôûäëïöãõç';
  c_up  constant text := 'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÄËÏÖÃÕÇ';
  c_particles constant text[] := array['de', 'del', 'la', 'las', 'los', 'y', 'e'];
  v_text text;
  v_words text[];
  v_out text[] := '{}';
  v_word text;
  v_res text;
  v_ch text;
  v_cap boolean;
  v_i integer;
  v_j integer;
begin
  if p_text is null then return null; end if;
  v_text := regexp_replace(btrim(p_text), '\s+', ' ', 'g');
  if v_text = '' then return ''; end if;
  v_words := string_to_array(v_text, ' ');
  for v_i in 1 .. array_length(v_words, 1) loop
    v_word := v_words[v_i];
    v_res := '';
    v_cap := true;
    for v_j in 1 .. char_length(v_word) loop
      v_ch := substr(v_word, v_j, 1);
      if v_cap then
        v_res := v_res || translate(upper(v_ch), c_low, c_up);
      else
        v_res := v_res || translate(lower(v_ch), c_up, c_low);
      end if;
      v_cap := v_ch in ('-', '''', '’', '.');
    end loop;
    if v_i > 1 and lower(v_res) = any (c_particles) then v_res := lower(v_res); end if;
    v_out := array_append(v_out, v_res);
  end loop;
  return array_to_string(v_out, ' ');
end;
$$;

create or replace function public.normalize_person_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'guests' then
    new.nombre := public.title_case_name(new.nombre);
  elsif tg_table_name = 'party_members' then
    new.nombre := public.title_case_name(new.nombre);
  elsif tg_table_name = 'invitations' then
    new.display_name := public.title_case_name(new.display_name);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guests_normalize_name on public.guests;
create trigger trg_guests_normalize_name
  before insert or update of nombre on public.guests
  for each row execute function public.normalize_person_name();

drop trigger if exists trg_invitations_normalize_name on public.invitations;
create trigger trg_invitations_normalize_name
  before insert or update of display_name on public.invitations
  for each row execute function public.normalize_person_name();

drop trigger if exists trg_party_members_normalize_name on public.party_members;
create trigger trg_party_members_normalize_name
  before insert or update of nombre on public.party_members
  for each row execute function public.normalize_person_name();

-- Corrige lo ya guardado (solo las filas que cambian).
update public.guests set nombre = public.title_case_name(nombre)
 where nombre is distinct from public.title_case_name(nombre);
update public.invitations set display_name = public.title_case_name(display_name)
 where display_name is distinct from public.title_case_name(display_name);
update public.party_members set nombre = public.title_case_name(nombre)
 where nombre is distinct from public.title_case_name(nombre);

revoke all on function public.title_case_name(text) from public, anon, authenticated;
revoke all on function public.normalize_person_name() from public, anon, authenticated;
grant execute on function public.title_case_name(text) to service_role;
grant execute on function public.normalize_person_name() to service_role;

notify pgrst, 'reload schema';
