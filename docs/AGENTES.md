# Recorder — control por agentes

Recorder se controla por MCP local o CLI JSON. No hace falta computer use para operar el grabador. El agente necesita ejecutar herramientas en el mismo Windows; no se expone un servicio público ni se instala un túnel.

## Conectar

1. Abre Recorder y entra en **Integraciones IA**.
2. Activa **Permitir conexiones locales**.
3. Pulsa **Copiar configuración MCP** y añade el bloque al cliente que utilices. La configuración contiene el ejecutable y la ruta reales de esta instalación; no contiene el token.
4. Asigna un `RECORDER_CLIENT` distinto a cada controlador independiente.

El conector utiliza el Node incluido en Electron con `ELECTRON_RUN_AS_NODE=1`. No necesita instalar Node por separado. En Windows, lanzar Electron como GUI con stdin oculto puede cerrar el canal: usa la configuración que genera el panel. En clientes cuyo formato no sea JSON, traslada los mismos campos command, args y env.

La distribución incluye `agent-skill/recorder-control/SKILL.md` dentro de la aplicación. En el proyecto está en [desktop/agent-skill/recorder-control](../desktop/agent-skill/recorder-control/SKILL.md). El skill enseña el procedimiento; el servidor MCP proporciona las herramientas reales. La selección del skill puede requerir una nueva sesión del cliente.

**Revocar conexiones** desactiva el acceso, cambia la clave, detiene y guarda una grabación de agente, y cancela sus tareas pendientes. El botón **Detener y guardar** también puede interrumpir la grabación desde la interfaz. Los clientes pertenecen a la misma cuenta de Windows: sus etiquetas evitan conflictos de sesión, pero no son identidades de seguridad aisladas. Si se vuelve a habilitar el acceso, un proceso autorizado de esa cuenta puede leer la nueva clave.

## CLI

```powershell
& '.\dist\Recorder-win32-x64\Recorder.exe' --cli tools
& '.\dist\Recorder-win32-x64\Recorder.exe' --cli sources.list
& '.\dist\Recorder-win32-x64\Recorder.exe' --cli recording.start --file '.\capture.json'
```

`capture.json`, después de sustituir el id por uno devuelto por sources.list:

```json
{
  "mode": "region",
  "sourceId": "screen:0:0",
  "region": { "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8 },
  "format": "mp4",
  "fps": 30,
  "systemAudio": false,
  "microphone": false,
  "autoStop": 60
}
```

Las respuestas correctas son JSON `{ "result": ... }`; los fallos salen en stderr y terminan con código distinto de cero. También se puede pasar JSON como argumento, pero los archivos evitan los problemas de comillas de PowerShell. `--request-id UUID` permite reintentar exactamente una petición; cambiar los parámetros con el mismo identificador se rechaza. La caché se limita a 1.000 peticiones en la ejecución actual: tras reiniciar o desalojar una entrada, consulta el estado antes de repetir.

En desarrollo: `node desktop/agents/entry.cjs --cli METHOD --file arguments.json`. `RECORDER_CONNECTION` permite usar un perfil aislado; por defecto se lee `%APPDATA%\Recorder\agent-connection.json`.

Al omitir `format` en `recording.start`, se usa MP3 para `mode: "audio"` y MP4 para vídeo. Solo audio admite MP3, WAV y WebM; las combinaciones incompatibles se rechazan antes de capturar. Cancelar una cuenta atrás devuelve el motor a `idle`. Los metadatos `.session.json` se guardan antes de devolver el archivo final.

## Herramientas

En MCP, el punto se convierte en guion bajo: `recording.start` → `recording_start`. `tools` / `tools/list` proporciona los esquemas completos vigentes.

| Método | Uso |
|---|---|
| capabilities.get | Monitores reales, navegadores instalados, operaciones y límites |
| devices.list | Cámaras/capturadoras y micrófonos enumerados por Windows |
| settings.get / update | Leer y cambiar preferencias persistentes; campos no enviados se conservan |
| schedule.create | Inicio puntual ISO con zona horaria; devuelve trabajo cancelable |
| sources.list | Fuentes con id, nombre, tipo y geometría de monitores |
| source.preview | Miniatura; MCP devuelve imagen |
| recording.start | Inicia y espera a que haya grabación real; devuelve id de sesión |
| recording.status | Estado, tiempo activo, propietario, dimensiones reales, marcas y archivo final |
| recording.pause / resume | Requieren sessionId y el mismo RECORDER_CLIENT |
| recording.mark | Guarda label y tiempo de grabación |
| recording.stop | Devuelve jobId; consultar hasta completar exportación |
| screenshot.capture | PNG/JPEG; durante grabación usa la composición activa y requiere sessionId |
| jobs.status / cancel | Consulta trabajos propios; cancelación de demo, montaje y voz |
| artifacts.list | Archivos de la carpeta de salida |
| demo.run | Receta Playwright en Edge o Chrome instalado |
| demo.multiview | Dos sesiones aisladas, pasos por sesión/paralelos y vídeo dividido |
| voices.list | Voces de Windows disponibles |
| narration.create | WAV local desde text, voice opcional y rate (-5 a 5) |
| media.compose | Nuevo MP4 con clips, recortes, títulos, marca, audio y subtítulos |

