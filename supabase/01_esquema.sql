-- ════════════════════════════════════════════════════════════════════
-- Silo Bolsa LIVE · Fase 3 · 01 — Esquema
-- Correr PRIMERO, en el SQL Editor de Supabase (proyecto ckvsiwiizwdrvrpuucxa).
-- Este archivo no trae datos: solo estructura y los parámetros de arranque.
-- La fórmula de la dieta, los kg/día, los textos de origen de los
-- coeficientes y la referencia del portal arrancan VACÍOS: son de la
-- empresa y el repo es público. Entran desde el relevamiento del 13/8
-- (pantalla de revisión) o a mano en Ajustes, y viven solo en la base.
-- ════════════════════════════════════════════════════════════════════

-- ── usuarios y roles ────────────────────────────────────────────────
-- Un usuario nuevo nace 'sin_acceso': el alta de usuarios del proyecto
-- está abierta (cualquiera puede crearse una cuenta con la clave pública),
-- así que tener cuenta no da acceso a nada. El rol lo da el admin.
create table public.perfiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null,
  nombre          text not null default '',
  rol             text not null default 'sin_acceso'
                  check (rol in ('admin','auditor','lectura','sin_acceso')),
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

-- Emails autorizados de antemano: al crearse la cuenta, toma este rol.
create table public.invitaciones (
  email         text primary key check (email = lower(email)),
  nombre        text not null default '',
  rol           text not null check (rol in ('admin','auditor','lectura')),
  invitado_por  uuid default auth.uid(),
  invitado_en   timestamptz not null default now()
);

-- ── lotes: cada planilla confirmada (o carga) es un lote ────────────
create table public.importaciones (
  id                uuid primary key default gen_random_uuid(),
  tipo              text not null check (tipo in ('planilla','manual','relevamiento','restauracion')),
  archivo           text not null default '',
  fecha_medicion    date,
  medido_por        text not null default '',
  resumen           jsonb not null default '{}'::jsonb,
  -- lo que la pantalla de revisión dijo de cada renglón al confirmar
  revision          jsonb not null default '[]'::jsonb,
  estado_auditoria  text not null default 'pendiente'
                    check (estado_auditoria in ('pendiente','ok','observada','no_aplica')),
  cargado_por       uuid default auth.uid(),
  cargado_en        timestamptz not null default now()
);

-- ── bolsones: el id no cambia nunca; la etiqueta es la del último recorrido
create table public.bolsones (
  id                       uuid primary key default gen_random_uuid(),
  etiqueta                 text not null,
  grupo                    text not null default '',
  alimento                 text not null,
  diametro_pies            numeric not null default 9,
  armado_fecha             date,
  armado_metros_iniciales  numeric check (armado_metros_iniciales is null or armado_metros_iniciales >= 0),
  armado_kg_declarados     numeric check (armado_kg_declarados is null or armado_kg_declarados >= 0),
  armado_origen            text not null default '',
  armado_responsable       text not null default '',
  sector                   text not null default 'Playa',
  fila                     text not null default 'A',
  posicion                 numeric not null default 0,
  estado                   text not null default 'cerrado'
                           check (estado in ('armando','cerrado','en_uso','terminado','retirado')),
  fecha_apertura           date,
  fecha_cierre             date,
  nota                     text not null default '',
  creado_por               uuid default auth.uid(),
  creado_en                timestamptz not null default now(),
  -- control de edición concurrente: el que guarda manda la versión que vio
  actualizado_en           timestamptz not null default clock_timestamp(),
  actualizado_por          uuid default auth.uid()
);

