# Mira un .xlsx por dentro, sin pasar por la app (lo usa planillas.mjs).
#   python -I revisar_xlsx.py comparar generada.xlsx referencia.xlsx
#       celda por celda: valor o fórmula, relleno, fuente y formato; validaciones,
#       celdas unidas y encabezado inmovilizado.
#   python -I revisar_xlsx.py valores archivo.xlsx
#       los valores calculados que guardó quien abrió el archivo (LibreOffice o
#       Excel), con su formato, y si alguna celda quedó con error de fórmula.
#   python -I revisar_xlsx.py textos archivo.xlsx
#       cómo guarda los textos: sharedStrings o inlineStr.
import json, sys, zipfile, re
import openpyxl

def hojas(ruta, data_only=False):
    return openpyxl.load_workbook(ruta, data_only=data_only)

def estilo(c):
    f = c.fill.fgColor.rgb if c.fill and c.fill.fill_type == "solid" else None
    return {"relleno": (f or "")[-6:], "negrita": bool(c.font.b), "color": (c.font.color.rgb if c.font and c.font.color and isinstance(c.font.color.rgb, str) else "")[-6:],
            "formato": c.number_format}

def comparar(a, b):
    A, B = hojas(a), hojas(b)
    out = {"hojas": [A.sheetnames, B.sheetnames], "diferencias": {}, "iguales": {}}
    for nombre in B.sheetnames:
        if nombre not in A.sheetnames:
            out["diferencias"][nombre] = "falta la hoja"; continue
        x, y = A[nombre], B[nombre]
        dif, iguales, invisibles = [], 0, []
        for fila in range(1, max(x.max_row, y.max_row) + 1):
            for col in range(1, max(x.max_column, y.max_column) + 1):
                cx, cy = x.cell(fila, col), y.cell(fila, col)
                vx, vy = cx.value, cy.value
                ex, ey = estilo(cx), estilo(cy)
                # vacía de los dos lados y sin relleno en ninguno: el formato de letra no se ve
                if vx is None and vy is None and not ex["relleno"] and not ey["relleno"] and ex != ey:
                    invisibles.append(cx.coordinate); continue
                if vx != vy or ex != ey:
                    dif.append({"celda": cx.coordinate, "generada": [vx, ex] if ex != ey else vx, "referencia": [vy, ey] if ex != ey else vy})
                else:
                    iguales += 1
        meta = lambda h: {"inmovilizado": h.freeze_panes, "unidas": sorted(str(r) for r in h.merged_cells.ranges),
                          "validaciones": sorted([dv.type, str(dv.sqref), dv.formula1, dv.formula2, bool(dv.showErrorMessage)] for dv in h.data_validations.dataValidation)}
        mx, my = meta(x), meta(y)
        out["diferencias"][nombre] = dif
        out["iguales"][nombre] = iguales
        out.setdefault("vacias_con_formato_de_letra_distinto", {})[nombre] = invisibles
        out.setdefault("estructura", {})[nombre] = {"igual": mx == my, "generada": mx, "referencia": my}
    print(json.dumps(out, ensure_ascii=False, default=str))

def valores(ruta):
    W = hojas(ruta, data_only=True)
    out, errores = {}, []
    for h in W.worksheets:
        filas = []
        for row in h.iter_rows():
            for c in row:
                if c.value is None: continue
                if isinstance(c.value, str) and (c.value.startswith("#") or c.value.startswith("Err:")):
                    errores.append(f"{h.title}!{c.coordinate}={c.value}")
                filas.append([c.coordinate, c.value, c.number_format])
        out[h.title] = filas
    print(json.dumps({"valores": out, "errores": errores}, ensure_ascii=False, default=str))

def textos(ruta):
    z = zipfile.ZipFile(ruta)
    nombres = z.namelist()
    inline = sum(z.read(n).decode("utf-8").count('t="inlineStr"') for n in nombres if n.startswith("xl/worksheets/"))
    compartidos = "xl/sharedStrings.xml" in nombres
    n = len(re.findall(r"<si>", z.read("xl/sharedStrings.xml").decode("utf-8"))) if compartidos else 0
    print(json.dumps({"sharedStrings": compartidos, "textos_compartidos": n, "inlineStr": inline, "partes": nombres}))

if sys.argv[1] not in ("hora", "vieja"):
    {"comparar": lambda: comparar(sys.argv[2], sys.argv[3]), "valores": lambda: valores(sys.argv[2]), "textos": lambda: textos(sys.argv[2])}[sys.argv[1]]()

# python -I revisar_xlsx.py hora salida.xlsx
#   una planilla nueva mínima donde los metros de MG1 se escribieron «67:30» en
#   Excel y Excel los guardó como hora ([h]:mm). La app tiene que leer 67,3 m.
if sys.argv[1] == "hora":
    from datetime import timedelta
    W = openpyxl.Workbook(); h = W.active; h.title = "Mediciones"
    h["A3"], h["B3"] = "Fecha", "19/11/2026"
    for i, t in enumerate(["Alimento", "N°", "Metros", "Nota (solo si pasa algo)"]): h.cell(6, i + 1, t)
    h["A7"], h["B7"], h["C7"] = "Maíz grano", 1, timedelta(hours=67, minutes=30)
    h["C7"].number_format = "[h]:mm"
    W.save(sys.argv[2]); print(json.dumps({"C7": "67:30 guardado como hora"}))

# python -I revisar_xlsx.py vieja plantilla_vieja.xlsx mediciones.csv materia_seca.csv salida.xlsx
#   llena una planilla del formato viejo (4 hojas: Recuento, Mediciones, Materia
#   seca, Instructivo) con los valores de los CSV, como la guardaría Excel
#   (openpyxl escribe los textos en sharedStrings).
if sys.argv[1] == "vieja":
    import csv
    W = openpyxl.load_workbook(sys.argv[2])
    med = W["Mediciones"]
    enc = [str(c.value or "").upper() for c in med[1]]
    col = lambda clave: next(i for i, t in enumerate(enc) if t.startswith(clave)) + 1
    filas = list(csv.DictReader(open(sys.argv[3], encoding="utf-8-sig"), delimiter=";"))
    letra = {"en_uso": "U", "armando": "A", "terminado": "T", "": "C"}
    for i, r in enumerate(filas):
        f = i + 2
        med.cell(f, col("BOLS")).value = r["etiqueta"]
        med.cell(f, col("ALIMENTO")).value = r["alimento"]
        med.cell(f, col("METROS")).value = float(r["metros_restantes"])
        med.cell(f, col("ESTADO")).value = letra.get(r["estado_anotado"], "C")
        if r["estado_anotado"]: med.cell(f, col("OBSERV")).value = r["nota"]
    ms = W["Materia seca"]
    lect = {("silo" if "silo" in r["muestra"].lower() else "dieta"): r for r in csv.DictReader(open(sys.argv[4], encoding="utf-8-sig"), delimiter=";")}
    for fila in ms.iter_rows(min_row=2):
        nom = str(fila[0].value or "").lower()
        r = lect.get("silo") if "silo" in nom else lect.get("dieta") if "dieta" in nom else None
        if r:
            fila[1].value = float(r["ms_pct_cota_superior"]); fila[2].value = "M" if "dieta" in nom else "C"
    W.save(sys.argv[5]); print(json.dumps({"renglones": len(filas)}))
