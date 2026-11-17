// Capturas de la fase 4: la app al lado de cada maqueta de diseno/v2,
// el celular a 375 px, la red cortada y los recursos externos.
//
//   node capturas.mjs "<carpeta datos>" "<carpeta diseno/v2>" "<carpeta de salida>"
//
// Arma en el banco el mismo estado que la base real (31/7 y 13/8 cargados,
// el silo del 13/8 vinculado, el lote del 11/11 con su revisión) y fotografía
// cada pestaña. Las maquetas son plantillas ({{ }}, <sc-for>, <sc-if>): las
// interpreta acá mismo con los datos que traen escritos.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearBanco, USUARIOS } from './servidor_prueba.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.resolve(process.argv[2] || path.join(AQUI, '../../datos'));
const DISENO = path.resolve(process.argv[3] || path.join(AQUI, '../../diseno/v2'));
const SALIDA = path.resolve(process.argv[4] || path.join(AQUI, 'salida-capturas'));
fs.mkdirSync(SALIDA, { recursive: true });
const NAVEGADOR = [process.env.NAVEGADOR, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((x) => x && fs.existsSync(x));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const resultados = [];
const anotar = (id, nombre, ok, evidencia) => { resultados.push({ id, nombre, ok: !!ok, evidencia }); console.log(`${ok ? 'OK  ' : 'FALLA'} [${id}] ${nombre}\n      ${JSON.stringify(evidencia).slice(0, 700)}`); };

// ── intérprete mínimo de las maquetas ──
function renderMaqueta(archivo) {
  const src = fs.readFileSync(archivo, 'utf8');
  const cuerpo = src.match(/<x-dc>([\s\S]*)<\/x-dc>/)[1].replace(/<helmet>[\s\S]*?<\/helmet>/, '');
  const estilo = (src.match(/<helmet>[\s\S]*?(<style>[\s\S]*?<\/style>)/) || [])[1] || '';
  const script = (src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/) || [])[1] || '';
  const vals = script ? new Function('DCLogic', script + '\nreturn new Component().renderVals();')(class {}) : {};
  const evalua = (expr, scope) => new Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope));
  const interp = (t, scope) => t
    .replace(/<sc-if value="\{\{([^}]*)\}\}"[^>]*>([\s\S]*?)<\/sc-if>/g, (_, e, b) => (evalua(e, scope) ? b : ''))
    .replace(/\{\{([^}]*)\}\}/g, (_, e) => { const v = evalua(e, scope); return v === undefined || v === null ? '' : String(v); });
  let html = cuerpo.replace(/<sc-for list="\{\{([^}]*)\}\}" as="([a-z]+)"[^>]*>([\s\S]*?)<\/sc-for>/g, (_, lista, nombre, b) =>
    (evalua(lista, vals) || []).map((item) => interp(b, { ...vals, [nombre]: item })).join(''));
  html = interp(html, vals);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">${estilo}</head><body>${html}</body></html>`;
}

const banco = await crearBanco();
const B = banco.url, APP = `${B}/?api=${B}`;
const sql = async (q, p = []) => (await banco.db.query(q, p)).rows;
const nav = await puppeteer.launch({ executablePath: NAVEGADOR, headless: true, args: ['--no-first-run'] });
async function entrar(usuario, ancho) {
  const c = await nav.createBrowserContext(); const p = await c.newPage();
  await p.setViewport(ancho === 375 ? { width: 375, height: 812, isMobile: true, hasTouch: true } : { width: ancho, height: 1000 });
  await p.goto(APP); await p.waitForSelector('#formLogin');
  await p.type('#lgEmail', USUARIOS[usuario].email); await p.type('#lgClave', USUARIOS[usuario].clave); await p.$eval('#btnEntrar', (e) => e.click());
  await p.waitForFunction(() => yo && !pantallaAuth); await listo(p); p.ctx = c; return p;
}
async function listo(p) { await p.waitForFunction(() => !cola.length && conexion !== 'guardando' && !vaciando && !cargando, { timeout: 30000 }); await espera(200); }
const ir = async (p, v, extra = '') => { await p.evaluate(new Function(`vista=${JSON.stringify(v)}; ${extra}; aviso=null; window.scrollTo(0,0); render();`)); await espera(250); };

