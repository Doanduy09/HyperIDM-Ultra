package com.doanduy.duytai.core

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min

/**
 * Kotlin port of the Duytai v7.4 Download Engine:
 * - Parallel segments (up to 64/128) with bounded worker dispatcher
 * - Dynamic Work-Stealing (split largest active segment when slots free)
 * - Google Tail-at-Scale Hedged Racing on stalled/tail segments
 * - AIMD HTTP 429/503 congestion control + Multi-IP EWMA edge scoring
 * - Preallocated seekable FileChannel in-place writes + SHA-256 verification + MediaStore export
 */
class DuytaiEngine(
    private val stagingRoot: File,
    private val context: Context? = null,
    workerThreads: Int = 48
) {
    private val dispatcher = Executors.newFixedThreadPool(workerThreads).asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val jobSlots = Semaphore(3)
    private val jobs = ConcurrentHashMap<String, ManagedJob>()

    private val _jobList = MutableStateFlow<List<DownloadJobState>>(emptyList())
    val jobList: StateFlow<List<DownloadJobState>> = _jobList.asStateFlow()

    val activeDownloadCount: Int
        get() = jobs.values.count { it.status == JobStatus.DOWNLOADING || it.status == JobStatus.PROBING }

    val aggregateSpeedBps: Long
        get() = jobs.values.filter { it.status == JobStatus.DOWNLOADING }.sumOf { it.speedBps }

    private class ManagedJob(
        val id: String,
        val rawUrl: String,
        val maxConnections: Int,
        val customFileName: String? = null,
        val customHeaders: Map<String, String> = emptyMap()
    ) {
        @Volatile var resolvedUrl: String = rawUrl
        @Volatile var fileName: String = FormatCatalog.sanitizeFileName(customFileName ?: guessName(rawUrl))
        @Volatile var category: String = FormatCatalog.categorize(fileName, rawUrl)
        @Volatile var status: JobStatus = JobStatus.QUEUED
        @Volatile var totalBytes: Long = 0L
        @Volatile var acceptRanges: Boolean = false
        @Volatile var effectiveMaxConnections: Int = maxConnections.coerceIn(1, 128)
        @Volatile var speedBps: Long = 0L
        @Volatile var peakSpeedBps: Long = 0L
        @Volatile var sha256: String = ""
        @Volatile var publicPath: String = ""
        @Volatile var publicUri: String = ""
        @Volatile var error: String? = null
        @Volatile var rateLimitUntil: Long = 0L

        val counters = JobRuntimeCounters()
        val segments = mutableListOf<SegmentState>()
        val edgeLatencyEwma = ConcurrentHashMap<String, Double>()
        val pausedOrStopped = AtomicBoolean(false)
        var cdnIps: List<String> = emptyList()
        var stagingFile: File? = null
        var stateJournalFile: File? = null
        var channel: FileChannel? = null
        var raf: RandomAccessFile? = null
        var runnerJob: Job? = null

        fun snapshot(): DownloadJobState = DownloadJobState(
            id = id,
            url = resolvedUrl,
            fileName = fileName,
            category = category,
            status = status,
            totalBytes = totalBytes,
            downloadedBytes = counters.downloadedBytes.get(),
            speedBps = speedBps,
            peakSpeedBps = peakSpeedBps,
            maxConnections = maxConnections,
            effectiveConnections = effectiveMaxConnections,
            activeWorkers = counters.activeWorkers.get(),
            hedgeWins = counters.hedgeWins.get(),
            recycleCount = counters.recycleCount.get(),
            sha256 = sha256,
            publicPath = publicPath,
            publicUri = publicUri,
            error = error
        )
    }

    init {
        stagingRoot.mkdirs()
        restorePersistedJournals()
    }

    fun enqueue(
        url: String,
        maxConnections: Int = 64,
        fileName: String? = null,
        headers: Map<String, String> = emptyMap(),
        startImmediately: Boolean = true
    ): String {
        val cleanUrl = url.trim()
        val id = FormatCatalog.newId()
        val job = ManagedJob(id, cleanUrl, maxConnections.coerceIn(1, 128), fileName, headers)
        jobs[id] = job
        emitStates()
        if (startImmediately) start(id)
        return id
    }

    fun start(id: String) {
        val job = jobs[id] ?: return
        if (job.status == JobStatus.DOWNLOADING || job.status == JobStatus.COMPLETED) return
        job.pausedOrStopped.set(false)
        job.error = null
        job.rateLimitUntil = 0L
        job.effectiveMaxConnections = job.maxConnections.coerceIn(1, 128)
        synchronized(job.segments) {
            job.segments.forEach {
                it.retries = 0
                if (it.status == "downloading") it.status = "pending"
            }
        }
        job.status = JobStatus.PROBING
        emitStates()
        job.runnerJob = scope.launch { executeJob(job) }
    }

    fun restart(id: String) {
        val job = jobs[id] ?: return
        if (!job.rawUrl.startsWith("http://", ignoreCase = true) && !job.rawUrl.startsWith("https://", ignoreCase = true)) {
            job.error = "Không thể tải lại tệp không có URL HTTP/HTTPS hợp lệ"
            job.status = JobStatus.ERROR
            emitStates()
            return
        }
        val prevRunner = job.runnerJob
        job.pausedOrStopped.set(true)
        job.status = JobStatus.QUEUED
        job.speedBps = 0L
        job.error = null
        emitStates()
        job.runnerJob = scope.launch {
            runCatching { prevRunner?.cancelAndJoin() }
            closeFileHandles(job)
            job.stagingFile?.delete()
            job.stateJournalFile?.delete()
            synchronized(job.segments) { job.segments.clear() }
            job.counters.downloadedBytes.set(0L)
            job.counters.activeWorkers.set(0)
            job.counters.hedgeWins.set(0)
            job.counters.recycleCount.set(0)
            job.counters.completedSinceDecrease.set(0)
            job.totalBytes = 0L
            job.peakSpeedBps = 0L
            job.sha256 = ""
            job.publicPath = ""
            job.publicUri = ""
            job.rateLimitUntil = 0L
            job.effectiveMaxConnections = job.maxConnections.coerceIn(1, 128)
            job.pausedOrStopped.set(false)
            job.status = JobStatus.PROBING
            emitStates()
            executeJob(job)
        }
    }

    fun pause(id: String) {
        val job = jobs[id] ?: return
        job.pausedOrStopped.set(true)
        job.status = JobStatus.PAUSED
        job.speedBps = 0L
        job.runnerJob?.cancel()
        saveStateJournal(job)
        closeFileHandles(job)
        emitStates()
    }

    fun pauseAll() {
        jobs.keys.forEach { id ->
            val st = jobs[id]?.status
            if (st == JobStatus.DOWNLOADING || st == JobStatus.PROBING) pause(id)
        }
    }

    fun deleteBatch(ids: Collection<String>) {
        for (id in ids) {
            val job = jobs.remove(id) ?: continue
            job.pausedOrStopped.set(true)
            job.status = JobStatus.CANCELED
            job.runnerJob?.cancel()
            closeFileHandles(job)
            job.stagingFile?.delete()
            job.stateJournalFile?.delete()
        }
        emitStates()
    }

    fun shutdown() {
        pauseAll()
        scope.cancel()
        dispatcher.close()
    }

    private suspend fun executeJob(job: ManagedJob) {
        jobSlots.withPermit {
            try {
                if (isIpswUrl(job.rawUrl)) {
                    resolveIpswUrl(job)
                }
                probeUrl(job)
                discoverEdgeIps(job)

                job.category = FormatCatalog.categorize(job.fileName, job.resolvedUrl)
                val catDir = File(stagingRoot, job.category).apply { mkdirs() }
                val target = File(catDir, job.fileName)
                job.stagingFile = target
                job.stateJournalFile = File(catDir, "${job.fileName}.hyper.json")

                val loadedJournal = tryLoadStateJournal(job)
                if (!loadedJournal) {
                    initSegments(job)
                }
                openPreallocatedChannel(job, target)

                job.status = JobStatus.DOWNLOADING
                emitStates()

                runWorkersLoop(job)

                if (job.pausedOrStopped.get()) return@withPermit

                closeFileHandles(job)
                job.sha256 = computeSha256(target)
                job.publicPath = exportToPublicDownloads(target, job.fileName, job.category)
                job.stateJournalFile?.delete()
                job.speedBps = 0L
                job.status = JobStatus.COMPLETED
                emitStates()
            } catch (ce: CancellationException) {
                if (job.status != JobStatus.CANCELED && job.status != JobStatus.PAUSED) {
                    job.status = JobStatus.PAUSED
                }
                saveStateJournal(job)
                closeFileHandles(job)
                emitStates()
            } catch (e: Exception) {
                job.status = JobStatus.ERROR
                job.error = e.message ?: e.javaClass.simpleName
                job.speedBps = 0L
                saveStateJournal(job)
                closeFileHandles(job)
                emitStates()
            }
        }
    }

    private fun isIpswUrl(url: String): Boolean =
        Regex("""^https?://(www\.)?ipsw\.me/download/([^/]+)/([^/?#]+)""", RegexOption.IGNORE_CASE).containsMatchIn(url)

    private fun resolveIpswUrl(job: ManagedJob) {
        val m = Regex("""^https?://(www\.)?ipsw\.me/download/([^/]+)/([^/?#]+)""", RegexOption.IGNORE_CASE).find(job.rawUrl)
            ?: return
        val apiUrl = "https://api.ipsw.me/v4/ipsw/${m.groupValues[2]}/${m.groupValues[3]}"
        val conn = (URL(apiUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("Accept", "application/json")
        }
        try {
            val raw = conn.inputStream.bufferedReader().readText()
            val json = JSONObject(raw)
            val direct = json.optString("url", "")
            if (direct.startsWith("http")) {
                job.resolvedUrl = direct
                val remoteName = URL(direct).path.substringAfterLast('/')
                if (remoteName.isNotBlank() && job.customFileName.isNullOrBlank()) {
                    job.fileName = FormatCatalog.sanitizeFileName(remoteName)
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun probeUrl(job: ManagedJob) {
        val headConn = (URL(job.resolvedUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "HEAD"
            instanceFollowRedirects = true
            connectTimeout = 12_000
            readTimeout = 12_000
            setRequestProperty("User-Agent", USER_AGENT)
            job.customHeaders.forEach { (k, v) -> setRequestProperty(k, v) }
        }
        try {
            val code = headConn.responseCode
            val finalUrl = headConn.url?.toString()
            if (!finalUrl.isNullOrBlank()) job.resolvedUrl = finalUrl
            val len = headConn.contentLengthLong
            val rangesHeader = headConn.getHeaderField("Accept-Ranges") ?: ""
            val disp = headConn.getHeaderField("Content-Disposition")
            applyContentDisposition(job, disp)
            if (code in 200..399 && len > 0) {
                job.totalBytes = len
                job.acceptRanges = rangesHeader.contains("bytes", ignoreCase = true)
                return
            }
        } catch (_: Exception) {
        } finally {
            headConn.disconnect()
        }

        val rangeConn = (URL(job.resolvedUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            instanceFollowRedirects = true
            connectTimeout = 12_000
            readTimeout = 12_000
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Range", "bytes=0-0")
            job.customHeaders.forEach { (k, v) -> setRequestProperty(k, v) }
        }
        try {
            val code = rangeConn.responseCode
            val finalUrl = rangeConn.url?.toString()
            if (!finalUrl.isNullOrBlank()) job.resolvedUrl = finalUrl
            applyContentDisposition(job, rangeConn.getHeaderField("Content-Disposition"))
            val contentRange = rangeConn.getHeaderField("Content-Range") ?: ""
            val crMatch = Regex("""bytes\s+\d+-\d+/(\d+)""", RegexOption.IGNORE_CASE).find(contentRange)
            if (code == 206 && crMatch != null) {
                job.totalBytes = crMatch.groupValues[1].toLong()
                job.acceptRanges = true
            } else {
                job.totalBytes = max(0L, rangeConn.contentLengthLong)
                job.acceptRanges = false
            }
        } finally {
            rangeConn.disconnect()
        }
    }

    private fun applyContentDisposition(job: ManagedJob, disp: String?) {
        if (disp.isNullOrBlank() || !job.customFileName.isNullOrBlank()) return
        val utf8Match = Regex("""filename\*\s*=\s*UTF-8''([^;\r\n]+)""", RegexOption.IGNORE_CASE).find(disp)
        val plainMatch = Regex("""filename\s*=\s*"?([^";\r\n]+)"?""", RegexOption.IGNORE_CASE).find(disp)
        val raw = utf8Match?.groupValues?.get(1) ?: plainMatch?.groupValues?.get(1) ?: return
        val decoded = java.net.URLDecoder.decode(raw, "UTF-8")
        if (decoded.isNotBlank()) job.fileName = FormatCatalog.sanitizeFileName(decoded)
    }

    private fun discoverEdgeIps(job: ManagedJob) {
        runCatching {
            val host = URL(job.resolvedUrl).host
            val addrs = InetAddress.getAllByName(host).mapNotNull { it.hostAddress }.distinct()
            if (addrs.isNotEmpty()) job.cdnIps = addrs
        }
    }

    private fun initSegments(job: ManagedJob) {
        job.segments.clear()
        if (!job.acceptRanges || job.totalBytes <= 512 * 1024) {
            val end = if (job.totalBytes > 0) job.totalBytes - 1 else -1L
            job.segments.add(SegmentState(0, 0L, 0L, end))
            return
        }
        val minChunk = 512 * 1024L
        val count = min(job.maxConnections.toLong(), max(1L, job.totalBytes / minChunk)).toInt()
        val chunkSize = job.totalBytes / count
        for (i in 0 until count) {
            val start = i * chunkSize
            val end = if (i == count - 1) job.totalBytes - 1 else (i + 1) * chunkSize - 1
            job.segments.add(SegmentState(i, start, start, end))
        }
    }

    private fun openPreallocatedChannel(job: ManagedJob, file: File) {
        val existed = file.exists()
        val raf = RandomAccessFile(file, "rw")
        if (!existed && job.totalBytes > 0 && raf.length() != job.totalBytes) {
            raf.setLength(job.totalBytes)
        }
        job.raf = raf
        job.channel = raf.channel
    }

    private suspend fun runWorkersLoop(job: ManagedJob) = coroutineScope {
        val activeJobs = ConcurrentHashMap<Int, Job>()
        var lastBytes = job.counters.downloadedBytes.get()
        var lastTick = System.currentTimeMillis()
        var lastJournalAt = lastTick

        while (isActive && !job.pausedOrStopped.get()) {
            val now = System.currentTimeMillis()
            if (now >= job.rateLimitUntil) {
                synchronized(job.segments) {
                    val limit = job.effectiveMaxConnections
                    for (seg in job.segments) {
                        if (seg.status == "pending" && activeJobs.size < limit) {
                            seg.status = "downloading"
                            seg.lastDataAt = now
                            activeJobs[seg.id] = launch { runSegmentWorker(job, seg, activeJobs) }
                        }
                    }
                    while (job.acceptRanges && activeJobs.size < limit) {
                        val stolen = tryStealLargestSegmentLocked(job) ?: break
                        stolen.status = "downloading"
                        stolen.lastDataAt = now
                        activeJobs[stolen.id] = launch { runSegmentWorker(job, stolen, activeJobs) }
                    }
                }
            }

            // Telemetry + smoothed 2s sliding speed window + bounded Hedged Watchdog every 450ms
            val dt = max(100L, now - lastTick)
            val currBytes = job.counters.downloadedBytes.get()
            val instantBps = ((currBytes - lastBytes) * 1000L) / dt
            val smoothedBps = if (job.speedBps > 0L) ((job.speedBps * 65L) + (instantBps * 35L)) / 100L else instantBps
            job.speedBps = smoothedBps
            if (smoothedBps > job.peakSpeedBps) job.peakSpeedBps = smoothedBps
            lastBytes = currBytes
            lastTick = now

            if (job.acceptRanges && now - job.rateLimitUntil > 0) {
                val snapSegs = synchronized(job.segments) { job.segments.filter { it.status == "downloading" } }
                val avgSpd = if (snapSegs.size >= 2) smoothedBps / snapSegs.size else 0L
                val tailZone = job.totalBytes > 0 && (currBytes.toDouble() / job.totalBytes) >= 0.96
                var activeHedges = snapSegs.count { it.hedging }
                for (seg in snapSegs) {
                    val rem = seg.end - seg.current + 1
                    val idleMs = now - seg.lastDataAt
                    val hedgeNeeded = !seg.hedging && activeHedges < 4 && (
                        (idleMs > 1800 && rem > 128 * 1024) ||
                            (tailZone && rem > 128 * 1024 && avgSpd > 0 && seg.speedBps < maxOf(64L * 1024L, avgSpd / 4L))
                        )
                    if (hedgeNeeded && activeJobs.size < job.effectiveMaxConnections + 2) {
                        activeHedges++
                        launchHedgedRace(this, job, seg, activeJobs)
                    }
                    if (idleMs > 3500 && rem > 0) {
                        seg.lastDataAt = now
                        job.counters.recycleCount.incrementAndGet()
                        activeJobs.remove(seg.id)?.cancel()
                        if (seg.status == "downloading") seg.status = "pending"
                    }
                }
            }

            if (now - lastJournalAt > 1500) {
                lastJournalAt = now
                saveStateJournal(job)
            }

            val allDone = synchronized(job.segments) {
                job.segments.isNotEmpty() && job.segments.all { it.status == "completed" }
            }
            emitStates()
            if (allDone && activeJobs.isEmpty()) break
            delay(450)
        }
    }

    private fun tryStealLargestSegmentLocked(job: ManagedJob): SegmentState? {
        if (job.segments.size >= 1024) return null
        val largest = job.segments
            .filter { it.status == "downloading" && it.end > it.current }
            .maxByOrNull { it.end - it.current + 1 } ?: return null
        val remaining = largest.end - largest.current + 1
        val isTail = job.totalBytes > 0 && (job.counters.downloadedBytes.get().toDouble() / job.totalBytes) > 0.80
        val minSplit = if (isTail) 256 * 1024L else 512 * 1024L
        if (remaining < minSplit * 2) return null

        val mid = largest.current + (remaining / 2)
        val stolen = SegmentState(
            id = job.segments.size,
            start = mid,
            current = mid,
            end = largest.end,
            status = "pending"
        )
        largest.end = mid - 1
        job.segments.add(stolen)
        return stolen
    }

    private fun launchHedgedRace(
        parentScope: CoroutineScope,
        job: ManagedJob,
        seg: SegmentState,
        activeJobs: ConcurrentHashMap<Int, Job>
    ) {
        seg.hedging = true
        parentScope.launch {
            var conn: HttpURLConnection? = null
            try {
                val raceStart = seg.current
                val raceEnd = seg.end
                if (raceStart > raceEnd) return@launch
                conn = openRangeConnection(job, raceStart, raceEnd, timeoutMs = 3500)
                val code = conn.responseCode
                if (code != 206 && code != 200) return@launch
                val input = conn.inputStream
                val buf = ByteArray(64 * 1024)
                val firstRead = input.read(buf)
                if (firstRead > 0 && raceStart == seg.current && seg.status == "downloading") {
                    job.counters.hedgeWins.incrementAndGet()
                    job.counters.recycleCount.incrementAndGet()
                    activeJobs[seg.id]?.cancel()
                    writeSegmentSlice(job, seg, buf, firstRead)
                    streamIntoChannel(job, seg, input, buf)
                    if (seg.end < 0 || seg.current > seg.end) {
                        seg.status = "completed"
                    } else if (!job.pausedOrStopped.get()) {
                        seg.status = "pending"
                    }
                }
            } catch (_: Exception) {
            } finally {
                seg.hedging = false
                conn?.disconnect()
            }
        }
    }

    private suspend fun runSegmentWorker(
        job: ManagedJob,
        seg: SegmentState,
        activeJobs: ConcurrentHashMap<Int, Job>
    ) {
        job.counters.activeWorkers.incrementAndGet()
        var conn: HttpURLConnection? = null
        try {
            val reqStart = seg.current
            val reqEnd = seg.end
            if (reqEnd >= 0 && reqStart > reqEnd) {
                seg.status = "completed"
                return
            }
            val t0 = System.nanoTime()
            conn = openRangeConnection(job, if (job.acceptRanges) reqStart else -1L, if (job.acceptRanges) reqEnd else -1L, timeoutMs = 30_000)
            val code = conn.responseCode
            if (code == 429 || code == 503) {
                job.counters.completedSinceDecrease.set(0)
                job.effectiveMaxConnections = max(4, job.effectiveMaxConnections / 2)
                val retryAfterSec = conn.getHeaderField("Retry-After")?.toLongOrNull() ?: (seg.retries + 1L)
                job.rateLimitUntil = max(job.rateLimitUntil, System.currentTimeMillis() + min(8000L, retryAfterSec * 1000L))
                seg.retries++
                seg.status = "pending"
                return
            }
            if (code !in 200..299) throw IllegalStateException("HTTP $code")

            val firstByteMs = (System.nanoTime() - t0) / 1_000_000.0
            val hostIp = job.cdnIps.firstOrNull() ?: "edge"
            job.edgeLatencyEwma.merge(hostIp, firstByteMs) { old, n -> 0.7 * old + 0.3 * n }
            seg.ip = hostIp

            val buf = ByteArray(128 * 1024)
            streamIntoChannel(job, seg, conn.inputStream, buf)

            if (job.pausedOrStopped.get()) return
            if (seg.end < 0 || seg.current > seg.end) {
                seg.status = "completed"
                seg.speedBps = 0L
                val c = job.counters.completedSinceDecrease.incrementAndGet()
                if (c >= 4 && job.effectiveMaxConnections < job.maxConnections) {
                    job.counters.completedSinceDecrease.set(0)
                    job.effectiveMaxConnections = min(job.maxConnections, job.effectiveMaxConnections + 2)
                }
            } else {
                seg.status = "pending"
            }
        } catch (ce: CancellationException) {
            if (seg.status == "downloading") seg.status = "pending"
        } catch (e: Exception) {
            seg.retries++
            seg.speedBps = 0L
            if (seg.retries <= 25 && !job.pausedOrStopped.get()) {
                delay(min(10_000L, 500L * seg.retries))
                seg.status = "pending"
            } else {
                throw e
            }
        } finally {
            conn?.disconnect()
            job.counters.activeWorkers.decrementAndGet()
            activeJobs.remove(seg.id)
        }
    }

    private fun openRangeConnection(job: ManagedJob, start: Long, end: Long, timeoutMs: Int): HttpURLConnection {
        return (URL(job.resolvedUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            instanceFollowRedirects = true
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Connection", "keep-alive")
            if (start >= 0 && end >= start) {
                setRequestProperty("Range", "bytes=$start-$end")
            } else if (start >= 0 && end < 0) {
                setRequestProperty("Range", "bytes=$start-")
            }
            job.customHeaders.forEach { (k, v) -> setRequestProperty(k, v) }
        }
    }

    private fun streamIntoChannel(job: ManagedJob, seg: SegmentState, input: InputStream, buf: ByteArray) {
        var winBytes = 0L
        var winStart = System.currentTimeMillis()
        while (!job.pausedOrStopped.get()) {
            if (seg.end >= 0 && seg.current > seg.end) break
            val read = input.read(buf)
            if (read <= 0) break
            val allowed = if (seg.end >= 0) min(read.toLong(), seg.end - seg.current + 1).toInt() else read
            if (allowed <= 0) break
            writeSegmentSlice(job, seg, buf, allowed)
            seg.retries = 0
            winBytes += allowed
            val now = System.currentTimeMillis()
            val dt = now - winStart
            if (dt >= 400) {
                seg.speedBps = (winBytes * 1000L) / dt
                winBytes = 0L
                winStart = now
            }
            seg.lastDataAt = now
        }
    }

    private fun writeSegmentSlice(job: ManagedJob, seg: SegmentState, buf: ByteArray, len: Int) {
        val ch = job.channel ?: return
        val offset = seg.current
        val bb = ByteBuffer.wrap(buf, 0, len)
        var writtenPos = offset
        while (bb.hasRemaining()) {
            val n = ch.write(bb, writtenPos)
            if (n <= 0) break
            writtenPos += n
        }
        seg.current = writtenPos
        job.counters.downloadedBytes.addAndGet(writtenPos - offset)
    }

    private fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { inp ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = inp.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun exportToPublicDownloads(source: File, fileName: String, category: String): String {
        val ctx = context ?: return source.absolutePath
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Duytai/$category")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = ctx.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return source.absolutePath
                resolver.openOutputStream(uri)?.use { out ->
                    source.inputStream().use { inp -> inp.copyTo(out, 256 * 1024) }
                }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                "Download/Duytai/$category/$fileName"
            } else {
                @Suppress("DEPRECATION")
                val destDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Duytai/$category").apply { mkdirs() }
                val dest = File(destDir, fileName)
                source.copyTo(dest, overwrite = true)
                dest.absolutePath
            }
        } catch (_: Exception) {
            source.absolutePath
        }
    }

    private fun saveStateJournal(job: ManagedJob) {
        val jf = job.stateJournalFile ?: return
        if (job.status == JobStatus.COMPLETED || job.status == JobStatus.CANCELED) return
        runCatching {
            val arr = JSONArray()
            synchronized(job.segments) {
                for (s in job.segments) {
                    arr.put(JSONObject().apply {
                        put("id", s.id)
                        put("start", s.start)
                        put("current", s.current)
                        put("end", s.end)
                        put("status", if (s.end >= 0 && s.current > s.end) "completed" else "pending")
                    })
                }
            }
            val payload = JSONObject().apply {
                put("id", job.id)
                put("url", job.rawUrl)
                put("finalUrl", job.resolvedUrl)
                put("fileName", job.fileName)
                put("category", job.category)
                put("totalBytes", job.totalBytes)
                put("downloadedBytes", job.counters.downloadedBytes.get())
                put("acceptRanges", job.acceptRanges)
                put("maxConnections", job.maxConnections)
                put("segments", arr)
            }
            jf.writeText(payload.toString())
        }
    }

    private fun tryLoadStateJournal(job: ManagedJob): Boolean {
        val jf = job.stateJournalFile ?: return false
        val sf = job.stagingFile ?: return false
        if (!jf.exists() || !sf.exists()) return false
        return runCatching {
            val payload = JSONObject(jf.readText())
            if (payload.optLong("totalBytes") != job.totalBytes) return false
            val arr = payload.getJSONArray("segments")
            synchronized(job.segments) {
                job.segments.clear()
                var done = 0L
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val s = SegmentState(
                        id = o.getInt("id"),
                        start = o.getLong("start"),
                        current = o.getLong("current"),
                        end = o.getLong("end"),
                        status = if (o.optString("status") == "completed") "completed" else "pending"
                    )
                    done += max(0L, s.current - s.start)
                    job.segments.add(s)
                }
                job.counters.downloadedBytes.set(done)
            }
            true
        }.getOrDefault(false)
    }

    private fun restorePersistedJournals() {
        stagingRoot.walkTopDown().filter { it.name.endsWith(".hyper.json") }.forEach { jf ->
            runCatching {
                val payload = JSONObject(jf.readText())
                val id = payload.optString("id").ifBlank { FormatCatalog.newId() }
                val url = payload.optString("finalUrl").ifBlank { payload.getString("url") }
                val fn = payload.optString("fileName")
                val maxC = payload.optInt("maxConnections", 64)
                val job = ManagedJob(id, url, maxC, fn).apply {
                    totalBytes = payload.optLong("totalBytes", 0L)
                    counters.downloadedBytes.set(payload.optLong("downloadedBytes", 0L))
                    acceptRanges = payload.optBoolean("acceptRanges", true)
                    status = JobStatus.PAUSED
                    stagingFile = File(jf.parentFile, jf.name.removeSuffix(".hyper.json"))
                    stateJournalFile = jf
                }
                jobs[id] = job
            }
        }
        emitStates()
    }

    private fun closeFileHandles(job: ManagedJob) {
        runCatching { job.channel?.close() }
        runCatching { job.raf?.close() }
        job.channel = null
        job.raf = null
    }

    private fun emitStates() {
        _jobList.value = jobs.values.map { it.snapshot() }
    }

    companion object {
        private const val USER_AGENT = "Mozilla/5.0 (Linux; Android 15) Duytai-Engine/7.4"

        private fun guessName(url: String): String {
            return runCatching {
                val path = URL(url).path
                val seg = path.substringAfterLast('/')
                if (seg.isNotBlank()) seg else "download.bin"
            }.getOrDefault("download.bin")
        }
    }
}
