// Prueba de punta a punta de la fase 3 contra el banco local.
// Maneja la app real (index.html) en Edge/Chrome sin ventana, con los
// datos reales de la carpeta del proyecto (FUERA del repo).
//
//   node e2e.mjs "<carpeta datos>" "<carpeta de salida>"
//
// Escribe en la carpeta de salida: resultados.json, capturas a 375 px y
// los archivos que la app descarga (respaldo JSON).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crearBanco, USUARIOS, CLAVE_PUBLICA } from './servidor_prueba.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.resolve(process.argv[2] || path.join(AQUI, '../../datos'));
const SALIDA = path.resolve(process.argv[3] || path.join(AQUI, 'salida'));
fs.mkdirSync(SALIDA, { recursive: true });
const NAVEGADOR = [
  process.env.NAVEGADOR,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((x) => x && fs.existsSync(x));

// Todo valor esperado sale de los archivos de datos al correr: el repo no lleva ni un número medido.
const leerCsvDatos = (f) => { const [h, ...rs] = fs.readFileSync(path.join(DATOS, f), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(';'));
  return rs.map((x) => Object.fromEntries(h.map((k, i) => [k, x[i]]))); };
const CSV = leerCsvDatos(fs.readdirSync(DATOS).find((f) => /^mediciones_.*\.csv$/.test(f)));
const MSCSV = leerCsvDatos(fs.readdirSync(DATOS).find((f) => /^materia_seca_.*\.csv$/.test(f)));
const J13 = JSON.parse(fs.readFileSync(path.join(DATOS, 'silobolsa_2026-08-13.json'), 'utf8'));
const PY = JSON.parse(execFileSync('python', ['-I', path.join(AQUI, 'totales.py'), DATOS], { encoding: 'utf8' }));
const metrosDe = (et) => Number(CSV.find((x) => x.etiqueta === et).metros_restantes);
const nAli = (a) => CSV.filter((x) => x.alimento === a).length;
const es1 = (x) => Number(x).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pctTxt = (v) => { const x = Math.round(v * 10) / 10; return (x % 1 ? es1(x) : String(x)) + ' %'; };
const cotaDe = (i) => { const f = MSCSV[i], ks = Object.keys(f).filter((k) => /^peso_\d+min/.test(k));
  return '≤ ' + pctTxt(Number(f[ks[ks.length - 1]]) / Number(f.peso_inicial_g) * 100); };
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VIEJO = (() => { const j = JSON.parse(fs.readFileSync(path.join(DATOS, 'mediciones.json'), 'utf8')); const bs = j.sesiones[0].bolsones;
  return { tramos: bs.length, bolsones: new Set(bs.map((b) => b.grupo || b.id)).size, metros: bs.reduce((s, b) => s + (b.metros || 0), 0) }; })();
// cuánto cambió cada bolsón de silo entre el 13/8 y el 11/11 (de los archivos)
const DELTAS_MS = CSV.filter((x) => x.alimento === 'MS').map((x) => {
  const m13 = J13.mediciones.find((m) => m.bolson_id === x.etiqueta);
  return { et: x.etiqueta, d: Math.round((Number(x.metros_restantes) - Number(m13.metros_restantes)) * 10) / 10 };
});
const N_DIF = DELTAS_MS.filter((x) => x.d > 0.5).length, N_RES = DELTAS_MS.filter((x) => x.d > 0 && x.d <= 0.5).length;
// controles táctiles visibles de menos de 44 × 44 px (las casillas se miden por su etiqueta)
const MEDIR = () => {
  const sel = 'button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), summary, a[href], label.tap, label.chip, tr.cl';
  const visible = (e) => e.offsetParent || getComputedStyle(e).position === 'fixed';
  const nombre = (e, r) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} ${Math.round(r.width)}×${Math.round(r.height)} «${(e.innerText || e.value || e.placeholder || '').trim().slice(0, 24)}»`;
  const malos = []; let total = 0;
  document.querySelectorAll(sel).forEach((e) => { if (!visible(e)) return; const r = e.getBoundingClientRect(); if (!r.width) return; total++;
    if (r.height < 43.5 || r.width < 43.5) malos.push(nombre(e, r)); });
  document.querySelectorAll('input[type=checkbox]').forEach((e) => { if (!visible(e)) return; total++; const l = e.closest('label'); const r = (l || e).getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) malos.push(`casilla ${l ? 'en etiqueta' : 'suelta'} ${Math.round(r.width)}×${Math.round(r.height)}`); });
  return { total, malos };
};
const resultados = [];
function anotar(id, nombre, ok, evidencia) {
  resultados.push({ id, nombre, ok: !!ok, evidencia });
  console.log(`${ok ? 'OK  ' : 'FALLA'} [${id}] ${nombre}\n      ${JSON.stringify(evidencia).slice(0, 900)}`);
}
async function paso(id, nombre, fn) {
  try { await fn(); } catch (e) { anotar(id, nombre, false, { error: String(e && e.stack || e).slice(0, 1500) }); }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const banco = await crearBanco();
const B = banco.url, APP = `${B}/?api=${B}`;
const sql = async (q, p = []) => (await banco.db.query(q, p)).rows;
const navegador = await puppeteer.launch({ executablePath: NAVEGADOR, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });

async function abrir(usuario, { ancho = 1100, ctx = null } = {}) {
  const c = ctx || await navegador.createBrowserContext();
  const page = await c.newPage();
  await page.setViewport({ width: ancho, height: 900 });
  page.on('pageerror', (e) => console.log('  [error en la página]', e.message));
  page.on('dialog', async (d) => { console.log('  [DIÁLOGO NATIVO!]', d.message()); await d.dismiss(); });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#formLogin');
  const u = USUARIOS[usuario];
  await page.type('#lgEmail', u.email); await page.type('#lgClave', u.clave);
  await page.click('#btnEntrar');
  await page.waitForFunction(() => typeof yo !== 'undefined' && yo && !pantallaAuth, { timeout: 15000 });
  await listo(page);
  page.ctx = c;
  return page;
}
async function listo(page) {
  await page.waitForFunction(() => !cola.length && conexion !== 'guardando' && !vaciando && !cargando, { timeout: 30000 });
  await espera(150);
}
async function ir(page, vistaNombre) { try { await page.click(`nav button[data-p="${vistaNombre}"]`); } catch (e) { const info = await page.$eval(`nav button[data-p="${vistaNombre}"]`, (b) => ({ cls: b.className, disp: getComputedStyle(b).display, navDisp: getComputedStyle(b.parentElement).display, w: innerWidth, vista, anchos: [...document.querySelectorAll("body *")].filter((x) => x.getBoundingClientRect().right > 380).slice(0, 8).map((x) => x.tagName + "." + x.className + "#" + x.id + " " + Math.round(x.getBoundingClientRect().right) + " " + (x.innerText || "").slice(0, 40)) })); throw new Error(`no pude tocar la pestaña ${vistaNombre}: ${JSON.stringify(info)}`); } await espera(100); }
async function textoPantalla(page) { return page.$eval('#pantalla', (e) => e.innerText); }
async function subir(page, selector, archivos) {
  const el = await page.$(selector);
  await el.uploadFile(...archivos);
  await espera(400);
}
async function rest(metodo, ruta, { token = null, cuerpo } = {}) {
  const h = { apikey: CLAVE_PUBLICA, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(B + ruta, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { }
  return { status: r.status, j };
}
const fmt = (x) => Number(x).toFixed(1);
async function bloqueos(page) { return page.evaluate(() => { const e = document.querySelector('#revBloqueos'); return e ? e.innerText : ''; }); }
async function modalOk(page) { await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await espera(200); }
async function llenarModal(page, valores) {
  await page.waitForSelector('[data-mc]');
  for (const [k, v] of Object.entries(valores)) {
    await page.$eval(`[data-mc="${k}"]`, (e, v) => { e.value = v; }, v);
  }
  await modalOk(page);
}

// ═══════════ 1 · MIGRACIÓN: relevamientos históricos ═══════════
const admin = await abrir('admin');
let lote1 = null;
await paso('A', 'La fórmula de la dieta no viaja en el repo', async () => {
  await ir(admin, 'panel');
  const t = await textoPantalla(admin);
  const dieta = t.match(/Materia seca[\s\S]{0,700}/)?.[0] || '';
  const fuentes = ['index.html', 'README.md', 'supabase/01_esquema.sql', 'supabase/02_seguridad.sql', 'supabase/03_funciones.sql', 'supabase/04_primer_admin.sql',
                   '.github/workflows/latido.yml'].map((f) => fs.readFileSync(path.join(AQUI, '..', f), 'utf8')).join(String.fromCharCode(10));
  const prop = J13.dieta.proporciones;
  const patrones = Object.entries(prop).flatMap(([k, v]) => [`${k}:${v}`, `"${k}":${v}`, `${k}: ${v}`, `"${k}": ${v}`]);
  const hallados = [
    ...patrones.filter((x) => fuentes.includes(x)),
    ...[J13.dieta.kg_dia_min, J13.dieta.kg_dia_max].map(String).filter((x) => fuentes.includes(x)),
    ...[J13.dieta.origen, ...Object.values(J13.alimentos).flatMap((a) => [a.origen_kgm, a.origen_ms])].filter((x) => x && x.length > 12)
      .map((x) => x.slice(0, 40)).filter((x) => fuentes.includes(x)),
  ];
  anotar('A1', 'Sin la fórmula cargada, el control de la dieta muestra s/d con su motivo', /Teórico\s+s\/d[\s\S]*MS por día\s+s\/d[\s\S]*la fórmula de la dieta no está cargada/i.test(dieta), { pantalla: dieta.slice(0, 300) });
  anotar('A2', 'Ni la fórmula, ni los kg/día, ni los textos de origen del JSON del 13/8 aparecen en el código', hallados.length === 0,
    { buscados: { pares_de_la_formula: patrones.length, kg_dia: 2, textos_de_origen: [J13.dieta.origen, ...Object.values(J13.alimentos).flatMap((a) => [a.origen_kgm, a.origen_ms])].filter((x) => x && x.length > 12).length }, hallados });
});

await paso('1', 'Migración exacta (relevamientos 31/7 y 13/8)', async () => {
  await ir(admin, 'param');
  await subir(admin, '#fImp', [path.join(DATOS, 'silobolsa_2026-07-31.json')]);
  await admin.waitForSelector('#relOk');
  const t31 = await textoPantalla(admin);
  await admin.click('#relOk'); await listo(admin);
  await ir(admin, 'param');
  await subir(admin, '#fImp', [path.join(DATOS, 'silobolsa_2026-08-13.json')]);
  await admin.waitForSelector('[data-relvivo="MS"]');
  const t13 = await textoPantalla(admin);
  const propuestos = await admin.evaluate(() => [...document.querySelectorAll('[data-relpar]')].map((e) => e.dataset.relpar + ':' + (e.checked ? 'sí' : 'no')));
  // F3: la casilla viene apagada, pero si la numeración coincide con la última hoja conocida, se avisa al lado
  const casillas = await admin.evaluate(() => [...document.querySelectorAll('[data-relvivo]')].map((e) => ({
    alimento: e.dataset.relvivo, tildada: e.checked, aviso: ((e.closest('label').querySelector('.marca') || {}).innerText || '').replace(/\s+/g, ' ') })));
  const msNum = J13.bolsones.filter((b) => b.alimento === 'MS').map((b) => b.id).join(', ');
  anotar('F3', 'Revisión del 13/8: la casilla de Maíz Silo viene apagada, pero avisa que su numeración coincide con la hoja del 31/7',
    casillas.every((c) => !c.tildada) && /coincide con la hoja del relevamiento del 31\/07\/2026/.test((casillas.find((c) => c.alimento === 'MS') || {}).aviso || '')
      && (casillas.find((c) => c.alimento === 'MS').aviso.includes(msNum)) && !(casillas.find((c) => c.alimento === 'MG') || {}).aviso,
    { casillas });
  // como en la base real: NO se tilda Maíz Silo
  await admin.click('#relOk'); await listo(admin);
  const dietaBase = (await sql(`select valor from parametros where clave='dieta'`))[0].valor;
  const alimBase = (await sql(`select valor from parametros where clave='alimentos'`))[0].valor;
  anotar('A3', 'La fórmula entra desde el JSON del 13/8, propuesta en la revisión, y queda solo en la base',
    propuestos.includes('dieta:sí') && Object.entries(J13.dieta.proporciones).every(([k, v]) => dietaBase.proporciones[k] === v) && Object.keys(dietaBase.proporciones).length === Object.keys(J13.dieta.proporciones).length &&
    propuestos.includes('alimentos:sí') && Object.keys(J13.alimentos).every((k) => alimBase[k] && alimBase[k].ms_pct === J13.alimentos[k].ms_pct) && !!alimBase.MS.fuera_de_alcance,
    { casillas_propuestas_13_8: propuestos, proporciones_en_la_base: dietaBase.proporciones,
      alimentos_en_la_base: Object.keys(alimBase), ms_de_casa_en_la_base: Object.fromEntries(Object.entries(alimBase).map(([k, v]) => [k, v.ms_pct])) });
  const tot = await sql(`select r.fecha::text, i.alimento, sum(i.metros)::text as m, count(*) as n, count(i.metros) as medidos
                           from relevamientos r join relevamiento_items i on i.relevamiento_id = r.id group by 1,2 order by 1,2`);
  const vivos = await sql(`select b.etiqueta, m.metros_restantes::text, m.origen from bolsones b join mediciones m on m.bolson_id=b.id order by b.etiqueta`);
  const g = (f, a) => (tot.find((x) => x.fecha === f && x.alimento === a) || {}).m;
  anotar('1a', 'Relevamiento 13/8: totales en SQL = Python desde el JSON, al decimal', g('2026-08-13', 'MG') === PY['2026-08-13'].MG.m && g('2026-08-13', 'MS') === PY['2026-08-13'].MS.m,
    { sql: tot, python: { '2026-07-31': PY['2026-07-31'], '2026-08-13': PY['2026-08-13'] }, pantalla_13_8: t13.match(/13\/08\/2026[\s\S]{0,200}/)?.[0] });
  anotar('1a2', 'Relevamiento 31/7 cargado como foto: SQL = Python', g('2026-07-31', 'MG') === PY['2026-07-31'].MG.m && g('2026-07-31', 'MS') === PY['2026-07-31'].MS.m,
    { pantalla: t31.slice(0, 300) });
  anotar('1a3', 'Sin tildar nada, el 13/8 queda solo como foto: ningún bolsón vivo', vivos.length === 0, { vivos });
  const ref = await sql(`select valor from parametros where clave='referencia'`);
  anotar('1a4', 'La referencia del portal del 13/8 entra desde el JSON (no desde el repo)', ref[0].valor.valores.MS === J13.referencia.valores.MS, { referencia: ref[0].valor });
});

// ═══════════ F · vincular después lo que no se tildó al cargar ═══════════
await paso('F', 'Vincular Maíz Silo del 13/8 ya cargado', async () => {
  await ir(admin, 'mapa'); const mapa = await textoPantalla(admin);
  await ir(admin, 'panel'); const panel = await textoPantalla(admin);
  const r13 = (await sql(`select id, importacion_id from relevamientos where fecha='2026-08-13'`))[0];
  const btn = await admin.$(`[data-vincular="${r13.id}|MS"]`);
  const r31b = (await sql(`select id from relevamientos where fecha='2026-07-31'`))[0];
  const botones31 = await admin.$$eval(`[data-vincular^="${r31b.id}|"]`, (xs) => xs.length);
  const botones = await admin.$$eval('[data-vincular]', (xs) => xs.map((x) => x.dataset.vincular.split('|')[1]));
  const hayBotonMG = !!(await admin.$(`[data-vincular="${r13.id}|MG"]`));
  await btn.evaluate((e) => e.click());
  await admin.waitForSelector('.modal'); const modal = await admin.$eval('.modal', (e) => e.innerText.replace(/\s+/g, ' '));
  await llenarModal(admin, { motivo: 'Iñaki confirmó en el campo: el orden de la hoja coincide (prueba)' });
  await listo(admin);
  const viv = await sql(`select b.etiqueta, b.estado, m.metros_restantes::text m, m.origen, m.fecha::text, m.importacion_id = $1 as del_relevamiento
                           from bolsones b join mediciones m on m.bolson_id=b.id where b.alimento='MS' order by b.etiqueta`, [r13.importacion_id]);
  const suma = (await sql(`select sum(m.metros_restantes)::text s from mediciones m join bolsones b on b.id=m.bolson_id where b.alimento='MS'`))[0].s;
  const ev = await sql(`select detalle from eventos e join bolsones b on b.id=e.bolson_id where b.alimento='MS' and e.tipo='alta'`);
  const cam = (await sql(`select count(*)::int n from cambios where tabla in ('bolsones','mediciones','eventos') and operacion='INSERT' and usuario=$1`, [banco.ids.admin]))[0].n;
  const nMS = J13.bolsones.filter((b) => b.alimento === 'MS').length;
  anotar('F1', `Vincular Maíz Silo del 13/8 ya cargado: ${nMS} bolsones con su medición del 13/8, que suman lo mismo que Python`,
    /No hay bolsones en la base todavía/.test(mapa) && /se vincula desde Panel/.test(mapa) && /ningún bolsón vivo/.test(panel)
    && new RegExp(`Va a crear ${nMS} bolsones de Maíz Silo con su medición del 13/08/2026`).test(modal) && hayBotonMG
    && viv.length === nMS && viv.every((v) => v.origen === 'migracion' && v.fecha === '2026-08-13' && v.del_relevamiento && v.estado === 'cerrado')
    && suma === PY['2026-08-13'].MS.m && ev.length === nMS && ev.every((e) => /confirmó en el campo/.test(e.detalle)) && cam >= nMS * 3,
    { aviso_mapa: mapa.slice(0, 160), aviso_modal: modal.slice(0, 260), bolsones: viv, suma_sql: suma, python: PY['2026-08-13'].MS.m,
      evento_alta: ev[0], filas_en_cambios: cam });
  // dos veces más: por la app (el botón ya no está) y directo a la base
  const botonDespues = !!(await admin.$(`[data-vincular="${r13.id}|MS"]`));
  const tok = (await banco.sesionDe('admin')).access_token;
  const otra = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { token: tok, cuerpo: { p_relevamiento: r13.id, p_alimento: 'MS', p_motivo: 'otra vez' } });
  const otraMas = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { token: tok, cuerpo: { p_relevamiento: r13.id, p_alimento: 'MS', p_motivo: 'otra vez' } });
  const despues = (await sql(`select count(*)::int b, (select count(*)::int from mediciones m join bolsones x on x.id=m.bolson_id where x.alimento='MS') m from bolsones where alimento='MS'`))[0];
  anotar('F2', 'Vincular dos veces más no duplica nada: la base contesta «ya estaba vinculado»',
    !botonDespues && otra.status === 200 && otra.j.ya_existia === true && otraMas.j.ya_existia === true && despues.b === nMS && despues.m === nMS,
    { boton_en_la_app: botonDespues, respuesta: otra.j, bolsones_y_mediciones_MS: despues });
  // la foto del 31/7 no se puede vincular encima de bolsones con mediciones posteriores; y lectura no puede vincular
  const r31 = (await sql(`select id from relevamientos where fecha='2026-07-31'`))[0];
  const vieja = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { token: tok, cuerpo: { p_relevamiento: r31.id, p_alimento: 'MS', p_motivo: 'x' } });
  const sil = (await banco.sesionDe('lectura')).access_token;
  const lect = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { token: sil, cuerpo: { p_relevamiento: r13.id, p_alimento: 'MG', p_motivo: 'x' } });
  const anon = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { cuerpo: { p_relevamiento: r13.id, p_alimento: 'MG', p_motivo: 'x' } });
  const sinMotivo = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { token: tok, cuerpo: { p_relevamiento: r13.id, p_alimento: 'MG', p_motivo: ' ' } });
  const vieja31MG = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { token: tok, cuerpo: { p_relevamiento: r31.id, p_alimento: 'MG', p_motivo: 'x' } });
  const forzada = await rest('POST', '/rest/v1/rpc/vincular_desde_relevamiento', { token: tok, cuerpo: { p_relevamiento: r31.id, p_alimento: 'MS', p_motivo: 'x', p_forzar: true } });
  const mg = (await sql(`select count(*)::int n from bolsones where alimento='MG'`))[0].n;
  anotar('V8', 'Vincular: el botón solo aparece para el relevamiento más reciente, y la base rechaza el 31/7 (salvo pedido explícito, que igual frena los duplicados)',
    botones31 === 0 && botones.length === 2 && vieja31MG.status === 409 && /no es el más reciente/.test((vieja31MG.j || {}).message || '')
      && forzada.status === 409 && /duplicaría/.test((forzada.j || {}).message || '') && mg === 0,
    { botones_del_31_7: botones31, botones_del_13_8: botones, rechazo_31_7_MG: [vieja31MG.status, vieja31MG.j && vieja31MG.j.message],
      forzado_31_7_MS: [forzada.status, forzada.j && forzada.j.message], bolsones_MG: mg });
  anotar('F4', 'No se vincula una foto más vieja encima de los de hoy; sin motivo, con rol lectura o sin sesión, la base dice que no',
    vieja.status === 409 && lect.status === 403 && anon.status === 401 && sinMotivo.status === 422 && mg === 0,
    { relevamiento_31_7: [vieja.status, vieja.j && vieja.j.message], lectura: [lect.status, lect.j && lect.j.message], sin_sesion: anon.status,
      sin_motivo: [sinMotivo.status, sinMotivo.j && sinMotivo.j.message], bolsones_MG: mg });
  // H: de dónde salió la referencia
  const portal = (await textoPantalla(admin)).match(/Contraste con el portal[\s\S]{0,2500}/)?.[0] || '';
  anotar('H', 'El contraste con el portal dice de dónde salió el número, y no dice «cargado a mano» (Panel y Ajustes)', /Cargado del relevamiento del 13\/08\/2026 \(silobolsa_2026-08-13\.json\), el .* por Iñaki/.test(portal.replace(/\s+/g, ' '))
      && !/cargad[oa]s? a mano/i.test(portal) && !/cargad[oa]s? a mano/i.test(await (async () => { await ir(admin, 'param'); const t = await textoPantalla(admin); await ir(admin, 'panel'); return t.match(/Referencia del portal[\s\S]{0,600}/)?.[0] || ''; })()),
    { texto: portal.replace(/\s+/g, ' ').slice(0, 400) });
});

// ═══════════ 1 · 1b · 1c · 7 · el lote del 11/11 ═══════════
await paso('1b', 'Primer lote real 11/11 por la revisión', async () => {
  await ir(admin, 'carga');
  await subir(admin, '#fPlanilla', [path.join(DATOS, 'mediciones_2026-11-11.csv'), path.join(DATOS, 'materia_seca_2026-11-11.csv')]);
  await admin.waitForSelector('#revOk');
  // estado de la revisión ANTES de confirmar
  const rev = await admin.evaluate(() => staging.filas.filter((f) => !f.vacia).map((f) => ({
    et: f.etiqueta, ali: f.alimento, m: f.metros, asig: f.asignado === 'nuevo' ? 'nuevo' : (bol(f.asignado) || {}).etiqueta || f.asignado,
    conf: f.propuesta && f.propuesta.conf, confirmado: f.confirmado, nivel: f.diag.nivel, por: f.propuesta && f.propuesta.por,
    marcas: f.diag.marcas.map((x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')), infos: (f.diag.infos || []).map((x) => x.replace(/\s+/g, ' ')) })));
  const okDeshabilitado = await admin.$eval('#revOk', (b) => b.disabled);
  const silo = rev.filter((r) => r.ali === 'MS'), maiz = rev.filter((r) => r.ali === 'MG');
  const msLeida = await admin.evaluate(() => staging.ms.map((m) => ({ nombre: m.nombre, txt: m.diag.lin[0], faltantes: m.faltantes, por: m.porQueFaltantes })));
  fs.writeFileSync(path.join(SALIDA, 'revision_11_11.json'), JSON.stringify({ rev, msLeida }, null, 1));
  anotar('1b1', 'Revisión: los 5 de silo proponen su bolsón del 13/8, sin confirmar todavía',
    silo.length === nAli('MS') && silo.every((r) => r.asig === r.et && !r.confirmado && r.nivel === 'revisar') && okDeshabilitado,
    { silo: silo.map((r) => `${r.et}→${r.asig} conf=${r.conf} · ${r.por}`), confirmar_deshabilitado: okDeshabilitado });
  anotar('1b2', 'Revisión: los 25 de maíz van como nuevos porque no hay maíz en la base (ninguno vinculado)',
    maiz.length === nAli('MG') && maiz.every((r) => r.asig === 'nuevo'), { ejemplo: maiz[0], total: maiz.length });
  const esperado = (et) => (DELTAS_MS.find((x) => x.et === et).d > 0.5 ? 'dif' : 'res');
  anotar('1b3', `Revisión: ${N_DIF} de silo con "diferencia de medición" (> 0,5 m) y ${N_RES} "dentro de la resolución" (≤ 0,5 m, informativo)`,
    silo.every((r) => esperado(r.et) === 'dif'
      ? r.marcas.some((m) => /Diferencia de medición/.test(m)) && !r.infos.length
      : r.infos.some((m) => /Dentro de la resolución/.test(m)) && !r.marcas.some((m) => /Diferencia de medición/.test(m))),
    { deltas_desde_los_archivos: DELTAS_MS, revision: silo.map((r) => ({ et: r.et, aviso: r.marcas.filter((m) => /Diferencia/.test(m))[0], informativo: r.infos[0] })) });
  anotar('1c1', 'Revisión MS: las dos lecturas como cota «≤», y propone que faltó harina de germen',
    msLeida[0].txt.startsWith(cotaDe(0)) && msLeida[1].txt.startsWith(cotaDe(1)) && msLeida[1].faltantes.join() === 'HG', { msLeida });
  // Iñaki confirma uno por uno los de silo y pone quién midió
  await admin.$eval('#revQuien', (e) => { e.value = 'Silvana'; e.dispatchEvent(new Event('input')); });
  for (let i = 0; i < 5; i++) {
    const cb = await admin.$('input[data-rv="confirmado"]:not(:checked)');
    if (!cb) break; await cb.evaluate((e) => e.click()); await espera(120);
  }
  const habilitado = await admin.$eval('#revOk', (b) => !b.disabled);
  await admin.screenshot({ path: path.join(SALIDA, 'revision_1100.png'), fullPage: false });
  await admin.$eval('#revOk', (e) => e.click()); await listo(admin);
  lote1 = (await sql(`select * from importaciones where tipo='planilla'`))[0];
  const tot = await sql(`select b.alimento, sum(m.metros_restantes)::text as m, count(*) as n from mediciones m join bolsones b on b.id=m.bolson_id
                          where m.importacion_id=$1 and not m.anulada group by 1 order by 1`, [lote1.id]);
  const py = execFileSync('python', ['-I', path.join(AQUI, 'totales.py'), DATOS], { encoding: 'utf8' });
  const pyj = JSON.parse(py);
  anotar('1d', 'Lote 11/11: metros y cantidad por alimento, SQL contra Python, al decimal',
    habilitado && tot.find((x) => x.alimento === 'MG').m === pyj['2026-11-11'].MG.m && tot.find((x) => x.alimento === 'MS').m === pyj['2026-11-11'].MS.m
    && tot.find((x) => x.alimento === 'MG').n === nAli('MG') && tot.find((x) => x.alimento === 'MS').n === nAli('MS'),
    { sql: tot, python: pyj });
  const vinc = await sql(`select b.etiqueta, string_agg(m.fecha::text || ' ' || m.metros_restantes || coalesce(' ['||m.revision_marca||']',''), ' → ' order by m.fecha) as historia
                            from bolsones b join mediciones m on m.bolson_id = b.id where b.alimento='MS' group by b.etiqueta order by 1`);
  const notas = await sql(`select b.etiqueta, m.revision_nota from mediciones m join bolsones b on b.id=m.bolson_id where m.revision_marca is not null order by 1`);
  const marcaBase = (v) => (v.historia.match(/\[(\w+)\]$/) || [])[1];
  const resumenLote = lote1.resumen || {};
  anotar('1b4', `En la base: los de silo vinculados al 13/8; la base marca ${N_DIF} diferencias de medición y ${N_RES} dentro de la resolución, y el lote las cuenta aparte`,
    vinc.length === nAli('MS') && vinc.every((v) => /2026-08-13.*→ 2026-11-11/.test(v.historia)) &&
    vinc.every((v) => marcaBase(v) === (DELTAS_MS.find((x) => x.et === v.etiqueta).d > 0.5 ? 'diferencia_medicion' : 'dentro_resolucion')) &&
    resumenLote.diferencias === N_DIF && resumenLote.dentro_resolucion === N_RES,
    { historia: vinc, notas_de_la_base: notas, resumen_del_lote: { diferencias: resumenLote.diferencias, dentro_resolucion: resumenLote.dentro_resolucion } });
  const mgMulti = await sql(`select count(*)::int as n from (select bolson_id from mediciones m join bolsones b on b.id=m.bolson_id where b.alimento='MG' group by bolson_id having count(*)>1) x`);
  const revMg = (lote1.revision || []).filter((r) => r.alimento === 'MG');
  anotar('1b5', 'Ningún bolsón de maíz vinculado sin confirmación (ninguno tiene historia previa; los 25 son altas)',
    mgMulti[0].n === 0 && revMg.length === nAli('MG') && revMg.every((r) => r.decision === 'nuevo'), { mg_con_mas_de_una_medicion: mgMulti[0].n });
  const ritmos = await admin.evaluate(() => D.bolsones.filter((b) => b.alimento === 'MS').map((b) => ({ et: b.etiqueta, tasa: tasa(b), ritmo: ritmo(b), dias: diasRest(b) })));
  anotar('1b6', 'Ningún ritmo de consumo calculado desde un par marcado', ritmos.every((r) => r.tasa === null && r.ritmo === null && r.dias === null), { ritmos });
  await ir(admin, 'panel');
  const panel = await textoPantalla(admin);
  const kpi = await admin.evaluate(() => { const r = {}; vivos().forEach((b) => { const m = metrosAct(b); if (m === null) return; const a = (r[b.alimento] = r[b.alimento] || { m: 0, kg: 0 }); a.m += m; a.kg += kgAct(b); }); return r; });
  const tnTxt = (x) => Number(x).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  anotar('F1.1', 'Totales del Panel = Python desde el CSV (metros y toneladas, al decimal)',
    fmt(kpi.MG.m) === pyj['2026-11-11'].MG.m && fmt(kpi.MS.m) === pyj['2026-11-11'].MS.m &&
    panel.includes(tnTxt(pyj['2026-11-11'].MG.tn)) && panel.includes(tnTxt(pyj['2026-11-11'].MS.tn)),
    { app: kpi, python: pyj['2026-11-11'], tn_en_pantalla: [tnTxt(pyj['2026-11-11'].MG.tn), tnTxt(pyj['2026-11-11'].MS.tn)] });
  const teo = await admin.evaluate(() => { const m = msDietaMedido(); const t = msDietaTeorico(m.ingredientes_faltantes); return { pct: t.pct, sin: t.sin, medido: txtMs(m) }; });
  const siloTxt = await admin.evaluate(() => txtMs(D.calidad.find((c) => c.alimento === 'MS')));
  anotar('1c2', 'Panel: las dos lecturas como cota «≤»; teórico sin harina de germen ≈ 69,5 % (fórmula y valores de casa)',
    siloTxt === cotaDe(0) && teo.medido === cotaDe(1) && Math.abs(teo.pct - 69.529) < 0.01
      && /Teórico para la muestra del 11\/11 \(sin harina de germen\)\s*69,5 %/i.test(panel) && panel.includes(cotaDe(0)),
    { silo: siloTxt, teo, extracto: panel.match(/Materia seca[\s\S]{0,900}/)?.[0] });
  // verificación 7 de la fase 4: la MS por día usa la fórmula COMPLETA (con germen); el «sin germen» es solo para la muestra
  const teoCompleto = Object.entries(J13.dieta.proporciones).reduce((s2, [k, v]) => s2 + v * J13.alimentos[k].ms_pct / 100, 0) / Object.values(J13.dieta.proporciones).reduce((a, b) => a + b, 0) * 100;
  const msDia = `${Math.round(J13.dieta.kg_dia_min * teoCompleto / 100 / 1000)}–${Math.round(J13.dieta.kg_dia_max * teoCompleto / 100 / 1000)} t`;
  const enApp = await admin.evaluate(() => { const t = msDietaTeorico([]); return { completo: t.pct, min: D.dieta.kg_dia_min * t.pct / 100 / 1000, max: D.dieta.kg_dia_max * t.pct / 100 / 1000 }; });
  anotar('G7', `Germen: MS por día con la fórmula completa (${msDia}); el teórico sin germen (69,5 %) solo para la muestra, rotulado`,
    new RegExp(`MS por día\\s*${msDia}`).test(panel) && Math.abs(enApp.completo - teoCompleto) < 1e-9
      && /Teórico para la muestra del 11\/11 \(sin harina de germen\)\s*69,5 %/i.test(panel),
    { esperado_desde_el_json: { teorico_completo: teoCompleto, ms_por_dia: msDia }, app: enApp,
      pantalla: (panel.match(/Teórico para la muestra[\s\S]{0,40}|MS por día[^\n]*\n?[^\n]*/g) || []).map((x) => x.replace(/\s+/g, ' ')) });
  const portal = panel.match(/Contraste con el portal[\s\S]{0,2500}/)?.[0] || '';
  anotar('1e', 'Contraste: portal del 13/8 contra bolsones del 11/11 dice «Fechas distintas» y no muestra ninguna conclusión',
    /Fechas distintas \(11\/11 contra 13\/08\): no se compara/.test(portal) && /Se compara solo con fechas a 7 días o menos/.test(portal)
      && !/cierra:|deja afuera a propósito|el portal tiene más|los bolsones dan más/.test(portal) && !/[+-]\d+,\d %/.test(portal),
    { portal: portal.replace(/\s+/g, ' ').slice(0, 900) });
  const cal = await sql(`select tipo, alimento, ms_pct::text, peso_constante, pesadas, ingredientes_faltantes, peso_inicial_g::text from calidad order by tipo`);
  anotar('1c3', 'En la base: pesadas crudas, peso_constante = false, faltó HG', cal.length === 2 && cal.every((c) => c.peso_constante === false) && cal.find((c) => c.tipo === 'dieta').ingredientes_faltantes.join() === 'HG', { calidad: cal });
});

await paso('7', 'Primer lote real pendiente en la bandeja de Nico', async () => {
  const nico = await abrir('auditor');
  const marcaPestana = await nico.$eval('#navPrincipal [data-p="auditoria"] .pend', (e) => e.innerText).catch(() => '');
  const cab = await nico.$eval('#indQuien', (e) => e.innerText);
  await ir(nico, 'auditoria');
  const bandeja = await textoPantalla(nico);
  anotar('7', 'El lote del 11/11 está pendiente y Nico ve el número arriba',
    lote1 && lote1.estado_auditoria === 'pendiente' && marcaPestana === '1' && /1 pendiente/.test(cab) && /11\/11\/2026[\s\S]*pendiente/.test(bandeja),
    { estado_en_base: lote1 && lote1.estado_auditoria, marca_en_la_pestana: marcaPestana, cabecera: cab, bandeja: bandeja.slice(0, 400) });
  await nico.setViewport({ width: 375, height: 800 });
  await espera(200);
  await nico.screenshot({ path: path.join(SALIDA, 'bandeja_375.png'), fullPage: true });
  globalThis.nico = nico;
});

// ═══════════ 2 · ID fijo: renumerar ═══════════
await paso('2', 'Renumerar MG1 → MG40', async () => {
  const antes = (await sql(`select b.id, (select count(*) from mediciones where bolson_id=b.id)::int as med, (select count(*) from eventos where bolson_id=b.id)::int as ev from bolsones b where etiqueta='MG1'`))[0];
  await admin.evaluate((id) => { fichaId = id; vista = 'ficha'; render(); }, antes.id);
  await admin.click('#btnRenum');
  await llenarModal(admin, { etiqueta: 'MG40', motivo: 'prueba de la fase 3' });
  await listo(admin);
  const desp = (await sql(`select b.id, b.etiqueta, (select count(*) from mediciones where bolson_id=b.id)::int as med from bolsones b where id=$1`, [antes.id]))[0];
  const ev = await sql(`select tipo, detalle, cargado_por from eventos where bolson_id=$1 and tipo='renumeracion'`, [antes.id]);
  const ficha = await textoPantalla(admin);
  anotar('2', 'Mismo id, misma historia, etiqueta MG40 y evento de renumeración',
    desp.etiqueta === 'MG40' && desp.med === antes.med && ev.length === 1 && /MG1 → MG40/.test(ev[0].detalle) && /MG1 → MG40/.test(ficha),
    { antes, despues: desp, evento: ev });
});

// ═══════════ 5 · nada se pisa: corregir ═══════════
let corregida = null;
await paso('5', 'Corregir una medición', async () => {
  const b = (await sql(`select id from bolsones where etiqueta='MG40'`))[0];
  await admin.evaluate((id) => { fichaId = id; vista = 'ficha'; render(); }, b.id);
  await admin.click('[data-corr]');
  const corr = Math.round((metrosDe('MG1') + 0.1) * 10) / 10;
  await llenarModal(admin, { metros: es1(corr), motivo: 'mal tipeado al cargar (prueba)' });
  await listo(admin);
  const ms = await sql(`select id, metros_restantes::text, anulada, anulada_motivo, anulada_por, anulada_en, reemplaza_a, motivo, cargado_por, cargado_en from mediciones where bolson_id=$1 order by cargado_en`, [b.id]);
  const orig = ms.find((m) => m.anulada), nueva = ms.find((m) => !m.anulada);
  const cam = await sql(`select tabla, operacion, fila_id, usuario, en, antes->>'anulada' as antes_anulada, despues->>'anulada' as despues_anulada from cambios where fila_id in ($1,$2) order by id`, [orig.id, nueva.id]);
  corregida = { orig, nueva };
  anotar('5', 'Original anulada con motivo/quién/cuándo, nueva con reemplaza_a, y filas en cambios',
    orig && nueva && Number(orig.metros_restantes) === metrosDe('MG1') && Number(nueva.metros_restantes) === corr && nueva.reemplaza_a === orig.id &&
    orig.anulada_por === banco.ids.admin && orig.anulada_en && /mal tipeado/.test(orig.anulada_motivo) && nueva.motivo &&
    cam.some((c) => c.fila_id === orig.id && c.operacion === 'UPDATE' && c.antes_anulada === 'false' && c.despues_anulada === 'true') &&
    cam.some((c) => c.fila_id === nueva.id && c.operacion === 'INSERT'),
    { mediciones: ms, cambios: cam });
});

// ═══════════ 6 · reimportar la misma fecha ═══════════
await paso('6', 'Reimportar la planilla del 11/11', async () => {
  const [antes] = await sql(`select count(*)::int as n, count(*) filter (where anulada)::int as anul from mediciones`);
  await ir(admin, 'carga');
  await subir(admin, '#fPlanilla', [path.join(DATOS, 'mediciones_2026-11-11.csv'), path.join(DATOS, 'materia_seca_2026-11-11.csv')]);
  await admin.waitForSelector('#revOk');
  const rev = await admin.evaluate(() => staging.filas.filter((f) => !f.vacia).map((f) => ({ et: f.etiqueta, asig: (bol(f.asignado) || {}).etiqueta, conf: f.propuesta && f.propuesta.conf, accion: f.accion, reemplaza: !!f.reemplaza, lin: f.diag.lin })));
  const ms = await admin.evaluate(() => staging.ms.map((m) => m.accion));
  const bca = await admin.$('#revConfAltas'); if (bca) { await bca.evaluate((e) => e.click()); await espera(150); }
  for (let i = 0; i < 40; i++) { const cb = await admin.$('input[data-rv="confirmado"]:not(:checked)'); if (!cb) break; await cb.evaluate((e) => e.click()); await espera(80); }
  await admin.$eval('#revQuien', (e) => { e.value = 'Silvana'; e.dispatchEvent(new Event('input')); });
  await admin.$eval('#revMotivo', (e) => { e.value = 'reimportación de prueba: vale lo de la planilla'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  await espera(200);
  await admin.$eval('#revOk', (e) => e.click()); await listo(admin);
  const [desp] = await sql(`select count(*)::int as n, count(*) filter (where anulada)::int as anul from mediciones`);
  const lotes = await sql(`select id, resumen->>'mediciones' as med, resumen->>'reemplazos' as reemp, estado_auditoria from importaciones where tipo='planilla' order by cargado_en`);
  const mg1 = await sql(`select b.etiqueta, m.metros_restantes::text, m.anulada, m.motivo, m.anulada_motivo from mediciones m join bolsones b on b.id=m.bolson_id where b.id=$1 order by m.cargado_en`, [corregida.orig ? (await sql(`select bolson_id from mediciones where id=$1`, [corregida.orig.id]))[0].bolson_id : null]);
  const iguales = rev.filter((r) => r.accion === 'igual').length;
  anotar('6', 'No borra nada: los iguales se saltean, MG1 se anula y reemplaza con motivo, nuevo lote con trazabilidad',
    desp.n === antes.n + 1 && desp.anul === antes.anul + 1 && iguales === CSV.length - 1 && rev.filter((r) => r.reemplaza).length === 1 && ms.every((x) => x === 'igual') && lotes.length === 2,
    { antes, despues: desp, iguales, ms_reimportada: ms, reemplazo: rev.find((r) => r.reemplaza), historia_MG1: mg1, lotes });
});

// ═══════════ 8 · auditoría por los dos caminos ═══════════
await paso('8', 'Auditoría: observar un lote y re-medir', async () => {
  const nico = globalThis.nico; await nico.setViewport({ width: 1100, height: 900 });
  await nico.reload({ waitUntil: 'domcontentloaded' }); await nico.waitForFunction(() => yo && !pantallaAuth); await listo(nico);
  await nico.evaluate((id) => { auditLote = id; vista = 'auditoria'; render(); }, lote1.id);
  await nico.type('#audCom', 'La lectura de MS5 no me cierra: la re-medí');
  await nico.$eval('#btnAuditarObs', (e) => e.click()); await listo(nico);
  const ms5 = (await sql(`select id from bolsones where etiqueta='MS5'`))[0];
  await nico.evaluate((id) => { fichaId = id; vista = 'ficha'; render(); }, ms5.id);
  await nico.click('#btnRemedir');
  const orig5 = metrosDe('MS5'), aud5 = Math.round((orig5 - 0.1) * 10) / 10;
  await llenarModal(nico, { fecha: '2026-11-11', metros: es1(aud5), nota: 'odómetro, mitad a mitad del triángulo' });
  await listo(nico);
  const ficha = await textoPantalla(nico);
  const tabla = ficha.match(/Re-mediciones de auditoría[\s\S]{0,400}/)?.[0];
  await admin.reload({ waitUntil: 'domcontentloaded' }); await admin.waitForFunction(() => yo && !pantallaAuth); await listo(admin);
  const panelAdmin = await textoPantalla(admin);
  const lot = (await sql(`select estado_auditoria from importaciones where id=$1`, [lote1.id]))[0];
  const aud = await sql(`select resultado, comentario, auditor from auditorias`);
  const med = await sql(`select origen, metros_restantes::text, anulada, cargado_por from mediciones where bolson_id=$1 and fecha='2026-11-11'`, [ms5.id]);
  const usada = await admin.evaluate((id) => { const u = ultimaMed(id); return u.origen + ' ' + u.metros_restantes; }, ms5.id);
  anotar('8a', 'Lote observado: Iñaki ve el comentario', lot.estado_auditoria === 'observada' && /Nico\s+observó el lote del 11\/11\/2026.*no me cierra/.test(panelAdmin.replace(/\n/g, ' ')),
    { estado: lot, auditorias: aud, aviso_admin: panelAdmin.match(/⚠ Nico[^\n]*/)?.[0] });
  anotar('8b', 'Re-medición de auditoría: la ficha muestra las dos y la diferencia (m y kg); no reemplaza',
    med.length === 2 && med.every((m) => !m.anulada) && new RegExp(`${escRe(es1(orig5))} m\\s+${escRe(es1(aud5))} m\\s+−0,1 m\\s+-400 kg`).test(tabla || '') && usada === 'planilla ' + orig5,
    { mediciones_del_dia: med, tabla, la_que_usan_los_calculos: usada });
});

// ═══════════ 3 · RLS sin login ═══════════
const TABLAS = ['perfiles', 'invitaciones', 'importaciones', 'bolsones', 'mediciones', 'eventos', 'calidad', 'auditorias', 'parametros', 'relevamientos', 'relevamiento_items', 'cambios', 'latidos'];
await paso('3', 'RLS con la clave anon y sin sesión', async () => {
  const lect = {}, esc = {};
  // para cada tabla, una columna de texto que exista: así el pedido está bien formado
  // y lo único que puede frenarlo es el permiso
  for (const t of TABLAS) {
    const col = (await sql(`select column_name from information_schema.columns where table_schema='public' and table_name=$1
                            and data_type = 'text' and is_identity = 'NO' order by ordinal_position limit 1`, [t]))[0].column_name;
    const r = await rest('GET', `/rest/v1/${t}?select=*`);
    lect[t] = `${r.status} · ${Array.isArray(r.j) ? r.j.length + ' filas' : JSON.stringify(r.j)}`;
    const ins = await rest('POST', `/rest/v1/${t}`, { cuerpo: { [col]: 'x' } });
    const upd = await rest('PATCH', `/rest/v1/${t}?${col}=eq.x`, { cuerpo: { [col]: 'y' } });
    const del = await rest('DELETE', `/rest/v1/${t}?${col}=eq.x`);
    esc[t] = [`${col}`, ins.status, upd.status, del.status, (ins.j && ins.j.message || '').slice(0, 40)];
  }
  const fn = await rest('POST', '/rest/v1/rpc/confirmar_lote', { cuerpo: { p: { id: '00000000-0000-0000-0000-000000000009', fecha: '2026-11-30' } } });
  const cuentas = await sql(`select (select count(*) from bolsones)::int b, (select count(*) from mediciones)::int m`);
  anotar('3', 'Cada tabla devuelve 0 filas y todo intento de escribir falla',
    Object.values(lect).every((x) => x.startsWith('200 · 0 filas')) && Object.values(esc).every((x) => x[1] === 401 && x[2] === 401 && x[3] === 401) && fn.status === 401,
    { lectura: lect, insert_update_delete: esc, rpc_confirmar_lote: [fn.status, fn.j && fn.j.message], datos_reales_en_la_base: cuentas[0] });
  const rls = await sql(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' order by 1`);
  anotar('3b', 'RLS activada en todas las tablas', rls.every((r) => r.relrowsecurity) && rls.length === TABLAS.length, { tablas: rls });
});

