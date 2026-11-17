-- ════════════════════════════════════════════════════════════════════
-- Silo Bolsa LIVE · Fase 3 · 05 — Vincular un relevamiento ya cargado
-- Se corre SOLO este archivo en el SQL Editor; no hace falta tocar 01..04.
-- Se puede correr más de una vez (create or replace).
--
-- Para qué: al cargar un relevamiento histórico, la casilla "son los mismos
-- bolsones de hoy" viene apagada. Si se olvidó tildarla, el relevamiento
-- queda como foto y no hay forma de volver a cargarlo (un relevamiento
-- cerrado no se recarga, y no se borra nada). Esta función hace después lo
-- que hubiera hecho la casilla: da de alta como bolsones vivos los renglones
-- de UN alimento de ese relevamiento, cada uno con su medición de esa fecha
-- (origen 'migracion') y su evento de alta con el motivo.
--
-- Corre con los permisos de quien llama (la RLS se aplica) y solo la puede
-- usar el admin. Queda en `cambios` por los triggers de siempre.
-- ════════════════════════════════════════════════════════════════════

create or replace function public.vincular_desde_relevamiento(p_relevamiento uuid, p_alimento text, p_motivo text)
returns jsonb language plpgsql as $$
declare
  rel public.relevamientos; it record; v_id uuid; n int := 0; n_med int := 0; v_metros numeric := 0;
  ya int; posteriores int; v_pos numeric;
begin
  perform public.exigir('admin');
  if length(trim(coalesce(p_motivo,''))) = 0 then
    raise exception 'Hace falta el motivo: quién confirmó que son los mismos bolsones.' using errcode = 'PT422';
  end if;
  select * into rel from public.relevamientos where id = p_relevamiento;
  if rel.id is null then raise exception 'No existe ese relevamiento.' using errcode = 'PT404'; end if;
  if not exists (select 1 from public.relevamiento_items where relevamiento_id = rel.id and alimento = p_alimento) then
    raise exception 'El relevamiento del % no tiene renglones de %.', to_char(rel.fecha,'DD/MM/YY'), p_alimento using errcode = 'PT422';
  end if;

  -- idempotente: si ya se vinculó (o se tildó al cargarlo), no se repite
  -- (se mira el evento de alta, que existe aunque el renglón no tuviera metros)
  select count(distinct e.bolson_id) into ya
    from public.eventos e join public.bolsones b on b.id = e.bolson_id
   where e.importacion_id = rel.importacion_id and e.tipo = 'alta' and b.alimento = p_alimento;
  if ya > 0 then
    return jsonb_build_object('ya_existia', true, 'bolsones', ya,
      'mensaje', format('Ya estaba vinculado: %s bolsones de %s del relevamiento del %s. No se creó nada.', ya, p_alimento, to_char(rel.fecha,'DD/MM/YY')));
  end if;

  -- no se vincula una foto vieja encima de bolsones que ya tienen mediciones más nuevas:
  -- se duplicarían los bolsones de hoy
  select count(distinct b.id) into posteriores
    from public.bolsones b join public.mediciones m on m.bolson_id = b.id
   where b.alimento = p_alimento and b.estado not in ('retirado','terminado')
     and not m.anulada and m.fecha > rel.fecha;
  if posteriores > 0 then
    raise exception 'Ya hay % bolsones vivos de % con mediciones posteriores al %: vincular este relevamiento los duplicaría.',
      posteriores, p_alimento, to_char(rel.fecha,'DD/MM/YY') using errcode = 'PT409';
  end if;

  -- lugar provisorio en el mapa (el relevamiento no guarda la ubicación): pasada A, al final
  select coalesce(max(posicion), 0) into v_pos from public.bolsones where fila = 'A';
  for it in select * from public.relevamiento_items
             where relevamiento_id = rel.id and alimento = p_alimento order by orden nulls last, etiqueta loop
    v_id := gen_random_uuid();
    v_pos := v_pos + 1;
    insert into public.bolsones (id, etiqueta, grupo, alimento, fila, posicion, estado, nota)
    values (v_id, it.etiqueta, coalesce(it.grupo,''), it.alimento, 'A', v_pos,
            case when it.estado in ('armando','cerrado','en_uso','terminado','retirado') then it.estado else 'cerrado' end,
            coalesce(it.nota,''));
    insert into public.eventos (bolson_id, fecha, tipo, detalle, importacion_id)
    values (v_id, rel.fecha, 'alta',
            format('Vinculado desde el relevamiento del %s (etiqueta %s): %s', to_char(rel.fecha,'DD/MM/YY'), it.etiqueta, trim(p_motivo)),
            rel.importacion_id);
    if it.metros is not null then
      insert into public.mediciones (bolson_id, fecha, metros_restantes, etiqueta_planilla, orden_planilla, nota, origen, importacion_id)
      values (v_id, rel.fecha, it.metros, it.etiqueta, it.orden, '', 'migracion', rel.importacion_id);
      n_med := n_med + 1; v_metros := v_metros + it.metros;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ya_existia', false, 'bolsones', n, 'con_medicion', n_med, 'metros', v_metros,
    'mensaje', format('Vinculados %s bolsones de %s con su medición del %s (%s m).', n, p_alimento, to_char(rel.fecha,'DD/MM/YY'), fmt_m(v_metros)));
end $$;

revoke execute on function public.vincular_desde_relevamiento(uuid, text, text) from public, anon;
grant  execute on function public.vincular_desde_relevamiento(uuid, text, text) to authenticated;