// ── el estado de la base real ──
const iñaki = await entrar('admin', 1440);
await ir(iñaki, 'param');
for (const f of ['silobolsa_2026-07-31.json', 'silobolsa_2026-08-13.json']) {
  await (await iñaki.$('#fImp')).uploadFile(path.join(DATOS, f)); await iñaki.waitForSelector('#relOk');
  await iñaki.$eval('#relOk', (e) => e.click()); await listo(iñaki); await ir(iñaki, 'param');
}
const r13 = (await sql(`select id from relevamientos where fecha='2026-08-13'`))[0];
const tok = (await banco.sesionDe('admin')).access_token;
await fetch(`${B}/rest/v1/rpc/vincular_desde_relevamiento`, { method: 'POST', headers: { apikey: 'sb_publishable_fLwisrwlOO9Mv2_lwXguXg_L-btmbLu', Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_relevamiento: r13.id, p_alimento: 'MS', p_motivo: 'Confirmado por Iñaki: mismo orden que la hoja del 11/11' }) });
await iñaki.evaluate(() => recargar()); await listo(iñaki);
// la revisión del 11/11 (Carga), antes de confirmar: es la pantalla de Revision2
await ir(iñaki, 'carga', 'cargaModo=null');
await (await iñaki.$('#fPlanilla')).uploadFile(...fs.readdirSync(DATOS).filter((f) => /_2026-11-11\.csv$/.test(f)).map((f) => path.join(DATOS, f)));
await iñaki.waitForSelector('#revOk');
await iñaki.evaluate(() => { filtroRev = 'confirmar'; render(); }); await iñaki.$eval('#revQuien', (e) => { e.value = 'Silvana'; e.dispatchEvent(new Event('input')); });
const CAP = {};
CAP.carga = path.join(SALIDA, 'app-1440-carga.png'); await iñaki.screenshot({ path: CAP.carga, fullPage: true });
for (let i = 0; i < 10; i++) { const cb = await iñaki.$('input[data-rv="confirmado"]:not(:checked)'); if (!cb) break; await cb.evaluate((e) => e.click()); await espera(100); }
await iñaki.$eval('#revOk', (e) => e.click()); await listo(iñaki);

// ── 1440 px: las seis pestañas ──
await ir(iñaki, 'panel'); CAP.panel = path.join(SALIDA, 'app-1440-panel.png'); await iñaki.screenshot({ path: CAP.panel, fullPage: true });
const mg14 = (await sql(`select id from bolsones where etiqueta='MG14'`))[0].id;
await ir(iñaki, 'mapa', `selMapa=${JSON.stringify(mg14)}`); CAP.mapa = path.join(SALIDA, 'app-1440-plano.png'); await iñaki.screenshot({ path: CAP.mapa, fullPage: true });
const ms1 = (await sql(`select id from bolsones where etiqueta='MS1'`))[0].id;
await ir(iñaki, 'ficha', `fichaId=${JSON.stringify(ms1)}`); CAP.ficha = path.join(SALIDA, 'app-1440-bolsones-ficha.png'); await iñaki.screenshot({ path: CAP.ficha, fullPage: true });
await ir(iñaki, 'ficha', 'fichaId=null'); CAP.lista = path.join(SALIDA, 'app-1440-bolsones-lista.png'); await iñaki.screenshot({ path: CAP.lista, fullPage: true });
const lote = (await sql(`select id from importaciones where tipo='planilla'`))[0].id;
await ir(iñaki, 'auditoria', `auditLote=${JSON.stringify(lote)}`); CAP.auditoria = path.join(SALIDA, 'app-1440-auditoria.png'); await iñaki.screenshot({ path: CAP.auditoria, fullPage: true });
await ir(iñaki, 'param'); CAP.ajustes = path.join(SALIDA, 'app-1440-ajustes.png'); await iñaki.screenshot({ path: CAP.ajustes, fullPage: true });