// ═══════════ 4 · roles ═══════════
await paso('4', 'Roles en la base', async () => {
  const sil = (await banco.sesionDe('lectura')).access_token;
  const nic = (await banco.sesionDe('auditor')).access_token;
  const unB = (await sql(`select id, actualizado_en from bolsones limit 1`))[0];
  const unaM = (await sql(`select id from mediciones where not anulada limit 1`))[0];
  const L = {
    leer_bolsones: await rest('GET', '/rest/v1/bolsones?select=*', { token: sil }),
    insertar: await rest('POST', '/rest/v1/bolsones', { token: sil, cuerpo: { etiqueta: 'HACK', alimento: 'MG' } }),
    editar: await rest('PATCH', `/rest/v1/bolsones?id=eq.${unB.id}`, { token: sil, cuerpo: { nota: 'editado por lectura' } }),
    borrar: await rest('DELETE', `/rest/v1/mediciones?id=eq.${unaM.id}`, { token: sil }),
    rpc_lote: await rest('POST', '/rest/v1/rpc/confirmar_lote', { token: sil, cuerpo: { p: { id: '00000000-0000-0000-0000-00000000000a', fecha: '2026-11-30', tipo: 'planilla' } } }),
    rpc_auditar: await rest('POST', '/rest/v1/rpc/auditar', { token: sil, cuerpo: { p_id: '00000000-0000-0000-0000-00000000000b', p_importacion: lote1.id, p_medicion: null, p_resultado: 'ok', p_comentario: '' } }),
  };
  const A = {
    auditar_med: await rest('POST', '/rest/v1/rpc/auditar', { token: nic, cuerpo: { p_id: '00000000-0000-0000-0000-00000000000c', p_importacion: null, p_medicion: unaM.id, p_resultado: 'ok', p_comentario: '' } }),
    medicion_auditoria: await rest('POST', '/rest/v1/rpc/medicion_auditoria', { token: nic, cuerpo: { p_id: '00000000-0000-0000-0000-00000000000d', p_bolson: unB.id, p_fecha: '2026-11-12', p_metros: 60, p_nota: 'prueba de rol' } }),
    insertar_planilla_directo: await rest('POST', '/rest/v1/mediciones', { token: nic, cuerpo: { bolson_id: unB.id, fecha: '2026-11-13', metros_restantes: 60, origen: 'planilla' } }),
    borrar: await rest('DELETE', `/rest/v1/mediciones?id=eq.${unaM.id}`, { token: nic }),
    parametro_rpc: await rest('POST', '/rest/v1/rpc/guardar_parametro', { token: nic, cuerpo: { p_clave: 'alimentos', p_valor: {}, p_origen: 'x' } }),
    parametro_patch: await rest('PATCH', '/rest/v1/parametros?clave=eq.alimentos', { token: nic, cuerpo: { origen: 'x' } }),
    anular: await rest('POST', '/rest/v1/rpc/anular', { token: nic, cuerpo: { p_tabla: 'mediciones', p_id: unaM.id, p_motivo: 'x' } }),
  };
  const st = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, `${v.status} ${Array.isArray(v.j) ? v.j.length + ' filas' : (v.j && (v.j.message || JSON.stringify(v.j)) || '').slice(0, 90)}`]));
  const sigue = (await sql(`select nota from bolsones where id=$1`, [unB.id]))[0];
  const medSigue = (await sql(`select anulada from mediciones where id=$1`, [unaM.id]))[0];
  anotar('4a', 'Lectura: insertar, editar y borrar fallan en la base',
    L.leer_bolsones.status === 200 && L.leer_bolsones.j.length > 0 && ['insertar', 'editar', 'borrar', 'rpc_lote', 'rpc_auditar'].every((k) => L[k].status === 403) && sigue.nota !== 'editado por lectura',
    { respuestas: st(L) });
  anotar('4b', 'Auditor: audita y carga medición de auditoría; no borra ni cambia parámetros',
    A.auditar_med.status === 200 && A.medicion_auditoria.status === 200 && ['insertar_planilla_directo', 'borrar', 'parametro_rpc', 'parametro_patch', 'anular'].every((k) => A[k].status === 403) && !medSigue.anulada,
    { respuestas: st(A) });
  // UI de lectura
  const silv = await abrir('lectura', { ancho: 375 });
  await ir(silv, 'carga');
  const t = await textoPantalla(silv);
  anotar('4c', 'Pantalla de Silvana: sin botones de carga, dice su rol', /lo hace el admin/.test(t) && !(await silv.$('#opSubir')) && /lectura/i.test(await silv.$eval('#indQuien', (e) => e.innerText)), { texto: t.slice(0, 250) });
  // alguien que se creó una cuenta por su cuenta (el alta está abierta)
  const otro = await navegador.createBrowserContext(); const po = await otro.newPage();
  await po.goto(APP); await po.waitForSelector('#formLogin');
  await po.type('#lgEmail', USUARIOS.extrano.email); await po.type('#lgClave', USUARIOS.extrano.clave); await po.click('#btnEntrar');
  await po.waitForFunction(() => pantallaAuth === 'sin_acceso');
  const tok = (await banco.sesionDe('extrano')).access_token;
  const r = await rest('GET', '/rest/v1/bolsones?select=*', { token: tok });
  anotar('4d', 'Una cuenta creada sin invitación no ve nada', r.status === 200 && r.j.length === 0, { pantalla: (await po.$eval('#pantalla', (e) => e.innerText)).slice(0, 160), bolsones_que_ve: r.j.length });
  await otro.close(); await silv.ctx.close();
});

