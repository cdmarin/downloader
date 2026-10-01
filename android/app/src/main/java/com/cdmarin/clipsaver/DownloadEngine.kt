package com.cdmarin.clipsaver

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.content.edit
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

/**
 * Android counterpart of server.js: runs yt-dlp (bundled by youtubedl-android),
 * tracks progress per job and saves the result to Downloads/ClipSaver.
 */
object DownloadEngine {
    private const val TAG = "ClipSaver"
    private const val PROGRESS_PREFIX = "NEXPROGRESS"
    private const val TOTAL_PREFIX = "NEXTOTAL"
    private const val PREFS = "clipsaver"
    private const val PREF_LAST_UPDATE = "lastYtDlpUpdate"
    private const val UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000L
    private const val DOWNLOADS_SUBFOLDER = "ClipSaver"
    private val POSTPROCESSOR_LINE = Regex("^\\[(Merger|ExtractAudio|Fixup\\w*|VideoConvertor)]")

    private val ready = CountDownLatch(1)
    @Volatile
    private var initError: Throwable? = null
    private val executor = Executors.newCachedThreadPool()
    private val jobs = ConcurrentHashMap<String, Job>()

    class Job(val id: String, val isAudio: Boolean, val trimmed: Boolean) {
        val createdAt = System.currentTimeMillis()
        var status = "starting"
        var completedBytes = 0L
        var streamBytes = 0L
        var streamTotal: Long? = null
        var expectedTotal: Long? = null
        var speed: Double? = null
        var eta: Long? = null
        var result: JSONObject? = null
        var error: String? = null
        var fileUri: Uri? = null
        var mimeType: String? = null

        val isActive get() = status != "done" && status != "error"
    }

    data class NotificationState(val status: String, val percent: Int?)

    /** Unpacks Python/FFmpeg on first launch and keeps yt-dlp up to date (once a day). */
    fun initialize(context: Context) {
        val appContext = context.applicationContext
        executor.execute {
            try {
                YoutubeDL.getInstance().init(appContext)
                FFmpeg.getInstance().init(appContext)
                updateYtDlpIfDue(appContext)
            } catch (e: Throwable) {
                Log.e(TAG, "Failed to initialize yt-dlp", e)
                initError = e
            } finally {
                ready.countDown()
            }
        }
    }

