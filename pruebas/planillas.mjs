// Verificaciones de la fase 5: las planillas simples para Silvana.
//
//   node planillas.mjs "<carpeta datos>" "<carpeta diseno/planillas>" "<carpeta de salida>"
//
// Arma en el banco el estado de la base real (31/7 y 13/8, el silo del 13/8
// vinculado y el lote del 11/11: 25 de maíz y 5 de silo vivos), y desde ahí:
// genera las dos planillas con la app, las llena por código con los valores
// del 11/11 de datos/, las vuelve a guardar con LibreOffice y las importa.
// Ningún número esperado está escrito acá: salen de datos/ y de totales.py.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crearBanco, USUARIOS, CLAVE_PUBLICA } from './servidor_prueba.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.resolve(process.argv[2] || path.join(AQUI, '../../datos'));
const PLANILLAS = path.resolve(process.argv[3] || path.join(AQUI, '../../diseno/planillas'));
const SALIDA = path.resolve(process.argv[4] || path.join(AQUI, 'salida-planillas'));
fs.mkdirSync(SALIDA, { recursive: true });
const NAVEGADOR = [process.env.NAVEGADOR, 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((x) => x && fs.existsSync(x));
const SOFFICE = [process.env.SOFFICE, 'C:/Program Files/LibreOffice/program/soffice.exe'].find((x) => x && fs.existsSync(x));
const PERFIL_LO = pathToFileURL(path.join(SALIDA, 'perfil-libreoffice')).href;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const resultados = [];
const anotar = (id, nombre, ok, evidencia) => { resultados.push({ id, nombre, ok: !!ok, evidencia });
  console.log(`${ok ? 'OK  ' : 'FALLA'} [${id}] ${nombre}\n      ${JSON.stringify(evidencia).slice(0, 1500)}`); };
async function paso(id, nombre, fn) { try { await fn(); } catch (e) { anotar(id, nombre, false, { error: String(e && e.stack || e).slice(0, 900) }); } }
const py = (...a) => JSON.parse(execFileSync('python', ['-I', ...a], { encoding: 'utf8' }));
const lo = (formato, archivo, dir) => { fs.mkdirSync(dir, { recursive: true });
  execFileSync(SOFFICE, [`-env:UserInstallation=${PERFIL_LO}`, '--headless', '--convert-to', formato, '--outdir', dir, archivo], { stdio: 'pipe', timeout: 180000 });
  return path.join(dir, path.basename(archivo).replace(/\.[^.]+$/, '.' + formato.split(':')[0])); };

// ── lo que dicen los archivos ──
const leerCsv = (f) => { const [h, ...rs] = fs.readFileSync(path.join(DATOS, f), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).map((l) => l.split(';'));
  return rs.map((x) => Object.fromEntries(h.map((k, i) => [k, x[i]]))); };
const CSV = leerCsv('mediciones_2026-11-11.csv');
const MSCSV = leerCsv('materia_seca_2026-11-11.csv');
const PY = py(path.join(AQUI, 'totales.py'), DATOS)['2026-11-11'];
const serial = (iso) => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000;
const SILO = MSCSV.find((x) => /silo/i.test(x.muestra)), DIETA = MSCSV.find((x) => /dieta/i.test(x.muestra));
const P = (x, k) => Number(x[k]);
// tercera pesada de la dieta: inventada, 0,5 g menos que la última (para que llegue a peso constante)
const DIETA3 = P(DIETA, 'peso_15min_g') - 0.5;
const ultimaFrase = (t) => String(t).split(/\.\s+/).pop().replace(/\.$/, '');

// ── el banco con el estado de la base real ──
const banco = await crearBanco();
const B = banco.url, APP = `${B}/?api=${B}`;
const sql = async (q, p = []) => (await banco.db.query(q, p)).rows;
const nav = await puppeteer.launch({ executablePath: NAVEGADOR, headless: true, args: ['--no-first-run'] });
async function listo(p) { await p.waitForFunction(() => !cola.length && conexion !== 'guardando' && !vaciando && !cargando, { timeout: 30000 }); await espera(200); }
async function entrar(usuario, ancho) {
  const c = await nav.createBrowserContext(); const p = await c.newPage();
  await p.setViewport({ width: ancho, height: 1000 });
  await p.goto(APP); await p.waitForSelector('#formLogin');
  await p.type('#lgEmail', USUARIOS[usuario].email); await p.type('#lgClave', USUARIOS[usuario].clave); await p.$eval('#btnEntrar', (e) => e.click());
  await p.waitForFunction(() => yo && !pantallaAuth); await listo(p); return p;
}
const ir = async (p, v, extra = '') => { await p.evaluate(new Function(`vista=${JSON.stringify(v)}; ${extra}; aviso=null; window.scrollTo(0,0); render();`)); await espera(200); };
async function subir(p, archivos) {
  await ir(p, 'carga', 'cargaModo=null; staging=null');
  await (await p.$('#fPlanilla')).uploadFile(...archivos); await p.waitForSelector('#revOk', { timeout: 15000 }); await espera(200);
}
async function cancelar(p) { await p.$eval('#revCancel', (e) => e.click()); await espera(200); }
const filasStaging = (p) => p.evaluate(() => staging.filas.map((f) => ({ et: f.etiqueta, ali: f.alimento, txt: f.metrosTxt, m: f.metros, nivel: f.diag.nivel,
  lin: f.diag.lin.join(' | '), marcas: f.diag.marcas.join(' | ').replace(/<[^>]+>/g, ''), nota: f.nota, prop: f.notaProp, estado: f.estado })));
const sumas = (filas) => { const t = {}; filas.filter((f) => typeof f.m === 'number').forEach((f) => { const x = t[f.ali] = t[f.ali] || { m: 0, n: 0 }; x.m += f.m; x.n++; });
  Object.values(t).forEach((x) => { x.m = x.m.toFixed(1); }); return t; };
const igualPy = (t) => ['MG', 'MS'].every((k) => t[k] && Number(t[k].m) === Number(PY[k].m) && t[k].n === PY[k].n);

const iñaki = await entrar('admin', 1440);
await ir(iñaki, 'param');
for (const f of ['silobolsa_2026-07-31.json', 'silobolsa_2026-08-13.json']) {
  await (await iñaki.$('#fImp')).uploadFile(path.join(DATOS, f)); await iñaki.waitForSelector('#relOk');
  await iñaki.$eval('#relOk', (e) => e.click()); await listo(iñaki); await ir(iñaki, 'param');
}
const r13 = (await sql(`select id from relevamientos where fecha='2026-08-13'`))[0];
const tok = (await banco.sesionDe('admin')).access_token;
await fetch(`${B}/rest/v1/rpc/vincular_desde_relevamiento`, { method: 'POST', headers: { apikey: CLAVE_PUBLICA, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_relevamiento: r13.id, p_alimento: 'MS', p_motivo: 'Confirmado por Iñaki: mismo orden que la hoja del 11/11' }) });
await iñaki.evaluate(() => recargar()); await listo(iñaki);
await subir(iñaki, fs.readdirSync(DATOS).filter((f) => /_2026-11-11\.csv$/.test(f)).map((f) => path.join(DATOS, f)));
await iñaki.$eval('#revQuien', (e) => { e.value = 'Silvana'; e.dispatchEvent(new Event('input')); });
for (let i = 0; i < 12; i++) { const cb = await iñaki.$('input[data-rv="confirmado"]:not(:checked)'); if (!cb) break; await cb.evaluate((e) => e.click()); await espera(80); }
await iñaki.$eval('#revOk', (e) => e.click()); await listo(iñaki);
console.log('banco listo:', JSON.stringify(await sql(`select alimento, count(*)::int n from bolsones where estado not in ('retirado','terminado') group by 1 order by 1`)));