// ═══════════ B · nadie se queda con el rol de otro ═══════════
await paso('B', 'Alta de usuarios e invitaciones', async () => {
  await ir(admin, 'param'); await admin.waitForSelector('#avisoAuth', { timeout: 10000 });
  const avisoAbierta = await admin.$eval('#avisoAuth', (e) => e.innerText);
  const mailsAntes = banco.mails.length;
  await admin.$eval('#invEmail', (e) => { e.value = 'nuevo@prueba.local'; });
  await admin.$eval('#invNombre', (e) => { e.value = 'Nuevo'; });
  await admin.select('#invRol', 'auditor');
  await admin.$eval('#btnInvitar', (e) => e.click());
  await admin.waitForSelector('.modal'); const modalInv = await admin.$eval('.modal', (e) => e.innerText); await admin.$eval('#modalOk', (e) => e.click());
  const cuentaCreada = (await sql(`select count(*)::int n from auth.users where email='nuevo@prueba.local'`))[0].n;
  anotar('B1', '«Registrar el rol» no manda mails ni crea cuentas, y explica el camino del panel',
    banco.mails.length === mailsAntes && cuentaCreada === 0 && /no crea la cuenta ni manda mails/.test(modalInv) && /Auto Confirm User/.test(modalInv),
    { mails_enviados: banco.mails.length - mailsAntes, cuentas_creadas: cuentaCreada, aviso: modalInv.replace(/\s+/g, ' ').slice(0, 300) });
  // alguien se registra solo con el mail invitado (alta abierta): nace sin confirmar → sin acceso
  const reg = await rest('POST', '/auth/v1/signup', { cuerpo: { email: 'nuevo@prueba.local', password: 'clave-del-intruso' } });
  const perfilIntruso = (await sql(`select p.rol, u.email_confirmed_at from perfiles p join auth.users u on u.id=p.id where p.email='nuevo@prueba.local'`))[0];
  const tok = (await rest('POST', '/auth/v1/token?grant_type=password', { cuerpo: { email: 'nuevo@prueba.local', password: 'clave-del-intruso' } })).j.access_token;
  const ve = await rest('GET', '/rest/v1/bolsones?select=*', { token: tok });
  anotar('B2', 'Registrarse solo con un mail invitado no da el rol: la cuenta nace sin confirmar y queda sin acceso',
    reg.status === 200 && perfilIntruso.rol === 'sin_acceso' && perfilIntruso.email_confirmed_at === null && ve.j.length === 0,
    { perfil: perfilIntruso, bolsones_que_ve: ve.j.length });
  // la cuenta que crea el admin en el panel (mail confirmado) sí toma el rol invitado
  await admin.$eval('#invEmail', (e) => { e.value = 'panel@prueba.local'; });
  await admin.select('#invRol', 'lectura'); await admin.$eval('#btnInvitar', (e) => e.click());
  await admin.waitForSelector('.modal'); await admin.$eval('#modalOk', (e) => e.click());
  await sql(`insert into auth.users (email, encrypted_password, email_confirmed_at) values ('panel@prueba.local','x',now())`);
  const perfilPanel = (await sql(`select rol from perfiles where email='panel@prueba.local'`))[0];
  anotar('B3', 'La cuenta creada desde el panel (mail confirmado) toma el rol registrado', perfilPanel.rol === 'lectura', { perfil: perfilPanel });
  // con el alta apagada y la confirmación prendida, el aviso se va y registrarse falla
  banco.config.disable_signup = true; banco.config.mailer_autoconfirm = false;
  const reg2 = await rest('POST', '/auth/v1/signup', { cuerpo: { email: 'otro2@prueba.local', password: 'x' } });
  await admin.evaluate(() => { authCfg = null; authCfgPedida = false; render(); });
  await admin.waitForFunction(() => { const e = document.getElementById('avisoAuth'); return e && /apagada/.test(e.innerText); }, { timeout: 10000 });
  const avisoOk = await admin.$eval('#avisoAuth', (e) => e.innerText);
  banco.config.mailer_autoconfirm = true;
  await admin.evaluate(() => { authCfg = null; authCfgPedida = false; render(); });
  await admin.waitForFunction(() => { const e = document.getElementById('avisoAuth'); return e && /Confirm email/.test(e.innerText); }, { timeout: 10000 });
  const avisoConfirm = await admin.$eval('#avisoAuth', (e) => e.innerText);
  banco.config.mailer_autoconfirm = false;
  anotar('B4', 'Ajustes avisa en rojo si el alta está abierta o «Confirm email» apagado, y en verde si está bien',
    /alta de usuarios está abierta/.test(avisoAbierta) && reg2.status === 422 && /alta de usuarios apagada/.test(avisoOk) && /Confirm email» está apagado/.test(avisoConfirm),
    { con_alta_abierta: avisoAbierta.replace(/\s+/g, ' ').slice(0, 160), alta_apagada: avisoOk, sin_confirmacion: avisoConfirm.replace(/\s+/g, ' ').slice(0, 160), registrarse_con_alta_apagada: reg2.status });
});

