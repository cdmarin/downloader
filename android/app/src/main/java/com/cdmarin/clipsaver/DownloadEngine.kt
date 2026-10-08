package com.cdmarin.clipsaver

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
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
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.concurrent.thread

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

    class Job(
        val id: String,
        val isAudio: Boolean,
        val trimmed: Boolean,
        val isTrimJob: Boolean = false,
        val isSpeedJob: Boolean = false,
        val isVolumeJob: Boolean = false
    ) {
        val createdAt = System.currentTimeMillis()
        var status = "starting"
        var completedBytes = 0L
        var streamBytes = 0L
        var streamTotal: Long? = null
        var expectedTotal: Long? = null
        var speed: Double? = null
        var eta: Long? = null
        var percent: Double? = null // trims/speed/volume report progress as a percentage instead of bytes
        var result: JSONObject? = null
        var error: String? = null
        var fileUri: Uri? = null
        var mimeType: String? = null

        val isActive get() = status != "done" && status != "error"
    }

    data class NotificationState(
        val status: String,
        val percent: Int?,
        val isTrim: Boolean,
        val isSpeed: Boolean = false,
        val isVolume: Boolean = false
    )

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
                .put("percent", job.percent ?: JSONObject.NULL)
                .put("result", job.result ?: JSONObject.NULL)
                .put("error", job.error ?: JSONObject.NULL)
        }
    }

    /** Most recent unfinished download, so the UI can resume it after the app is reopened. */
    fun activeJobId(): String? =
        jobs.values.filter { !it.isTrimJob && !it.isSpeedJob && !it.isVolumeJob && synchronized(it) { it.isActive } }.maxByOrNull { it.createdAt }?.id

    fun notificationState(): NotificationState? {
        val job = jobs.values.filter { synchronized(it) { it.isActive } }.maxByOrNull { it.createdAt }
            ?: return null
        val snapshot = snapshot(job.id)
        val status = snapshot.getString("status")
        if (job.isTrimJob || job.isSpeedJob || job.isVolumeJob) {
            val percent = synchronized(job) { job.percent }?.toInt()?.coerceIn(0, 100)
            return NotificationState(
                status,
                percent,
                isTrim = job.isTrimJob,
                isSpeed = job.isSpeedJob,
                isVolume = job.isVolumeJob
            )
        }
        val downloaded = snapshot.optLong("downloadedBytes")
        val total = snapshot.optLong("totalBytes", 0)
        val percent = if (total > 0 && status == "downloading") (downloaded * 100 / total).toInt().coerceIn(0, 100) else null
        return NotificationState(status, percent, isTrim = false, isSpeed = false, isVolume = false)
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
            // If only a format with video is available, its audio is extracted
            "m4a" -> request
                .addOption("-f", "bestaudio[ext=m4a]/bestaudio/best")
                .addOption("-x")
                .addOption("--audio-format", "m4a")
            else -> request
                .addOption("-f", "bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best")
                .addOption("--merge-output-format", "mp4")
        }

        if (startSec != null || endSec != null) {
            val start = formatSeconds(startSec ?: 0.0)
            val end = endSec?.let(::formatSeconds) ?: "inf"
            request
                .addOption("--download-sections", "*$start-$end")
                .addOption("--force-keyframes-at-cuts")
                // Sections are fetched by FFmpeg, and YouTube answers 403 to its requests for the
                // high quality streams; the mweb client still offers one (360p) that FFmpeg can read
                .addOption("--extractor-args", "youtube:player_client=mweb")
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

    // ----- Trimmer (menu > "Recortar audio o vídeo"): same rules as trimArgs() in server.js -----

    private class AudioEncoder(val ext: String, val args: List<String>)

    // Codec settings for trims of audio-only files, keyed by input extension
    private val AUDIO_ENCODERS = mapOf(
        "mp3" to AudioEncoder("mp3", listOf("-c:a", "libmp3lame", "-q:a", "0")),
        "m4a" to AudioEncoder("m4a", listOf("-c:a", "aac", "-b:a", "192k")),
        "aac" to AudioEncoder("m4a", listOf("-c:a", "aac", "-b:a", "192k")),
        "ogg" to AudioEncoder("ogg", listOf("-c:a", "libvorbis", "-q:a", "6")),
        "oga" to AudioEncoder("ogg", listOf("-c:a", "libvorbis", "-q:a", "6")),
        "opus" to AudioEncoder("opus", listOf("-c:a", "libopus", "-b:a", "160k")),
        "webm" to AudioEncoder("opus", listOf("-c:a", "libopus", "-b:a", "160k")),
        "wav" to AudioEncoder("wav", listOf("-c:a", "pcm_s16le")),
        "flac" to AudioEncoder("flac", listOf("-c:a", "flac"))
    )
    private val DEFAULT_AUDIO_ENCODER = AUDIO_ENCODERS.getValue("m4a")
    private val FFMPEG_OUT_TIME = Regex("^out_time_(?:us|ms)=(\\d+)")

    /** Cuts [source] (the file picked in the page) between payload.start and payload.end. */
    fun startTrim(context: Context, source: Uri?, payload: JSONObject): JSONObject {
        if (source == null) {
            return JSONObject().put("error", "Vuelve a elegir el archivo.")
        }
        val start = parseTimeInput(payload.optString("start")) ?: 0.0
        val end = parseTimeInput(payload.optString("end"))
        if (end != null && start >= end) {
            return JSONObject().put("error", "El inicio debe ser anterior al final.")
        }
        val hasVideo = payload.optString("hasVideo") == "1"
        val mediaDuration = payload.optString("mediaDuration").toDoubleOrNull()

        val job = Job(UUID.randomUUID().toString(), isAudio = !hasVideo, trimmed = true, isTrimJob = true)
        jobs[job.id] = job
        Log.i(TAG, "Trimming $source: $start - ${end ?: "end"}")

        val appContext = context.applicationContext
        DownloadService.start(appContext)
        executor.execute {
            val duration = end?.let { it - start } ?: mediaDuration?.let { it - start }
            runTrim(appContext, job, source, start, end, hasVideo, duration)
        }
        return JSONObject().put("jobId", job.id)
    }

    private fun runTrim(
        context: Context,
        job: Job,
        source: Uri,
        start: Double,
        end: Double?,
        hasVideo: Boolean,
        expectedDuration: Double?
    ) {
        val jobDir = File(context.noBackupFilesDir, "jobs/${job.id}")
        try {
            ready.await()
            initError?.let { throw EngineInitException(it) }
            jobDir.mkdirs()

            // FFmpeg needs a real file, so the picked document is copied first
            val displayName = displayName(context, source)?.replace('/', '_') ?: "archivo"
            val inputExt = displayName.substringAfterLast('.', "").lowercase(Locale.ROOT).take(10)
            val input = File(jobDir, if (inputExt.isEmpty()) "input" else "input.$inputExt")
            val stream = context.contentResolver.openInputStream(source) ?: throw IOException("Could not open $source")
            stream.use { inp -> input.outputStream().use { inp.copyTo(it) } }

            val baseName = (if ('.' in displayName) displayName.substringBeforeLast('.') else displayName)
                .ifBlank { "archivo" }
            val ext = trimOutputExt(hasVideo, inputExt)
            val output = File(jobDir, "$baseName (recorte).$ext")
            synchronized(job) {
                job.status = "processing"
                job.percent = 0.0
            }
            runFfmpeg(context, trimArgs(input, output, start, end?.let { it - start }, hasVideo, inputExt), job, expectedDuration)

            val mimeType = mimeTypeFor(output, !hasVideo)
            val uri = saveToDownloads(context, output, mimeType)
            val what = if (hasVideo) "Vídeo" else "Audio"
            synchronized(job) {
                job.fileUri = uri
                job.mimeType = mimeType
                job.percent = 100.0
                job.result = JSONObject()
                    .put("success", true)
                    .put("message", "$what recortado con éxito. Guardado en Descargas/$DOWNLOADS_SUBFOLDER.")
                    .put("filename", output.name)
                    .put("jobId", job.id)
                job.status = "done"
            }
        } catch (e: Throwable) {
            Log.e(TAG, "Trim error", e)
            synchronized(job) {
                job.error = if (e is EngineInitException) {
                    "No se pudo iniciar FFmpeg. Prueba a reinstalar la app."
                } else {
                    "No se pudo recortar el archivo. Comprueba que sea un audio o vídeo válido."
                }
                job.status = "error"
            }
        } finally {
            jobDir.deleteRecursively()
        }
    }

    private fun trimOutputExt(hasVideo: Boolean, inputExt: String): String =
        if (hasVideo) "mp4" else (AUDIO_ENCODERS[inputExt] ?: DEFAULT_AUDIO_ENCODER).ext

    // Re-encodes the fragment so the cut lands exactly on the requested times
    private fun trimArgs(
        input: File,
        output: File,
        start: Double,
        duration: Double?,
        hasVideo: Boolean,
        inputExt: String
    ): List<String> {
        val args = mutableListOf(
            "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
            "-ss", seconds(start), "-i", input.absolutePath
        )
        if (duration != null) args += listOf("-t", seconds(duration))
        args += if (hasVideo) {
            listOf(
                "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"
            )
        } else {
            listOf("-map", "0:a:0", "-vn") + (AUDIO_ENCODERS[inputExt] ?: DEFAULT_AUDIO_ENCODER).args
        }
        args += output.absolutePath
        return args
    }

    // ----- Speed changer (menu > "Cambiar velocidad"): same rules as speedArgs() in server.js -----

    private fun buildAtempoFilter(speed: Double): String {
        var s = speed
        val filters = mutableListOf<String>()
        while (s > 2.0) {
            filters += "atempo=2.0"
            s /= 2.0
        }
        while (s < 0.5) {
            filters += "atempo=0.5"
            s /= 0.5
        }
        val formatted = String.format(Locale.US, "%.4f", s).trimEnd('0').trimEnd('.')
        filters += "atempo=$formatted"
        return filters.joinToString(",")
    }

    private fun speedArgs(
        input: File,
        output: File,
        speed: Double,
        hasVideo: Boolean,
        inputExt: String
    ): List<String> {
        val atempo = buildAtempoFilter(speed)
        val setpts = String.format(Locale.US, "%.6f*PTS", 1.0 / speed)
        val args = mutableListOf(
            "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
            "-i", input.absolutePath
        )
        if (hasVideo) {
            args += listOf(
                "-map", "0:v:0", "-map", "0:a?",
                "-filter:v", "setpts=$setpts",
                "-filter:a", atempo,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"
            )
        } else {
            args += listOf("-map", "0:a:0", "-vn", "-filter:a", atempo) + (AUDIO_ENCODERS[inputExt] ?: DEFAULT_AUDIO_ENCODER).args
        }
        args += output.absolutePath
        return args
    }

    /** Changes speed of [source] (the file picked in the page) by payload.speed. */
    fun startSpeed(context: Context, source: Uri?, payload: JSONObject): JSONObject {
        if (source == null) {
            return JSONObject().put("error", "Vuelve a elegir el archivo.")
        }
        val speed = payload.optDouble("speed", 1.0)
        if (speed <= 0.1 || speed > 16.0) {
            return JSONObject().put("error", "Velocidad no válida.")
        }
        val hasVideo = payload.optString("hasVideo") == "1"
        val mediaDuration = payload.optString("mediaDuration").toDoubleOrNull()

        val job = Job(UUID.randomUUID().toString(), isAudio = !hasVideo, trimmed = false, isSpeedJob = true)
        jobs[job.id] = job
        Log.i(TAG, "Changing speed for $source to ${speed}x")

        val appContext = context.applicationContext
        DownloadService.start(appContext)
        executor.execute {
            val expectedDuration = mediaDuration?.let { it / speed }
            runSpeed(appContext, job, source, speed, hasVideo, expectedDuration)
        }
        return JSONObject().put("jobId", job.id)
    }

    private fun runSpeed(
        context: Context,
        job: Job,
        source: Uri,
        speed: Double,
        hasVideo: Boolean,
        expectedDuration: Double?
    ) {
        val jobDir = File(context.noBackupFilesDir, "jobs/${job.id}")
        try {
            ready.await()
            initError?.let { throw EngineInitException(it) }
            jobDir.mkdirs()

            // FFmpeg needs a real file, so the picked document is copied first
            val displayName = displayName(context, source)?.replace('/', '_') ?: "archivo"
            val inputExt = displayName.substringAfterLast('.', "").lowercase(Locale.ROOT).take(10)
            val input = File(jobDir, if (inputExt.isEmpty()) "input" else "input.$inputExt")
            val stream = context.contentResolver.openInputStream(source) ?: throw IOException("Could not open $source")
            stream.use { inp -> input.outputStream().use { inp.copyTo(it) } }

            val baseName = (if ('.' in displayName) displayName.substringBeforeLast('.') else displayName)
                .ifBlank { "archivo" }
            val ext = trimOutputExt(hasVideo, inputExt)
            val speedLabel = if (speed % 1.0 == 0.0) "${speed.toLong()}x" else "${speed}x"
            val output = File(jobDir, "$baseName ($speedLabel).$ext")
            synchronized(job) {
                job.status = "processing"
                job.percent = 0.0
            }
            runFfmpeg(context, speedArgs(input, output, speed, hasVideo, inputExt), job, expectedDuration)

            val mimeType = mimeTypeFor(output, !hasVideo)
            val uri = saveToDownloads(context, output, mimeType)
            val what = if (hasVideo) "Vídeo" else "Audio"
            synchronized(job) {
                job.fileUri = uri
                job.mimeType = mimeType
                job.percent = 100.0
                job.result = JSONObject()
                    .put("success", true)
                    .put("message", "$what modificado a $speedLabel con éxito. Guardado en Descargas/$DOWNLOADS_SUBFOLDER.")
                    .put("filename", output.name)
                    .put("jobId", job.id)
                job.status = "done"
            }
        } catch (e: Throwable) {
            Log.e(TAG, "Speed error", e)
            synchronized(job) {
                job.error = if (e is EngineInitException) {
                    "No se pudo iniciar FFmpeg. Prueba a reinstalar la app."
                } else {
                    "No se pudo cambiar la velocidad del archivo. Comprueba que sea un audio o vídeo válido."
                }
                job.status = "error"
            }
        } finally {
            jobDir.deleteRecursively()
        }
    }

    // ----- Volume changer (menu > "Ajustar volumen"): same rules as volumeArgs() in server.js -----

    private fun volumeArgs(
        input: File,
        output: File,
        volumeFactor: Double,
        hasVideo: Boolean,
        inputExt: String
    ): List<String> {
        val volFilter = String.format(Locale.US, "volume=%.2f", volumeFactor)
        val args = mutableListOf(
            "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
            "-i", input.absolutePath
        )
        if (hasVideo) {
            args += listOf(
                "-c:v", "copy",
                "-filter:a", volFilter,
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart"
            )
        } else {
            args += listOf("-map", "0:a:0", "-vn", "-filter:a", volFilter) + (AUDIO_ENCODERS[inputExt] ?: DEFAULT_AUDIO_ENCODER).args
        }
        args += output.absolutePath
        return args
    }

    /** Adjusts volume of [source] (the file picked in the page) by payload.volume. */
    fun startVolume(context: Context, source: Uri?, payload: JSONObject): JSONObject {
        if (source == null) {
            return JSONObject().put("error", "Vuelve a elegir el archivo.")
        }
        val rawVol = payload.optDouble("volume", 100.0)
        val volumeFactor = if (rawVol > 10.0) rawVol / 100.0 else rawVol
        val volumePercent = if (rawVol > 10.0) rawVol.toInt() else (rawVol * 100).toInt()

        if (volumeFactor < 0.0 || volumeFactor > 10.0) {
            return JSONObject().put("error", "Nivel de volumen no válido.")
        }
        val hasVideo = payload.optString("hasVideo") == "1"
        val mediaDuration = payload.optString("mediaDuration").toDoubleOrNull()

        val job = Job(UUID.randomUUID().toString(), isAudio = !hasVideo, trimmed = false, isVolumeJob = true)
        jobs[job.id] = job
        Log.i(TAG, "Changing volume for $source to $volumePercent% (${volumeFactor}x)")

        val appContext = context.applicationContext
        DownloadService.start(appContext)
        executor.execute {
            runVolume(appContext, job, source, volumeFactor, volumePercent, hasVideo, mediaDuration)
        }
        return JSONObject().put("jobId", job.id)
    }

    private fun runVolume(
        context: Context,
        job: Job,
        source: Uri,
        volumeFactor: Double,
        volumePercent: Int,
        hasVideo: Boolean,
        expectedDuration: Double?
    ) {
        val jobDir = File(context.noBackupFilesDir, "jobs/${job.id}")
        try {
            ready.await()
            initError?.let { throw EngineInitException(it) }
            jobDir.mkdirs()

            val displayName = displayName(context, source)?.replace('/', '_') ?: "archivo"
            val inputExt = displayName.substringAfterLast('.', "").lowercase(Locale.ROOT).take(10)
            val input = File(jobDir, if (inputExt.isEmpty()) "input" else "input.$inputExt")
            val stream = context.contentResolver.openInputStream(source) ?: throw IOException("Could not open $source")
            stream.use { inp -> input.outputStream().use { inp.copyTo(it) } }

            val baseName = (if ('.' in displayName) displayName.substringBeforeLast('.') else displayName)
                .ifBlank { "archivo" }
            val ext = trimOutputExt(hasVideo, inputExt)
            val output = File(jobDir, "$baseName (volumen $volumePercent%).$ext")
            synchronized(job) {
                job.status = "processing"
                job.percent = 0.0
            }
            runFfmpeg(context, volumeArgs(input, output, volumeFactor, hasVideo, inputExt), job, expectedDuration)

            val mimeType = mimeTypeFor(output, !hasVideo)
            val uri = saveToDownloads(context, output, mimeType)
            val what = if (hasVideo) "Vídeo" else "Audio"
            synchronized(job) {
                job.fileUri = uri
                job.mimeType = mimeType
                job.percent = 100.0
                job.result = JSONObject()
                    .put("success", true)
                    .put("message", "$what con volumen al $volumePercent% guardado con éxito. Guardado en Descargas/$DOWNLOADS_SUBFOLDER.")
                    .put("filename", output.name)
                    .put("jobId", job.id)
                job.status = "done"
            }
        } catch (e: Throwable) {
            Log.e(TAG, "Volume error", e)
            synchronized(job) {
                job.error = if (e is EngineInitException) {
                    "No se pudo iniciar FFmpeg. Prueba a reinstalar la app."
                } else {
                    "No se pudo ajustar el volumen del archivo. Comprueba que sea un audio o vídeo válido."
                }
                job.status = "error"
            }
        } finally {
            jobDir.deleteRecursively()
        }
    }

    // Runs the FFmpeg bundled by youtubedl-android the same way the library does for yt-dlp
    private fun runFfmpeg(context: Context, args: List<String>, job: Job, durationSec: Double?) {
        val ffmpeg = File(context.applicationInfo.nativeLibraryDir, "libffmpeg.so")
        val packages = File(context.noBackupFilesDir, "youtubedl-android/packages")
        val builder = ProcessBuilder(listOf(ffmpeg.absolutePath) + args)
        builder.environment()["LD_LIBRARY_PATH"] =
            listOf("python", "ffmpeg").joinToString(":") { File(packages, "$it/usr/lib").absolutePath }
        val process = builder.start()

        val errorTail = StringBuilder()
        val stderrReader = thread(name = "ffmpeg-stderr") {
            process.errorStream.bufferedReader().forEachLine { line ->
                synchronized(errorTail) {
                    errorTail.append(line).append('\n')
                    if (errorTail.length > 4000) errorTail.delete(0, errorTail.length - 4000)
                }
            }
        }
        process.inputStream.bufferedReader().forEachLine { line ->
            val micros = FFMPEG_OUT_TIME.find(line)?.groupValues?.get(1)?.toLongOrNull() ?: return@forEachLine
            if (durationSec != null && durationSec > 0) {
                synchronized(job) { job.percent = (micros / 1e6 / durationSec * 100).coerceIn(0.0, 100.0) }
            }
        }
        val exitCode = process.waitFor()
        stderrReader.join()
        if (exitCode != 0) {
            throw IOException("ffmpeg exited with code $exitCode: ${synchronized(errorTail) { errorTail.takeLast(600) }}")
        }
    }

    private fun displayName(context: Context, uri: Uri): String? =
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }

    private fun seconds(value: Double): String = String.format(Locale.US, "%.3f", value)

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