async function bajarPlanilla(nombre) {
  const bytes = await iñaki.evaluate(() => Array.from(planillaXlsx()));
  const f = path.join(SALIDA, nombre); fs.writeFileSync(f, Buffer.from(bytes)); return f;
}
function llenar(enBlanco, nombre, celdas) {
  const spec = path.join(SALIDA, nombre.replace(/\.xlsx$/, '.json')); fs.writeFileSync(spec, JSON.stringify(celdas));
  const f = path.join(SALIDA, nombre); execFileSync('python', ['-I', path.join(AQUI, 'llenar_planilla.py'), enBlanco, f, spec]); return f;
}
// fila de la hoja Mediciones para el N° de un alimento (los bloques arrancan en la fila 7, en el orden de la planilla)
const filaDe = (bloques, k, num) => { let r = 7; for (const b of bloques) { if (b.k === k) return r + num - 1; r += b.n; } throw new Error('sin bloque ' + k); };

// ═══════════ 1 · ida y vuelta con el Excel ═══════════
let llena = null, bloques = null;
await paso('1', 'Ida y vuelta con el Excel', async () => {
  await ir(iñaki, 'carga', 'cargaModo=null; plCfg={}');
  bloques = await iñaki.evaluate(() => bloquesPlanilla().filter((b) => b.on).map((b) => ({ k: b.k, n: b.n, vivos: b.vivos })));
  const fuera = await iñaki.evaluate(() => bloquesPlanilla().filter((b) => !b.on).map((b) => b.nombre));
  const textoCarga = await iñaki.$eval('#pantalla', (e) => e.innerText);
  const enBlanco = await bajarPlanilla('planilla_en_blanco.xlsx');
  const comp = py(path.join(AQUI, 'revisar_xlsx.py'), 'comparar', enBlanco, path.join(PLANILLAS, 'planilla_silvana.xlsx'));
  const textosBlanco = py(path.join(AQUI, 'revisar_xlsx.py'), 'textos', enBlanco);
  // los valores del 11/11, como los cargaría Silvana en el Excel
  const med = { B3: serial('2026-11-18'), B4: 'Silvana' };
  CSV.forEach((r) => { const num = +r.etiqueta.replace(/^\D+/, ''), q = filaDe(bloques, r.alimento, num);
    med['C' + q] = Number(r.metros_restantes); if (r.estado_anotado) med['D' + q] = r.nota; });
  const silo = SILO, dieta = DIETA;
  const hum = { C5: Number(silo.peso_10min_g), D5: Number(silo.peso_15min_g), K5: ultimaFrase(silo.nota),
                C6: Number(dieta.peso_10min_g), D6: Number(dieta.peso_15min_g), K6: ultimaFrase(dieta.nota) };
  llena = llenar(enBlanco, 'planilla_llena_11_11.xlsx', { Mediciones: med, Humedad: hum });
  await subir(iñaki, [llena]);
  const fs1 = await filasStaging(iñaki);
  const st = await iñaki.evaluate(() => ({ fecha: staging.fecha, quien: staging.quien, formato: staging.formato.txt,
    ms: staging.ms.map((m) => ({ nombre: m.nombre, pct: m.calc.pct, constante: m.calc.constante, origen: m.origen, por: m.origenPor, faltantes: m.faltantes, nivel: m.diag.nivel })) }));
  const pantalla = await iñaki.$eval('#pantalla', (e) => e.innerText);
  const t = sumas(fs1);
  await iñaki.evaluate(() => { staging.filas.forEach((f) => { if (f.asignado && f.asignado !== 'nuevo') { f.confirmado = true; f.tocado = true; } }); procesarStaging(); render(); });
  const bloq = await iñaki.evaluate(() => (document.querySelector('#revBloqueos') || {}).innerText || '');
  await iñaki.$eval('#revOk', (e) => e.click()); await listo(iñaki);
  const base = Object.fromEntries((await sql(`select b.alimento, sum(m.metros_restantes)::text m, count(*)::int n from mediciones m join bolsones b on b.id=m.bolson_id
    where m.fecha='2026-11-18' and not m.anulada group by 1`)).map((x) => [x.alimento, { m: Number(x.m).toFixed(1), n: x.n }]));
  const msBase = await sql(`select tipo, alimento, ms_pct::float pct, peso_constante, origen_tipo, ingredientes_faltantes from calidad where fecha='2026-11-18' order by tipo`);
  const siloOk = st.ms.find((m) => m.nombre === 'Silo'), dietaOk = st.ms.find((m) => m.nombre === 'Dieta');
  anotar('1', `Excel en blanco desde la app (${bloques.map((b) => b.k + ' ' + b.n).join(', ')}) → llenado con el 11/11 → importado: MG ${PY.MG.m} m y MS ${PY.MS.m} m, igual que Python`,
    bloques.length === 2 && bloques[0].k === 'MG' && bloques[0].n === 30 && bloques[1].k === 'MS' && bloques[1].n === 10 && fuera.includes('Gluten')
      && /Agregar bloque de Gluten/.test(textoCarga) && /alcanza para los de hoy y los que se armen/.test(textoCarga)
      && textosBlanco.inlineStr > 0 && !textosBlanco.sharedStrings
      && igualPy(t) && igualPy(base) && st.fecha === '2026-11-18' && st.quien === 'Silvana' && /planilla nueva/.test(st.formato) && /Formato detectado: planilla nueva/.test(pantalla)
      && Math.abs(siloOk.pct - P(SILO, 'ms_pct_cota_superior')) < 1e-9 && siloOk.constante === false && siloOk.origen === SILO.origen_tipo
      && Math.abs(dietaOk.pct - P(DIETA, 'ms_pct_cota_superior')) < 1e-9 && dietaOk.constante === false && dietaOk.faltantes.join() === 'HG'
      && msBase.length === 2 && !bloq,
    { renglones_por_defecto: bloques, sin_bloque: fuera, python: PY, app_al_importar: t, base_al_guardar: base, fecha: st.fecha, midio: st.quien, formato: st.formato,
      humedad: st.ms, en_la_base: msBase, textos_de_la_planilla_en_blanco: { inlineStr: textosBlanco.inlineStr, sharedStrings: textosBlanco.sharedStrings },
      comparacion_con_la_referencia: { hojas: comp.hojas, celdas_iguales: comp.iguales, diferencias: comp.diferencias,
        estructura_igual: Object.fromEntries(Object.entries(comp.estructura).map(([k, v]) => [k, v.igual])), estructura: comp.estructura } });
  fs.writeFileSync(path.join(SALIDA, 'comparacion_con_referencia.json'), JSON.stringify(comp, null, 1));
});