-- ── mediciones: nunca se borran ni se editan; se anulan y se reemplazan
create table public.mediciones (
  id                 uuid primary key default gen_random_uuid(),
  bolson_id          uuid not null references public.bolsones(id) on delete restrict,
  fecha              date not null,
  -- una medición sin metros no es una medición: el s/d es la ausencia de fila
  metros_restantes   numeric not null check (metros_restantes >= 0),
  etiqueta_planilla  text not null default '',   -- el número de ESE recorrido
  orden_planilla     integer,                    -- posición en la hoja de ese recorrido
  estado_anotado     text not null default '',   -- 'en_uso', 'armando' tal como vino
  lectura            text not null default 'ok' check (lectura in ('ok','dudosa')),
  medido_por         text not null default '',   -- de la planilla: "Silvana"
  nota               text not null default '',
  origen             text not null check (origen in ('planilla','manual','auditoria','migracion')),
  importacion_id     uuid references public.importaciones(id),
  -- 'dentro_resolucion': subió ≤ 0,5 m · 'diferencia_medicion': subió > 0,5 m (ver 02_seguridad.sql)
  revision_marca     text check (revision_marca in ('diferencia_medicion','dentro_resolucion')),
  revision_nota      text,
  reemplaza_a        uuid references public.mediciones(id),
  motivo             text,                       -- por qué reemplaza a la anterior
  anulada            boolean not null default false,
  anulada_motivo     text,
  anulada_por        uuid,
  anulada_en         timestamptz,
  cargado_por        uuid default auth.uid(),
  cargado_en         timestamptz not null default now(),
  check (reemplaza_a is null or length(trim(coalesce(motivo,''))) > 0),
  check (not anulada or length(trim(coalesce(anulada_motivo,''))) > 0)
);
create index on public.mediciones (bolson_id, fecha);
create index on public.mediciones (importacion_id);

create table public.eventos (
  id              uuid primary key default gen_random_uuid(),
  bolson_id       uuid not null references public.bolsones(id) on delete restrict,
  fecha           date not null,
  tipo            text not null check (tipo in ('alta','armado','apertura','cierre','rotura','perdida',
                                                'retiro','nota','renumeracion')),
  detalle         text not null default '',
  importacion_id  uuid references public.importaciones(id),
  anulado         boolean not null default false,
  anulado_motivo  text,
  anulado_por     uuid,
  anulado_en      timestamptz,
  cargado_por     uuid default auth.uid(),
  cargado_en      timestamptz not null default now(),
  check (not anulado or length(trim(coalesce(anulado_motivo,''))) > 0)
);
create index on public.eventos (bolson_id);

-- ── materia seca: se guardan las pesadas crudas ─────────────────────
-- ms_pct = última pesada / peso inicial. Si no llegó a peso constante,
-- ms_pct es una COTA SUPERIOR (la MS real es menor) y se muestra "≤".
create table public.calidad (
  id                      uuid primary key default gen_random_uuid(),
  tipo                    text not null check (tipo in ('ingrediente','dieta')),
  alimento                text,
  origen_tipo             text not null default 'celda' check (origen_tipo in ('bolson','celda','mixer')),
  origen_id               text not null default '',          -- cuál bolsón o celda; vacío = s/d
  fecha                   date not null,
  peso_inicial_g          numeric check (peso_inicial_g is null or peso_inicial_g > 0),
  pesadas                 jsonb not null default '[]'::jsonb, -- [{"min":10,"g":73}, ...]
  peso_constante          boolean,                            -- null = no hay pesadas para saberlo
  ms_pct                  numeric not null check (ms_pct > 0 and ms_pct <= 100),
  ingredientes_faltantes  text[] not null default '{}',       -- solo dieta: qué no tenía ese día
  medido_por              text not null default '',
  nota                    text not null default '',
  origen                  text not null default 'planilla' check (origen in ('planilla','manual','auditoria','migracion')),
  importacion_id          uuid references public.importaciones(id),
  reemplaza_a             uuid references public.calidad(id),
  motivo                  text,
  anulada                 boolean not null default false,
  anulada_motivo          text,
  anulada_por             uuid,
  anulada_en              timestamptz,
  cargado_por             uuid default auth.uid(),
  cargado_en              timestamptz not null default now(),
  check (tipo = 'dieta' or alimento is not null),
  check (reemplaza_a is null or length(trim(coalesce(motivo,''))) > 0),
  check (not anulada or length(trim(coalesce(anulada_motivo,''))) > 0)
);

-- ── auditorías de Nico ──────────────────────────────────────────────
create table public.auditorias (
  id              uuid primary key default gen_random_uuid(),
  importacion_id  uuid references public.importaciones(id),
  medicion_id     uuid references public.mediciones(id),
  auditor         uuid default auth.uid(),
  en              timestamptz not null default now(),
  resultado       text not null check (resultado in ('ok','observada')),
  comentario      text not null default '',
  check (num_nonnulls(importacion_id, medicion_id) = 1),
  check (resultado = 'ok' or length(trim(comentario)) > 0)   -- una observación sin comentario no le sirve a nadie
);

