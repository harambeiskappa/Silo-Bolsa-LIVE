-- ════════════════════════════════════════════════════════════════════
-- Silo Bolsa LIVE · Fase 3 · 02 — Seguridad: roles, RLS, triggers
-- Correr SEGUNDO, después de 01_esquema.sql.
--
-- Principio: los permisos viven en la base. La pantalla esconde botones
-- por comodidad, pero aunque alguien llame a la API a mano con su token,
-- la base dice que no.
--   admin    → todo (cargar, importar, editar, anular, parámetros, usuarios)
--   auditor  → ver todo, auditar, cargar mediciones de origen 'auditoria'
--   lectura  → ver todo
--   sin_acceso / sin sesión → nada
-- Nadie borra filas de datos: no hay permiso DELETE en ninguna tabla de
-- datos. Corregir = anular + reemplazar.
-- ════════════════════════════════════════════════════════════════════

-- ── quién soy ───────────────────────────────────────────────────────
-- security definer: lee perfiles sin pasar por su propia RLS (si no, la
-- política de perfiles se llamaría a sí misma).
create or replace function public.mi_rol() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select rol from public.perfiles where id = auth.uid()), 'sin_acceso')
$$;
create or replace function public.es_admin() returns boolean
language sql stable as $$ select public.mi_rol() = 'admin' $$;
create or replace function public.puede_leer() returns boolean
language sql stable as $$ select public.mi_rol() in ('admin','auditor','lectura') $$;

-- ── perfil automático al crearse una cuenta ─────────────────────────
-- El rol de una invitación se aplica SOLO si la cuenta nace con el mail ya
-- confirmado (la crea el admin desde el panel con "Auto Confirm User").
-- Una cuenta que se registró sola, con el mail sin confirmar, nace
-- 'sin_acceso' aunque su mail esté invitado: así nadie puede registrarse
-- con el mail de Nico y quedarse con su rol. El alta de usuarios además
-- tiene que estar APAGADA en el panel (ver README).
create or replace function public.nuevo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_nombre text; v_rol text;
begin
  if new.email_confirmed_at is not null then
    select nombre, rol into v_nombre, v_rol from public.invitaciones where email = lower(new.email);
  end if;
  insert into public.perfiles (id, email, nombre, rol)
  values (new.id, lower(coalesce(new.email,'')), coalesce(v_nombre, ''), coalesce(v_rol, 'sin_acceso'))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario after insert on auth.users
  for each row execute function public.nuevo_usuario();