// ═══════════ 2 · el mismo archivo, guardado por LibreOffice ═══════════
let llenaLo = null;
await paso('2', 'Guardado por LibreOffice', async () => {
  llenaLo = lo('xlsx', llena, path.join(SALIDA, 'libreoffice'));
  const tx = py(path.join(AQUI, 'revisar_xlsx.py'), 'textos', llenaLo);
  const val = py(path.join(AQUI, 'revisar_xlsx.py'), 'valores', llenaLo);
  const contador = (val.valores.Mediciones.find((x) => x[0] === 'D4') || [])[1];
  await subir(iñaki, [llenaLo]);
  const fs2 = await filasStaging(iñaki);
  const st = await iñaki.evaluate(() => ({ fecha: staging.fecha, quien: staging.quien, formato: staging.formato.txt, ms: staging.ms.map((m) => [m.nombre, m.calc.pct, m.calc.constante, m.origen, m.faltantes.join()]) }));
  await cancelar(iñaki);
  const t = sumas(fs2);
  anotar('2', 'El mismo archivo vuelto a guardar con LibreOffice (sharedStrings, sin inlineStr) se lee igual',
    tx.sharedStrings && tx.inlineStr === 0 && igualPy(t) && st.fecha === '2026-11-18' && st.quien === 'Silvana' && /planilla nueva/.test(st.formato)
      && JSON.stringify(st.ms) === JSON.stringify([['Silo', P(SILO, 'ms_pct_cota_superior'), false, SILO.origen_tipo, ''], ['Dieta', P(DIETA, 'ms_pct_cota_superior'), false, 'mixer', 'HG']]),
    { textos: { sharedStrings: tx.sharedStrings, textos_compartidos: tx.textos_compartidos, inlineStr: tx.inlineStr }, app: t, python: PY, fecha: st.fecha, midio: st.quien,
      humedad: st.ms, contador_calculado_por_libreoffice: contador, errores_de_formula: val.errores });
});

