package com.doanduy.duytai.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.webkit.*
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import com.doanduy.duytai.core.FormatCatalog

class WebSnifferActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var urlBar: EditText

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0A0E17"))
        }

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(16, 24, 16, 12)
        }
        urlBar = EditText(this).apply {
            setText("https://ipsw.me/")
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#111827"))
            setPadding(16, 12, 16, 12)
            isSingleLine = true
        }
        val goBtn = Button(this).apply {
            text = "Đi"
            setBackgroundColor(Color.parseColor("#0284C7"))
            setTextColor(Color.WHITE)
            setOnClickListener {
                val u = urlBar.text.toString().trim()
                webView.loadUrl(if (u.startsWith("http")) u else "https://$u")
            }
        }
        topBar.addView(urlBar, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        topBar.addView(goBtn)
        root.addView(topBar)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val u = request?.url?.toString() ?: return false
                    if (isInterceptableDownload(u)) {
                        returnCapturedUrl(u)
                        return true
                    }
                    return false
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    urlBar.setText(url ?: "")
                }
            }
            setDownloadListener { url, _, _, _, _ ->
                if (!url.isNullOrBlank()) returnCapturedUrl(url)
            }
        }
        root.addView(webView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        webView.loadUrl("https://ipsw.me/")
    }

    private fun isInterceptableDownload(url: String): Boolean {
        if (Regex("""^https?://(www\.)?ipsw\.me/download/[^/]+/[^/?#]+""", RegexOption.IGNORE_CASE).containsMatchIn(url)) {
            return true
        }
        val clean = url.substringBefore('?').substringBefore('#')
        val ext = clean.substringAfterLast('.', "")
        return FormatCatalog.isDownloadableExtension(ext)
    }

    private fun returnCapturedUrl(url: String) {
        val data = Intent().putExtra(RESULT_URL, url)
        setResult(RESULT_OK, data)
        finish()
    }

    companion object {
        const val RESULT_URL = "captured_url"
    }
}
