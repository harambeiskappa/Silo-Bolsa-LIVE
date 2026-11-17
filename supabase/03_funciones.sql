-- ════════════════════════════════════════════════════════════════════
-- Silo Bolsa LIVE · Fase 3 · 03 — Funciones que usa la app
-- Correr TERCERO, después de 02_seguridad.sql.
--
-- Todas son SECURITY INVOKER (salvo latido y las auxiliares de rol): corren
-- con los permisos de quien llama, así que la RLS se aplica igual que si
-- escribiera en las tablas a mano. Agrupan varios pasos en una sola
-- transacción: o entra el lote entero, o no entra nada.
-- Todas son idempotentes por id: si la red se corta y la app reintenta,
-- no se duplica nada.
-- ════════════════════════════════════════════════════════════════════

create or replace function public.exigir(p_rol text) returns void
language plpgsql stable as $$
begin
  if p_rol = 'admin' and not public.es_admin() then
    raise exception 'Esto lo hace el admin. Tu rol: %.', public.mi_rol() using errcode = 'PT403';
  elsif p_rol = 'auditor' and public.mi_rol() not in ('auditor','admin') then
    raise exception 'Esto lo hace el auditor. Tu rol: %.', public.mi_rol() using errcode = 'PT403';
  elsif p_rol = 'leer' and not public.puede_leer() then
    raise exception 'Tu usuario no tiene acceso todavía (rol: %).', public.mi_rol() using errcode = 'PT403';
  end if;
end $$;

create or replace function public.nombre_estado(e text) returns text
language sql immutable as $$
  select case e when 'armando' then 'En armado' when 'cerrado' then 'Cerrado' when 'en_uso' then 'En uso'
                when 'terminado' then 'Terminado' when 'retirado' then 'Ya no está' else coalesce(e,'s/d') end
$$;

-- un solo camino para cambiar de estado (como cambiarEstado() en el HTML)
create or replace function public._cambiar_estado(p_bolson uuid, p_nuevo text, p_fecha date, p_lote uuid)
returns void language plpgsql as $$
declare antes text;
begin
  select estado into antes from public.bolsones where id = p_bolson;
  if antes is null then raise exception 'No existe el bolsón %.', p_bolson using errcode = 'PT404'; end if;
  if antes = p_nuevo then return; end if;
  update public.bolsones set
    estado = p_nuevo,
    fecha_apertura = case when p_nuevo = 'en_uso' and fecha_apertura is null then p_fecha else fecha_apertura end,
    fecha_cierre   = case when p_nuevo = 'terminado' then p_fecha else fecha_cierre end
  where id = p_bolson;
  insert into public.eventos (bolson_id, fecha, tipo, detalle, importacion_id)
  values (p_bolson, p_fecha,
          case p_nuevo when 'terminado' then 'cierre' when 'en_uso' then 'apertura'
                       when 'armando' then 'armado' when 'retirado' then 'retiro' else 'nota' end,
          format('Estado: %s → %s', public.nombre_estado(antes), public.nombre_estado(p_nuevo)), p_lote);
end $$;

-- cambiar la etiqueta deja el evento de renumeración; la historia no se toca
create or replace function public._renumerar(p_bolson uuid, p_etiqueta text, p_fecha date, p_lote uuid, p_motivo text)
returns void language plpgsql as $$
declare antes text;
begin
  select etiqueta into antes from public.bolsones where id = p_bolson;
  if antes is null then raise exception 'No existe el bolsón %.', p_bolson using errcode = 'PT404'; end if;
  if length(trim(coalesce(p_etiqueta,''))) = 0 then
    raise exception 'La etiqueta no puede quedar vacía.' using errcode = 'PT422';
  end if;
  if antes = p_etiqueta then return; end if;
  update public.bolsones set etiqueta = trim(p_etiqueta) where id = p_bolson;
  insert into public.eventos (bolson_id, fecha, tipo, detalle, importacion_id)
  values (p_bolson, p_fecha, 'renumeracion',
          format('Etiqueta %s → %s%s', antes, trim(p_etiqueta),
                 case when coalesce(p_motivo,'') <> '' then ' · ' || p_motivo else '' end), p_lote);