// ═══════════ 3 · las fórmulas de Humedad, calculadas por LibreOffice ═══════════
await paso('3', 'Fórmulas de Humedad', async () => {
  const enBlanco = path.join(SALIDA, 'planilla_en_blanco.xlsx');
  const f = llenar(enBlanco, 'humedad_formulas.xlsx', { Humedad: { C5: P(SILO, 'peso_10min_g'), D5: P(SILO, 'peso_15min_g'),
    C6: P(DIETA, 'peso_10min_g'), D6: P(DIETA, 'peso_15min_g'), E6: DIETA3 } });
  const calc = lo('xlsx', f, path.join(SALIDA, 'libreoffice-formulas'));
  const val = py(path.join(AQUI, 'revisar_xlsx.py'), 'valores', calc);
  const h = Object.fromEntries(val.valores.Humedad.map(([c, v, fmt]) => [c, { v, fmt }]));
  const sg = [P(SILO, 'peso_10min_g'), P(SILO, 'peso_15min_g')], dg = [P(DIETA, 'peso_10min_g'), P(DIETA, 'peso_15min_g'), DIETA3];
  anotar('3', `LibreOffice: ${sg.join(' → ')} g da ${sg[1]} % y «no: seguir pesando»; ${dg.join(' → ')} g da ${dg[2]} % y «sí»; sin errores de fórmula`,
    Math.abs(h.I5.v - sg[1] / 100) < 1e-9 && h.J5.v === 'no: seguir pesando' && Math.abs(h.I6.v - dg[2] / 100) < 1e-9 && h.J6.v === 'sí'
      && h.G6.v === dg[2] && h.H6.v === dg[1] && val.errores.length === 0 && h.I6.fmt === '0.0%',
    { silo: { ultimo: h.G5.v, anterior: h.H5.v, ms: h.I5.v, constante: h.J5.v }, dieta: { ultimo: h.G6.v, anterior: h.H6.v, ms: h.I6.v, formato: h.I6.fmt, constante: h.J6.v },
      fila_vacia: { ms: (h.I7 || {}).v ?? '(vacía)', constante: (h.J7 || {}).v ?? '(vacía)' }, errores: val.errores });
});