// ═══════════ 9 · dos sesiones a la vez ═══════════
await paso('9', 'Editar el mismo bolsón desde dos navegadores', async () => {
  const ms2 = (await sql(`select id from bolsones where etiqueta='MS2'`))[0];
  const otra = await abrir('admin');
  for (const p of [admin, otra]) { await p.evaluate((id) => { fichaId = id; vista = 'ficha'; render(); }, ms2.id); await p.$eval('#btnEditArmado', (e) => e.click()); await espera(150); }
  await admin.$eval('[data-arm="armado_origen"]', (e) => { e.value = 'Lote 7 (primero)'; e.dispatchEvent(new Event('change')); });
  await listo(admin);
  await otra.$eval('[data-arm="armado_origen"]', (e) => { e.value = 'Lote 9 (segundo)'; e.dispatchEvent(new Event('change')); });
  await otra.waitForSelector('#modalOk', { timeout: 10000 });
  const modal = await otra.$eval('.modal', (e) => e.innerText);
  const base = (await sql(`select armado_origen from bolsones where id=$1`, [ms2.id]))[0];
  anotar('9', 'El segundo recibe el aviso con lo que cambió y no pisa', base.armado_origen === 'Lote 7 (primero)' && /alguien guardó antes/.test(modal) && /Lote 7 \(primero\)/.test(modal) && /Lote 9 \(segundo\)/.test(modal),
    { en_la_base: base, aviso: modal.replace(/\s+/g, ' ').slice(0, 500) });
  await otra.click('#modalCancel'); await otra.ctx.close();
});

