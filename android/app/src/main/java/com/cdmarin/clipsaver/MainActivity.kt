package com.cdmarin.clipsaver

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.window.OnBackInvokedDispatcher
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader

/** Shows the same web UI as the PC version (public/) inside a WebView. */
class MainActivity : Activity() {
    private lateinit var webView: WebView

    @Volatile
    private var pendingSharedUrl: String? = null

    /** File last chosen in a page file input (the trimmer), read by [WebBridge.startTrim]. */
    @Volatile
    var pickedFileUri: Uri? = null
        private set

    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        pendingSharedUrl = extractSharedUrl(intent)

        val root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.background)) }
        webView = WebView(this).apply { setBackgroundColor(getColor(R.color.background)) }
        root.addView(webView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setContentView(root)

        // Keep the page clear of the status bar, navigation bar and keyboard
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            // Files picked in the trimmer come from content:// documents
            allowContentAccess = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            // Only the app's own page runs inside the WebView; other links open in the browser
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (e: ActivityNotFoundException) {
                    // Nothing can open it; ignore the click
                }
                return true
            }
        }
        // <input type="file"> (trimmer): open the system picker for videos and audios
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                val mimeTypes = params.acceptTypes
                    .flatMap { it.split(',') }
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .ifEmpty { listOf("*/*") }
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, REQUEST_PICK_FILE)
                    true
                } catch (e: ActivityNotFoundException) {
                    fileChooserCallback = null
                    false
                }
            }
        }
        webView.addJavascriptInterface(WebBridge(this), "ClipSaverAndroid")
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/index.html")

        requestNotificationPermission()

        // Back goes back inside the page first (e.g. from the trimmer to the downloader)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
                handleBack()
            }
        }
    }

    @Deprecated("Only used before Android 13; newer versions use the callback registered in onCreate")
    override fun onBackPressed() {
        handleBack()
    }

    private fun handleBack() {
        if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
    }

    data class PickedFileItem(val uri: Uri, val name: String, val size: Long)

    val pickedFilesHistory = java.util.Collections.synchronizedList(mutableListOf<PickedFileItem>())

    fun resolvePickedUris(names: List<String>): List<Uri> {
        val result = mutableListOf<Uri>()
        val pool = synchronized(pickedFilesHistory) { ArrayList(pickedFilesHistory) }
        for (name in names) {
            val idx = pool.indexOfFirst { it.name.equals(name, ignoreCase = true) }
            if (idx != -1) {
                result.add(pool.removeAt(idx).uri)
            } else if (pool.isNotEmpty()) {
                result.add(pool.removeAt(0).uri)
            }
        }
        return result
    }

    @Deprecated("Activity result API needs AndroidX Activity; this app uses the platform Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_PICK_FILE) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val uris = mutableListOf<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            data.data?.let { uris.add(it) }
            val clipData = data.clipData
            if (clipData != null) {
                for (i in 0 until clipData.itemCount) {
                    val u = clipData.getItemAt(i).uri
                    if (u != null && !uris.contains(u)) uris.add(u)
                }
            }
        }
        if (uris.isNotEmpty()) {
            pickedFileUri = uris.first()
            for (u in uris) {
                val name = DownloadEngine.displayName(this, u) ?: u.lastPathSegment ?: "archivo"
                val size = DownloadEngine.fileSize(this, u)
                pickedFilesHistory.add(PickedFileItem(u, name, size))
            }
        }
        fileChooserCallback?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        fileChooserCallback = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingSharedUrl = extractSharedUrl(intent) ?: return
        // If the page is still loading, it picks the link up itself once ready
        webView.evaluateJavascript(
            "window.clipSaverReceiveUrl && window.clipSaverReceiveUrl(ClipSaverAndroid.consumeSharedUrl())",
            null
        )
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    fun consumeSharedUrl(): String? {
        val url = pendingSharedUrl
        pendingSharedUrl = null
        return url
    }

    fun openFile(uri: Uri, mimeType: String) {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mimeType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_to_open, Toast.LENGTH_SHORT).show()
        }
    }

    private fun extractSharedUrl(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (text.isEmpty()) return null
        // Apps like TikTok share a sentence with the link inside it
        return Regex("https?://\\S+").find(text)?.value ?: text
    }

    private companion object {
        const val REQUEST_PICK_FILE = 2
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }
}