// ═══════════ 4 · metros como los escribe Silvana ═══════════
await paso('4', 'Metros como los escribe Silvana', async () => {
  const lista = ['67.10', '67:80 cm', '2.70', '67,8', 'sesenta', '67:80', '67 m 80 cm', '67:8', ''];
  const directo = await iñaki.evaluate((xs) => xs.map((x) => { const r = metrosDe(x); return [x, r.v === undefined ? 'revisar' : r.v]; }), lista);
  const enBlanco = path.join(SALIDA, 'planilla_en_blanco.xlsx');
  const q = (num) => filaDe(bloques, 'MG', num);
  const f = llenar(enBlanco, 'metros_como_escribe_silvana.xlsx', { Mediciones: { B3: '19/11/2026',
    ['C' + q(1)]: '67.10', ['C' + q(2)]: '67:80 cm', ['C' + q(3)]: '2.70', ['C' + q(4)]: '67,8', ['C' + q(5)]: 'sesenta', ['C' + q(7)]: 0 } });
  await subir(iñaki, [f]);
  const fs4 = await filasStaging(iñaki);
  const sinMedir = await iñaki.evaluate(() => staging.sinMedir);
  const pantalla = await iñaki.$eval('#pantalla', (e) => e.innerText);
  await iñaki.screenshot({ path: path.join(SALIDA, 'revision-metros.png'), fullPage: true });
  await cancelar(iñaki);
  const de = (et) => fs4.find((x) => x.et === et) || {};
  const hora = path.join(SALIDA, 'metros_guardados_como_hora.xlsx'); py(path.join(AQUI, 'revisar_xlsx.py'), 'hora', hora);
  await subir(iñaki, [hora]);
  const fh = await filasStaging(iñaki); await cancelar(iñaki);
  const orden = ['MG1', 'MG2', 'MG3', 'MG4', 'MG5'].map((et) => de(et).nivel === 'revisar' && de(et).m === undefined ? 'revisar' : de(et).m);
  anotar('4', '67.10, 67:80 cm, 2.70, 67,8 y sesenta dan 67,1, 67,8, 2,7, 67,8 y «revisar»; vacío no da medición; 0 en un bolsón no terminado da error',
    JSON.stringify(orden) === JSON.stringify([67.1, 67.8, 2.7, 67.8, 'revisar']) && /No entiendo «sesenta» como metros/.test(de('MG5').lin) && /sesenta/.test(pantalla)
      && !fs4.some((x) => x.et === 'MG6') && sinMedir.MG === 30 - 6 && sinMedir.MS === 10
      && de('MG7').m === 0 && de('MG7').nivel === 'error' && /Dice 0 m/.test(de('MG7').lin)
      && JSON.stringify(directo.slice(0, 5).map((x) => x[1])) === JSON.stringify([67.1, 67.8, 2.7, 67.8, 'revisar'])
      && fh.length === 1 && fh[0].m === 67.3,
    { en_ese_orden: orden, metrosDe: directo, renglones: fs4.map((x) => ({ et: x.et, escrito: x.txt, metros: x.m, nivel: x.nivel, por_que: x.lin.slice(0, 160) })),
      sin_medir: sinMedir, excel_lo_guardo_como_hora: fh.map((x) => ({ et: x.et, leido: x.txt, metros: x.m })) });
});