-- ── registro de cambios (tabla `cambios`) ───────────────────────────
create or replace function public.registrar_cambio() returns trigger
language plpgsql security definer set search_path = public as $$
declare fila jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.cambios (tabla, fila_id, operacion, antes, despues, usuario)
  values (tg_table_name,
          coalesce(fila->>'id', fila->>'clave', fila->>'email'),
          tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          auth.uid());
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['perfiles','invitaciones','importaciones','bolsones','mediciones','eventos',
                           'calidad','auditorias','parametros','relevamientos','relevamiento_items']
  loop
    execute format('drop trigger if exists registrar_cambio on public.%I', t);
    execute format('create trigger registrar_cambio after insert or update or delete on public.%I
                    for each row execute function public.registrar_cambio()', t);
  end loop;
end $$;

-- ── versión de cada bolsón: la base la pone, no el navegador ────────
create or replace function public.bolson_version() returns trigger
language plpgsql as $$
begin
  new.actualizado_en  := clock_timestamp();
  new.actualizado_por := auth.uid();
  new.id := old.id; new.creado_por := old.creado_por; new.creado_en := old.creado_en;
  return new;
end $$;
drop trigger if exists bolson_version on public.bolsones;
create trigger bolson_version before update on public.bolsones
  for each row execute function public.bolson_version();

-- ── mediciones / calidad / eventos: lo único que se puede cambiar es anular
create or replace function public.solo_anular() returns trigger
language plpgsql as $$
declare
  col text := case when tg_table_name = 'eventos' then 'anulado' else 'anulada' end;
  o jsonb := to_jsonb(old); n jsonb := to_jsonb(new);
  libres text[] := array[col, col||'_motivo', col||'_por', col||'_en'];
  k text;
begin
  for k in select jsonb_object_keys(n) loop
    if not (k = any(libres)) and (o->k) is distinct from (n->k) then
      raise exception 'En % no se edita «%»: se anula la fila con motivo y se carga una nueva que la reemplace.', tg_table_name, k
        using errcode = 'PT409';
    end if;
  end loop;
  if (o->>col)::boolean and not (n->>col)::boolean then
    raise exception 'Una fila anulada no se des-anula: cargá una nueva.' using errcode = 'PT409';
  end if;
  if not (o->>col)::boolean and (n->>col)::boolean then
    if length(trim(coalesce(n->>(col||'_motivo'),''))) = 0 then
      raise exception 'Para anular hace falta un motivo.' using errcode = 'PT422';
    end if;
    -- quién y cuándo los pone la base
    new := jsonb_populate_record(new, jsonb_build_object(col||'_por', auth.uid(), col||'_en', now()));
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['mediciones','calidad','eventos'] loop
    execute format('drop trigger if exists solo_anular on public.%I', t);
    execute format('create trigger solo_anular before update on public.%I
                    for each row execute function public.solo_anular()', t);
  end loop;
end $$;

-- ── al entrar una medición: el cero y la diferencia de medición ─────
-- 1) Un 0 solo vale en un bolsón terminado.
-- 2) Un bolsón que no está en armado no puede crecer. Si la medición nueva
--    da MÁS metros que la anterior válida del mismo bolsón, la base la marca
--    y el ritmo de consumo NO se calcula con ese par, sea cual sea el aumento.
--    El aviso tiene dos niveles (umbral 0,5 m):
--      · 'dentro_resolucion' (sube ≤ 0,5 m): informativo. El odómetro lee
--        de a 0,1 m y medir "de la mitad del triángulo a la mitad del otro"
--        mueve unos decímetros por punta; es la misma tolerancia que usa la
--        propuesta de correspondencia.
--      · 'diferencia_medicion' (sube > 0,5 m): aviso. Más que eso no lo
--        explica la resolución de la medición.
create or replace function public.fmt_m(x numeric) returns text
language sql immutable as $$ select replace(trim(to_char(x, 'FM999990.0')), '.', ',') $$;

create or replace function public.marcar_medicion() returns trigger
language plpgsql set search_path = public as $$
declare
  est text; ant record;
begin
  -- al restaurar un respaldo la fila viene tal como estaba (con su marca): no se recalcula
  if coalesce(current_setting('silobolsa.restaurando', true), '') = '1' then return new; end if;
  select estado into est from public.bolsones where id = new.bolson_id;
  if new.metros_restantes = 0 and est is distinct from 'terminado' and not new.anulada then
    raise exception 'Un 0 solo vale en un bolsón terminado. Este está «%». Si no se midió, no se carga nada (s/d).', est
      using errcode = 'PT422';
  end if;
  if new.origen <> 'auditoria' and not new.anulada and new.revision_marca is null and est <> 'armando' then
    select m.fecha, m.metros_restantes into ant
      from public.mediciones m
     where m.bolson_id = new.bolson_id and not m.anulada and m.origen <> 'auditoria'
       and m.fecha < new.fecha
     order by m.fecha desc, m.cargado_en desc limit 1;
    if ant.fecha is not null and new.metros_restantes > ant.metros_restantes + 0.5 then
      new.revision_marca := 'diferencia_medicion';
      new.revision_nota := format(
        'Subió %s m desde el %s (%s → %s m). Un bolsón %s no crece: es una diferencia de medición (más de 0,5 m), no un dato. No se calcula ritmo con este par.',
        fmt_m(new.metros_restantes - ant.metros_restantes), to_char(ant.fecha, 'DD/MM/YY'),
        fmt_m(ant.metros_restantes), fmt_m(new.metros_restantes),
        case est when 'en_uso' then 'en uso' else est end);
    elsif ant.fecha is not null and new.metros_restantes > ant.metros_restantes then
      new.revision_marca := 'dentro_resolucion';
      new.revision_nota := format(
        'Subió %s m desde el %s (%s → %s m): dentro de la resolución de la medición (hasta 0,5 m). No es alerta, pero un bolsón %s no crece: no se calcula ritmo con este par.',
        fmt_m(new.metros_restantes - ant.metros_restantes), to_char(ant.fecha, 'DD/MM/YY'),
        fmt_m(ant.metros_restantes), fmt_m(new.metros_restantes),
        case est when 'en_uso' then 'en uso' else est end);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists marcar_medicion on public.mediciones;
