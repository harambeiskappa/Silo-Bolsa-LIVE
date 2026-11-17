-- ════════════════════════════════════════════════════════════════════
-- Silo Bolsa LIVE · Fase 4 · 06 — Auditoría compartida
-- Se corre SOLO este archivo en el SQL Editor, sobre una base que ya tiene
-- 01..05. Se puede correr más de una vez.
--
-- Qué cambia (decidido el 17/11):
--   · Iñaki (admin) también audita; Nico (auditor) sigue igual.
--   · Un lote puede tener varias auditorías, una VIGENTE por persona. Si la
--     misma persona vuelve a auditar, la anterior queda anulada con motivo
--     (no se borra).
--   · Si quien audita es quien cargó el lote, la base la marca como
--     «control de quien cargó» (es_quien_cargo). No lo decide el navegador.
--   · Estado del lote, calculado por la base con las auditorías vigentes:
--       observado   si hay alguna observación (del lote o de una medición suya);
--       auditado    si no, con al menos un OK del lote;
--       sin auditar en otro caso.
--     Con el OK de Iñaki alcanza. En la tabla quedan los valores de siempre:
--     'observada', 'ok' y 'pendiente'.
--   · K: vincular_desde_relevamiento acepta solo el relevamiento más reciente
--     de cada alimento, salvo p_forzar = true.
-- La excepción de restaurar_respaldo se mantiene: al restaurar, las filas
-- entran tal cual (con su anulación y su marca) y no se recalcula nada.
-- ════════════════════════════════════════════════════════════════════

alter table public.auditorias add column if not exists es_quien_cargo boolean not null default false;
alter table public.auditorias add column if not exists anulada boolean not null default false;
alter table public.auditorias add column if not exists anulada_motivo text;
alter table public.auditorias add column if not exists anulada_por uuid;
alter table public.auditorias add column if not exists anulada_en timestamptz;
alter table public.auditorias drop constraint if exists auditorias_anulada_con_motivo;
alter table public.auditorias add constraint auditorias_anulada_con_motivo
  check (not anulada or length(trim(coalesce(anulada_motivo,''))) > 0);

-- ── quién puede auditar: auditor y admin, siempre a su nombre ───────
drop policy if exists auditorias_alta on public.auditorias;
create policy auditorias_alta on public.auditorias for insert to authenticated
  with check ((public.mi_rol() in ('auditor','admin') and auditor = auth.uid())
              -- restaurar un respaldo (restaurar_respaldo, solo admin) trae las auditorías tal cual
              or (public.es_admin() and coalesce(current_setting('silobolsa.restaurando', true), '') = '1'));

create or replace function public.auditar(p_id uuid, p_importacion uuid, p_medicion uuid, p_resultado text, p_comentario text)
returns jsonb language plpgsql as $$
begin
  if exists (select 1 from public.auditorias where id = p_id) then return jsonb_build_object('id', p_id, 'ya_existia', true); end if;
  if public.mi_rol() not in ('auditor','admin') then
    raise exception 'Auditan el auditor y el admin. Tu rol: %.', public.mi_rol() using errcode = 'PT403';
  end if;
  insert into public.auditorias (id, importacion_id, medicion_id, resultado, comentario, auditor)
  values (p_id, p_importacion, p_medicion, p_resultado, coalesce(p_comentario,''), auth.uid());
  return (select jsonb_build_object('id', id, 'es_quien_cargo', es_quien_cargo) from public.auditorias where id = p_id);
end $$;

-- ── antes de entrar: ¿es quien cargó el lote? (lo decide la base) ───
create or replace function public.auditoria_quien_cargo() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lote uuid; v_cargo uuid;
begin
  if coalesce(current_setting('silobolsa.restaurando', true), '') = '1' then return new; end if;
  v_lote := coalesce(new.importacion_id, (select importacion_id from public.mediciones where id = new.medicion_id));
  select cargado_por into v_cargo from public.importaciones where id = v_lote;
  new.es_quien_cargo := (v_cargo is not null and v_cargo = new.auditor);
  new.anulada := false; new.anulada_motivo := null; new.anulada_por := null; new.anulada_en := null;
  return new;
end $$;
drop trigger if exists auditoria_quien_cargo on public.auditorias;
create trigger auditoria_quien_cargo before insert on public.auditorias
  for each row execute function public.auditoria_quien_cargo();