## Varias pantallas y aplicaciones

En el selector de fuente, activa **Combinar fuentes**, busca por nombre y elige de dos a cuatro pantallas o ventanas. **Todas las pantallas** selecciona hasta cuatro monitores detectados. Elige distribución horizontal, vertical o cuadrícula. La UI usa 1920×1080; la API permite otra resolución, hasta 3840×2160. No necesitas dos monitores para combinar dos ventanas.

`capabilities.get` devuelve la topología actual, monitor principal, escala, rotación y límites. `sources.list` actualiza las fuentes en cada consulta; vuelve a consultarlo tras conectar/desconectar monitores o cerrar ventanas. Los bounds están en DIP de Windows y pueden ser negativos. Width/height de monitor son píxeles físicos nominales; una ventana solo conoce su resolución real al iniciar captura. Las regiones son relativas a la imagen de la fuente, nunca a la miniatura ni al escritorio global.

Ejemplo para `recording.start` o `screenshot.capture`, sustituyendo ambos ids:

```json
{
  "mode": "scene", "format": "mp4", "systemAudio": false,
  "scene": {
    "layout": "horizontal", "width": 1920, "height": 1080,
    "items": [
      { "sourceId": "ID_DE_VENTANA", "label": "Cliente" },
      { "sourceId": "ID_DE_PANTALLA", "label": "Administración" }
    ]
  }
}
```

Cada item admite `region`. La composición conserva la proporción y añade bandas cuando hace falta. El sonido del sistema se toma una sola vez para evitar duplicarlo; sigue siendo la mezcla Windows, no sonido aislado por aplicación. Si se cierra una fuente durante una grabación, se finaliza la captura. `recording.status.dimensions` informa de la salida compuesta. La composición nativa produce un único archivo; las demos web multipantalla sí conservan originales separados.

`devices.list` devuelve identificadores de cámaras y micrófonos para `cameraId`/`microphoneId`. `settings.update` admite los ajustes de captura, `videoFormat`, `audioFormat` y `minimizeOnStart`; solo se aplica en reposo y actualiza la interfaz. No cambia credenciales ni carpeta de salida.

Para programar: `schedule.create` con `{ "at": "2026-11-08T10:00:00+01:00", "capture": { ...opciones de recording.start... } }`. Usa una fecha futura dentro de 24 días. Consulta el trabajo: al completarse devuelve la sesión iniciada; después consulta `recording.status` o detén esa sesión. Cancela mediante `jobs.cancel`. Las programaciones de agente no sobreviven al cierre/revocación; Recorder y Windows deben permanecer activos. La programación local de General continúa disponible.

Los trabajos usan `running`, `completed`, `failed` o `cancelled`. El resultado final vive en `result`; un fallo informa `error`. No confundas la recepción de jobId con la existencia de un vídeo terminado. Las exportaciones de grabación no se cancelan a mitad: se completan para preservar el archivo.

El temporizador `autoStop` mide segundos efectivos de captura, excluyendo pausas. 0 significa sin límite; máximo 86.400. Se aplica en el motor tanto para agentes como para botones. Los ajustes de una captura por agente se muestran en la UI, pero no sobrescriben por sí mismos la configuración persistente del usuario.

Las marcas se guardan en un `.session.json` junto al vídeo. Los identificadores de sesión, trabajos y la caché de reintentos viven en memoria; los archivos producidos y sus metadatos permanecen tras reiniciar.

## Demos web y encuadres semánticos

[Receta de ejemplo](../desktop/examples/demo.json). Ajusta URL y nombres de controles al software objetivo. Las acciones posibles son click, fill, wait, expectText, hold, mark, frame y screenshot. Los targets admiten role/name exactos, testId o selector. No hay ejecución de JavaScript arbitrario ni comandos de shell.

`frame` localiza un elemento, lo desplaza a la vista y registra su rectángulo normalizado en las marcas del resultado. Puedes reutilizar ese `region` en media.compose para un primer plano. `screenshot` con target captura solo ese elemento. Sin target captura el viewport.

La demo graba el **viewport del navegador**, sin marcos del escritorio ni audio del sistema. Abre un perfil efímero: no reutiliza sesiones personales ni cookies del navegador habitual. Utiliza un usuario de demostración y acciones autorizadas: pulsar un botón puede modificar el software real. Si falla una acción se detiene y se conserva el vídeo parcial, cuando se haya podido producir; no se deshacen las operaciones realizadas en el software objetivo.

El resultado incluye artifact, marks, screenshots y el listado de pasos completados. También se escribe `.demo.json` junto al vídeo. Para capturar la ventana completa y sonido del sistema, usa recording.start y automatiza el navegador externamente con Playwright.

Las regiones de escritorio son proporciones de la fuente; las regiones de demo son proporciones del viewport. No intercambies coordenadas CSS, miniaturas, DPI de Windows y píxeles de pantalla. La geometría real de una ventana solo se conoce al iniciar la captura; sources.list indica null en vez de usar el tamaño de la miniatura.