// ═══════════ 5 · notas ═══════════
await paso('5', 'Notas', async () => {
  const enBlanco = path.join(SALIDA, 'planilla_en_blanco.xlsx');
  const g = (num) => filaDe(bloques, 'MG', num), s = (num) => filaDe(bloques, 'MS', num);
  const f = llenar(enBlanco, 'notas.xlsx', { Mediciones: { B3: '20/11/2026', B4: 'Silvana',
    ['C' + g(1)]: '66,5', ['D' + g(1)]: 'sacando mixer',
    ['D' + g(2)]: 'no se pudo medir',
    ['C' + g(3)]: '67,0', ['D' + g(3)]: 'roto',
    ['C' + g(15)]: '4,1', ['D' + g(15)]: 'embolsadora',
    ['C' + s(1)]: '66,0', ['D' + s(1)]: 'se mojó la punta' } });
  await subir(iñaki, [f]);
  const f5 = await filasStaging(iñaki);
  const de = (et) => f5.find((x) => x.et === et) || {};
  await iñaki.screenshot({ path: path.join(SALIDA, 'revision-notas.png'), fullPage: true });
  // Iñaki confirma: cada renglón con el bolsón de su etiqueta; los que no vinieron, «no se midió»
  await iñaki.evaluate(() => { staging.filas.forEach((x) => { const b = D.bolsones.find((y) => y.etiqueta === x.etiqueta); x.asignado = b.id; x.tocado = true; x.confirmado = true; });
    staging.faltantes.forEach((x) => { x.decision = 'no_medido'; }); procesarStaging(); render(); });
  const bloq = await iñaki.evaluate(() => (document.querySelector('#revBloqueos') || {}).innerText || '');
  await iñaki.$eval('#revOk', (e) => e.click()); await listo(iñaki);
  const meds = await sql(`select b.etiqueta, m.metros_restantes::float m, m.nota from mediciones m join bolsones b on b.id=m.bolson_id where m.fecha='2026-11-20' order by 1`);
  const evs = await sql(`select b.etiqueta, e.tipo, e.detalle from eventos e join bolsones b on b.id=e.bolson_id where e.fecha='2026-11-20' order by 1, 2`);
  const est = Object.fromEntries((await sql(`select etiqueta, estado from bolsones where etiqueta in ('MG1','MG15')`)).map((x) => [x.etiqueta, x.estado]));
  anotar('5', '«sacando mixer» propone en uso, «embolsadora» en armado, «roto» un evento de rotura, «no se pudo medir» no da medición; cada propuesta dice de qué palabra salió',
    de('MG1').estado === 'en_uso' && /Propone estado En uso: sale de la palabra «sacando mixer»/.test(de('MG1').lin)
      && de('MG15').estado === 'armando' && /Propone estado En armado: sale de la palabra «embolsadora»/.test(de('MG15').lin)
      && de('MG3').prop && de('MG3').prop.tipo === 'evento' && /Propone un evento de rotura con esa nota: sale de la palabra «roto»/.test(de('MG3').lin)
      && de('MG2').m === null && /Sin medición: la nota dice «no se pudo medir»/.test(de('MG2').lin)
      && /Queda como nota de la medición/.test(de('MS1').marcas) && !bloq
      && meds.length === 4 && !meds.some((x) => x.etiqueta === 'MG2') && meds.find((x) => x.etiqueta === 'MS1').nota === 'se mojó la punta'
      && evs.some((x) => x.etiqueta === 'MG3' && x.tipo === 'rotura' && /^roto/.test(x.detalle)) && evs.some((x) => x.etiqueta === 'MG2' && x.tipo === 'nota' && /^no se pudo medir/.test(x.detalle))
      && est.MG1 === 'en_uso' && est.MG15 === 'armando',
    { revision: ['MG1', 'MG2', 'MG3', 'MG15', 'MS1'].map((et) => ({ et, metros: de(et).m, estado: de(et).estado, propuesta: de(et).lin.split(' | ').find((l) => /Propone|Sin medición/.test(l)) || de(et).marcas })),
      en_la_base: { mediciones: meds, eventos: evs, estados: est } });
});

// ═══════════ 6 · la impresa en una hoja A4 ═══════════
await paso('6', 'Impresa', async () => {
  await ir(iñaki, 'carga', 'cargaModo=null; plCfg={}');
  const html = await iñaki.evaluate(() => planillaHTML());
  fs.writeFileSync(path.join(SALIDA, 'planilla_impresa_app.html'), html);
  const pg = await (await nav.createBrowserContext()).newPage();
  await pg.setContent(html, { waitUntil: 'load' });
  const pdf = await pg.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(SALIDA, 'planilla_impresa_app.pdf'), pdf);
  const paginas = (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  const cuenta = await pg.evaluate(() => [...document.querySelectorAll('h2')].map((h) => h.childNodes[0].textContent.trim() + ': ' + (h.nextElementSibling && h.nextElementSibling.classList.contains('dos') ? h.nextElementSibling.querySelectorAll('td.n').length : '')));
  await pg.emulateMediaType('print'); await pg.setViewport({ width: 794, height: 1123 });
  const appPng = path.join(SALIDA, 'impresa-app.png'); await pg.screenshot({ path: appPng, fullPage: true });
  // la referencia: su PDF pasado a imagen con LibreOffice
  let refPng = null; try { refPng = lo('png', path.join(PLANILLAS, 'planilla_impresa.pdf'), path.join(SALIDA, 'referencia')); } catch (e) { refPng = null; }
  const b64 = (fl) => 'data:image/png;base64,' + fs.readFileSync(fl).toString('base64');
  await pg.emulateMediaType('screen');
  await pg.setContent(`<body style="margin:0;display:flex;gap:16px;background:#cfd6e2;font:600 15px sans-serif;align-items:flex-start;padding:16px">
    <div style="width:794px"><div style="padding:6px 0">Referencia: diseno/planillas/planilla_impresa.pdf</div>${refPng ? `<img src="${b64(refPng)}" style="width:794px;background:#fff">` : 'no se pudo convertir'}</div>
    <div style="width:794px"><div style="padding:6px 0">App: «Imprimir planilla» con 30 + 10 renglones (vista de impresión)</div><img src="${b64(appPng)}" style="width:794px;background:#fff"></div></body>`, { waitUntil: 'load' });
  await pg.setViewport({ width: 1660, height: 1000 }); await pg.screenshot({ path: path.join(SALIDA, 'impresa-lado-a-lado.png'), fullPage: true });
  // con más renglones, sigue al dorso con el mismo formato
  await iñaki.evaluate(() => { plCfg = { MG: { n: 60 } }; });
  const html60 = await iñaki.evaluate(() => planillaHTML());
  await iñaki.evaluate(() => { plCfg = {}; });
  await pg.setContent(html60, { waitUntil: 'load' });
  const pdf60 = await pg.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(SALIDA, 'planilla_impresa_60_renglones.pdf'), pdf60);
  const paginas60 = (Buffer.from(pdf60).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  await pg.close();
  anotar('6', 'Impresa con 30 + 10 renglones: una sola hoja A4 (PDF de una página), al lado de la referencia; con 60 de maíz sigue al dorso',
    paginas === 1 && cuenta.map((x) => x.trim()).join() === 'MAÍZ GRANO: 30,MAÍZ SILO: 10,HUMEDAD:' && paginas60 === 2 && !!refPng && /de la mitad del triángulo de una punta a la mitad del otro/.test(html),
    { paginas_pdf: paginas, bloques: cuenta, paginas_con_60_de_maiz: paginas60, captura: 'impresa-lado-a-lado.png', referencia_como_imagen: refPng && path.basename(refPng) });
});