// ═══════════ 10 · se corta internet ═══════════
await paso('10', 'Cortar la red a mitad de una carga', async () => {
  const ms1 = (await sql(`select id from bolsones where etiqueta='MS1'`))[0];
  await ir(admin, 'carga'); await admin.click('#opMano'); await espera(150);
  await admin.$eval('#cFecha', (e) => { e.value = '2026-11-18'; e.dispatchEvent(new Event('change')); });
  await admin.setOfflineMode(true);
  // fase 5: la carga a mano es la lista numerada del papel; MS N° 1 → la revisión propone MS1
  await admin.type('[data-mm="MS|1"]', '66,9');
  const borrador = await admin.evaluate(() => JSON.parse(localStorage.getItem('silobolsa_borrador_v4')));
  await admin.$eval('#btnGuardar', (e) => e.click()); await espera(200);
  const propuesto = await admin.evaluate(() => { const f = staging.filas[0]; return f && (bol(f.asignado) || {}).etiqueta; });
  await admin.$eval('#revFaltNoMed', (e) => e.click()); await espera(100);
  await admin.$eval('[data-rev] input[data-rv="confirmado"]', (e) => { if (!e.checked) e.click(); }); await espera(100);
  await admin.$eval('#revOk', (e) => e.click()); await espera(1500);
  const ind = await admin.$eval('#indGuardado', (e) => e.innerText);
  const enBase = await sql(`select count(*)::int n from mediciones where fecha='2026-11-18'`);
  const enCola = await admin.evaluate(() => JSON.parse(localStorage.getItem('silobolsa_cola_v4')).length);
  await admin.setOfflineMode(false);
  await admin.waitForFunction(() => !cola.length && conexion === 'ok', { timeout: 30000 }); await listo(admin);
  const despues = await sql(`select m.metros_restantes::text, b.etiqueta from mediciones m join bolsones b on b.id=m.bolson_id where fecha='2026-11-18'`);
  const ind2 = await admin.$eval('#indGuardado', (e) => e.innerText);
  anotar('10', 'Lo tipeado queda como borrador, dice "sin guardar" y al volver la red se guarda',
    borrador.cargaBuf['m:MS:1'] === '66,9' && propuesto === 'MS1' && despues[0] && despues[0].etiqueta === 'MS1' && /sin guardar en la base/i.test(ind) && enBase[0].n === 0 && enCola === 1 && despues.length === 1 && despues[0].metros_restantes === '66.9' && /guardado en la base/i.test(ind2),
    { borrador_en_el_navegador: borrador.cargaBuf, propuesto_por_la_revision: propuesto, indicador_sin_red: ind, en_la_base_sin_red: enBase[0].n, operaciones_en_cola: enCola, en_la_base_al_volver: despues, indicador_despues: ind2 });
});

