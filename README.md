# Seguimiento Ocular TEA

Sistema web *exprofeso* de entrenamiento y evaluación del seguimiento ocular para niños de 6 a 10 años con TEA y con desarrollo típico. Forma parte de la tesis doctoral «Seguimiento ocular de objetos y su impacto en la percepción visual de niños con TEA» (Instituto de Investigaciones Cerebrales, Universidad Veracruzana).

**Dirección web:** <https://fermu1508.github.io/seguimiento-ocular-tea/>

El niño sigue con la mirada una figura geométrica que se mueve por la pantalla. El sistema estima la mirada con la cámara web o con un eye tracker de investigación, y calcula las métricas oculomotoras de cada sesión.

**Estímulos no sociales.** El objeto nunca es un rostro: la atención atípica a las caras en el TEA podría sesgar la comparación entre grupos.
* **Evaluación (T0, T1, T2), calibración y deriva:** diana blanca con cruz y punto central, la forma que produce la fijación más estable (Thaler et al., 2013).
* **Entrenamiento:** figura geométrica de color sólido (círculo, estrella, rombo o cuadrado), elegida para cada participante y mantenida durante todo el estudio.

**Retroalimentación desactivada.** No hay brillo, sonido ni estrellas. Si más adelante se decide usarla, se activa en `FEEDBACK` dentro de `js/config.js`, y cada sesión registra si estuvo activa.

## 1. Arquitectura propuesta

| Componente | Decisión | Por qué |
|---|---|---|
| Plataforma | Página web estática (HTML + JavaScript) | Funciona en cualquier computadora con Chrome o Edge y cámara web. No hay que instalar nada. |
| Seguimiento ocular | MediaPipe Face Landmarker (478 puntos con iris), dentro del navegador | Es el equivalente web de la combinación Python + OpenCV + MediaPipe que propone la tesis. |
| Estimación de la mirada | Calibración de 9 puntos, regresión de cresta y validación de 5 puntos | Reporta exactitud y precisión en grados (Kasneci et al., 2024). |
| Juego | Canvas 2D: fondo uniforme oscuro y figuras geométricas de alto contraste (sin rostros) | Bajo ruido visual, como pide la metodología. |
| Datos | IndexedDB local, copia en Google Drive, exportación CSV y respaldo JSON | Los datos quedan en el equipo y en el Drive del investigador, organizados por grupo y sujeto. |
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
* **Participantes:**
  * Se registran una vez con código, nombre, fecha de nacimiento, grupo, condición y figura.
  * En las siguientes sesiones se eligen de una lista; se muestra cuántas sesiones lleva el niño, la fecha de la última y el siguiente módulo.
  * **El nombre sólo se guarda en el equipo.** No aparece en los CSV, en los respaldos ni en Drive; ahí sólo va el código.
  * La edad se calcula en cada sesión y se exporta como covariable.
* **Fecha y hora** de inicio y fin en cada sesión. Aparecen en los resultados, en el historial, en el CSV y en el nombre de los archivos (`TEA-01_2026-11-12_10h30_T0_S1_resumen.csv`).
* **Durante la sesión:**
  * Corrección de deriva antes de cada bloque.
  * Pausa automática si se pierden los ojos («Mira de nuevo a la pantalla»).
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

1. Elija al participante de la lista (o regístrelo la primera vez) y el tipo de sesión.
2. Mida y anote el **ancho visible de la pantalla** y la **distancia ojos–pantalla**. Con esos datos el sistema convierte píxeles a grados de ángulo visual.
3. Haga la calibración. Recalibre si la exactitud es > 4°.
4. Inicie la actividad. Al terminar se muestran los resultados y la sesión se guarda en el equipo.
5. Si Google Drive está conectado, la sesión se sube sola. Si no, al final del día use **Historial → Subir sesiones pendientes** o **Exportar respaldo (JSON)**.

### Capacidad de almacenamiento

Las sesiones se guardan en el navegador del equipo (IndexedDB), que puede usar una parte grande del disco libre: normalmente varios GB. Una sesión ocupa menos de 1 MB con la cámara web, y unos pocos MB con un eye tracker de 120–300 Hz. Todo el estudio (20 niños × 52 semanas) cabe de sobra.

El sistema pide al navegador que no borre los datos automáticamente y muestra en el Historial el espacio usado. Aun así, los datos se pierden si alguien borra los datos de navegación o cambia de navegador, por lo que conviene usar Drive o respaldos.

**Importante:** los datos están ligados a la dirección web y al navegador. Use siempre la misma dirección y el mismo navegador en cada equipo.

## 4. Google Drive

Cada sesión se sube a `Mi unidad / Seguimiento Ocular TEA / <TEA o Desarrollo tipico> / <Código> /` como tres archivos: resumen CSV, datos crudos CSV y respaldo JSON. La página usa el permiso `drive.file`: sólo puede ver y crear sus propios archivos, no el resto de su Drive.

### Configuración (una sola vez)

Para que Google permita a la página guardar en su Drive, hace falta un «ID de cliente»:

1. Entre a <https://console.cloud.google.com/> con su cuenta de Google y cree un proyecto, por ejemplo «Seguimiento Ocular TEA».
2. En **APIs y servicios → Biblioteca**, busque **Google Drive API** y presione **Habilitar**.
3. En **Google Auth Platform** (pantalla de consentimiento de OAuth), presione **Comenzar**:
   * Nombre de la app: «Seguimiento Ocular TEA», con su correo.
   * Público: **Externo**.
   * En **Público → Usuarios de prueba**, agregue el correo de cada persona que aplicará sesiones.
4. En **Clientes → Crear cliente**:
   * Tipo: **Aplicación web**.
   * **Orígenes autorizados de JavaScript:** `https://fermu1508.github.io` y, para pruebas locales, `http://localhost:8000`.
5. Copie el **ID de cliente** (termina en `.apps.googleusercontent.com`) y péguelo en `js/drive-config.js`. El ID de cliente no es una contraseña; puede estar en el código público.

Después, en **Historial → Conectar Google Drive**, inicie sesión con su cuenta. Google mostrará un aviso de «app no verificada» mientras el proyecto esté en modo de prueba; es normal para uso interno. La conexión dura alrededor de una hora; si expira, vuelva a presionar «Conectar».

## 5. Eye tracker de investigación

El navegador no puede hablar directamente con un eye tracker. Para eso está el programa puente `bridge/puente_eyetracker.py`, que se ejecuta en la misma computadora y envía la mirada a la página.

1. Instale Python y, en una terminal, ejecute:

   ```bash
   pip install websockets tobii-research
   ```

2. Calibre el eye tracker con el software del fabricante (p. ej. Tobii Pro Eye Tracker Manager).
3. Abra el puente y deje la ventana abierta:

   ```bash
   python bridge/puente_eyetracker.py
   ```

4. En la página elija **Fuente de mirada → Eye tracker**. El sistema omite su propia calibración y hace una validación de 5 puntos para registrar la exactitud.

Para probar sin equipo: `python bridge/puente_eyetracker.py --simular`.

El puente incluido funciona con **Tobii Pro**, que tiene SDK para Python. Para otro fabricante (EyeLink, Gazepoint, Pupil Labs) hay que agregar una función de lectura en el puente; el formato de los mensajes está documentado en el archivo. Los equipos Tobii para videojuegos (Eye Tracker 5) no permiten este uso con fines de investigación.

**Decida el equipo antes de T0.** Las métricas de la cámara web y las del eye tracker no son intercambiables: frecuencia, exactitud y umbrales de análisis cambian. Las tres evaluaciones de cada niño deben hacerse con el mismo dispositivo. Una opción es usar el eye tracker para T0, T1 y T2, y la cámara web para el entrenamiento semanal.

## 6. Limitaciones y recomendaciones para la tesis

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
* **Movimiento de la cabeza.** Con cámara web, la estimación es confiable sólo cerca de la posición de calibración.
  * Si la cabeza se desplaza más de un tercio del ancho del rostro, o la distancia cambia más de 15 %, el juego se pausa («Regresa a tu lugar») y esas muestras se marcan como inválidas (`motivo = posicion`).
  * Al final de cada sesión se repite la validación de 5 puntos. Su exactitud se guarda junto con la inicial para juzgar la calidad del dato.
* **Reloj de la cámara.** Cada sesión guarda si la marca de tiempo de la cámara coincidía con la del navegador (`equipo.reloj`). Si no coincide, se usa la del navegador.
* **Mismo equipo para las evaluaciones.** Use el mismo equipo y la misma ubicación en T0, T1 y T2, aunque el entrenamiento se haga en otros equipos.
* Los 10 módulos son una propuesta inicial. Requieren la **validación de contenido por expertos** del objetivo 2. Todos los valores se editan en `js/config.js`.

## 7. Estructura

```
index.html            Pantallas: inicio, cámara, calibración, plan, resultados, historial
css/style.css
js/config.js          Módulos, batería de evaluación, progresión y parámetros de análisis
js/tracker.js         MediaPipe, rasgos oculares, regresión de mirada y modo ratón
js/stimuli.js         Trayectorias (funciones exactas del tiempo, con semilla reproducible)
js/analysis.js        Métricas: I-VT, I-DT, ganancia, latencia, tiempo sobre el objeto
js/storage.js         IndexedDB (participantes y sesiones) y exportación CSV/JSON
js/drive.js           Copia de las sesiones en Google Drive
js/drive-config.js    ID de cliente de Google (vacío = Drive desactivado)
bridge/               Programa puente para eye trackers (Tobii Pro y simulador)
tests/test-analysis.mjs  Prueba con datos sintéticos (node tests/test-analysis.mjs)
vendor/, models/      MediaPipe Tasks Vision 1.2.2 y modelo face_landmarker (Apache-2.0)
```

## 8. Siguientes pasos sugeridos

1. Pruebas con adultos y luego el piloto con niños; ajustar tamaños, velocidades y umbrales.
3. Script de análisis en R (`lme4`), por ejemplo:

   ```r
   lmer(tiempoSobreObjeto ~ tiempo * condicion + grupo + edad + (1 | participante))
   ```
