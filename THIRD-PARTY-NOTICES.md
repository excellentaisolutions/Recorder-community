# Avisos de terceros

El código de Recorder se distribuye bajo [Apache License 2.0](LICENSE). Las versiones empaquetadas y el instalador incluyen además software de terceros, cada uno con su propia licencia. El repositorio **no** incluye los binarios de FFmpeg: `desktop/scripts/prepare-tools.ps1` los copia desde tu instalación local de FFmpeg al preparar el empaquetado.

| Componente | Licencia | Cómo se usa |
|---|---|---|
| [Electron](https://www.electronjs.org/) | MIT (Chromium y Node.js incluidos con sus licencias en `LICENSES.chromium.html` y `LICENSE`, junto al ejecutable) | Base de la aplicación |
| [FFmpeg](https://ffmpeg.org/) y FFprobe | GPLv3 en la compilación que se distribuye (consulta `licenses/FFmpeg-README.txt` para la versión, la línea `configure` y las bibliotecas incluidas) | Programas independientes que Recorder ejecuta para exportar y analizar vídeo; no se enlazan con el código de Recorder |
| FFmpeg de Playwright (`ffmpeg-win64.exe`) | LGPL 2.1 (`COPYING.LGPLv2.1` junto al binario) | Codificación de las demos web |
| [Playwright](https://playwright.dev/) | Apache-2.0 | Automatización de navegador para demos |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | Servidor MCP local |
| [Zod](https://zod.dev/) | MIT | Validación |
| Resto de dependencias npm de producción | MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 | Dependencias transitivas; ver `desktop/package-lock.json` |

## Código fuente de FFmpeg

Quien **distribuya** un paquete o instalador que contenga FFmpeg debe ofrecer, desde el mismo lugar de descarga, el código fuente correspondiente a ese binario exacto (GPLv3, sección 6). Para la compilación de [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) esto incluye el código de FFmpeg de esa versión y el de las bibliotecas externas compiladas dentro. Antes de publicar una Release con binarios, adjunta ese código o usa una compilación de FFmpeg que lo publique completo.