// ═══════════ 7 · compatibilidad con los formatos viejos ═══════════
await paso('7', 'Compatibilidad', async () => {
  const casos = [];
  // la planilla vieja de 4 hojas de datos/ (viene en blanco), llenada con el 11/11 como la guardaría Excel
  const vieja = path.join(SALIDA, 'planilla_vieja_4_hojas_llena.xlsx');
  py(path.join(AQUI, 'revisar_xlsx.py'), 'vieja', path.join(DATOS, 'ejemplo_planilla_campo.xlsx'), path.join(DATOS, 'mediciones_2026-11-11.csv'), path.join(DATOS, 'materia_seca_2026-11-11.csv'), vieja);
  for (const [nombre, archivos] of [['xlsx viejo de 4 hojas (datos/ejemplo_planilla_campo.xlsx llenada con el 11/11)', [vieja]],
    ['CSV del 11/11 (mediciones + materia seca)', ['mediciones_2026-11-11.csv', 'materia_seca_2026-11-11.csv'].map((x) => path.join(DATOS, x))],
    ['planilla nueva (la del punto 1)', [llena]]]) {
    await subir(iñaki, archivos);
    const st = await iñaki.evaluate(() => ({ formato: staging.formato.txt, filas: staging.filas.filter((f) => !f.vacia).length, ms: staging.ms.length,
      conMetros: staging.filas.filter((f) => typeof f.metros === 'number').length }));
    st.pantalla = ((await iñaki.$eval('#pantalla', (e) => e.innerText)).match(/Formato detectado:[^\n]*/) || [''])[0];
    await cancelar(iñaki); casos.push({ nombre, ...st });
  }
  anotar('7', 'Los xlsx viejos y el CSV del 11/11 siguen entrando, y la revisión dice qué formato detectó',
    /planilla vieja de 4 hojas/.test(casos[0].pantalla) && casos[0].conMetros === CSV.length && casos[0].ms === MSCSV.length && /CSV del formato viejo/.test(casos[1].pantalla) && casos[1].conMetros === CSV.length && casos[1].ms === MSCSV.length
      && /planilla nueva/.test(casos[2].pantalla),
    { casos });
});