// ═══════════ 12 · latido ═══════════
await paso('12', 'Latido diario (lo que corre el Action)', async () => {
  const wf = fs.readFileSync(path.join(AQUI, '../.github/workflows/latido.yml'), 'utf8');
  const r = await rest('POST', '/rest/v1/rpc/latido', { cuerpo: { p_origen: 'github-action' } });
  const r2 = await rest('POST', '/rest/v1/rpc/latido', { cuerpo: { p_origen: 'github-action' } });
  const filas = await sql(`select id, en, origen from latidos`);
  anotar('12-local', 'El latido con la clave anon queda registrado (una fila por hora como máximo)', r.status === 200 && r2.status === 200 && filas.length === 1 && /rpc\/latido/.test(wf),
    { respuesta: r.j, segunda_llamada: r2.j, filas, workflow: 'app/.github/workflows/latido.yml' });
});

// ═══════════ 14 · regresiones de las fases 1 y 2 ═══════════
await paso('14', 'Regresiones', async () => {
  // F1.2 faltantes + F2.3 problemas + recuento + ningún 0 + cancelar no deja rastro (planilla guardada por Excel con sharedStrings)
  const sucia = path.join(SALIDA, 'planilla_sucia_sharedstrings.xlsx');
  execFileSync('python', ['-I', path.join(AQUI, 'planilla_sucia.py'), sucia]);
  const antes = await sql(`select (select count(*) from mediciones)::int m, (select count(*) from bolsones)::int b, (select count(*) from importaciones)::int l`);
  await ir(admin, 'carga');
  await subir(admin, '#fPlanilla', [sucia]);
  await admin.waitForSelector('#revOk');
  const diag = await admin.evaluate(() => ({ fecha: staging.fecha, filas: staging.filas.filter((f) => !f.vacia).map((f) => ({ r: f.renglon, et: f.etiqueta, m: f.metros, nivel: f.diag.nivel, txt: f.diag.lin[0] })), vacias: staging.filas.filter((f) => f.vacia).length }));
  const txtRev = await textoPantalla(admin);
  const ceros = diag.filas.filter((f) => f.m === 0);
  anotar('F2.3', 'Archivo guardado por Excel (sharedStrings), sucio: cada problema con su razón y ningún vacío se vuelve 0',
    diag.filas.some((f) => /No entiendo «abc»/.test(f.txt)) && diag.filas.some((f) => /no es ninguno de los alimentos/.test(f.txt)) &&
    diag.filas.some((f) => /aparece en los renglones/.test(f.txt)) && diag.filas.some((f) => /Dice 0 m/.test(f.txt)) &&
    diag.filas.some((f) => f.m === 67.5) && diag.filas.some((f) => f.m === 64.6) && diag.vacias >= 1 && ceros.every((f) => f.nivel === 'error' || /terminado/i.test(f.txt)) &&
    diag.filas.filter((f) => f.m === null).every((f) => f.nivel !== 'listo' || /s\/d/.test(f.txt)),
    { diag });
  anotar('F2.5', 'El recuento que no cuadra avisa antes de confirmar', /El recuento dice\s+30\s+bolsones/.test(txtRev), { aviso: txtRev.match(/El recuento dice[^\n]*/)?.[0] });
  await admin.$eval('#revCancel', (e) => e.click()); await espera(200);
  const desp = await sql(`select (select count(*) from mediciones)::int m, (select count(*) from bolsones)::int b, (select count(*) from importaciones)::int l`);
  anotar('F2.4', 'Cancelar no deja rastro', JSON.stringify(antes) === JSON.stringify(desp) && await admin.evaluate(() => staging === null), { antes: antes[0], despues: desp[0] });
  // F2.1 ida y vuelta con la planilla en blanco que genera la app (inlineStr), llenada por código
  const ida = await admin.evaluate(async () => {
    const vivosMs = D.bolsones.filter((b) => b.alimento === 'MS');
    const IN = (v) => ({ __inp: true, v });
    const h1 = [['N°', 'ETIQUETA', 'ALIMENTO', 'PASADA', 'METROS', 'ESTADO', 'OBSERVACIONES', 'LECTURA']];
    const vals = [66.5, 68.5, 66, 66, 57.5];
    vivosMs.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta)).forEach((b, i) => h1.push([i + 1, IN(b.etiqueta), IN('MS'), IN('A'), IN(String(vals[i]).replace('.', ',')), IN('C'), IN(''), IN('')]));
    const rec = [['Alimento', 'Contado'], ['TOTAL', 5], ['Fecha de medición', IN('25/11/2026')], ['Medido por', IN('Silvana')]];
    const bytes = xlsx([{ nombre: 'Recuento', filas: rec }, { nombre: 'Mediciones', filas: h1 }]);
    await importarPlanilla([new File([bytes], 'ida_y_vuelta.xlsx')]);
    staging.filas.forEach((f) => { if (f.asignado && f.asignado !== 'nuevo') { f.confirmado = true; f.tocado = true; } });
    staging.faltantes.forEach((x) => { x.decision = 'no_medido'; });   // los de maíz no vinieron: no se midieron
    procesarStaging(); render();
    return { suma: vals.reduce((s, x) => s + x, 0), fecha: staging.fecha, quien: staging.quien, listas: staging.filas.filter((f) => f.diag.nivel === 'listo').length,
             vinculos: staging.filas.filter((f) => !f.vacia).map((f) => `${f.etiqueta}→${(bol(f.asignado) || {}).etiqueta} (${f.propuesta && f.propuesta.conf})`) };
  });
  await admin.$eval('#revOk', (e) => e.click()); await listo(admin);
  const tIda = await sql(`select sum(m.metros_restantes)::text s, count(*)::int n from mediciones m where fecha='2026-11-25' and not anulada`);
  anotar('F2.1', 'Ida y vuelta: planilla de la app llenada por código → revisión → base, totales iguales',
    ida.listas === 5 && ida.vinculos.every((v) => v.split('→')[0] === v.split('→')[1].split(' ')[0]) && Number(tIda[0].s) === ida.suma && tIda[0].n === 5 && ida.fecha === '2026-11-25' && ida.quien === 'Silvana', { app: ida, base: tIda[0] });
  // F1.3 ritmo y días por dos caminos (MS1: 11/11 → 25/11 no es diferencia: bajó)
  const r = await admin.evaluate(() => { const b = D.bolsones.find((x) => x.etiqueta === 'MS1'); const ms = medsDe(b.id); return { ms: ms.map((m) => [m.fecha, m.metros_restantes, m.revision_marca]), ritmo: ritmo(b), dias: diasRest(b) }; });
  const aMano = (66.9 - 66.5) / 7; // 18/11 66,9 → 25/11 66,5
  anotar('F1.3', 'Ritmo y días restantes: app contra la cuenta a mano', Math.abs(r.ritmo - aMano) < 1e-9 && Math.abs(r.dias - 66.5 / aMano) < 1e-6, { app: r, a_mano: { ritmo: aMano, dias: 66.5 / aMano } });
  // F1.2 s/d, sin metros iniciales, terminado con 0  +  F1.4 rendimiento real con aviso de desvío
  const ms3 = (await sql(`select id, actualizado_en from bolsones where etiqueta='MS3'`))[0];
  await admin.evaluate((id) => { const b = bol(id); editarBolson(b, { armado_metros_iniciales: 70, armado_kg_declarados: 330000 }, 'prueba rendimiento'); }, ms3.id);
  await listo(admin);
  await admin.evaluate(async () => {
    const h1 = [['ETIQUETA', 'ALIMENTO', 'METROS', 'ESTADO'], ['MS3', 'MS', '0', 'T'], ['MG99', 'MG', '', '']];
    const bytes = xlsx([{ nombre: 'Mediciones', filas: h1 }, { nombre: 'Recuento', filas: [['Fecha de medición', '26/11/2026']] }]);
    await importarPlanilla([new File([bytes], 'faltantes.xlsx')]);
    staging.filas.forEach((f) => { if (f.etiqueta === 'MS3') { f.asignado = D.bolsones.find((b) => b.etiqueta === 'MS3').id; f.tocado = true; f.confirmado = true; }
                                   if (f.etiqueta === 'MG99') { f.asignado = 'nuevo'; f.tocado = true; f.confirmado = true; } });
    procesarStaging();
    staging.faltantes.forEach((x) => { x.decision = 'no_medido'; });
    procesarStaging(); render();
  });
  const blq = await bloqueos(admin);
  const diagF = await admin.evaluate(() => staging.filas.filter((f) => !f.vacia).map((f) => f.etiqueta + ': ' + f.diag.lin.join(' ')));
  if (blq) throw new Error('El lote de faltantes no se habilita: ' + blq + ' · ' + diagF.join(' | '));
  await admin.$eval('#revOk', (e) => e.click()); await listo(admin);
  const v = await admin.evaluate(() => {
    const t = D.bolsones.find((b) => b.etiqueta === 'MS3'), s = D.bolsones.find((b) => b.etiqueta === 'MG99'), x = D.bolsones.find((b) => b.etiqueta === 'MS2');
    return { terminado: { estado: t.estado, metros: metrosAct(t), rend: rendReal(t) }, sin_medicion: { metros: metrosAct(s), kg: kgAct(s) }, sin_iniciales: { consumido: pctConsumido(x) }, calib: calibracion('MS') };
  });
  await ir(admin, 'panel');
  const pan = await textoPantalla(admin);
  anotar('F1.2', 'Sin medición → s/d; sin metros iniciales → consumido s/d; terminado con 0 → 0', v.sin_medicion.metros === null && v.sin_iniciales.consumido === null && v.terminado.metros === 0 && v.terminado.estado === 'terminado',
    { valores: v, fila_panel_MG99: pan.match(/MG99[^\n]*/)?.[0] });
  anotar('F1.4', 'Rendimiento real 330.000 kg / 70 m = 4.714 kg/m y aviso de desvío (+17,9 %)', Math.abs(v.terminado.rend - 330000 / 70) < 1e-9 && /Maíz Silo: los 1 bolsón\(es\) terminados/.test(pan), { rend: v.terminado.rend, aviso: pan.match(/⚠ Maíz Silo: los 1[^\n]*/)?.[0] });
  // F1.5 JSON viejo (sesiones)
  const viejo = await admin.evaluate(async (txt) => { prepararRelevamiento(JSON.parse(txt), 'mediciones.json'); const g = relev.grupos[0];
    const r = { fecha: g.fecha, tramos: g.items.length, bolsones: nBols(g.items.map((i) => ({ id: i.etiqueta, grupo: i.grupo }))), metros: g.items.reduce((s, i) => s + (i.metros || 0), 0), ya: g.ya }; relev = null; vista = 'panel'; render(); return r; },
    fs.readFileSync(path.join(DATOS, 'mediciones.json'), 'utf8'));
  anotar('F1.5', 'JSON viejo (libreta 31/7): bolsones, tramos y metros sobreviven la conversión', viejo.bolsones === VIEJO.bolsones && viejo.tramos === VIEJO.tramos && Math.abs(viejo.metros - VIEJO.metros) < 1e-9, { app: viejo, desde_el_archivo: VIEJO });
  // F2.6 archivo que no es + F2.9 sin DecompressionStream
  await ir(admin, 'carga');
  const pdf = path.join(SALIDA, 'no_es_planilla.pdf'); fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  await subir(admin, '#fPlanilla', [pdf]);
  const mPdf = await admin.$eval('.modal', (e) => e.innerText); await admin.click('#modalOk');
  await admin.evaluate(() => { window.__DS = window.DecompressionStream; delete window.DecompressionStream; globalThis.DecompressionStream = undefined; });
  await ir(admin, 'carga');
  await subir(admin, '#fPlanilla', [sucia]);
  const mDs = await admin.$eval('.modal', (e) => e.innerText); await admin.click('#modalOk');
  await admin.evaluate(() => { globalThis.DecompressionStream = window.__DS; });
  anotar('F2.6/9', 'Un archivo que no es, y un navegador sin DecompressionStream: mensaje claro', /no parece un Excel/.test(mPdf) && /guardá la planilla como CSV/.test(mDs), { pdf: mPdf.slice(0, 200), sin_ds: mDs.slice(0, 200) });
  // F2.8 sin prompt/confirm/alert
  const src = fs.readFileSync(path.join(AQUI, '../index.html'), 'utf8');
  const nativos = (src.match(/\b(prompt|confirm|alert)\s*\(/g) || []).filter((x, i, a) => true);
  const enComentario = src.split('\n').filter((l) => /\b(prompt|confirm|alert)\s*\(/.test(l));
  anotar('F2.8', 'Nada de prompt()/confirm()/alert() en el código (solo una mención en un comentario)', enComentario.every((l) => /^\s*(\/\/|\*|Reemplazan)/.test(l.trim()) || /Reemplazan a prompt/.test(l)), { lineas: enComentario });
  // F2.11 mover + F2.14 deshacer + F2.12 máquina + F2.13 ya no está
  const pos = async () => (await sql(`select etiqueta, fila, posicion::int p from bolsones where estado <> 'retirado' order by fila, posicion`));
  const p0 = await pos();
  const terceroA = p0.filter((x) => x.fila === 'A')[2];
  await admin.evaluate((et) => { const b = D.bolsones.find((x) => x.etiqueta === et); moverBolson(b.id, 'B', 1); }, terceroA.etiqueta);
  await listo(admin);
  const p1 = await pos();
  const consec = (fl) => { const xs = p1.filter((x) => x.fila === fl).map((x) => x.p); return xs.every((x, i) => x === i + 1); };
  const plan = 'fase 5: la planilla sale en blanco y no lista bolsones (el orden lo pone el recorrido)';
  const carga = await admin.evaluate(() => recorrido().filter((b) => b.ubicacion.fila === 'B')[0].etiqueta);
  anotar('F2.11', 'Mover el 3.º de la pasada A al 1.º de la B: posiciones consecutivas, sin repetidos; el recorrido de Carga en el orden nuevo',
    consec('A') && consec('B') && p1.find((x) => x.etiqueta === terceroA.etiqueta).fila === 'B' && p1.find((x) => x.etiqueta === terceroA.etiqueta).p === 1 && carga === terceroA.etiqueta,
    { movido: terceroA.etiqueta, A: p1.filter((x) => x.fila === 'A').map((x) => x.p).join(','), B: p1.filter((x) => x.fila === 'B').map((x) => x.p).join(','), primera_de_B_en_carga: carga, planilla: plan });
  await admin.evaluate(() => deshacer()); await listo(admin);
  const p2 = await pos();
  anotar('F2.14', 'Deshacer: la playa vuelve exactamente a como estaba (las ediciones quedan en cambios)', JSON.stringify(p2) === JSON.stringify(p0),
    { iguales: JSON.stringify(p2) === JSON.stringify(p0), cambios_registrados: (await sql(`select count(*)::int n from cambios where tabla='bolsones' and operacion='UPDATE'`))[0].n });
  const mg5 = (await sql(`select id from bolsones where etiqueta='MG5'`))[0].id;
  await admin.evaluate((id) => engancharMaquina(id, 'en_uso'), mg5); await listo(admin);
  const e1 = await sql(`select estado, fecha_apertura::text from bolsones where id=$1`, [mg5]);
  await admin.evaluate((id) => desengancharMaquina(id), mg5); await listo(admin);
  const e2 = await sql(`select estado from bolsones where id=$1`, [mg5]);
  const evs = await sql(`select tipo, fecha::text, detalle from eventos where bolson_id=$1 and tipo in ('apertura','nota') order by cargado_en`, [mg5]);
  anotar('F2.12', 'Extractora: en uso con evento fechado; sacarla: cerrado con otro evento', e1[0].estado === 'en_uso' && e2[0].estado === 'cerrado' && evs.length === 2, { en_uso: e1[0], despues: e2[0], eventos: evs });
  const mg6 = (await sql(`select id from bolsones where etiqueta='MG6'`))[0].id;
  const tot0 = await admin.evaluate(() => vivos().filter((b) => b.alimento === 'MG').length);
  await admin.evaluate((id) => ponerEstado(id, 'retirado', 'ya no está'), mg6); await listo(admin);
  const tot1 = await admin.evaluate(() => vivos().filter((b) => b.alimento === 'MG').length);
  const medKept = await sql(`select count(*)::int n from mediciones where bolson_id=$1`, [mg6]);
  await ir(admin, 'mapa');
  const enMapa = await admin.$(`.bolg[data-ficha="${mg6}"]`);
  anotar('F2.13', '«Ya no está» saca de totales y mapa y conserva las mediciones (el borrado definitivo ya no existe: nada se pisa)', tot1 === tot0 - 1 && medKept[0].n === 1 && !enMapa, { vivos_MG_antes: tot0, despues: tot1, mediciones_conservadas: medKept[0].n });
  // F2.15 con el dedo, a 375 px: dos toques sin arrastrar
  await admin.setViewport({ width: 375, height: 800, isMobile: true, hasTouch: true });
  await ir(admin, 'mapa'); await espera(300);
  const mg7 = (await sql(`select id, fila, posicion::int p from bolsones where etiqueta='MG7'`))[0];
  const g = await admin.$(`.bolg[data-ficha="${mg7.id}"]`);
  await g.evaluate((el) => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1, clientY: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 1, clientY: 1 })); });
  await espera(200);
  const elegido = await admin.evaluate(() => selMapa);
  const destino = await admin.$('.hueco[data-fila="A"][data-pos="1"]');
  await destino.evaluate((el) => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
  await listo(admin);
  const mg7b = (await sql(`select fila, posicion::int p from bolsones where id=$1`, [mg7.id]))[0];
  anotar('F2.15', 'Mapa a 375 px: tocar el bolsón y tocar el lugar lo mueve, sin arrastrar', elegido === mg7.id && mg7b.fila === 'A' && mg7b.p === 1 && mg7.p > 1, { antes: mg7, despues: mg7b });
  await admin.evaluate(() => deshacer()); await listo(admin);
  await admin.setViewport({ width: 1100, height: 900 });
});

