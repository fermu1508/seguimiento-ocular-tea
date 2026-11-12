# Seguimiento Ocular TEA

Sistema web *exprofeso* de entrenamiento y evaluación del seguimiento ocular para niños de 6 a 10 años con TEA y con desarrollo típico. Forma parte de la tesis doctoral «Seguimiento ocular de objetos y su impacto en la percepción visual de niños con TEA» (Instituto de Investigaciones Cerebrales, Universidad Veracruzana).

El niño sigue con la mirada a un personaje que se mueve por la pantalla. El sistema estima la mirada con la cámara web, da retroalimentación inmediata (el personaje sonríe y brilla, suena una campanita y se ganan estrellas) y calcula las métricas oculomotoras de cada sesión.

## 1. Arquitectura propuesta

| Componente | Decisión | Por qué |
|---|---|---|
| Plataforma | Página web estática (HTML + JavaScript) | Funciona en cualquier computadora con Chrome o Edge y cámara web. No hay que instalar nada. |
| Seguimiento ocular | MediaPipe Face Landmarker (478 puntos con iris), dentro del navegador | Es el equivalente web de la combinación Python + OpenCV + MediaPipe que propone la tesis. |
| Estimación de la mirada | Calibración de 9 puntos, regresión de cresta y validación de 5 puntos | Reporta exactitud y precisión en grados (Kasneci et al., 2024). |
| Juego | Canvas 2D: fondo uniforme oscuro y personaje amarillo de alto contraste | Bajo ruido visual, como pide la metodología. |
| Datos | IndexedDB local, exportación CSV y respaldo JSON | Los datos se quedan en el equipo y se exportan al software estadístico. |
| Privacidad | El video **no se envía ni se guarda**; sólo se guardan coordenadas | Se trata de menores: esto facilita la aprobación del comité de ética. |

Una sola tecnología (JavaScript en el navegador) sustituye al motor de videojuegos y al programa Python separados. Así, la sincronización entre el estímulo y la mirada es exacta: la posición del objeto se calcula en el mismo instante en que se captura cada cuadro de la cámara.

## 2. Contenido

* **10 módulos progresivos** (objetivo específico 2), definidos en `js/config.js`:
  1. Fijación.
  2. Lineal a 5 °/s.
  3. Lineal a 10 °/s.
  4. Horizontal-vertical (renglones).
  5. Sinusoidal suave.
  6. Saltos (sacadas).
  7. Lineal a 15 °/s con distractores.
  8. Sinusoidal amplia.
  9. Renglones rápidos con distractores.
  10. Mixto, con velocidad variable y distractores en movimiento.
* **Trayectorias de la tesis:**
  * Lineal: de izquierda a derecha y regreso.
  * Horizontal y vertical: el objeto desaparece y reaparece en la línea inferior.
  * Sinusoidal.
  * Además: fijación y saltos, que se usan para medir latencia y precisión sacádica.
* **Batería fija de evaluación** para T0, T1 y T2: fijación, lineal, sinusoidal, horizontal-vertical y saltos. Dura unos 4 minutos y es idéntica en todas las mediciones.
* **Progresión adaptativa** para las 52 semanas:
  * Se avanza de módulo cuando el tiempo sobre el objeto es ≥ 70 % en 2 sesiones seguidas.
  * Se retrocede cuando es < 35 %.
* **Sesión de entrenamiento:** 3 bloques del módulo actual, de 1 a 4 minutos de actividad ocular en total. Es menos que el límite de 10 minutos que fija la tesis.
* **Durante la sesión:**
  * Corrección de deriva antes de cada bloque.
  * Pausa automática si se pierde el rostro («¿Dónde estás?»).
  * Teclas del aplicador: `Espacio` pausa, `G` muestra u oculta la mirada, `S` salta el bloque, `Esc` termina la sesión.

### Métricas por bloque

| Objetivo de la tesis | Métrica |
|---|---|
| Fijación | Número y duración de fijaciones (I-DT); fijación más larga sobre el objeto |
| Latencia | Latencia media y su desviación estándar en los saltos y reapariciones del objeto; anticipaciones |
| Precisión | Error medio de posición (°); ganancia sacádica; ganancia de persecución |
| Tiempo que mantiene la mirada | % del tiempo sobre el objeto; racha continua más larga (s) |
| Calidad del dato | Exactitud y precisión de la calibración; pérdida de datos; frecuencia de muestreo efectiva |

El botón **«Exportar resumen de todos (CSV)»** genera una fila por bloque: participante, grupo, condición, tipo de sesión, número de sesión y métricas. Es el formato «largo» que piden los modelos lineales mixtos del plan de análisis.

## 3. Cómo usarlo

### Prueba local

