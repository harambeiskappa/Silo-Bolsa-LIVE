# Llena por código la planilla en blanco que genera la app, como lo haría
# quien carga en Excel: escribe valores en las celdas vacías y deja todo lo
# demás igual (estilos, validaciones, fórmulas, textos inlineStr).
#   python -I llenar_planilla.py en_blanco.xlsx llena.xlsx celdas.json
# celdas.json: {"Mediciones": {"C7": 67.1, "D20": "Sacando mixer"}, "Humedad": {...}}
# Un número va como número; un texto, como texto (así se prueba «67:80 cm»).
import json, re, sys, zipfile
from xml.sax.saxutils import escape

origen, destino, spec = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3], encoding="utf-8"))
zin = zipfile.ZipFile(origen)
wb = zin.read("xl/workbook.xml").decode("utf-8")
rels = zin.read("xl/_rels/workbook.xml.rels").decode("utf-8")
hoja_de = {}
for nombre, rid in re.findall(r'<sheet name="([^"]+)"[^>]*r:id="([^"]+)"', wb):
    hoja_de[nombre] = "xl/" + re.search(r'Id="%s"[^>]*Target="([^"]+)"' % rid, rels).group(1)
cambios = {}
for hoja, celdas in spec.items():
    xml = zin.read(hoja_de[hoja]).decode("utf-8")
    for ref, v in celdas.items():
        m = re.search(r'<c r="%s"( s="\d+")?/>' % ref, xml)
        if not m:
            raise SystemExit(f"{hoja}!{ref}: la celda no está vacía o no existe en la planilla en blanco")
        s = m.group(1) or ""
        if isinstance(v, (int, float)):
            nueva = f'<c r="{ref}"{s}><v>{v}</v></c>'
        else:
            nueva = f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{escape(str(v))}</t></is></c>'
        xml = xml[:m.start()] + nueva + xml[m.end():]
    cambios[hoja_de[hoja]] = xml
with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        datos = cambios[item.filename].encode("utf-8") if item.filename in cambios else zin.read(item.filename)
        zout.writestr(item, datos)
print(json.dumps({h: len(c) for h, c in spec.items()}))