    private fun updateYtDlpIfDue(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong(PREF_LAST_UPDATE, 0) < UPDATE_INTERVAL_MS) return
        try {
            val status = YoutubeDL.getInstance().updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
            Log.i(TAG, "yt-dlp update: $status (${YoutubeDL.getInstance().versionName(context)})")
            prefs.edit { putLong(PREF_LAST_UPDATE, now) }
        } catch (e: Exception) {
            // Offline or GitHub unreachable: keep using the current version
            Log.w(TAG, "yt-dlp update failed", e)
        }
    }

    fun start(context: Context, payload: JSONObject): JSONObject {
        val url = payload.optString("url").trim()
        if (url.isEmpty()) {
            return JSONObject().put("error", "Introduce un enlace.")
        }
        val format = payload.optString("format", "mp4")
        val startSec = parseTimeInput(payload.optString("trimStart"))
        val endSec = parseTimeInput(payload.optString("trimEnd"))
        if (startSec != null && endSec != null && startSec >= endSec) {
            return JSONObject().put("error", "El tiempo de inicio debe ser menor que el tiempo final.")
        }

        val job = Job(
            id = UUID.randomUUID().toString(),
            isAudio = format == "mp3" || format == "m4a",
            trimmed = startSec != null || endSec != null
        )
        jobs[job.id] = job
        Log.i(TAG, "Starting download for: $url (Format: $format, Trim: $startSec - $endSec)")

        val appContext = context.applicationContext
        DownloadService.start(appContext)
        executor.execute { runJob(appContext, job, url, format, startSec, endSec) }
        return JSONObject().put("jobId", job.id)
    }

    fun snapshot(jobId: String): JSONObject {
        val job = jobs[jobId] ?: return JSONObject().put("error", "Descarga no encontrada.")
        synchronized(job) {
            val downloadedBytes = job.completedBytes + job.streamBytes
            var totalBytes = job.streamTotal?.let { job.completedBytes + it }
            // Prefer the size announced before downloading (covers video+audio together),
            // unless it is already exceeded because it was only approximate
            job.expectedTotal?.let { if (it >= downloadedBytes) totalBytes = it }
            return JSONObject()
                .put("status", job.status)
                .put("downloadedBytes", downloadedBytes)
                .put("totalBytes", totalBytes ?: JSONObject.NULL)
                .put("speed", job.speed ?: JSONObject.NULL)
                .put("eta", job.eta ?: JSONObject.NULL)
                .put("result", job.result ?: JSONObject.NULL)
                .put("error", job.error ?: JSONObject.NULL)
        }
    }

    /** Most recent unfinished job, so the UI can resume it after the app is reopened. */
    fun activeJobId(): String? =
        jobs.values.filter { synchronized(it) { it.isActive } }.maxByOrNull { it.createdAt }?.id

    fun notificationState(): NotificationState? {
        val job = jobs.values.filter { synchronized(it) { it.isActive } }.maxByOrNull { it.createdAt }
            ?: return null
        val snapshot = snapshot(job.id)
        val downloaded = snapshot.optLong("downloadedBytes")
        val total = snapshot.optLong("totalBytes", 0)
        val percent = if (total > 0) (downloaded * 100 / total).toInt().coerceIn(0, 100) else null
        return NotificationState(snapshot.getString("status"), percent)
    }

    fun savedFile(jobId: String): Pair<Uri, String>? {
        val job = jobs[jobId] ?: return null
        synchronized(job) {
            val uri = job.fileUri ?: return null
            return uri to (job.mimeType ?: "*/*")
        }
    }

    private fun runJob(
        context: Context,
        job: Job,
        url: String,
        format: String,
        startSec: Double?,
        endSec: Double?
    ) {
        // Each job downloads into its own folder, so the result is whatever file ends up there
        val jobDir = File(context.noBackupFilesDir, "jobs/${job.id}")
        try {
            ready.await()
            initError?.let { throw EngineInitException(it) }
            jobDir.mkdirs()

            val request = buildRequest(url, format, startSec, endSec, jobDir)
            YoutubeDL.getInstance().execute(request, job.id) { _, _, line -> handleOutputLine(job, line) }

            val file = jobDir.listFiles()
                ?.filter { it.isFile && !it.name.endsWith(".part") && !it.name.endsWith(".ytdl") }
                ?.maxByOrNull { it.length() }
                ?: throw IOException("yt-dlp did not produce any file")

            synchronized(job) { job.status = "processing" }
            val mimeType = mimeTypeFor(file, job.isAudio)
            val uri = saveToDownloads(context, file, mimeType)

            var message = if (job.isAudio) "Audio descargado con éxito." else "Video descargado con éxito."
            if (job.trimmed) message += " (Fragmento recortado)"
            message += " Guardado en Descargas/$DOWNLOADS_SUBFOLDER."
            Log.i(TAG, "Download completed successfully: ${file.name}")

            synchronized(job) {
                job.fileUri = uri
                job.mimeType = mimeType
                job.result = JSONObject()
                    .put("success", true)
                    .put("message", message)
                    .put("filename", file.name)
                    .put("jobId", job.id)
                job.status = "done"
            }
        } catch (e: Throwable) {
            Log.e(TAG, "Download error", e)
            synchronized(job) {
                job.error = errorMessage(e)
                job.status = "error"
            }
        } finally {
            jobDir.deleteRecursively()
        }
    }

    private fun buildRequest(
        url: String,
        format: String,
        startSec: Double?,
        endSec: Double?,
        jobDir: File
    ): YoutubeDLRequest {
        val request = YoutubeDLRequest(url)
            .addOption("-o", File(jobDir, "%(title)s.%(ext)s").absolutePath)
            .addOption("--no-check-certificates")
            .addOption("--no-warnings")
            .addOption("--extractor-args", "youtube:player_client=mweb")
            .addOption("--newline")
            .addOption("--progress")
            .addOption(
                "--progress-template",
                "download:$PROGRESS_PREFIX %(progress.status)s %(progress.downloaded_bytes)s " +
                    "%(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s"
            )
            // Announce the full size (video+audio) before downloading, when the site provides it.
            // --print implies --quiet, so --no-quiet keeps the progress/postprocessor output
            .addOption("--print", "before_dl:$TOTAL_PREFIX %(filesize,filesize_approx)s")
            .addOption("--no-quiet")
            // Names that are also valid for Android's shared storage
            .addOption("--windows-filenames")
            .addOption("--no-mtime")

        when (format) {
            "mp3" -> request
                .addOption("-x")
                .addOption("--audio-format", "mp3")
                .addOption("--audio-quality", "0")
            "m4a" -> request.addOption("-f", "bestaudio[ext=m4a]/bestaudio/best")
            else -> request
                .addOption("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best")
                .addOption("--merge-output-format", "mp4")
        }

        if (startSec != null || endSec != null) {
            val start = formatSeconds(startSec ?: 0.0)
            val end = endSec?.let(::formatSeconds) ?: "inf"
            request
                .addOption("--download-sections", "*$start-$end")
                .addOption("--force-keyframes-at-cuts")
        }
        return request
    }

    private fun handleOutputLine(job: Job, line: String) {
        synchronized(job) {
            when {
                line.startsWith(PROGRESS_PREFIX) -> handleProgressLine(job, line)
                line.startsWith(TOTAL_PREFIX) -> {
                    // The announced size is for the whole video, so it is wrong when trimming
                    if (!job.trimmed) job.expectedTotal = toLong(line.substring(TOTAL_PREFIX.length).trim())
                }
                POSTPROCESSOR_LINE.containsMatchIn(line) -> job.status = "processing"
            }
        }
    }

    // Video+audio downloads report each stream separately, so bytes of finished
    // streams are accumulated to show the overall amount downloaded.
    private fun handleProgressLine(job: Job, line: String) {
        val parts = line.substring(PROGRESS_PREFIX.length).trim().split(' ')
        val bytes = toLong(parts.getOrNull(1)) ?: return

        if (bytes < job.streamBytes) {
            // A new stream started without a "finished" report
            job.completedBytes += job.streamBytes
        }
        job.streamBytes = bytes
        job.streamTotal = toLong(parts.getOrNull(2)) ?: toLong(parts.getOrNull(3))
        job.speed = toDouble(parts.getOrNull(4))
        job.eta = toLong(parts.getOrNull(5))
        job.status = "downloading"

        if (parts.getOrNull(0) == "finished") {
            job.completedBytes += bytes
            job.streamBytes = 0
            job.streamTotal = null
        }
    }

    private fun saveToDownloads(context: Context, file: File, mimeType: String): Uri {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOADS_SUBFOLDER")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("Could not create file in Downloads")
        try {
            val output = resolver.openOutputStream(uri) ?: throw IOException("Could not open $uri")
            output.use { out -> file.inputStream().use { it.copyTo(out) } }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return uri
    }

    private fun mimeTypeFor(file: File, isAudio: Boolean): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
            ?: if (isAudio) "audio/*" else "video/*"

    private fun errorMessage(e: Throwable): String {
        if (e is EngineInitException) {
            return "No se pudo iniciar el motor de descarga. Prueba a reinstalar la app."
        }
        var message = "No se pudo descargar el archivo. Verifica la URL o tu conexión."
        // yt-dlp explains what went wrong in its last "ERROR:" line
        val detail = (e as? YoutubeDLException)?.message
            ?.lineSequence()
            ?.lastOrNull { it.startsWith("ERROR:") }
            ?.removePrefix("ERROR:")
            ?.trim()
        if (!detail.isNullOrEmpty()) message += " Detalle: ${detail.take(300)}"
        return message
    }

    private class EngineInitException(cause: Throwable) : Exception(cause)

    // Parse time input (seconds or mm:ss or hh:mm:ss)
    private fun parseTimeInput(timeStr: String?): Double? {
        val str = timeStr?.trim().orEmpty()
        if (str.isEmpty()) return null
        if (Regex("^\\d+(\\.\\d+)?$").matches(str)) return str.toDouble()
        val parts = str.split(':').map { it.toDoubleOrNull() ?: return null }
        return when (parts.size) {
            2 -> parts[0] * 60 + parts[1]
            3 -> parts[0] * 3600 + parts[1] * 60 + parts[2]
            else -> null
        }
    }

    private fun formatSeconds(value: Double): String =
        if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()

    // yt-dlp prints "NA" for unknown values
    private fun toDouble(value: String?): Double? = value?.toDoubleOrNull()?.takeIf { it.isFinite() }

    private fun toLong(value: String?): Long? = toDouble(value)?.toLong()
}
