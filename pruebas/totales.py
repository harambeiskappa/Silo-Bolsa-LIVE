# Cálculo independiente de los totales, desde los archivos (no desde la app).
#   python -I totales.py "<carpeta datos>"
# Imprime JSON con metros por alimento y por fecha, en Decimal (sin redondeos de float).
import csv, json, sys
from decimal import Decimal as D
from pathlib import Path

datos = Path(sys.argv[1])
out = {}

def sumar(dest, ali, metros):
    t = dest.setdefault(ali, {"m": D(0), "n": 0, "medidos": 0})
    t["n"] += 1
    if metros is not None:
        t["m"] += D(str(metros)); t["medidos"] += 1

for nombre in ["silobolsa_2026-07-31.json", "silobolsa_2026-08-13.json"]:
    j = json.loads((datos / nombre).read_text(encoding="utf-8"))
    ultimo = {}
    for m in sorted(j["mediciones"], key=lambda m: m["fecha"]):
        if m.get("metros_restantes") is not None:
            ultimo[m["bolson_id"]] = m
    fecha = max(m["fecha"] for m in ultimo.values())
    d = out.setdefault(fecha, {})
    for b in j["bolsones"]:
        u = ultimo.get(b["id"])
        sumar(d, b["alimento"], u["metros_restantes"] if u else None)

with open(datos / "mediciones_2026-11-11.csv", encoding="utf-8") as f:
    for r in csv.DictReader(f, delimiter=";"):
        d = out.setdefault(r["fecha"], {})
        sumar(d, r["alimento"], r["metros_restantes"] if r["metros_restantes"].strip() else None)

kgm = {"MG": 3664, "MS": 4000, "GL": 4700}
for fecha, d in out.items():
    for ali, t in d.items():
        t["tn"] = str((t["m"] * kgm[ali] / 1000).quantize(D("0.1")))
        t["m"] = str(t["m"].normalize()) if t["m"] == t["m"].to_integral() else str(t["m"].quantize(D("0.1")))
print(json.dumps(out, ensure_ascii=False))