end $$;

-- ── confirmar un lote (planilla o carga a mano) ─────────────────────
-- Lo que llega ya pasó por la pantalla de revisión: cada renglón trae el
-- bolsón que Iñaki confirmó (o "nuevo"). La base vuelve a controlar:
--   · un bolsón que ya tiene una medición válida en esa fecha solo acepta
--     otra si dice explícitamente a cuál reemplaza y por qué;
--   · reemplazar = anular la vieja con motivo + cargar la nueva.
create or replace function public.confirmar_lote(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_fecha date := (p->>'fecha')::date;
  v_tipo text := coalesce(p->>'tipo','planilla');
  r jsonb; v_bolson uuid; v_prev uuid; n_med int := 0; n_cal int := 0; n_nue int := 0; n_anul int := 0;
begin
  perform public.exigir('admin');
  if v_id is null then raise exception 'Falta el id del lote.' using errcode = 'PT422'; end if;
  if exists (select 1 from public.importaciones where id = v_id) then
    return jsonb_build_object('id', v_id, 'ya_existia', true);
  end if;
  if v_fecha is null then raise exception 'Falta la fecha de la medición.' using errcode = 'PT422'; end if;
  if v_tipo not in ('planilla','manual') then raise exception 'Tipo de lote inválido: %', v_tipo using errcode = 'PT422'; end if;

  insert into public.importaciones (id, tipo, archivo, fecha_medicion, medido_por, resumen, revision)
  values (v_id, v_tipo, coalesce(p->>'archivo',''), v_fecha, coalesce(p->>'medido_por',''),
          coalesce(p->'resumen','{}'::jsonb), coalesce(p->'revision','[]'::jsonb));

  for r in select * from jsonb_array_elements(coalesce(p->'nuevos','[]'::jsonb)) loop
    insert into public.bolsones (id, etiqueta, alimento, fila, posicion, nota, diametro_pies)
    values ((r->>'id')::uuid, r->>'etiqueta', r->>'alimento', coalesce(r->>'fila','A'),
            coalesce((r->>'posicion')::numeric, 0), coalesce(r->>'nota',''), coalesce((r->>'diametro_pies')::numeric, 9));
    insert into public.eventos (bolson_id, fecha, tipo, detalle, importacion_id)
    values ((r->>'id')::uuid, v_fecha, 'alta',
            format('Dado de alta desde %s (etiqueta %s)', case v_tipo when 'planilla' then 'la planilla' else 'la carga a mano' end, r->>'etiqueta'),
            v_id);
    n_nue := n_nue + 1;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'renumerar','[]'::jsonb)) loop
    perform public._renumerar((r->>'bolson_id')::uuid, r->>'etiqueta', v_fecha, v_id, 'según la planilla del ' || to_char(v_fecha,'DD/MM/YY'));
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'estados','[]'::jsonb)) loop
    perform public._cambiar_estado((r->>'bolson_id')::uuid, r->>'estado', v_fecha, v_id);
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'mediciones','[]'::jsonb)) loop
    v_bolson := (r->>'bolson_id')::uuid;
    select id into v_prev from public.mediciones
     where bolson_id = v_bolson and fecha = v_fecha and not anulada and origen <> 'auditoria' limit 1;
    if v_prev is not null and (r->>'reemplaza_a') is null then
      raise exception 'El bolsón % ya tiene una medición válida del %. La revisión tiene que decir si se reemplaza.',
        (select etiqueta from public.bolsones where id = v_bolson), to_char(v_fecha,'DD/MM/YY') using errcode = 'PT409';
    end if;
    if (r->>'reemplaza_a') is not null then
      update public.mediciones set anulada = true, anulada_motivo = r->>'motivo'
       where id = (r->>'reemplaza_a')::uuid and not anulada;
      if not found then
        raise exception 'La medición a reemplazar ya fue anulada o no existe: alguien la tocó mientras revisabas.' using errcode = 'PT409';
      end if;
      n_anul := n_anul + 1;
    end if;
    insert into public.mediciones (id, bolson_id, fecha, metros_restantes, etiqueta_planilla, orden_planilla,
                                   estado_anotado, lectura, medido_por, nota, origen, importacion_id, reemplaza_a, motivo)
    values ((r->>'id')::uuid, v_bolson, v_fecha, (r->>'metros')::numeric, coalesce(r->>'etiqueta_planilla',''),
            (r->>'orden_planilla')::int, coalesce(r->>'estado_anotado',''), coalesce(r->>'lectura','ok'),
            coalesce(p->>'medido_por',''), coalesce(r->>'nota',''), v_tipo, v_id,
            (r->>'reemplaza_a')::uuid, r->>'motivo');
    n_med := n_med + 1;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'calidad','[]'::jsonb)) loop
    if (r->>'reemplaza_a') is not null then
      update public.calidad set anulada = true, anulada_motivo = r->>'motivo'
       where id = (r->>'reemplaza_a')::uuid and not anulada;
      if not found then
        raise exception 'La lectura de materia seca a reemplazar ya fue anulada o no existe.' using errcode = 'PT409';
      end if;
    end if;
    insert into public.calidad (id, tipo, alimento, origen_tipo, origen_id, fecha, peso_inicial_g, pesadas,
                                peso_constante, ms_pct, ingredientes_faltantes, medido_por, nota, origen,
                                importacion_id, reemplaza_a, motivo)
    values ((r->>'id')::uuid, r->>'tipo', r->>'alimento', coalesce(r->>'origen_tipo','celda'), coalesce(r->>'origen_id',''),
            v_fecha, (r->>'peso_inicial_g')::numeric, coalesce(r->'pesadas','[]'::jsonb),
            (r->>'peso_constante')::boolean, (r->>'ms_pct')::numeric,
            coalesce(array(select jsonb_array_elements_text(r->'ingredientes_faltantes')), '{}'),
            coalesce(p->>'medido_por',''), coalesce(r->>'nota',''), v_tipo, v_id, (r->>'reemplaza_a')::uuid, r->>'motivo');
    n_cal := n_cal + 1;
  end loop;

  return jsonb_build_object('id', v_id, 'mediciones', n_med, 'nuevos', n_nue, 'calidad', n_cal, 'reemplazadas', n_anul);
