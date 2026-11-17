// Banco de pruebas local: un Postgres de verdad (PGlite, en memoria) con los
// archivos ../supabase/01..03 tal cual, detrás de un servidor que imita las
// partes de la API de Supabase que usa la app (PostgREST + Auth).
// Cada pedido corre en una transacción con el rol de quien llama (anon o
// authenticated) y su id en request.jwt.claims, igual que en Supabase: así
// la RLS que se prueba acá es la misma que va a correr allá.
//
// Uso suelto:  node servidor_prueba.mjs 8787   → abre http://localhost:8787/?api=http://localhost:8787
import { PGlite } from '@electric-sql/pglite';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
export const CLAVE_PUBLICA = 'sb_publishable_fLwisrwlOO9Mv2_lwXguXg_L-btmbLu';
const SECRETO = crypto.randomBytes(16).toString('hex');

export const USUARIOS = {
  admin:   { email: 'inaki@prueba.local',   clave: 'clave-inaki-1',   nombre: 'Iñaki',   rol: 'admin' },
  auditor: { email: 'nico@prueba.local',    clave: 'clave-nico-1',    nombre: 'Nico',    rol: 'auditor' },
  lectura: { email: 'silvana@prueba.local', clave: 'clave-silvana-1', nombre: 'Silvana', rol: 'lectura' },
  extrano: { email: 'otro@prueba.local',    clave: 'clave-otro-1',    nombre: '',        rol: null },
};

const b64u = (x) => Buffer.from(x).toString('base64url');
function firmar(payload) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', SECRETO).update(h + '.' + p).digest('base64url');
  return `${h}.${p}.${s}`;
}
function verificar(tok) {
  const [h, p, s] = String(tok || '').split('.');
  if (!s) return null;
  const ok = crypto.createHmac('sha256', SECRETO).update(h + '.' + p).digest('base64url');
  if (ok !== s) return null;
  const pl = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (pl.exp && pl.exp * 1000 < Date.now()) return { vencido: true };
  return pl;
}

export async function crearBase() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(AQUI, 'shim_supabase.sql'), 'utf8'));
  for (const f of ['01_esquema.sql', '02_seguridad.sql', '03_funciones.sql', '05_vincular_relevamiento.sql', '06_auditoria_compartida.sql'])
    await db.exec(fs.readFileSync(path.join(RAIZ, 'supabase', f), 'utf8'));
  return db;
}

