"""Programa puente entre un eye tracker de investigación y la página web.

El navegador no puede comunicarse directamente con un eye tracker. Este
programa corre en la misma computadora, lee la mirada con el SDK del
fabricante y la envía a la página por WebSocket (ws://localhost:8770).

Uso:
    pip install websockets tobii-research   # (tobii-research sólo para Tobii Pro)
    python puente_eyetracker.py             # usa el primer Tobii Pro conectado
    python puente_eyetracker.py --simular   # sin equipo: datos simulados para probar

Después, en la página elija "Fuente de mirada → Eye tracker (programa puente)".

Protocolo (un mensaje JSON por muestra):
    {"x": 0.512, "y": 0.430, "valid": true, "ts": 123456789}
    x, y normalizados 0–1 sobre el área de la pantalla (0,0 = esquina superior
    izquierda). Al conectar se envía {"info": {"modelo", "serie", "frecuencia"}}.

Para otro fabricante (EyeLink, Gazepoint, Pupil Labs…) basta con escribir otra
fuente que llame a `publicar(x, y, valido, ts)` con el mismo formato.
"""
import argparse
import asyncio
import json
import math
import random
import threading
import time

import websockets

PUERTO = 8770
clientes = set()
info = {"modelo": "desconocido", "serie": "", "frecuencia": None}
loop = None
cola = None


def publicar(x, y, valido, ts):
    """Puede llamarse desde cualquier hilo (p. ej. el callback del SDK)."""
    msg = json.dumps({"x": x, "y": y, "valid": bool(valido), "ts": ts})
    loop.call_soon_threadsafe(cola.put_nowait, msg)


# ---------------- Fuentes ----------------
def fuente_tobii():
    import tobii_research as tr

    equipos = tr.find_all_eyetrackers()
    if not equipos:
        raise SystemExit("No se encontró ningún eye tracker Tobii Pro. Revise la conexión y el software Eye Tracker Manager.")
    et = equipos[0]
    info.update(modelo=et.model, serie=et.serial_number, frecuencia=et.get_gaze_output_frequency())
    print(f"Conectado a {et.model} (serie {et.serial_number}) a {info['frecuencia']} Hz")

    def callback(d):
        pts = []
        for ojo in ("left", "right"):
            if d[f"{ojo}_gaze_point_validity"]:
                pts.append(d[f"{ojo}_gaze_point_on_display_area"])
        if pts:
            x = sum(p[0] for p in pts) / len(pts)
            y = sum(p[1] for p in pts) / len(pts)
            publicar(x, y, True, d["system_time_stamp"])
        else:
            publicar(None, None, False, d["system_time_stamp"])

    et.subscribe_to(tr.EYETRACKER_GAZE_DATA, callback, as_dictionary=True)
    return lambda: et.unsubscribe_from(tr.EYETRACKER_GAZE_DATA, callback)


def fuente_simulada(hz=120):
    info.update(modelo="simulador", serie="SIM-0001", frecuencia=hz)
    print(f"Modo simulado a {hz} Hz (la mirada describe una figura de Lissajous con ruido)")
    activo = {"si": True}

    def correr():
        t0 = time.time()
        while activo["si"]:
            t = time.time() - t0
            valido = random.random() > 0.02
            x = 0.5 + 0.35 * math.sin(2 * math.pi * 0.1 * t) + random.gauss(0, 0.004)
            y = 0.5 + 0.30 * math.sin(2 * math.pi * 0.07 * t) + random.gauss(0, 0.004)
            publicar(x if valido else None, y if valido else None, valido, int(t * 1e6))
            time.sleep(1 / hz)

    threading.Thread(target=correr, daemon=True).start()
    return lambda: activo.update(si=False)


# ---------------- Servidor WebSocket ----------------
async def atender(ws):
    clientes.add(ws)
    print(f"Página conectada ({len(clientes)})")
    try:
        await ws.send(json.dumps({"info": info}))
        await ws.wait_closed()
    finally:
        clientes.discard(ws)
        print(f"Página desconectada ({len(clientes)})")


async def difundir():
    while True:
        msg = await cola.get()
        for ws in list(clientes):
            try:
                await ws.send(msg)
            except websockets.ConnectionClosed:
                clientes.discard(ws)


async def principal(simular):
    global loop, cola
    loop = asyncio.get_running_loop()
    cola = asyncio.Queue(maxsize=10000)
    detener = fuente_simulada() if simular else fuente_tobii()
    try:
        async with websockets.serve(atender, "localhost", PUERTO):
            print(f"Puente listo en ws://localhost:{PUERTO}. Deje esta ventana abierta. Ctrl+C para salir.")
            await difundir()
    finally:
        detener()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--simular", action="store_true", help="enviar datos simulados (sin eye tracker)")
    try:
        asyncio.run(principal(ap.parse_args().simular))
    except KeyboardInterrupt:
        pass
