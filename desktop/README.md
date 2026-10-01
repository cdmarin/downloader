# ClipSaver para Windows

App de escritorio que descarga videos y audios sin tener que instalar nada más (ni Node.js, ni Python,
ni FFmpeg). Es la misma interfaz y el mismo `server.js` que la versión de PC, empaquetados con
[Electron](https://www.electronjs.org/) junto con yt-dlp y FFmpeg.

- Los archivos se guardan en la carpeta **Descargas**.
- Al terminar una descarga puedes **abrir el archivo** o **mostrarlo en su carpeta**.
- yt-dlp se actualiza solo una vez al día para seguir funcionando cuando cambian las webs.
- Desde el menú (arriba a la izquierda) puedes **recortar** cualquier vídeo o audio del PC y ver la versión instalada.

## Descargar

GitHub Actions compila la app en cada cambio (workflow **Windows App**):

- Al publicar una release con tag `v...` se añaden a ella los dos `.exe`.
- En cualquier ejecución del workflow están en el artefacto **ClipSaver-windows**.

| Archivo | Para |
| --- | --- |
| `ClipSaver-Setup-X.Y.Z.exe` | Instalador normal: acceso directo en el escritorio y en el menú Inicio |
| `ClipSaver-portable-X.Y.Z.exe` | Un único archivo que se abre sin instalar (para pasarlo por USB o Drive) |

La app no está firmada, así que la primera vez Windows muestra **"Windows protegió su PC"**:
pulsa **Más información → Ejecutar de todas formas**.

## Compilar en tu PC

Con Node.js instalado, en Windows:

```bash
cd desktop
npm install
npm start       # abre la app sin empaquetar (necesita también `npm install` en la raíz)
npm run dist    # crea los .exe en desktop/dist/
```