## Demo multipantalla: cliente y administración

`demo.multiview` abre dos contextos Playwright independientes, con cookies y almacenamiento separados. Pueden usar la misma web con usuarios diferentes o URLs distintas. No requiere dos monitores físicos. [Receta de ejemplo](../desktop/examples/multiview.json).

Cada elemento de `views` define id, label, url y una lista opcional setup para acciones previas a la grabación (por ejemplo, iniciar sesión). Las acciones de steps llevan view con el id destinatario. Un grupo `parallel` ejecuta dos acciones, una por sesión: permite esperar el pedido en administración mientras el cliente lo crea. No se admiten ids duplicados ni pasos dirigidos a sesiones desconocidas.

El resultado guarda las dos tomas originales y un MP4 horizontal o vertical con etiquetas. Se espera la llegada de fotogramas de ambos lados antes del guion común y se alinean los vídeos usando timestamps del navegador. Los metadatos documentan offsets y duración. Es sincronización práctica para demos; no se promete precisión exacta de fotograma entre procesos/renderizadores.

width/height son las dimensiones **de cada viewport**. Se añade una cabecera de 40px por panel: 640×480 produce 1280×520 horizontal o 640×1040 vertical. Un frame devuelve region para el vídeo original de esa sesión y compositeRegion para el MP4 dividido. Los originales permiten montar también una versión alternando vistas o primeros planos.

Prueba reproducible: dos sesiones en el mismo dominio con cookies diferentes, creación de un pedido con una petición HTTP desde cliente, actualización visible en administración, exportación de ambos diseños y cancelación. [Vídeo de demostración generado](qa/demo-multipantalla.mp4).

## Montaje y voz

```json
{
  "clips": [
    { "file": "C:\\ruta-de-salida\\demo.mp4", "start": 0, "duration": 5, "title": "Presentación" },
    { "file": "C:\\ruta-de-salida\\demo.mp4", "start": 5, "duration": 3,
      "region": { "x": 0.1, "y": 0.2, "width": 0.6, "height": 0.5 }, "title": "Resultado" }
  ],
  "width": 1280,
  "height": 720,
  "branding": true,
  "subtitles": [{ "start": 0, "end": 3, "text": "Una demostración paso a paso" }]
}
```

Todos los archivos de entrada deben estar en la carpeta de salida de Recorder; no se admite leer rutas arbitrarias. Los originales se conservan. Los clips se recortan a su duración disponible, se ajustan a la resolución elegida y se unen con cortes. `branding` (desactivado por defecto) añade el icono de Recorder en la esquina inferior derecha; para usar tu marca, sustituye `desktop/assets/recorder.png`. Se conserva el audio original, rellenando silencio cuando un clip no lo tiene.

Para narrar, consulta voices.list, llama a narration.create y espera su WAV. Pasa su ruta como `narration` a media.compose. El audio original baja al 25% y se mezcla con la voz; el vídeo determina la duración final. Ajusta la duración del montaje para no cortar la locución. La voz utiliza System.Speech local y su calidad depende de las voces instaladas. Los subtítulos son texto y tiempos proporcionados por el agente; no hay transcripción automática.

## Límites y seguridad

- Aplicación local Windows; captura de escritorio requiere sesión interactiva y equipo activo. No se han probado grabaciones de varias horas.
- Demos web requieren Edge o Chrome instalado. El codificador de Playwright se distribuye con Recorder; no hay descarga automática al usarlo.
- MCP utiliza el SDK oficial v1 y negociación compatible hasta la revisión 2025-11-25. No se afirma compatibilidad con todos los clientes o revisiones futuras; se probó un cliente real del SDK.
- No hay control arbitrario de programas Windows mediante UI Automation, conexión cloud, clonación de voz, transcripción ni transiciones de zoom animadas. Se pueden grabar esas ventanas, y su automatización requiere un adaptador del software objetivo.
- Servicio solo en 127.0.0.1, token aleatorio, validación Zod, rechazo de Origin y Host ajenos, sin acceso externo a eval/shell. El archivo de conexión permanece en el perfil local. No lo compartas.
- No es un aislamiento frente a procesos maliciosos de la misma cuenta de Windows. Usar distintos RECORDER_CLIENT evita órdenes accidentales entre agentes, pero un cliente con la clave tiene acceso al conjunto de herramientas.

## Verificación

`npm --prefix desktop run test:agents` prueba contra Electron real. `RECORDER_EXE` permite repetirla sobre la versión portable. Comprueba CLI, MCP stdio, autenticación, regiones, grabación, pausa, marcas, exportación, demo web, voz local, montaje, errores, cancelación y revocación. Las duraciones y streams se inspeccionan con FFprobe. Evidencias en `desktop/qa/artifacts/`.

`npm --prefix desktop run test:multiview` comprueba el flujo de dos sesiones y genera la demo de ejemplo.

`npm --prefix desktop run test:compatibility` comprueba fuentes reales, composición de aplicación + Edge, metadatos de monitores, dispositivos, ajustes parciales, programación y selector. `test:visual` revisa las ocho secciones y pausa/reanudación.