// ═══════════ 8 · solo silo y dieta ═══════════
await paso('8', 'Solo silo y dieta', async () => {
  const enc = fs.readFileSync(path.join(DATOS, 'materia_seca_2026-11-11.csv'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  const cols = enc.split(';');
  const fila = Object.fromEntries(cols.map((c) => [c, '']));
  Object.assign(fila, { fecha: '2026-11-11', muestra: 'Maíz grano', origen_tipo: 'celda', peso_inicial_g: '100', peso_10min_g: '88', peso_15min_g: '87.5', nota: 'prueba: una lectura de maíz grano en un archivo viejo' });
  const f = path.join(SALIDA, 'materia_seca_vieja_con_maiz.csv');
  fs.writeFileSync(f, [enc, cols.map((c) => fila[c]).join(';')].join('\n'));
  await subir(iñaki, [path.join(DATOS, 'mediciones_2026-11-11.csv'), f]);
  const ms = await iñaki.evaluate(() => staging.ms.map((m) => ({ nombre: m.nombre, nivel: m.diag.nivel, por: m.diag.lin.join(' ') })));
  const bloq = await iñaki.evaluate(() => (document.querySelector('#revBloqueos') || {}).innerText || '');
  const pantalla = await iñaki.$eval('#pantalla', (e) => e.innerText);
  await cancelar(iñaki);
  anotar('8', 'Una lectura de maíz grano en un archivo viejo va a «revisar» con su motivo',
    ms.length === 1 && ms[0].nivel === 'revisar' && /solo se mide silo y dieta \(decisión del 17\/11\)/.test(ms[0].por) && /lectura\(s\) de MS para revisar/.test(bloq)
      && /solo se mide silo y dieta/.test(pantalla), { lecturas: ms, bloqueo: bloq });
});

// ═══════════ 9 · carga a mano solo con el teclado ═══════════
await paso('9', 'Carga a mano con el teclado', async () => {
  await ir(iñaki, 'carga', 'cargaModo=null; staging=null; cargaBuf={}');
  await iñaki.screenshot({ path: path.join(SALIDA, 'carga-elegir.png') });
  // desde arriba de la página, con Tab hasta «Cargar a mano» y Enter
  await iñaki.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  let tabs = 0;
  for (; tabs < 80; tabs++) { if (await iñaki.evaluate(() => document.activeElement && document.activeElement.id === 'opMano')) break; await iñaki.keyboard.press('Tab'); }
  await iñaki.keyboard.press('Enter'); await iñaki.waitForSelector('[data-mm]'); await espera(150);
  const foco0 = await iñaki.evaluate(() => document.activeElement && document.activeElement.dataset.mm);
  const diez = CSV.filter((r) => r.alimento === 'MG').slice(0, 10).map((r) => r.metros_restantes.replace('.', ','));
  for (const v of diez) { await iñaki.keyboard.type(v); await iñaki.keyboard.press('Enter'); }
  const foco10 = await iñaki.evaluate(() => document.activeElement && document.activeElement.dataset.mm);
  await iñaki.screenshot({ path: path.join(SALIDA, 'carga-a-mano-1440.png'), fullPage: true });
  await iñaki.keyboard.down('Control'); await iñaki.keyboard.press('Enter'); await iñaki.keyboard.up('Control');
  await iñaki.waitForSelector('#revOk'); await espera(200);
  const st = await iñaki.evaluate(() => ({ vista, tipo: staging.tipo, formato: staging.formato.txt, filas: staging.filas.map((f) => [f.etiqueta, f.metros, f.diag.nivel, (bol(f.asignado) || {}).etiqueta || f.asignado]) }));
  await iñaki.screenshot({ path: path.join(SALIDA, 'carga-a-mano-revision.png'), fullPage: true });
  await cancelar(iñaki);
  // la misma pantalla a 375 px
  await iñaki.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await ir(iñaki, 'carga', 'cargaModo="mano"; cargaBuf={}');
  const ancho = await iñaki.evaluate(() => document.documentElement.scrollWidth);
  await iñaki.screenshot({ path: path.join(SALIDA, 'carga-a-mano-375.png'), fullPage: true });
  await iñaki.setViewport({ width: 1440, height: 1000 });
  anotar('9', 'Carga a mano: 10 renglones tipeados solo con el teclado (Tab, Enter, Ctrl+Enter) y la revisión los recibe',
    foco0 === 'MG|1' && foco10 === 'MG|11' && st.vista === 'revision' && st.tipo === 'manual' && st.filas.length === 10
      && st.filas.every((x, i) => x[0] === 'MG' + (i + 1) && x[1] === Number(diez[i].replace(',', '.'))) && ancho <= 375,
    { tabs_hasta_cargar_a_mano: tabs, foco_al_abrir: foco0, foco_despues_de_10_enter: foco10, tipeado: diez, revision: st, ancho_a_375: ancho });
});

fs.writeFileSync(path.join(SALIDA, 'resultados-planillas.json'), JSON.stringify(resultados, null, 1));
const mal = resultados.filter((x) => !x.ok);
console.log(`\n${resultados.length - mal.length} de ${resultados.length} verificaciones OK${mal.length ? ' · FALLAN: ' + mal.map((x) => x.id).join(', ') : ''}`);
await nav.close(); await banco.cerrar?.();
process.exit(mal.length ? 1 : 0);
