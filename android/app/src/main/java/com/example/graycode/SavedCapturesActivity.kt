package com.example.graycode

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class SavedCapturesActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_captures)

        val textView = findViewById<TextView>(R.id.captures_text)
        val captures = CaptureStore.all()
        textView.text = if (captures.isEmpty()) {
            "No captures yet."
        } else {
            captures.joinToString("\n\n---\n\n")
        }
    }
}