end $$;

-- ── corregir y anular ───────────────────────────────────────────────
create or replace function public.corregir_medicion(p_id uuid, p_metros numeric, p_motivo text, p_nuevo_id uuid)
returns jsonb language plpgsql as $$
declare m public.mediciones;
begin
  perform public.exigir('admin');
  if exists (select 1 from public.mediciones where id = p_nuevo_id) then
    return jsonb_build_object('id', p_nuevo_id, 'ya_existia', true);
  end if;
  if length(trim(coalesce(p_motivo,''))) = 0 then raise exception 'Para corregir hace falta un motivo.' using errcode = 'PT422'; end if;
  select * into m from public.mediciones where id = p_id;
  if m.id is null then raise exception 'No existe la medición.' using errcode = 'PT404'; end if;
  if m.anulada then raise exception 'Esa medición ya estaba anulada: alguien la corrigió antes.' using errcode = 'PT409'; end if;
  update public.mediciones set anulada = true, anulada_motivo = 'Corregida: ' || p_motivo where id = p_id;
  insert into public.mediciones (id, bolson_id, fecha, metros_restantes, etiqueta_planilla, orden_planilla,
                                 estado_anotado, lectura, medido_por, nota, origen, importacion_id, reemplaza_a, motivo)
  values (p_nuevo_id, m.bolson_id, m.fecha, p_metros, m.etiqueta_planilla, m.orden_planilla, m.estado_anotado,
          'ok', m.medido_por, m.nota, case when m.origen = 'auditoria' then 'auditoria' else 'manual' end,
          m.importacion_id, p_id, p_motivo);
  return jsonb_build_object('id', p_nuevo_id, 'reemplaza_a', p_id);
end $$;

create or replace function public.anular(p_tabla text, p_id uuid, p_motivo text) returns jsonb
language plpgsql as $$
declare col text;
begin
  perform public.exigir('admin');
  if p_tabla not in ('mediciones','calidad','eventos') then
    raise exception 'No se anula en %.', p_tabla using errcode = 'PT422';
  end if;
  col := case when p_tabla = 'eventos' then 'anulado' else 'anulada' end;
  execute format('update public.%I set %I = true, %I = $1 where id = $2 and not %I', p_tabla, col, col||'_motivo', col)
    using p_motivo, p_id;
  return jsonb_build_object('id', p_id, 'anulada', true);