// ── maquetas renderizadas y lado a lado ──
const pares = [['Panel2', CAP.panel], ['Mapa2', CAP.mapa], ['Revision2', CAP.carga], ['Ficha2', CAP.ficha], ['Auditoria2', CAP.auditoria]];
const pm = await (await nav.createBrowserContext()).newPage(); await pm.setViewport({ width: 1440, height: 1000 });
const lado = [];
for (const [nombre, app] of pares) {
  const mq = path.join(SALIDA, `maqueta-${nombre}.png`);
  await pm.setContent(renderMaqueta(path.join(DISENO, `${nombre}.dc.html`)), { waitUntil: 'load' }); await pm.screenshot({ path: mq, fullPage: true });
  const comp = path.join(SALIDA, `lado-a-lado-${nombre}.png`);
  const b64 = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  await pm.setContent(`<body style="margin:0;display:flex;gap:16px;background:#cfd6e2;font:600 16px sans-serif;align-items:flex-start;padding:16px">
    <div style="width:1440px"><div style="padding:6px 0">Maqueta ${nombre} (diseno/v2)</div><img src="${b64(mq)}" style="width:1440px"></div>
    <div style="width:1440px"><div style="padding:6px 0">App (banco, mismos datos)</div><img src="${b64(app)}" style="width:1440px"></div></body>`, { waitUntil: 'load' });
  await pm.setViewport({ width: 2928, height: 1000 }); await pm.screenshot({ path: comp, fullPage: true }); await pm.setViewport({ width: 1440, height: 1000 });
  lado.push(comp);
}
anotar('2', 'Capturas a 1440 px de las 6 pestañas, y cada una al lado de su maqueta', lado.length === 5 && Object.keys(CAP).length === 7,
  { app: Object.values(CAP).map((x) => path.basename(x)), lado_a_lado: lado.map((x) => path.basename(x)), ajustes: 'sin maqueta (no hay diseño de Ajustes)' });