```bash
cd seguimiento-ocular-tea
python3 -m http.server 8000
```

Abra `http://localhost:8000` en Chrome o Edge. Para probar sin cámara, elija **Fuente de mirada → Ratón**.

### Publicarlo en internet (gratis)

La cámara sólo funciona con **HTTPS**. Cualquiera de estas opciones lo da automáticamente:

* **GitHub Pages:**
  1. Suba esta carpeta a un repositorio.
  2. Vaya a *Settings → Pages → Deploy from branch → main / root*.
  3. Queda una dirección del tipo `https://usuario.github.io/seguimiento-ocular-tea/`.
* **Netlify:** arrastre la carpeta a <https://app.netlify.com/drop>.

No hace falta servidor ni base de datos. La biblioteca y el modelo de MediaPipe van incluidos en `vendor/` y `models/`, con la versión fija 1.2.2. Así el sistema no cambia durante los 12 meses del estudio.

### Procedimiento por sesión

1. Capture el código del participante (sin nombres reales), el grupo, la condición y el tipo de sesión.
2. Mida y anote el **ancho visible de la pantalla** y la **distancia ojos–pantalla**. Con esos datos el sistema convierte píxeles a grados de ángulo visual.
3. Haga la calibración. Recalibre si la exactitud es > 4°.
4. Inicie la actividad. Al terminar se muestran los resultados y la sesión se guarda en el equipo.
5. Al final del día, haga **Historial → Exportar respaldo (JSON)**. Los datos se guardan en el navegador del equipo usado; el respaldo sirve para archivarlos o para juntar datos de varios equipos con «Importar respaldo».

## 4. Limitaciones y recomendaciones para la tesis

* **Frecuencia de muestreo.** Una cámara web da de 30 a 60 Hz; un equipo de investigación da de 500 a 1000 Hz.
  * Con 30 Hz, la latencia tiene una resolución de unos 33 ms. Por eso el sistema la estima por interpolación del cruce del 25 % de la amplitud y conviene promediar muchos ensayos (la batería tiene 20 saltos).
  * Las sacadas de corrección de menos de unos 4° no se detectan de forma confiable. La velocidad pico de las sacadas no se puede medir.
  * La propia tesis lo anticipa (Andersson et al., 2010; Wang et al., 2025). Es conveniente usar una cámara de 60 fps.
* **Exactitud esperada:** de 1.5 a 4° según la iluminación, la cámara y cuánto se mueva el niño. El área de interés por defecto es de 3°. Una mentonera o una silla fija mejoran mucho el dato.
* **Estudio piloto (ya previsto en la metodología).** Sirve para:
  * verificar la exactitud, la precisión y la tasa de muestreo efectiva en niños;
  * fijar los umbrales de análisis (I-VT, I-DT, área de interés);
  * si es posible, comparar contra un equipo de referencia (p. ej. Tobii) en algunos participantes.

  Después del piloto, **no cambie los parámetros**. Se guardan con cada sesión, y el botón «Recalcular métricas» permite volver a analizar todo con un mismo conjunto de parámetros.
* **Mismo equipo para las evaluaciones.** Use el mismo equipo y la misma ubicación en T0, T1 y T2, aunque el entrenamiento se haga en otros equipos.
* Los 10 módulos son una propuesta inicial. Requieren la **validación de contenido por expertos** del objetivo 2. Todos los valores se editan en `js/config.js`.

## 5. Estructura

```
index.html            Pantallas: inicio, cámara, calibración, plan, resultados, historial
css/style.css
js/config.js          Módulos, batería de evaluación, progresión y parámetros de análisis
js/tracker.js         MediaPipe, rasgos oculares, regresión de mirada y modo ratón
js/stimuli.js         Trayectorias (funciones exactas del tiempo, con semilla reproducible)
js/analysis.js        Métricas: I-VT, I-DT, ganancia, latencia, tiempo sobre el objeto
js/storage.js         IndexedDB y exportación CSV/JSON
tests/test-analysis.mjs  Prueba con datos sintéticos (node tests/test-analysis.mjs)
vendor/, models/      MediaPipe Tasks Vision 1.2.2 y modelo face_landmarker (Apache-2.0)
```

## 6. Siguientes pasos sugeridos

1. Pruebas con adultos y luego el piloto con niños; ajustar tamaños, velocidades y umbrales.
2. Opcional: un servidor central (p. ej. Supabase o Firebase) para que las sesiones de varios equipos se junten automáticamente, con códigos anónimos y acceso restringido.
3. Script de análisis en R (`lme4`), por ejemplo:

   ```r
   lmer(tiempoSobreObjeto ~ tiempo * condicion + grupo + edad + (1 | participante))
   ```