end $$;

-- ── editar un bolsón con control de versión ─────────────────────────
-- p_version es el actualizado_en que vio el que edita. Si otro guardó en
-- el medio, la base no pisa: devuelve 409 con la fila actual para mostrar
-- qué cambió.
create or replace function public.actualizar_bolson(p_id uuid, p_cambios jsonb, p_version timestamptz, p_fecha date)
returns jsonb language plpgsql as $$
declare
  b public.bolsones; permitidas text[] := array['grupo','alimento','diametro_pies','armado_fecha',
    'armado_metros_iniciales','armado_kg_declarados','armado_origen','armado_responsable','sector','fila',
    'posicion','nota','fecha_apertura','fecha_cierre'];
  k text; resto jsonb := '{}'::jsonb; quien text;
begin
  perform public.exigir('admin');
  select * into b from public.bolsones where id = p_id for update;
  if b.id is null then raise exception 'No existe el bolsón.' using errcode = 'PT404'; end if;
  if b.actualizado_en is distinct from p_version then
    select coalesce(nullif(nombre,''), email) into quien from public.perfiles where id = b.actualizado_por;
    raise exception 'CONFLICTO' using errcode = 'PT409',
      detail = jsonb_build_object('actual', to_jsonb(b), 'por', coalesce(quien,'otro usuario'))::text;
  end if;
  for k in select jsonb_object_keys(p_cambios) loop
    if k = any(permitidas) then resto := resto || jsonb_build_object(k, p_cambios->k);
    elsif k not in ('estado','etiqueta','motivo_etiqueta') then
      raise exception 'No se puede editar «%» de un bolsón.', k using errcode = 'PT422';
    end if;
  end loop;
  if resto <> '{}'::jsonb then
    update public.bolsones x set
      grupo = r.grupo, alimento = r.alimento, diametro_pies = r.diametro_pies, armado_fecha = r.armado_fecha,
      armado_metros_iniciales = r.armado_metros_iniciales, armado_kg_declarados = r.armado_kg_declarados,
      armado_origen = r.armado_origen, armado_responsable = r.armado_responsable, sector = r.sector,
      fila = r.fila, posicion = r.posicion, nota = r.nota, fecha_apertura = r.fecha_apertura, fecha_cierre = r.fecha_cierre
    from jsonb_populate_record(b, resto) r where x.id = p_id;
  end if;
  if p_cambios ? 'etiqueta' then
    perform public._renumerar(p_id, p_cambios->>'etiqueta', coalesce(p_fecha, current_date), null, p_cambios->>'motivo_etiqueta');
  end if;
  if p_cambios ? 'estado' then
    perform public._cambiar_estado(p_id, p_cambios->>'estado', coalesce(p_fecha, current_date), null);
  end if;
  select * into b from public.bolsones where id = p_id;
  return to_jsonb(b);
end $$;

-- reordenar la playa desde el mapa: varios bolsones, todos con su versión
create or replace function public.mover_bolsones(p jsonb) returns jsonb
language plpgsql as $$
declare r jsonb; b public.bolsones; quien text;
begin
  perform public.exigir('admin');
  for r in select * from jsonb_array_elements(p) loop
    select * into b from public.bolsones where id = (r->>'id')::uuid for update;
    if b.id is null then raise exception 'No existe el bolsón.' using errcode = 'PT404'; end if;
    if b.actualizado_en is distinct from (r->>'version')::timestamptz then
      select coalesce(nullif(nombre,''), email) into quien from public.perfiles where id = b.actualizado_por;
      raise exception 'CONFLICTO' using errcode = 'PT409',
        detail = jsonb_build_object('actual', to_jsonb(b), 'por', coalesce(quien,'otro usuario'))::text;
    end if;
    update public.bolsones set fila = r->>'fila', posicion = (r->>'posicion')::numeric where id = b.id;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- ── eventos ─────────────────────────────────────────────────────────