create trigger marcar_medicion before insert on public.mediciones
  for each row execute function public.marcar_medicion();

-- ── auditar actualiza el estado del lote ─────────────────────────────
create or replace function public.al_auditar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.importacion_id is not null then
    update public.importaciones set estado_auditoria = new.resultado where id = new.importacion_id;
  end if;
  return new;
end $$;
drop trigger if exists al_auditar on public.auditorias;
create trigger al_auditar after insert on public.auditorias
  for each row execute function public.al_auditar();

-- ════════════════════ RLS: activada en TODAS las tablas ═══════════════
alter table public.perfiles            enable row level security;
alter table public.invitaciones        enable row level security;
alter table public.importaciones       enable row level security;
alter table public.bolsones            enable row level security;
alter table public.mediciones          enable row level security;
alter table public.eventos             enable row level security;
alter table public.calidad             enable row level security;
alter table public.auditorias          enable row level security;
alter table public.parametros          enable row level security;
alter table public.relevamientos       enable row level security;
alter table public.relevamiento_items  enable row level security;
alter table public.cambios             enable row level security;
alter table public.latidos             enable row level security;

-- Las políticas de UPDATE usan "using (puede_leer()) with check (es_admin())":
-- así un usuario lectura que intenta editar recibe un ERROR, no un "0 filas"
-- silencioso que parece que anduvo.

-- perfiles: cada uno ve el suyo (para saber su rol); los que leen ven todos
-- (para mostrar quién cargó qué). Solo el admin cambia roles, y no el suyo.
create policy perfiles_ver on public.perfiles for select to authenticated
  using (id = auth.uid() or public.puede_leer());
create policy perfiles_admin on public.perfiles for update to authenticated
  using (public.puede_leer()) with check (public.es_admin() and id <> auth.uid());

create policy invitaciones_admin_ver on public.invitaciones for select to authenticated using (public.es_admin());
create policy invitaciones_admin_alta on public.invitaciones for insert to authenticated with check (public.es_admin());
create policy invitaciones_admin_mod on public.invitaciones for update to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy invitaciones_admin_baja on public.invitaciones for delete to authenticated using (public.es_admin());

do $$
declare t text;
begin
  -- lectura para los tres roles
  foreach t in array array['importaciones','bolsones','mediciones','eventos','calidad','auditorias',
                           'parametros','relevamientos','relevamiento_items','cambios','latidos'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.puede_leer())', t||'_ver', t);
  end loop;
  -- alta solo admin (mediciones y auditorías aparte)
  foreach t in array array['importaciones','bolsones','eventos','calidad','parametros',
                           'relevamientos','relevamiento_items'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (public.es_admin())', t||'_alta', t);
  end loop;
  -- edición solo admin (en mediciones/calidad/eventos el trigger deja solo anular)
  foreach t in array array['bolsones','mediciones','eventos','calidad','parametros'] loop
    execute format('create policy %I on public.%I for update to authenticated
                    using (public.puede_leer()) with check (public.es_admin())', t||'_mod', t);
  end loop;
end $$;

-- mediciones: el admin carga cualquiera; el auditor, solo las de auditoría y a su nombre
create policy mediciones_alta on public.mediciones for insert to authenticated
  with check (public.es_admin()
              or (public.mi_rol() = 'auditor' and origen = 'auditoria' and cargado_por = auth.uid()));

-- auditorías: las hace el auditor, a su nombre. El admin no audita su propia carga.
create policy auditorias_alta on public.auditorias for insert to authenticated
  with check ((public.mi_rol() = 'auditor' and auditor = auth.uid())
              -- restaurar un respaldo (función restaurar_respaldo, solo admin) trae las auditorías de Nico tal cual
              or (public.es_admin() and coalesce(current_setting('silobolsa.restaurando', true), '') = '1'));

-- ── privilegios: nadie borra datos, anon no escribe nada ─────────────
revoke insert, update, delete, truncate on all tables in schema public from anon;
revoke delete, truncate on all tables in schema public from authenticated;
grant  delete on public.invitaciones to authenticated;                 -- lo único que se borra: una invitación
revoke insert, update on public.cambios, public.latidos, public.auditorias from authenticated;
grant  insert on public.auditorias to authenticated;
revoke update on public.importaciones, public.relevamientos, public.relevamiento_items from authenticated;
revoke insert on public.perfiles from authenticated;                   -- los crea el trigger