// ═══════════ 15 · 375 px ═══════════
await paso('15', 'Login, bandeja y revisión usables a 375 px', async () => {
  const c = await navegador.createBrowserContext(); const p = await c.newPage();
  await p.setViewport({ width: 375, height: 760, isMobile: true, hasTouch: true });
  await p.goto(APP); await p.waitForSelector('#formLogin');
  const anchoLogin = await p.evaluate(() => document.documentElement.scrollWidth);
  const tLogin = await p.evaluate(MEDIR);
  const txtLogin = await p.$eval('#pantalla', (e) => e.innerText.replace(/\s+/g, ' '));
  anotar('G', 'El login ya no habla de un mail de invitación', /La cuenta te la crea Iñaki/.test(txtLogin) && !/mail de invitación/.test(txtLogin), { texto: txtLogin.slice(0, 220) });
  await p.screenshot({ path: path.join(SALIDA, 'login_375.png') });
  await c.close();
  const tactil = { login: tLogin };
  await admin.setViewport({ width: 375, height: 800, isMobile: true, hasTouch: true });
  await admin.evaluate(() => { cargaModo = null; vista = 'carga'; render(); }); await espera(150);
  tactil.carga_elegir = await admin.evaluate(MEDIR);
  await admin.evaluate(() => { cargaModo = 'mano'; render(); document.querySelectorAll('#pantalla details').forEach((d) => { d.open = true; }); }); await espera(150);
  tactil.carga_a_mano = await admin.evaluate(MEDIR);
  await admin.screenshot({ path: path.join(SALIDA, 'carga_mano_375.png') });
  await admin.evaluate(() => { cargaBuf = {}; cargaModo = null; render(); });
  await ir(admin, 'carga');
  await subir(admin, '#fPlanilla', [path.join(DATOS, 'mediciones_2026-11-11.csv'), path.join(DATOS, 'materia_seca_2026-11-11.csv')]);
  await admin.waitForSelector('#revOk');
  const anchoRev = await admin.evaluate(() => document.documentElement.scrollWidth);
  await admin.evaluate(() => document.querySelectorAll('#pantalla details').forEach((d) => { d.open = true; }));
  tactil.revision = await admin.evaluate(MEDIR);
  await admin.screenshot({ path: path.join(SALIDA, 'revision_375.png'), fullPage: true });
  await admin.click('#revCancel');
  await ir(admin, 'auditoria');
  const anchoBand = await admin.evaluate(() => document.documentElement.scrollWidth);
  tactil.bandeja_admin = await admin.evaluate(MEDIR);
  await admin.screenshot({ path: path.join(SALIDA, 'bandeja_admin_375.png') });
  // la bandeja y un lote abierto, como los ve Nico (con el formulario de auditar)
  const nico = globalThis.nico; await nico.setViewport({ width: 375, height: 800, isMobile: true, hasTouch: true });
  await nico.evaluate(() => { auditLote = null; vista = 'auditoria'; render(); }); await espera(150);
  tactil.bandeja_auditor = await nico.evaluate(MEDIR);
  await nico.evaluate((id) => { auditLote = id; render(); document.querySelectorAll('#pantalla details').forEach((d) => { d.open = true; }); }, lote1.id); await espera(150);
  tactil.lote_auditor = await nico.evaluate(MEDIR);
  await nico.screenshot({ path: path.join(SALIDA, 'lote_auditor_375.png'), fullPage: true });
  const malos = Object.values(tactil).flatMap((x) => x.malos);
  anotar('15', 'A 375 px: sin scroll horizontal y ningún control táctil de menos de 44 × 44 px en login, carga, revisión y bandeja',
    anchoLogin <= 375 && anchoRev <= 375 && anchoBand <= 375 && malos.length === 0,
    { ancho_login: anchoLogin, ancho_revision: anchoRev, ancho_bandeja: anchoBand,
      controles_medidos: Object.fromEntries(Object.entries(tactil).map(([k, v]) => [k, v.total])), de_menos_de_44px: malos });
  await admin.setViewport({ width: 1100, height: 900 });
});