create or replace function public.agregar_evento(p_id uuid, p_bolson uuid, p_fecha date, p_tipo text, p_detalle text)
returns jsonb language plpgsql as $$
begin
  perform public.exigir('admin');
  insert into public.eventos (id, bolson_id, fecha, tipo, detalle) values (p_id, p_bolson, p_fecha, p_tipo, coalesce(p_detalle,''))
  on conflict (id) do nothing;
  return jsonb_build_object('id', p_id);
end $$;

-- ── auditoría ───────────────────────────────────────────────────────
-- La re-medición de Nico entra como medición de origen 'auditoria'. NO
-- reemplaza a la original: decide Iñaki, anulando una con motivo.
create or replace function public.medicion_auditoria(p_id uuid, p_bolson uuid, p_fecha date, p_metros numeric, p_nota text)
returns jsonb language plpgsql as $$
declare quien text;
begin
  perform public.exigir('auditor');
  if exists (select 1 from public.mediciones where id = p_id) then return jsonb_build_object('id', p_id, 'ya_existia', true); end if;
  select coalesce(nullif(nombre,''), email) into quien from public.perfiles where id = auth.uid();
  insert into public.mediciones (id, bolson_id, fecha, metros_restantes, medido_por, nota, origen, cargado_por)
  values (p_id, p_bolson, p_fecha, p_metros, coalesce(quien,''), coalesce(p_nota,''), 'auditoria', auth.uid());
  return jsonb_build_object('id', p_id);
end $$;

create or replace function public.auditar(p_id uuid, p_importacion uuid, p_medicion uuid, p_resultado text, p_comentario text)
returns jsonb language plpgsql as $$
begin
  if exists (select 1 from public.auditorias where id = p_id) then return jsonb_build_object('id', p_id, 'ya_existia', true); end if;
  if public.mi_rol() <> 'auditor' then
    raise exception 'Audita el auditor. Tu rol: %.', public.mi_rol() using errcode = 'PT403';
  end if;
  insert into public.auditorias (id, importacion_id, medicion_id, resultado, comentario, auditor)
  values (p_id, p_importacion, p_medicion, p_resultado, coalesce(p_comentario,''), auth.uid());
  return jsonb_build_object('id', p_id);
end $$;

-- ── parámetros ──────────────────────────────────────────────────────
create or replace function public.guardar_parametro(p_clave text, p_valor jsonb, p_origen text) returns jsonb
language plpgsql as $$
begin
  perform public.exigir('admin');
  insert into public.parametros (clave, valor, origen) values (p_clave, p_valor, coalesce(p_origen,''))
  on conflict (clave) do update set valor = excluded.valor, origen = excluded.origen,
                                    actualizado_en = now(), actualizado_por = auth.uid();
  return jsonb_build_object('clave', p_clave);
end $$;

