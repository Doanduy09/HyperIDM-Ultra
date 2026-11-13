package com.doanduy.duytai

import com.doanduy.duytai.core.DuytaiEngine
import com.doanduy.duytai.core.FormatCatalog
import com.doanduy.duytai.core.JobStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.ServerSocket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlin.random.Random

class DuytaiEngineTest {

    @Test
    fun formatCatalogCategorizesAllCoreFormats() {
        assertEquals("Firmware_ISO", FormatCatalog.categorize("UniversalMac_14.5_23F79_Restore.ipsw", null))
        assertEquals("Programs", FormatCatalog.categorize("Duytai.apk", null))
        assertEquals("Compressed", FormatCatalog.categorize("archive.r01", null))
        assertEquals("Video", FormatCatalog.categorize("movie.mkv", null))
        assertEquals("Music", FormatCatalog.categorize("track.flac", null))
        assertEquals("Documents", FormatCatalog.categorize("spec.pdf", null))
    }

    @Test
    fun multiSegmentDownloadMatchesSha256() = runBlocking {
        val payload = Random(42).nextBytes(2 * 1024 * 1024)
        val expectedSha = MessageDigest.getInstance("SHA-256")
            .digest(payload)
            .joinToString("") { "%02x".format(it) }

        val serverSocket = ServerSocket(0)
        val pool = Executors.newCachedThreadPool()
        val serverThread = Thread {
            while (!serverSocket.isClosed) {
                try {
                    val client = serverSocket.accept()
                    pool.submit {
                        client.use { sock ->
                            val reader = BufferedReader(InputStreamReader(sock.getInputStream()))
                            val reqLine = reader.readLine() ?: return@submit
                            var rangeHeader: String? = null
                            while (true) {
                                val line = reader.readLine() ?: break
                                if (line.isBlank()) break
                                if (line.startsWith("Range:", ignoreCase = true)) {
                                    rangeHeader = line.substringAfter(':').trim()
                                }
                            }
                            val out = sock.getOutputStream()
                            val method = reqLine.substringBefore(' ')
                            if (method == "HEAD") {
                                val hdr = "HTTP/1.1 200 OK\r\nContent-Length: ${payload.size}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n"
                                out.write(hdr.toByteArray())
                            } else if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                                val spec = rangeHeader.removePrefix("bytes=")
                                val start = spec.substringBefore('-').toInt()
                                val endStr = spec.substringAfter('-')
                                val end = if (endStr.isBlank()) payload.size - 1 else endStr.toInt().coerceAtMost(payload.size - 1)
                                val len = end - start + 1
                                val hdr = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes $start-$end/${payload.size}\r\nContent-Length: $len\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n"
                                out.write(hdr.toByteArray())
                                out.write(payload, start, len)
                            } else {
                                val hdr = "HTTP/1.1 200 OK\r\nContent-Length: ${payload.size}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n"
                                out.write(hdr.toByteArray())
                                out.write(payload)
                            }
                            out.flush()
                        }
                    }
                } catch (_: Exception) {
                    break
                }
            }
        }.apply { start() }

        val tempDir: File = Files.createTempDirectory("duytai-android-test").toFile()
        val engine = DuytaiEngine(tempDir, context = null, workerThreads = 8)
        try {
            val id = engine.enqueue("http://127.0.0.1:${serverSocket.localPort}/test_firmware.ipsw", maxConnections = 8)
            var doneState = engine.jobList.value.firstOrNull { it.id == id }
            repeat(80) {
                delay(150)
                doneState = engine.jobList.value.firstOrNull { it.id == id }
                if (doneState?.status == JobStatus.COMPLETED || doneState?.status == JobStatus.ERROR) return@repeat
            }
            assertEquals(JobStatus.COMPLETED, doneState?.status)
            assertEquals(payload.size.toLong(), doneState?.downloadedBytes)
            assertEquals(expectedSha, doneState?.sha256)
            assertTrue(File(tempDir, "Firmware_ISO/test_firmware.ipsw").exists())

            // Verify restart() cleans previous partial/completed file and redownloads cleanly from 0
            engine.restart(id)
            var restartedState = engine.jobList.value.firstOrNull { it.id == id }
            repeat(80) {
                delay(150)
                restartedState = engine.jobList.value.firstOrNull { it.id == id }
                if (restartedState?.status == JobStatus.COMPLETED || restartedState?.status == JobStatus.ERROR) return@repeat
            }
            assertEquals(JobStatus.COMPLETED, restartedState?.status)
            assertEquals(payload.size.toLong(), restartedState?.downloadedBytes)
            assertEquals(expectedSha, restartedState?.sha256)

            // Non-HTTP file:// jobs must refuse restart cleanly without wiping files on disk
            val localFile = File(tempDir, "keep_intact.bin").apply { writeText("SAFE_BYTES") }
            val badId = engine.enqueue("file://${localFile.absolutePath}", startImmediately = false)
            engine.restart(badId)
            val badState = engine.jobList.value.firstOrNull { it.id == badId }
            assertEquals(JobStatus.ERROR, badState?.status)
            assertTrue(localFile.exists() && localFile.readText() == "SAFE_BYTES")
        } finally {
            engine.shutdown()
            serverSocket.close()
            serverThread.join(1000)
            pool.shutdownNow()
            tempDir.deleteRecursively()
        }
    }
}
