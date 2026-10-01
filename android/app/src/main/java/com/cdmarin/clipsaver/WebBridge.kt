package com.cdmarin.clipsaver

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

    @JavascriptInterface
    fun getProgress(jobId: String): String = DownloadEngine.snapshot(jobId).toString()

    @JavascriptInterface
    fun activeJobId(): String = DownloadEngine.activeJobId().orEmpty()

    @JavascriptInterface
    fun consumeSharedUrl(): String = activity.consumeSharedUrl().orEmpty()

    @JavascriptInterface
    fun openFile(jobId: String) {
        val (uri, mimeType) = DownloadEngine.savedFile(jobId) ?: return
        activity.runOnUiThread { activity.openFile(uri, mimeType) }
    }
}
