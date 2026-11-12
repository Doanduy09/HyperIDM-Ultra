package com.doanduy.duytai.core

import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

enum class JobStatus {
    QUEUED,
    PROBING,
    DOWNLOADING,
    PAUSED,
    COMPLETED,
    ERROR,
    CANCELED
}

data class SegmentState(
    val id: Int,
    val start: Long,
    @Volatile var current: Long,
    @Volatile var end: Long,
    @Volatile var status: String = "pending",
    @Volatile var speedBps: Long = 0L,
    @Volatile var ip: String = "",
    @Volatile var retries: Int = 0,
    @Volatile var lastDataAt: Long = System.currentTimeMillis(),
    @Volatile var hedging: Boolean = false
)

data class DownloadJobState(
    val id: String,
    val url: String,
    val fileName: String,
    val category: String,
    val status: JobStatus,
    val totalBytes: Long,
    val downloadedBytes: Long,
    val speedBps: Long,
    val peakSpeedBps: Long,
    val maxConnections: Int,
    val effectiveConnections: Int,
    val activeWorkers: Int,
    val hedgeWins: Int,
    val recycleCount: Int,
    val sha256: String = "",
    val publicPath: String = "",
    val publicUri: String = "",
    val error: String? = null
) {
    val progressPercent: Int
        get() = if (totalBytes > 0) ((downloadedBytes * 100L) / totalBytes).toInt().coerceIn(0, 100) else 0
}

object FormatCatalog {
    val SUPPORTED_EXTENSIONS: Set<String> = setOf(
        "3gp", "7z", "aac", "ace", "aif", "apk", "arj", "asf", "avi", "bin", "bz2",
        "dmg", "exe", "flac", "gz", "gzip", "img", "ipsw", "iso", "lzh", "m4a",
        "m4v", "mkv", "mov", "mp3", "mp4", "mpa", "mpe", "mpeg", "mpg", "msi",
        "msu", "ogg", "ogv", "pdf", "pkg", "plj", "pps", "ppt", "pptx", "qt",
        "ra", "rar", "rm", "rmvb", "sea", "sit", "sitx", "tar", "tif", "tiff",
        "wav", "webm", "wma", "wmv", "z", "zip", "xapk", "obb", "deb", "rpm",
        "xz", "zst", "doc", "docx", "xls", "xlsx", "epub"
    )

    private val CATEGORIES = listOf(
        "Firmware_ISO" to setOf("ipsw", "iso", "img", "bin", "dmg", "pkg", "msu"),
        "Compressed" to setOf("zip", "rar", "7z", "gz", "gzip", "bz2", "tar", "z", "arj", "lzh", "ace", "sea", "sit", "sitx", "xz", "zst"),
        "Programs" to setOf("apk", "xapk", "obb", "exe", "msi", "deb", "rpm"),
        "Video" to setOf("mp4", "mkv", "avi", "mov", "wmv", "m4v", "mpg", "mpeg", "mpe", "3gp", "asf", "ogv", "rm", "rmvb", "qt", "webm"),
        "Music" to setOf("mp3", "aac", "m4a", "wav", "wma", "ogg", "aif", "mpa", "ra", "flac", "plj"),
        "Documents" to setOf("pdf", "ppt", "pptx", "pps", "doc", "docx", "xls", "xlsx", "tif", "tiff", "epub")
    )

    fun isRarPart(ext: String): Boolean = Regex("^r\\d+$").matches(ext.lowercase(Locale.US))

    fun isDownloadableExtension(ext: String): Boolean {
        val clean = ext.lowercase(Locale.US).trimStart('.')
        return clean in SUPPORTED_EXTENSIONS || isRarPart(clean)
    }

    fun categorize(fileName: String?, url: String?): String {
        val target = (fileName?.takeIf { it.isNotBlank() } ?: url ?: "").lowercase(Locale.US)
        val dot = target.substringBefore('?').substringAfterLast('.', "")
        if (isRarPart(dot)) return "Compressed"
        for ((cat, exts) in CATEGORIES) {
            if (dot in exts) return cat
        }
        return "General"
    }

    fun sanitizeFileName(raw: String?): String {
        val clean = (raw ?: "download_${System.currentTimeMillis()}.bin")
            .replace(Regex("""[\\/:*?"<>|]"""), "_")
            .trim()
        return if (clean.isBlank()) "download_${System.currentTimeMillis()}.bin" else clean
    }

    fun newId(): String = "dt-" + UUID.randomUUID().toString().substring(0, 8)

    fun formatBytes(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val kb = bytes / 1024.0
        if (kb < 1024) return String.format(Locale.US, "%.1f KB", kb)
        val mb = kb / 1024.0
        if (mb < 1024) return String.format(Locale.US, "%.2f MB", mb)
        return String.format(Locale.US, "%.2f GB", mb / 1024.0)
    }
}

class JobRuntimeCounters {
    val downloadedBytes = AtomicLong(0L)
    val hedgeWins = AtomicInteger(0)
    val recycleCount = AtomicInteger(0)
    val activeWorkers = AtomicInteger(0)
    val completedSinceDecrease = AtomicInteger(0)
}