-- ── relevamiento histórico ──────────────────────────────────────────
-- Una foto del inventario en una fecha: sus renglones NO se vinculan a los
-- bolsones de hoy. Excepción: los alimentos que el admin marca en la
-- revisión como "son los mismos bolsones de hoy" se dan de alta como
-- bolsones vivos con su medición de esa fecha (origen 'migracion').
create or replace function public.cargar_relevamiento(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id uuid := (p->>'id')::uuid; v_rel uuid := (p->>'relevamiento_id')::uuid; v_fecha date := (p->>'fecha')::date;
  r jsonb; e jsonb; n_items int := 0; n_vivos int := 0;
begin
  perform public.exigir('admin');
  if exists (select 1 from public.importaciones where id = v_id) then return jsonb_build_object('id', v_id, 'ya_existia', true); end if;
  if exists (select 1 from public.relevamientos where fecha = v_fecha) then
    raise exception 'Ya hay un relevamiento del %. Un relevamiento cerrado no se vuelve a cargar.', to_char(v_fecha,'DD/MM/YY') using errcode = 'PT409';
  end if;
  insert into public.importaciones (id, tipo, archivo, fecha_medicion, resumen, revision, estado_auditoria)
  values (v_id, 'relevamiento', coalesce(p->>'archivo',''), v_fecha, coalesce(p->'resumen','{}'::jsonb),
          coalesce(p->'revision','[]'::jsonb), 'no_aplica');
  insert into public.relevamientos (id, fecha, fuente, nota, importacion_id)
  values (v_rel, v_fecha, coalesce(p->>'archivo',''), coalesce(p->>'nota',''), v_id);
  for r in select * from jsonb_array_elements(coalesce(p->'items','[]'::jsonb)) loop
    insert into public.relevamiento_items (relevamiento_id, etiqueta, grupo, alimento, metros, estado, nota, orden)
    values (v_rel, r->>'etiqueta', coalesce(r->>'grupo',''), r->>'alimento', (r->>'metros')::numeric,
            coalesce(r->>'estado',''), coalesce(r->>'nota',''), (r->>'orden')::int);
    n_items := n_items + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p->'vivos','[]'::jsonb)) loop
    insert into public.bolsones (id, etiqueta, grupo, alimento, diametro_pies, armado_fecha, armado_metros_iniciales,
      armado_kg_declarados, armado_origen, armado_responsable, sector, fila, posicion, estado, fecha_apertura, fecha_cierre, nota)
    select x.id, x.etiqueta, x.grupo, x.alimento, x.diametro_pies, x.armado_fecha, x.armado_metros_iniciales,
      x.armado_kg_declarados, x.armado_origen, x.armado_responsable, x.sector, x.fila, x.posicion, x.estado,
      x.fecha_apertura, x.fecha_cierre, x.nota
    from jsonb_populate_record(null::public.bolsones,
           jsonb_build_object('grupo','','diametro_pies',9,'armado_origen','','armado_responsable','',
                              'sector','Playa','fila','A','posicion',0,'estado','cerrado','nota','') || (r->'bolson')) x;
    insert into public.eventos (bolson_id, fecha, tipo, detalle, importacion_id)
    values ((r->'bolson'->>'id')::uuid, v_fecha, 'alta', coalesce(r->>'motivo_alta', 'Dado de alta desde el relevamiento'), v_id);
    if r->'medicion' is not null and r->'medicion' <> 'null'::jsonb then
      insert into public.mediciones (id, bolson_id, fecha, metros_restantes, etiqueta_planilla, orden_planilla,
                                     medido_por, nota, origen, importacion_id)
      values ((r->'medicion'->>'id')::uuid, (r->'bolson'->>'id')::uuid, v_fecha, (r->'medicion'->>'metros')::numeric,
              coalesce(r->'medicion'->>'etiqueta_planilla',''), (r->'medicion'->>'orden_planilla')::int,
              coalesce(r->'medicion'->>'medido_por',''), coalesce(r->'medicion'->>'nota',''), 'migracion', v_id);
    end if;
    for e in select * from jsonb_array_elements(coalesce(r->'eventos','[]'::jsonb)) loop
      insert into public.eventos (bolson_id, fecha, tipo, detalle, importacion_id)
      values ((r->'bolson'->>'id')::uuid, (e->>'fecha')::date, e->>'tipo', coalesce(e->>'detalle',''), v_id);
    end loop;
    n_vivos := n_vivos + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p->'parametros','[]'::jsonb)) loop
    perform public.guardar_parametro(r->>'clave', r->'valor', r->>'origen');
  end loop;
  return jsonb_build_object('id', v_id, 'items', n_items, 'vivos', n_vivos);
end $$;

-- ── historial de cambios de un bolsón (para la ficha) ───────────────
create or replace function public.cambios_de_bolson(p_id uuid) returns setof public.cambios
language sql stable as $$
  select c.* from public.cambios c
   where (c.tabla = 'bolsones' and c.fila_id = p_id::text)
      or (c.tabla = 'mediciones' and c.fila_id in (select id::text from public.mediciones where bolson_id = p_id))
      or (c.tabla = 'eventos'    and c.fila_id in (select id::text from public.eventos    where bolson_id = p_id))
   order by c.en, c.id
$$;

