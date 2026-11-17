# Arma una planilla "sucia" como la guardaría Excel (textos en sharedStrings),
# con un renglón por cada tipo de problema. Datos inventados: es una prueba.
#   python -I planilla_sucia.py salida.xlsx
import sys
from openpyxl import Workbook

wb = Workbook()
rec = wb.active; rec.title = "Recuento"
rec.append(["TOTAL", 30])                       # contó 30, la planilla trae menos
rec.append(["Fecha de medición", "27/11/2026"])
rec.append(["Medido por", "Silvana"])
med = wb.create_sheet("Medición del día")        # hoja renombrada
med.append(["METROS", "Etiqueta", "Estado", "alimento", "Observaciones"])   # columnas cambiadas de orden
med.append([" 67,5 ", "MG1", "c", " mg ", "coma decimal, minúsculas y espacios"])
med.append(["64.6", "MG2", "", "MG", "punto decimal"])
med.append([])                                   # fila vacía en el medio
med.append(["abc", "MG3", "", "MG", "metros no numéricos"])
med.append(["60", "MG4", "", "XX", "alimento desconocido"])
med.append(["61", "MG5", "", "MG", "repetido"])
med.append(["62", "MG5", "", "MG", "repetido"])
med.append(["0", "MG8", "", "MG", "un cero sin estar terminado"])
med.append(["", "MG9", "", "MG", "sin metros: tiene que quedar s/d"])
med.append(["55", "MG77", "", "MG", "etiqueta que no estaba"])
wb.save(sys.argv[1])
