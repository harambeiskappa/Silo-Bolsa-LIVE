-- ════════════════════════════════════════════════════════════════════
-- Silo Bolsa LIVE · Fase 3 · 04 — El primer admin
-- Correr CUARTO, una sola vez, DESPUÉS de crear la cuenta de Iñaki en
-- Authentication → Users → "Add user" (o de que él entre por primera vez).
--
-- Copiarlo como 04_primer_admin.sql (ese nombre está en .gitignore: el mail
-- real no entra al repo) y ahí reemplazar  iñaki@ejemplo.com  por el mail real.
-- Los demás roles (Nico auditor, Silvana lectura) se dan desde la app,
-- en Ajustes → Usuarios, con Iñaki logueado.
-- ════════════════════════════════════════════════════════════════════

-- 1) perfiles para las cuentas que ya existían antes del trigger
insert into public.perfiles (id, email)
select id, lower(email) from auth.users
on conflict (id) do nothing;

-- 2) Iñaki admin
update public.perfiles set rol = 'admin', nombre = 'Iñaki'
 where email = lower('iñaki@ejemplo.com');

-- 3) control: tiene que mostrar una fila con rol admin
select email, nombre, rol from public.perfiles order by creado_en;