export async function crearBanco({ puerto = 0, usuarios = USUARIOS, db = null } = {}) {
  db = db || await crearBase();
  const ids = {};
  for (const [k, u] of Object.entries(usuarios)) {
    if (u.rol) await db.query('insert into public.invitaciones (email, nombre, rol) values ($1,$2,$3) on conflict do nothing', [u.email, u.nombre, u.rol]);
    // como "Create new user" + "Auto Confirm User" en el panel: el mail nace confirmado
    const r = await db.query('insert into auth.users (email, encrypted_password, email_confirmed_at) values ($1,$2,now()) returning id', [u.email, u.clave]);
    ids[k] = r.rows[0].id;
  }
  const refresh = new Map(), mails = [];
  // configuración de Auth del proyecto imitado; la prueba la cambia para ver los dos casos
  const config = { disable_signup: false, mailer_autoconfirm: false };
  let cadena = Promise.resolve();
  const enSerie = (fn) => { const p = cadena.then(fn, fn); cadena = p.catch(() => {}); return p; };

  function sesion(user) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access_token = firmar({ sub: user.id, email: user.email, role: 'authenticated', exp });
    const refresh_token = crypto.randomBytes(12).toString('hex');
    refresh.set(refresh_token, user);
    return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token, user: { id: user.id, email: user.email } };
  }

  // corre SQL como un usuario de la app (o anon si uid es null)
  async function comoUsuario(uid, fn) {
    return enSerie(() => db.transaction(async (tx) => {
      await tx.exec(`set local role ${uid ? 'authenticated' : 'anon'}`);
      const claims = uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : JSON.stringify({ role: 'anon' });
      await tx.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [claims, uid || '']);
      return fn(tx);
    }));
  }

  const COL = /^[a-z_][a-z0-9_]*$/;
  function filtros(q, params, alias = '') {
    const a = alias ? alias + '.' : '';
    const w = [];
    for (const [k, v] of q) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      if (!COL.test(k)) throw Object.assign(new Error('columna inválida'), { code: '42703' });
      if (v.startsWith('eq.')) { params.push(v.slice(3)); w.push(`${a}${k}::text = $${params.length}`); }
      else if (v === 'is.null') w.push(`${a}${k} is null`);
      else if (v.startsWith('in.(')) { const xs = v.slice(4, -1).split(','); params.push(xs); w.push(`${a}${k}::text = any($${params.length})`); }
      else throw Object.assign(new Error('operador no soportado en el banco: ' + v), { code: '42883' });
    }
    return w.length ? ' where ' + w.join(' and ') : '';
  }
  function estadoDe(e, anon) {
    const c = String(e.code || '');
    if (c.startsWith('PT')) return parseInt(c.slice(2), 10) || 400;
    if (c === '42501') return anon ? 401 : 403;
    if (c === '23505' || c === '23503') return 409;
    if (c === '42883' || c === '42P01') return 404;
    return 400;
  }

  async function rest(req, url, cuerpo, uid) {
    const partes = url.pathname.replace(/^\/rest\/v1\//, '').split('/');
    const q = url.searchParams;
    if (partes[0] === 'rpc') {
      const fn = partes[1];
      if (!COL.test(fn)) throw Object.assign(new Error('función inválida'), { code: '42883' });
      const meta = await db.query(`select p.proretset, p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes) t) as tipos
                                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                    where n.nspname = 'public' and p.proname = $1`, [fn]);
      if (!meta.rows.length) throw Object.assign(new Error(`Could not find the function public.${fn}`), { code: 'PGRST202', status: 404 });
      const { proretset, proargnames, tipos } = meta.rows[0];
      const args = [], params = [];
      for (const [k, v] of Object.entries(cuerpo || {})) {
        const i = (proargnames || []).indexOf(k);
        if (i < 0) throw Object.assign(new Error(`argumento desconocido ${k}`), { code: 'PGRST202', status: 404 });
        params.push(v === null || v === undefined ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
        args.push(`${k} => $${params.length}::${tipos[i]}`);
      }
      const llamada = `public.${fn}(${args.join(', ')})`;
      const sql = proretset ? `select coalesce(json_agg(r), '[]'::json) as r from ${llamada} r` : `select to_json(${llamada}) as r`;
      const r = await comoUsuario(uid, (tx) => tx.query(sql, params));
      return { status: 200, json: r.rows[0].r };
    }
    const tabla = partes[0];
    if (!COL.test(tabla)) throw Object.assign(new Error('tabla inválida'), { code: '42P01' });
    const params = [];
    if (req.method === 'GET') {
      let sql = `select * from public.${tabla}` + filtros(q, params);
      if (q.get('order')) { const [c, d] = q.get('order').split('.'); if (!COL.test(c)) throw new Error('orden'); sql += ` order by ${c} ${d === 'desc' ? 'desc' : 'asc'}`; }
      if (q.get('limit')) sql += ` limit ${parseInt(q.get('limit'), 10)}`;
      if (q.get('offset')) sql += ` offset ${parseInt(q.get('offset'), 10)}`;
      const r = await comoUsuario(uid, (tx) => tx.query(`select coalesce(json_agg(t), '[]'::json) as r from (${sql}) t`, params));
      return { status: 200, json: r.rows[0].r };
    }
    const repr = /return=representation/.test(req.headers['prefer'] || '');
    if (req.method === 'POST') {
      const filas = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
      const cols = [...new Set(filas.flatMap(Object.keys))].filter((c) => COL.test(c));
      params.push(JSON.stringify(filas));
      const sql = `insert into public.${tabla} (${cols.join(',')}) select ${cols.join(',')} from json_populate_recordset(null::public.${tabla}, $1) returning *`;
      const r = await comoUsuario(uid, (tx) => tx.query(`with x as (${sql}) select coalesce(json_agg(x), '[]'::json) as r from x`, params));
      return { status: 201, json: repr ? r.rows[0].r : undefined };
    }
    if (req.method === 'PATCH') {
      const cols = Object.keys(cuerpo).filter((c) => COL.test(c));
      params.push(JSON.stringify(cuerpo));
      const set = cols.map((c) => `${c} = j.${c}`).join(', ');
      const w = filtros(q, params, 't');
      const sql = `update public.${tabla} t set ${set} from json_populate_record(null::public.${tabla}, $1) j ${w} returning t.*`;
      const r = await comoUsuario(uid, (tx) => tx.query(`with x as (${sql}) select coalesce(json_agg(x), '[]'::json) as r from x`, params));
      return { status: repr ? 200 : 204, json: repr ? r.rows[0].r : undefined };
    }
    if (req.method === 'DELETE') {
      const sql = `delete from public.${tabla}` + filtros(q, params) + ' returning *';
      const r = await comoUsuario(uid, (tx) => tx.query(`with x as (${sql}) select coalesce(json_agg(x), '[]'::json) as r from x`, params));
      return { status: repr ? 200 : 204, json: repr ? r.rows[0].r : undefined };
    }
    return { status: 405, json: { message: 'método' } };
  }

  async function auth(req, url, cuerpo, pl) {
    const p = url.pathname.replace(/^\/auth\/v1\//, '');
    const gt = url.searchParams.get('grant_type');
    const redirect = url.searchParams.get('redirect_to') || '';
    if (p === 'settings') return { status: 200, json: { ...config } };
    if (p === 'signup') {
      // alta libre: como en Supabase, la cuenta nace SIN confirmar (salvo que "Confirm email" esté apagado)
      if (config.disable_signup) return { status: 422, json: { error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' } };
      const r = await db.query(`insert into auth.users (email, encrypted_password, email_confirmed_at) values (lower($1), $2, ${config.mailer_autoconfirm ? 'now()' : 'null'})
                                on conflict (email) do nothing returning id, email`, [cuerpo.email || '', cuerpo.password || '']);
      return { status: 200, json: r.rows[0] || {} };
    }
    if (p === 'token' && gt === 'password') {
      const r = await db.query('select id, email from auth.users where email = lower($1) and encrypted_password = $2', [cuerpo.email || '', cuerpo.password || '']);
      if (!r.rows.length) return { status: 400, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
      return { status: 200, json: sesion(r.rows[0]) };
    }
    if (p === 'token' && gt === 'refresh_token') {
      const u = refresh.get(cuerpo.refresh_token);
      if (!u) return { status: 400, json: { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } };
      refresh.delete(cuerpo.refresh_token);
      return { status: 200, json: sesion(u) };
    }
    if (p === 'user') {
      if (!pl || pl.vencido) return { status: 401, json: { msg: 'JWT expired' } };
      if (req.method === 'PUT' && cuerpo.password) await db.query('update auth.users set encrypted_password = $1 where id = $2', [cuerpo.password, pl.sub]);
      return { status: 200, json: { id: pl.sub, email: pl.email } };
    }
    if (p === 'logout') return { status: 204 };
    if (p === 'otp' || p === 'recover') {
      const email = String(cuerpo.email || '').toLowerCase();
      let r = await db.query('select id, email from auth.users where email = $1', [email]);
      if (!r.rows.length && p === 'otp' && cuerpo.create_user && !config.disable_signup)
        r = await db.query("insert into auth.users (email, encrypted_password) values ($1, '') returning id, email", [email]);
      if (r.rows.length) {
        const s = sesion(r.rows[0]);
        mails.push({ email, tipo: p === 'otp' ? 'magiclink' : 'recovery',
          link: `${redirect}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer&type=${p === 'otp' ? 'magiclink' : 'recovery'}` });
      }
      return { status: 200, json: {} };
    }
    return { status: 404, json: { msg: 'no implementado en el banco: ' + p } };
  }

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, range',
                   'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(RAIZ, 'index.html')));
    }
    let txt = ''; for await (const c of req) txt += c;
    let cuerpo = null; try { cuerpo = txt ? JSON.parse(txt) : null; } catch { }
    const enviar = (status, json) => {
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    if (req.headers['apikey'] !== CLAVE_PUBLICA) return enviar(401, { message: 'No API key found in request' });
    const tok = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const pl = tok && tok !== CLAVE_PUBLICA ? verificar(tok) : null;
    try {
      if (url.pathname.startsWith('/auth/v1/')) { const r = await auth(req, url, cuerpo || {}, pl); return enviar(r.status, r.json); }
      if (url.pathname.startsWith('/rest/v1/')) {
        if (pl && pl.vencido) return enviar(401, { code: 'PGRST301', message: 'JWT expired' });
        const r = await rest(req, url, cuerpo, pl ? pl.sub : null);
        return enviar(r.status, r.json);
      }
      return enviar(404, { message: 'no encontrado' });
    } catch (e) {
      return enviar(e.status || estadoDe(e, !pl), { code: e.code || null, message: e.message, details: e.detail || null, hint: e.hint || null });
    }
  });
  await new Promise((ok) => servidor.listen(puerto, '127.0.0.1', ok));
  const url = `http://localhost:${servidor.address().port}`;
  return { db, url, ids, mails, config, comoUsuario, cerrar: () => new Promise((ok) => servidor.close(ok)),
           sesionDe: async (k) => sesion({ id: ids[k], email: usuarios[k].email }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const b = await crearBanco({ puerto: +(process.argv[2] || 8787) });
  console.log(`Banco listo: ${b.url}/?api=${b.url}`);
  for (const u of Object.values(USUARIOS)) console.log(`  ${u.email} / ${u.clave}  (${u.rol || 'sin acceso'})`);
}