// ── 3 · sin recursos externos ──
const html = fs.readFileSync(path.join(AQUI, '../index.html'), 'utf8');
const externos = [...html.matchAll(/https:\/\/[^\s"'`)<>]+/g)].map((m) => m[0]).filter((u) => !u.startsWith('https://ckvsiwiizwdrvrpuucxa.supabase.co'));
const httpPlanos = [...new Set([...html.matchAll(/http:\/\/[^\s"'`)<>]+/g)].map((m) => m[0]))];
const pedidos = [];
const pr = await (await nav.createBrowserContext()).newPage(); await pr.setViewport({ width: 1440, height: 1000 });
pr.on('request', (q) => { const u = q.url(); if (!u.startsWith(B) && !u.startsWith('data:')) pedidos.push(u); });
await pr.goto(APP); await pr.waitForSelector('#formLogin');
await pr.type('#lgEmail', USUARIOS.admin.email); await pr.type('#lgClave', USUARIOS.admin.clave); await pr.$eval('#btnEntrar', (e) => e.click());
await pr.waitForFunction(() => yo && !pantallaAuth); await listo(pr);
const enLinea = await pr.screenshot({ fullPage: true });
await pr.setOfflineMode(true); await pr.evaluate(() => render()); await espera(400);
const sinRed = await pr.screenshot({ fullPage: true });
const fuentes = await pr.evaluate(() => [...document.fonts].map((x) => x.family + ' ' + x.status));
await pr.setOfflineMode(false);
fs.writeFileSync(path.join(SALIDA, 'red-en-linea.png'), enLinea); fs.writeFileSync(path.join(SALIDA, 'red-cortada.png'), sinRed);
// lo único que cambia con la red cortada es el indicador de guardado de la cabecera: se compara todo lo demás
const igual = await (async () => {
  const pc = await (await nav.createBrowserContext()).newPage(); await pc.setViewport({ width: 1440, height: 1000 });
  const dif = await pc.evaluate(async (a, b) => {
    const carga = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = s; });
    const [x, y] = await Promise.all([carga(a), carga(b)]);
    if (x.width !== y.width || x.height !== y.height) return { tam: [x.width, x.height, y.width, y.height] };
    const cv = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const d1 = cv(x), d2 = cv(y); let distintos = 0, fuera = 0;
    for (let k = 0; k < d1.length; k += 4) if (d1[k] !== d2[k] || d1[k + 1] !== d2[k + 1] || d1[k + 2] !== d2[k + 2]) { distintos++; if (Math.floor(k / 4 / x.width) >= 56) fuera++; }
    return { distintos, fuera_de_la_cabecera: fuera };
  }, 'data:image/png;base64,' + enLinea.toString('base64'), 'data:image/png;base64,' + sinRed.toString('base64'));
  return dif;
})();
anotar('3', 'Sin recursos externos: cero https:// fuera de Supabase, ningún pedido afuera, y con la red cortada se ve igual (salvo el indicador de la cabecera)',
  externos.length === 0 && pedidos.length === 0 && igual.fuera_de_la_cabecera === 0,
  { https_fuera_de_supabase: externos, http_sin_s_que_no_se_descargan: httpPlanos, pedidos_a_otros_servidores: pedidos, pixeles_distintos: igual, fuentes_cargadas: fuentes });

// ── 4 · celular a 375 px ──
const MEDIR = () => {
  const sel = 'button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), textarea, summary, a[href], label.tap, label.chip, tr.cl, [role=button]';
  const visible = (e) => e.offsetParent || getComputedStyle(e).position === 'fixed';
  const malos = []; let total = 0;
  document.querySelectorAll(sel).forEach((e) => { if (!visible(e)) return; const r = e.getBoundingClientRect(); if (!r.width) return; total++;
    if (r.height < 43.5 || r.width < 43.5) malos.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} ${Math.round(r.width)}×${Math.round(r.height)} «${(e.innerText || e.value || e.placeholder || '').trim().slice(0, 24)}»`); });
  document.querySelectorAll('input[type=checkbox]').forEach((e) => { if (!visible(e)) return; total++; const l = e.closest('label'); const r = (l || e).getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) malos.push(`casilla ${l ? 'en etiqueta' : 'suelta'} ${Math.round(r.width)}×${Math.round(r.height)}`); });
  // scroll horizontal fuera de las tablas: algo más ancho que la pantalla que no esté dentro de un contenedor con scroll propio
  const anchos = [...document.querySelectorAll('#pantalla *')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 && !e.closest('.tabla'); })
    .slice(0, 5).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
  return { total, malos, ancho_documento: document.documentElement.scrollWidth, desbordan: anchos };
};
const movil = {};
const cel = await entrar('admin', 375);
for (const [n, v, extra] of [['panel', 'panel', ''], ['plano', 'mapa', `selMapa=${JSON.stringify(mg14)}`], ['auditoria', 'auditoria', `auditLote=${JSON.stringify(lote)}`], ['mas', 'mas', '']]) {
  await ir(cel, v, extra); movil[n] = await cel.evaluate(MEDIR); await cel.screenshot({ path: path.join(SALIDA, `app-375-${n}.png`), fullPage: true });
}
// la revisión a 375: se reimporta el 11/11 (no se confirma)
await ir(cel, 'carga', 'cargaModo=null');
await (await cel.$('#fPlanilla')).uploadFile(...fs.readdirSync(DATOS).filter((f) => /_2026-11-11\.csv$/.test(f)).map((f) => path.join(DATOS, f)));
await cel.waitForSelector('#revOk'); await cel.evaluate(() => { filtroRev = 'todos'; render(); });
movil.carga_revision = await cel.evaluate(MEDIR); await cel.screenshot({ path: path.join(SALIDA, 'app-375-carga-revision.png'), fullPage: true });
await cel.$eval('#revCancel', (e) => e.click());
const malos = Object.values(movil).flatMap((x) => x.malos), desb = Object.values(movil).flatMap((x) => x.desbordan);
anotar('4', 'Celular a 375 px: Panel, Carga (revisión), Plano y Auditoría sin scroll horizontal fuera de las tablas y ningún control de menos de 44 px',
  malos.length === 0 && desb.length === 0 && Object.values(movil).every((x) => x.ancho_documento <= 375),
  { controles_medidos: Object.fromEntries(Object.entries(movil).map(([k, v]) => [k, v.total])), de_menos_de_44px: malos, desbordan: desb,
    ancho_documento: Object.fromEntries(Object.entries(movil).map(([k, v]) => [k, v.ancho_documento])) });

fs.writeFileSync(path.join(SALIDA, 'resultados-capturas.json'), JSON.stringify(resultados, null, 1));
await nav.close(); await banco.cerrar();
process.exit(resultados.every((r) => r.ok) ? 0 : 1);