// ═══════════ fase 4 · 5 · auditoría compartida ═══════════
await paso('V5', 'Auditoría compartida', async () => {
  await admin.setViewport({ width: 1100, height: 900 });
  const lote = (await sql(`select id, cargado_por from importaciones where fecha_medicion='2026-11-25' and tipo='planilla'`))[0];
  // Iñaki, que cargó el lote, lo audita OK
  await admin.evaluate((id) => { vista = 'auditoria'; auditLote = id; render(); }, lote.id);
  const avisoPropio = await admin.$eval('#pantalla', (e) => (e.innerText.match(/Este lote lo cargaste vos[^\n]*/) || [''])[0]);
  await admin.$eval('#btnAuditarOk', (e) => e.click()); await listo(admin);
  const a1 = (await sql(`select estado_auditoria from importaciones where id=$1`, [lote.id]))[0].estado_auditoria;
  const audI = await sql(`select resultado, es_quien_cargo, anulada from auditorias where importacion_id=$1 and auditor=$2`, [lote.id, banco.ids.admin]);
  // Nico lo observa
  const nico = globalThis.nico; await nico.setViewport({ width: 1100, height: 900 });
  await nico.evaluate(() => recargar()); await listo(nico);
  await nico.evaluate((id) => { vista = 'auditoria'; auditLote = id; render(); }, lote.id);
  await nico.type('#audCom', 'MS3 terminado con 0 m: confirmar que se terminó (prueba)');
  await nico.$eval('#btnAuditarObs', (e) => e.click()); await listo(nico);
  const a2 = (await sql(`select estado_auditoria from importaciones where id=$1`, [lote.id]))[0].estado_auditoria;
  // Nico vuelve a auditar OK
  await nico.$eval('#btnAuditarOk', (e) => e.click()); await listo(nico);
  const a3 = (await sql(`select estado_auditoria from importaciones where id=$1`, [lote.id]))[0].estado_auditoria;
  const audN = await sql(`select resultado, es_quien_cargo, anulada, anulada_motivo, anulada_por = auditor as la_anulo_el_mismo from auditorias where importacion_id=$1 and auditor=$2 order by en`, [lote.id, banco.ids.auditor]);
  const cam = (await sql(`select count(*)::int n from cambios where tabla='auditorias' and operacion='UPDATE'`))[0].n;
  // Silvana no puede auditar
  const sil = (await banco.sesionDe('lectura')).access_token;
  const s1 = await rest('POST', '/rest/v1/rpc/auditar', { token: sil, cuerpo: { p_id: '00000000-0000-0000-0000-0000000000f1', p_importacion: lote.id, p_medicion: null, p_resultado: 'ok', p_comentario: '' } });
  const s2 = await rest('POST', '/rest/v1/auditorias', { token: sil, cuerpo: { importacion_id: lote.id, resultado: 'ok', auditor: banco.ids.lectura } });
  // la bandeja: una columna por auditor
  await admin.evaluate(() => recargar()); await listo(admin);
  await admin.evaluate(() => { vista = 'auditoria'; auditLote = null; filtroAud = 'todos'; render(); });
  const fila = await admin.$eval('#pantalla', (e) => (e.innerText.match(/25\/11\/2026[^\n]*\n[\s\S]{0,200}/) || [''])[0].replace(/\s+/g, ' '));
  const cabecera = await admin.$eval('#pantalla thead', (e) => e.innerText.replace(/\s+/g, ' '));
  anotar('V5', 'Auditoría compartida: OK de quien cargó → auditado (control de quien cargó); Nico observa → observado; Nico OK → su observación anulada con motivo y vuelve a auditado; Silvana 403',
    /control de quien cargó/.test(avisoPropio) && a1 === 'ok' && audI.length === 1 && audI[0].es_quien_cargo === true
      && a2 === 'observada' && a3 === 'ok' && audN.length === 2 && audN[0].resultado === 'observada' && audN[0].anulada === true && /Reemplazada/.test(audN[0].anulada_motivo)
      && audN[0].la_anulo_el_mismo && audN[1].resultado === 'ok' && !audN[1].anulada && audN.every((x) => x.es_quien_cargo === false)
      && s1.status === 403 && s2.status === 403 && /IÑAKI/.test(cabecera) && /NICO/.test(cabecera) && cam >= 1,
    { aviso_antes_de_guardar: avisoPropio, estado_tras_ok_de_inaki: a1, auditoria_de_inaki: audI, tras_observacion_de_nico: a2, tras_ok_de_nico: a3,
      auditorias_de_nico: audN, updates_en_cambios: cam, silvana_rpc: [s1.status, s1.j && s1.j.message], silvana_directo: [s2.status, s2.j && s2.j.message],
      bandeja: { columnas: cabecera, fila } });
});

// ═══════════ fase 4 · 6b · contraste con un portal a 3 días ═══════════
await paso('V6', 'Contraste a 3 días', async () => {
  const fb = await admin.evaluate(() => fechaUltimaMed(vivos().filter((b) => b.alimento === 'MG' && metrosAct(b) !== null)));
  const fp = new Date(new Date(fb + 'T00:00:00Z').getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const antes = await admin.evaluate(() => clonar(D.referencia));
  await admin.evaluate((fp) => guardarReferencia((r) => { r.fecha = fp; }), fp); await listo(admin);
  await ir(admin, 'panel');
  const portal = ((await textoPantalla(admin)).match(/Contraste con el portal[\s\S]{0,2500}/) || [''])[0];
  const mg = (portal.match(/Maíz Grano[^\n]*(\n[^\n]*){0,8}/) || [''])[0].replace(/\s+/g, ' ');
  anotar('V6', 'Contraste: con un portal a 3 días de la medición sí compara (diferencia y conclusión)',
    !/Fechas distintas/.test(portal) && /[+-]\d+,\d %/.test(mg) && /(cierra:|el portal tiene más|los bolsones dan más|deja afuera)/.test(portal) && /Se compara con fechas a 7 días o menos/.test(portal),
    { bolsones_MG_al: fb, portal_al: fp, fila_MG: mg.slice(0, 300) });
  await admin.evaluate((r0) => guardarReferencia((r) => { r.fecha = r0.fecha; }), antes); await listo(admin);
});

// ═══════════ 13 · respaldo: exportar, restaurar en otro proyecto, comparar ═══════════
await paso('13', 'Respaldo idéntico', async () => {
  // lo que la app "descarga" se intercepta en bajar(), la misma función que dispara la descarga
  const capturar = (p) => p.evaluate(() => { window.__bajado = null; bajar = (txt, nombre) => { window.__bajado = { txt, nombre }; }; });
  const bajado = async (p) => { await p.waitForFunction(() => window.__bajado, { timeout: 30000 }); return p.evaluate(() => window.__bajado); };
  await ir(admin, 'param'); await capturar(admin); await admin.click('#btnExp');
  const d1 = await bajado(admin); const archivo = d1.nombre;
  const dir = path.join(SALIDA, 'descargas'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, archivo), d1.txt);
  const resp = JSON.parse(d1.txt);
  // proyecto de prueba: otra base vacía, con otros usuarios
  const otroBanco = await crearBanco();
  const URL2 = `${otroBanco.url}/?api=${otroBanco.url}`;
  const c = await navegador.createBrowserContext(); const p = await c.newPage();
  await p.goto(URL2); await p.waitForSelector('#formLogin');
  await p.type('#lgEmail', USUARIOS.admin.email); await p.type('#lgClave', USUARIOS.admin.clave); await p.click('#btnEntrar');
  await p.waitForFunction(() => yo && !pantallaAuth); await listo(p);
  await p.click('nav button[data-p="param"]'); await listo(p);
  await (await p.waitForSelector('#fImp')).uploadFile(path.join(dir, archivo)); await p.waitForSelector('#btnRestaurar');
  const aviso = await p.$eval('#pantalla', (e) => e.innerText);
  await p.$eval('#btnRestaurar', (e) => e.click()); await p.waitForFunction(() => restauracion && restauracion.resultado, { timeout: 30000 });
  const resultado = await p.evaluate(() => restauracion.resultado);
  // exportar desde la base nueva y comparar
  await p.$eval('#volverParam', (e) => e.click()); await espera(200); await capturar(p); await p.$eval('#btnExp', (e) => e.click());
  const resp2 = JSON.parse((await bajado(p)).txt);
  fs.writeFileSync(path.join(dir, 'respaldo_reexportado_de_la_base_restaurada.json'), JSON.stringify(resp2));
  const canon = (t) => JSON.stringify([...t].sort((x, y) => String(x.id || x.clave).localeCompare(String(y.id || y.clave))));
  const comp = {}; let todo = true;
  for (const t of ['parametros', 'importaciones', 'relevamientos', 'relevamiento_items', 'bolsones', 'mediciones', 'eventos', 'calidad', 'auditorias']) {
    const igual = canon(resp.tablas[t]) === canon(resp2.tablas[t]);
    comp[t] = `${resp.tablas[t].length} filas · ${igual ? 'idéntica' : 'DISTINTA'}`; todo = todo && igual;
  }
  anotar('13', 'Exportar desde la base, restaurar en otra base vacía, volver a exportar: idéntico tabla por tabla', todo,
    { comparacion: comp, resultado_restauracion: resultado, aviso: aviso.match(/Qué se pisa[^\n]*/)?.[0], archivo });
  fs.copyFileSync(path.join(dir, archivo), path.join(SALIDA, 'respaldo_de_prueba.json'));
  await c.close(); await otroBanco.cerrar();
});

// diálogos nativos: ninguno en toda la corrida
fs.writeFileSync(path.join(SALIDA, 'resultados.json'), JSON.stringify(resultados, null, 1));
const fallas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallas.length} de ${resultados.length} verificaciones OK${fallas.length ? ' · FALLAN: ' + fallas.map((f) => f.id).join(', ') : ''}`);
await navegador.close(); await banco.cerrar();
process.exit(fallas.length ? 1 : 0);