-- ── estado del lote con las auditorías vigentes ─────────────────────
create or replace function public.estado_lote(p_lote uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.auditorias a left join public.mediciones m on m.id = a.medicion_id
                  where not a.anulada and a.resultado = 'observada'
                    and (a.importacion_id = p_lote or m.importacion_id = p_lote)) then 'observada'
    when exists (select 1 from public.auditorias a
                  where not a.anulada and a.resultado = 'ok' and a.importacion_id = p_lote) then 'ok'
    else 'pendiente' end
$$;

-- ── después de entrar: anular la anterior de la misma persona y recalcular
create or replace function public.al_auditar() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lote uuid;
begin
  if coalesce(current_setting('silobolsa.restaurando', true), '') = '1' then return new; end if;
  v_lote := coalesce(new.importacion_id, (select importacion_id from public.mediciones where id = new.medicion_id));
  -- una auditoría vigente por persona: la nueva reemplaza a las anteriores de esa persona
  -- (auditar el lote reemplaza también lo que esa persona dijo de sus mediciones)
  update public.auditorias x set
         anulada = true, anulada_por = new.auditor, anulada_en = now(),
         anulada_motivo = format('Reemplazada por una auditoría nueva de la misma persona (%s, %s)',
                                 case new.resultado when 'ok' then 'OK' else 'observada' end, to_char(new.en, 'DD/MM/YY HH24:MI'))
   where x.id <> new.id and x.auditor = new.auditor and not x.anulada
     and ( (new.importacion_id is not null and (x.importacion_id = new.importacion_id
              or x.medicion_id in (select id from public.mediciones where importacion_id = new.importacion_id)))
        or (new.medicion_id is not null and x.medicion_id = new.medicion_id) );
  if v_lote is not null then
    update public.importaciones set estado_auditoria = public.estado_lote(v_lote)
     where id = v_lote and estado_auditoria <> 'no_aplica';
  end if;
  return new;
end $$;
drop trigger if exists al_auditar on public.auditorias;
create trigger al_auditar after insert on public.auditorias
  for each row execute function public.al_auditar();

-- los lotes que ya existían quedan con el estado que dicen sus auditorías vigentes
update public.importaciones set estado_auditoria = public.estado_lote(id)
 where tipo in ('planilla','manual') and estado_auditoria <> public.estado_lote(id);

-- ── K: vincular solo el relevamiento más reciente ───────────────────
drop function if exists public.vincular_desde_relevamiento(uuid, text, text);
create or replace function public.vincular_desde_relevamiento(p_relevamiento uuid, p_alimento text, p_motivo text, p_forzar boolean default false)
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

  -- K: se vincula solo el relevamiento MÁS RECIENTE de ese alimento. Uno más viejo es una foto
  -- de bolsones que pudieron no ser los de hoy; para hacerlo igual hay que pedirlo explícitamente
  -- (p_forzar = true), y el freno de duplicados de abajo sigue valiendo.
  if not coalesce(p_forzar, false) and exists (
       select 1 from public.relevamientos r2 join public.relevamiento_items i2 on i2.relevamiento_id = r2.id
        where i2.alimento = p_alimento and r2.fecha > rel.fecha) then
    raise exception 'El relevamiento del % no es el más reciente de % (hay uno del %): se vincula solo el más reciente. Si de verdad corresponde, hay que pedirlo con p_forzar = true.',
      to_char(rel.fecha,'DD/MM/YY'), p_alimento,
      (select to_char(max(r2.fecha),'DD/MM/YY') from public.relevamientos r2 join public.relevamiento_items i2 on i2.relevamiento_id = r2.id where i2.alimento = p_alimento)
      using errcode = 'PT409';
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


revoke execute on function public.vincular_desde_relevamiento(uuid, text, text, boolean) from public, anon;
grant  execute on function public.vincular_desde_relevamiento(uuid, text, text, boolean) to authenticated;
revoke execute on function public.auditar(uuid, uuid, uuid, text, text) from public, anon;
grant  execute on function public.auditar(uuid, uuid, uuid, text, text) to authenticated;
revoke execute on function public.estado_lote(uuid) from public, anon;
grant  execute on function public.estado_lote(uuid) to authenticated;
revoke execute on function public.auditoria_quien_cargo() from public, anon;
revoke execute on function public.al_auditar() from public, anon;
