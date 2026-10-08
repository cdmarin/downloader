package com.cdmarin.clipsaver

import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Exposed to script.js as `window.ClipSaverAndroid`; replaces the /api endpoints of server.js.
 * Methods are called from a WebView background thread.
 */
class WebBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun startDownload(payload: String): String =
        try {
            DownloadEngine.start(activity, JSONObject(payload)).toString()
        } catch (e: Exception) {
            Log.e("ClipSaver", "Could not start download", e)
            JSONObject().put("error", "Error al procesar la descarga.").toString()
        }

    /** Trims the file last picked in the page (trimmer.js); progress is read with [getProgress]. */
    @JavascriptInterface
    fun startTrim(payload: String): String =
        try {
            DownloadEngine.startTrim(activity, activity.pickedFileUri, JSONObject(payload)).toString()
        } catch (e: Exception) {
            Log.e("ClipSaver", "Could not start trim", e)
            JSONObject().put("error", "Error al preparar el recorte.").toString()
        }

    /** Changes speed of the file last picked in the page (speed.js); progress is read with [getProgress]. */
    @JavascriptInterface
    fun startSpeed(payload: String): String =
        try {
            DownloadEngine.startSpeed(activity, activity.pickedFileUri, JSONObject(payload)).toString()
        } catch (e: Exception) {
            Log.e("ClipSaver", "Could not start speed change", e)
            JSONObject().put("error", "Error al preparar el cambio de velocidad.").toString()
        }

    @JavascriptInterface
    fun getProgress(jobId: String): String = DownloadEngine.snapshot(jobId).toString()

    @JavascriptInterface
    fun activeJobId(): String = DownloadEngine.activeJobId().orEmpty()

    @JavascriptInterface
    fun consumeSharedUrl(): String = activity.consumeSharedUrl().orEmpty()

    @JavascriptInterface
    fun appVersion(): String =
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName.orEmpty()

    /** Main CPU type (e.g. "arm64-v8a"), to download the matching APK of a new version. */
    @JavascriptInterface
    fun cpuAbi(): String = Build.SUPPORTED_ABIS.firstOrNull().orEmpty()

    @JavascriptInterface
    fun openFile(jobId: String) {
        val (uri, mimeType) = DownloadEngine.savedFile(jobId) ?: return
        activity.runOnUiThread { activity.openFile(uri, mimeType) }
    }
}