-- ── parámetros, con su origen escrito al lado ───────────────────────
create table public.parametros (
  clave            text primary key check (clave in ('alimentos','dieta','referencia','meta')),
  valor            jsonb not null,
  origen           text not null default '',
  actualizado_en   timestamptz not null default now(),
  actualizado_por  uuid default auth.uid()
);

-- ── relevamientos históricos: fotos del inventario, sin vincular ────
create table public.relevamientos (
  id              uuid primary key default gen_random_uuid(),
  fecha           date not null,
  fuente          text not null default '',
  nota            text not null default '',
  importacion_id  uuid references public.importaciones(id),
  cargado_por     uuid default auth.uid(),
  cargado_en      timestamptz not null default now()
);
create table public.relevamiento_items (
  id               uuid primary key default gen_random_uuid(),
  relevamiento_id  uuid not null references public.relevamientos(id),
  etiqueta         text not null,
  grupo            text not null default '',
  alimento         text not null,
  metros           numeric check (metros is null or metros >= 0),   -- null = s/d
  estado           text not null default '',
  nota             text not null default '',
  orden            integer
);

-- ── registro automático de toda alta, edición y baja ────────────────
create table public.cambios (
  id         bigint generated always as identity primary key,
  tabla      text not null,
  fila_id    text,
  operacion  text not null,
  antes      jsonb,
  despues    jsonb,
  usuario    uuid,
  en         timestamptz not null default now()
);
create index on public.cambios (tabla, fila_id);

-- ── latido diario (para que el plan gratis no pause el proyecto) ────
create table public.latidos (
  id      bigint generated always as identity primary key,
  en      timestamptz not null default now(),
  origen  text not null default ''
);

-- ── parámetros de arranque ──────────────────────────────────────────
-- Solo lo que hace falta para que la app arranque: nombres, colores y los
-- coeficientes vigentes que fija el prompt de la fase 3 (MG 3.664 medido,
-- MS 4.000 estimado, GL 4.700 sin validar). Sin textos de origen, sin
-- fórmula de dieta y sin referencia: eso entra desde el relevamiento.
insert into public.parametros (clave, valor, origen) values
('alimentos', $j${
  "MG":{"nombre":"Maíz Grano","color":"#C9A227","kg_por_metro":3664,"ms_pct":null,"calidad":"med","origen_kgm":"","origen_ms":""},
  "MS":{"nombre":"Maíz Silo","color":"#2E9E5B","kg_por_metro":4000,"ms_pct":null,"calidad":"est","origen_kgm":"","origen_ms":"",
        "fuera_de_alcance":"el silo de maíz que no está embolsado"},
  "GL":{"nombre":"Gluten","color":"#8E2A2A","kg_por_metro":4700,"ms_pct":null,"calidad":"sv","origen_kgm":"","origen_ms":""},
  "HG":{"nombre":"Harina de Germen","color":"#7A5C3E","kg_por_metro":null,"ms_pct":null,"calidad":"est","sinBolson":true,"origen_kgm":"","origen_ms":""},
  "NU":{"nombre":"Núcleo","color":"#5B6E8C","kg_por_metro":null,"ms_pct":null,"calidad":"est","sinBolson":true,"origen_kgm":"","origen_ms":""}
}$j$::jsonb, 'Arranque: coeficientes vigentes sin su texto de origen ni %MS de casa; se completan desde el relevamiento o en Ajustes.'),
('dieta', '{"proporciones":{},"kg_dia_min":null,"kg_dia_max":null,"origen":""}'::jsonb,
 'Arranque: sin fórmula. Se carga desde el relevamiento o en Ajustes.'),
('referencia', $j${
  "fuente":"Portal PEGSA · vista v_PB_StockInsumo (SQL WinCampo)",
  "fecha":"",
  "nota":"Valor externo, cargado a mano. La app no se conecta al portal: esto es solo para contrastar.",
  "valores":{"MG":null,"MS":null,"GL":null}
}$j$::jsonb, 'Sin valores: se cargan a mano desde Ajustes o desde el relevamiento del 13/8.'),
('meta', '{"version":4,"diametro_pies":9}'::jsonb, 'Fase 3.');