-- ── usuarios ────────────────────────────────────────────────────────
create or replace function public.invitar(p_email text, p_nombre text, p_rol text) returns jsonb
language plpgsql as $$
declare v_email text := lower(trim(p_email));
begin
  perform public.exigir('admin');
  insert into public.invitaciones (email, nombre, rol) values (v_email, coalesce(p_nombre,''), p_rol)
  on conflict (email) do update set nombre = excluded.nombre, rol = excluded.rol;
  -- si ya tenía cuenta, el rol se aplica ahora
  update public.perfiles set rol = p_rol, nombre = coalesce(nullif(p_nombre,''), nombre), actualizado_en = now()
   where email = v_email and id <> auth.uid();
  return jsonb_build_object('email', v_email, 'rol', p_rol);
end $$;

create or replace function public.cambiar_rol(p_id uuid, p_rol text, p_nombre text) returns jsonb
language plpgsql as $$
begin
  perform public.exigir('admin');
  if p_id = auth.uid() then raise exception 'No podés cambiar tu propio rol.' using errcode = 'PT422'; end if;
  update public.perfiles set rol = p_rol, nombre = coalesce(p_nombre, nombre), actualizado_en = now() where id = p_id;
  return jsonb_build_object('id', p_id, 'rol', p_rol);
end $$;

-- ── restaurar un respaldo JSON ──────────────────────────────────────
-- Nada se pisa: una fila que ya existe con el mismo id no se toca. Si es
-- idéntica cuenta como "igual"; si difiere, como "distinta" y se informa.
-- Única excepción: un parámetro que sigue con el valor de arranque del
-- 01_esquema.sql (nadie lo editó: actualizado_por vacío) toma el del respaldo.
create or replace function public.restaurar_respaldo(p jsonb) returns jsonb
language plpgsql as $$
declare
  t text; k text; fila jsonb; existente jsonb; res jsonb := '{}'::jsonb;
  ins int; igu int; dis int; distintas jsonb;
begin
  perform public.exigir('admin');
  perform set_config('silobolsa.restaurando', '1', true);
  foreach t in array array['parametros','importaciones','relevamientos','relevamiento_items','bolsones',
                           'mediciones','eventos','calidad','auditorias'] loop
    k := case t when 'parametros' then 'clave' else 'id' end;
    ins := 0; igu := 0; dis := 0; distintas := '[]'::jsonb;
    for fila in select value from jsonb_array_elements(coalesce(p->'tablas'->t, '[]'::jsonb))
                order by coalesce(value->>'cargado_en', value->>'en', value->>'actualizado_en', ''), value->>k loop
      execute format('select to_jsonb(x) from public.%I x where x.%I::text = $1', t, k) into existente using fila->>k;
      if existente is null then
        execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)', t, t) using fila;
        ins := ins + 1;
      elsif existente = fila then
        igu := igu + 1;
      elsif t = 'parametros' and (existente->>'actualizado_por') is null then
        -- valor de arranque de 01_esquema.sql, que nadie editó todavía: no es un dato, se reemplaza
        update public.parametros set valor = fila->'valor', origen = fila->>'origen',
               actualizado_en = (fila->>'actualizado_en')::timestamptz, actualizado_por = (fila->>'actualizado_por')::uuid
         where clave = fila->>'clave';
        ins := ins + 1;
      else
        dis := dis + 1; distintas := distintas || to_jsonb(fila->>k);
      end if;
    end loop;
    res := res || jsonb_build_object(t, jsonb_build_object('insertadas', ins, 'iguales', igu, 'distintas', dis, 'ids_distintos', distintas));
  end loop;
  return res;
end $$;

-- ── latido: lo llama el GitHub Action diario con la clave pública ───
-- Escribe a lo sumo una fila por hora: suficiente para que quede registro
-- y para que nadie pueda llenar la tabla.
create or replace function public.latido(p_origen text default 'github-action') returns jsonb
language plpgsql security definer set search_path = public as $$
declare ultimo timestamptz;
begin
  select max(en) into ultimo from public.latidos;
  if ultimo is null or ultimo < now() - interval '1 hour' then
    insert into public.latidos (origen) values (left(coalesce(p_origen,''), 40));
  end if;
  return jsonb_build_object('ok', true, 'ultimo', (select max(en) from public.latidos),
                            'total', (select count(*) from public.latidos));
end $$;

-- ── quién puede ejecutar qué ────────────────────────────────────────
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
grant  execute on function public.latido(text) to anon;
