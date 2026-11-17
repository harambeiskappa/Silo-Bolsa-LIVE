# Silo Bolsa LIVE

Control de los bolsones de silo bolsa del feedlot El Haras (Darwash / PEGSA). Por fuera del portal de PEGSA.

**Este repo no contiene datos.** Las mediciones viven en la base (Supabase) y en la carpeta del proyecto, fuera del repo.
En el HTML va solo la URL del proyecto y la clave pública; la clave `service_role` no va nunca.

## Qué hay

| Archivo | Qué es |
|---|---|
| `index.html` | La app entera: un solo HTML, JS plano, sin framework ni CDN. Habla con Supabase por `fetch`. |
| `supabase/01_esquema.sql` | Tablas y parámetros de arranque. |
| `supabase/02_seguridad.sql` | Roles, RLS en todas las tablas, registro de cambios, reglas de "nada se pisa". |
| `supabase/03_funciones.sql` | Las funciones que usa la app (confirmar un lote, corregir, auditar, restaurar…). |
| `supabase/04_primer_admin.sql` | Deja a Iñaki como admin (editar el mail antes de correrlo). |
| `.github/workflows/latido.yml` | Llamada diaria para que el plan gratis de Supabase no pause el proyecto. |
| `pruebas/` | Banco de pruebas local (Postgres en memoria con el mismo SQL) y la prueba de punta a punta. |

## Poner en marcha (una sola vez)

1. **Base.** En el panel de Supabase → SQL Editor, correr en este orden, cada uno completo:
   `01_esquema.sql`, `02_seguridad.sql`, `03_funciones.sql`.
2. **Auth — obligatorio.** Authentication → Sign In / Providers → Email:
   - **«Allow new users to sign up» en OFF.** Las cuentas las crea solo el admin desde el panel.
   - **«Confirm email» en ON.** Verificarlo.

   La app lo controla: en Ajustes → Usuarios, con Iñaki logueado, aparece en verde si está bien y en rojo si no.
3. **URLs de Auth.** Authentication → URL Configuration:
   Site URL `https://harambeiskappa.github.io/Silo-Bolsa-LIVE/` y la misma en Redirect URLs (para "Me olvidé la contraseña").
4. **Cuenta de Iñaki.** Authentication → Users → Add user → Create new user (mail y contraseña, con **Auto Confirm User**).
   Después, en el SQL Editor, `04_primer_admin.sql` con su mail.
5. **Publicar.** En GitHub: Settings → Pages → Deploy from a branch → `main` / `(root)`.
6. **Latido.** Pestaña Actions → "Latido diario" → Run workflow, para ver que corre.

## Dar acceso a alguien

1. En la app: Ajustes → Usuarios → mail, nombre y rol → **Registrar el rol**. La app no manda mails ni crea cuentas.
2. En el panel de Supabase: Authentication → Users → Add user → **Create new user**, con ese mail, una contraseña
   provisoria y **Auto Confirm User** tildado.
3. Pasarle la contraseña. Entra con su rol y la cambia en Ajustes → Mi cuenta.

El rol registrado solo se aplica a una cuenta que nace con el mail confirmado (la que crea el admin así).
Cualquier otra cuenta nace **sin acceso**.

## Lo que no está en el repo

La fórmula de la dieta, los kg/día, el %MS de casa, los textos de origen de los coeficientes y la referencia
del portal **no están en el código**: el SQL los deja vacíos. Entran desde el relevamiento del 13/8
(Ajustes → Datos → "Cargar relevamiento o respaldo JSON") o a mano en Ajustes, y viven solo en la base.
Mientras no estén cargados, la app muestra `s/d` con su motivo.

## Roles

| Rol | Puede |
|---|---|
| `admin` | todo: cargar, importar, editar, anular, parámetros, usuarios |
| `auditor` | ver todo, auditar lotes y mediciones, cargar re-mediciones de auditoría |
| `lectura` | ver todo |
| `sin_acceso` | nada (así nace toda cuenta nueva hasta que el admin le da un rol) |

Los permisos los aplica la base (RLS), no la pantalla.

## Pruebas

Necesitan Node 20+, Python 3 con `openpyxl` y Chrome o Edge instalados. Leen los datos de la carpeta del proyecto
(fuera del repo) y escriben sus resultados en `pruebas/salida/` (ignorada por git).

```
cd pruebas
npm install
node e2e.mjs "../../datos" "./salida"
```

Para mirar la app contra el banco local a mano: `node servidor_prueba.mjs 8787` y abrir
`http://localhost:8787/?api=http://localhost:8787` (usuarios de prueba impresos en la consola).
