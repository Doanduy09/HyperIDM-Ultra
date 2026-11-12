package com.doanduy.duytai.ui

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.Gravity
import android.widget.*
import com.doanduy.duytai.core.DownloadJobState
import com.doanduy.duytai.core.FormatCatalog
import com.doanduy.duytai.core.JobStatus
import com.doanduy.duytai.service.DownloadForegroundService
import kotlinx.coroutines.*

class MainActivity : Activity() {

    private var isBound = false
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private lateinit var urlInput: EditText
    private lateinit var threadSpinner: Spinner
    private lateinit var speedHeader: TextView
    private lateinit var jobsContainer: LinearLayout
    private lateinit var deleteSelectedBtn: Button
    private val selectedIds = linkedSetOf<String>()
    private var pendingUrl: String? = null

    private val serviceConn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as DownloadForegroundService.LocalBinder
            isBound = true
            observeEngine(binder.engine)
            pendingUrl?.let {
                pendingUrl = null
                binder.engine.enqueue(it, selectedThreads(), startImmediately = true)
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            isBound = false
        }
    }

    private var engineRef: com.doanduy.duytai.core.DuytaiEngine? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermissionIfNeeded()
        buildUi()
        handleIncomingIntent(intent)

        val svcIntent = Intent(this, DownloadForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svcIntent)
        } else {
            startService(svcIntent)
        }
        bindService(svcIntent, serviceConn, Context.BIND_AUTO_CREATE)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
    }

    override fun onDestroy() {
        uiScope.cancel()
        if (isBound) {
            unbindService(serviceConn)
            isBound = false
        }
        super.onDestroy()
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        val extracted = when (intent.action) {
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_VIEW -> {
                val uri = intent.data
                if (uri?.scheme == "duytai") {
                    uri.getQueryParameter("url") ?: uri.toString().removePrefix("duytai://")
                } else {
                    uri?.toString()
                }
            }
            else -> null
        }?.trim()

        if (!extracted.isNullOrBlank() && extracted.startsWith("http", ignoreCase = true)) {
            urlInput.setText(extracted)
            val eng = engineRef
            if (eng != null) {
                eng.enqueue(extracted, selectedThreads(), startImmediately = true)
            } else {
                pendingUrl = extracted
            }
        }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0A0E17"))
            setPadding(36, 48, 36, 36)
        }

        val title = TextView(this).apply {
            text = "⚡ DUYTAI DOWNLOADER — ANDROID"
            setTextColor(Color.parseColor("#38BDF8"))
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
        }
        speedHeader = TextView(this).apply {
            text = "Động cơ 64/128 luồng • Tail-at-Scale Hedged + AIMD"
            setTextColor(Color.parseColor("#94A3B8"))
            textSize = 12f
            setPadding(0, 6, 0, 20)
        }
        root.addView(title)
        root.addView(speedHeader)

        urlInput = EditText(this).apply {
            hint = "Dán link tải (ZIP, IPSW, MKV, MP4, APK, ISO, PDF...)"
            setHintTextColor(Color.parseColor("#64748B"))
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#111827"))
            setPadding(24, 20, 24, 20)
            isSingleLine = true
        }
        root.addView(urlInput)

        val controlsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 16, 0, 16)
            gravity = Gravity.CENTER_VERTICAL
        }

        threadSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_dropdown_item,
                listOf("64 Luồng", "128 Luồng", "32 Luồng")
            )
            setBackgroundColor(Color.parseColor("#1E293B"))
        }

        val addBtn = Button(this).apply {
            text = "TẢI NGAY"
            setBackgroundColor(Color.parseColor("#0284C7"))
            setTextColor(Color.WHITE)
            setOnClickListener {
                val u = urlInput.text.toString().trim()
                if (u.startsWith("http", ignoreCase = true)) {
                    engineRef?.enqueue(u, selectedThreads(), startImmediately = true)
                    urlInput.text.clear()
                } else {
                    val clip = getClipboardUrl()
                    if (clip != null) {
                        urlInput.setText(clip)
                        engineRef?.enqueue(clip, selectedThreads(), startImmediately = true)
                    } else {
                        Toast.makeText(this@MainActivity, "Nhập URL hợp lệ (http/https)", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }

        val snifferBtn = Button(this).apply {
            text = "BẮT LINK WEB"
            setBackgroundColor(Color.parseColor("#7C3AED"))
            setTextColor(Color.WHITE)
            setOnClickListener {
                startActivityForResult(Intent(this@MainActivity, WebSnifferActivity::class.java), REQ_SNIFF)
            }
        }

        controlsRow.addView(threadSpinner, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        controlsRow.addView(addBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = 12 })
        controlsRow.addView(snifferBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = 12 })
        root.addView(controlsRow)

        val batchRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, 16)
        }
        val selectAllBtn = Button(this).apply {
            text = "Chọn tất cả"
            setBackgroundColor(Color.parseColor("#1E293B"))
            setTextColor(Color.WHITE)
            setOnClickListener {
                val all = engineRef?.jobList?.value ?: emptyList()
                if (selectedIds.size == all.size && all.isNotEmpty()) {
                    selectedIds.clear()
                } else {
                    selectedIds.clear()
                    selectedIds.addAll(all.map { it.id })
                }
                renderJobs(all)
            }
        }
        deleteSelectedBtn = Button(this).apply {
            text = "Xóa đã chọn (0)"
            setBackgroundColor(Color.parseColor("#B91C1C"))
            setTextColor(Color.WHITE)
            setOnClickListener {
                if (selectedIds.isNotEmpty()) {
                    val toDelete = selectedIds.toList()
                    selectedIds.clear()
                    engineRef?.deleteBatch(toDelete)
                }
            }
        }
        batchRow.addView(selectAllBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        batchRow.addView(deleteSelectedBtn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = 12 })
        root.addView(batchRow)

        val scroll = ScrollView(this)
        jobsContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(jobsContainer)
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_SNIFF && resultCode == RESULT_OK) {
            val captured = data?.getStringExtra(WebSnifferActivity.RESULT_URL)
            if (!captured.isNullOrBlank()) {
                engineRef?.enqueue(captured, selectedThreads(), startImmediately = true)
            }
        }
    }

    private fun observeEngine(engine: com.doanduy.duytai.core.DuytaiEngine) {
        engineRef = engine
        uiScope.launch {
            engine.jobList.collect { list ->
                val agg = FormatCatalog.formatBytes(engine.aggregateSpeedBps) + "/s"
                speedHeader.text = "Đang tải: ${engine.activeDownloadCount} • Tổng tốc độ: $agg • Hedge Wins: ${list.sumOf { it.hedgeWins }}"
                renderJobs(list)
            }
        }
    }

    private fun renderJobs(list: List<DownloadJobState>) {
        deleteSelectedBtn.text = "Xóa đã chọn (${selectedIds.size})"
        jobsContainer.removeAllViews()
        if (list.isEmpty()) {
            val empty = TextView(this).apply {
                text = "Chưa có tác vụ tải. Dán URL hoặc bấm BẮT LINK WEB."
                setTextColor(Color.parseColor("#64748B"))
                setPadding(16, 48, 16, 16)
                gravity = Gravity.CENTER
            }
            jobsContainer.addView(empty)
            return
        }

        for (job in list) {
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(Color.parseColor("#111827"))
                setPadding(24, 20, 24, 20)
            }
            val topRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val cb = CheckBox(this).apply {
                isChecked = job.id in selectedIds
                setOnCheckedChangeListener { _, checked ->
                    if (checked) selectedIds.add(job.id) else selectedIds.remove(job.id)
                    deleteSelectedBtn.text = "Xóa đã chọn (${selectedIds.size})"
                }
            }
            val nameTv = TextView(this).apply {
                text = "${job.fileName} [${job.category}]"
                setTextColor(Color.WHITE)
                setTypeface(typeface, Typeface.BOLD)
                textSize = 14f
            }
            topRow.addView(cb)
            topRow.addView(nameTv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            card.addView(topRow)

            val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 100
                progress = job.progressPercent
            }
            card.addView(bar)

            val meta = TextView(this).apply {
                val sizeStr = if (job.totalBytes > 0) "${FormatCatalog.formatBytes(job.downloadedBytes)} / ${FormatCatalog.formatBytes(job.totalBytes)}" else FormatCatalog.formatBytes(job.downloadedBytes)
                val spdStr = if (job.status == JobStatus.DOWNLOADING) "${FormatCatalog.formatBytes(job.speedBps)}/s" else job.status.name
                text = "${job.progressPercent}% • $sizeStr • $spdStr • ${job.activeWorkers}/${job.effectiveConnections} luồng"
                setTextColor(Color.parseColor("#94A3B8"))
                textSize = 12f
                setPadding(0, 6, 0, 8)
            }
            card.addView(meta)

            if (!job.error.isNullOrBlank()) {
                card.addView(TextView(this).apply {
                    text = "Lỗi: ${job.error}"
                    setTextColor(Color.parseColor("#F87171"))
                    textSize = 12f
                })
            } else if (job.status == JobStatus.COMPLETED && job.publicPath.isNotBlank()) {
                card.addView(TextView(this).apply {
                    text = "✓ Đã lưu: ${job.publicPath} | SHA256: ${job.sha256.take(16)}..."
                    setTextColor(Color.parseColor("#34D399"))
                    textSize = 11f
                })
            }

            val actionRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            val toggleBtn = Button(this).apply {
                text = if (job.status == JobStatus.DOWNLOADING || job.status == JobStatus.PROBING) "Tạm dừng" else "Tiếp tục"
                isEnabled = job.status != JobStatus.COMPLETED
                setBackgroundColor(Color.parseColor("#1E293B"))
                setTextColor(Color.WHITE)
                setOnClickListener {
                    if (job.status == JobStatus.DOWNLOADING || job.status == JobStatus.PROBING) {
                        engineRef?.pause(job.id)
                    } else {
                        engineRef?.start(job.id)
                    }
                }
            }
            actionRow.addView(toggleBtn)
            card.addView(actionRow)

            jobsContainer.addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = 16
            })
        }
    }

    private fun selectedThreads(): Int = when (threadSpinner.selectedItemPosition) {
        1 -> 128
        2 -> 32
        else -> 64
    }

    private fun getClipboardUrl(): String? {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip: ClipData = cm.primaryClip ?: return null
        val text = clip.getItemAt(0)?.text?.toString()?.trim() ?: return null
        return if (text.startsWith("http", ignoreCase = true)) text else null
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
            }
        }
    }

    companion object {
        private const val REQ_SNIFF = 2001
    }
}
