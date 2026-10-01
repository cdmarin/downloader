# ClipSaver para Android

App Android que descarga videos y audios directamente en el móvil, sin necesitar el PC.
Usa la misma interfaz que la versión de escritorio (carpeta `public/`) dentro de un WebView,
y ejecuta yt-dlp, Python y FFmpeg dentro de la app gracias a
[youtubedl-android](https://github.com/JunkFood02/youtubedl-android).

- Los archivos se guardan en **Descargas/ClipSaver**.
- Puedes compartir un enlace desde YouTube, TikTok, Instagram... y elegir **ClipSaver**.
- La descarga sigue en segundo plano y muestra su progreso en una notificación.
- yt-dlp se actualiza solo una vez al día para seguir funcionando cuando cambian las webs.
- Desde el menú (arriba a la izquierda) puedes **recortar** cualquier vídeo o audio del móvil y ver la versión instalada.
- Requiere Android 10 o superior.

## Descargar la APK

GitHub Actions compila la APK en cada cambio (workflow **Android APK**):

1. Ve a la pestaña **Actions** del repositorio, abre la última ejecución de *Android APK*
   y descarga el artefacto **ClipSaver-apk** (un .zip con las APKs).
2. O crea un tag de versión (`git tag v1.0 && git push origin v1.0`) y las APKs se publican
   en **Releases**, más cómodo para descargarlas desde el móvil.

Qué APK elegir:

| Archivo | Para |
| --- | --- |
| `ClipSaver-arm64-v8a-release.apk` | Casi todos los móviles actuales (recomendada) |
| `ClipSaver-armeabi-v7a-release.apk` | Móviles antiguos de 32 bits |
| `ClipSaver-universal-release.apk` | Cualquier móvil (más pesada) |
| `ClipSaver-x86_64-release.apk` | Emuladores |

Al instalarla, Android pedirá permitir la instalación desde "orígenes desconocidos".

## Compilar en tu PC

Con Android Studio (o el SDK de Android y JDK 17):

```bash
cd android
./gradlew assembleRelease
```

Las APKs quedan en `android/app/build/outputs/apk/release/`.

La app se firma con `app/clipsaver.keystore` para que cada versión nueva se pueda instalar
encima de la anterior. Es una clave para uso personal: no la uses para publicar en Google Play.
