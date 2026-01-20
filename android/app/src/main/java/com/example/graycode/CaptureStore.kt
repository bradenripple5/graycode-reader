package com.example.graycode

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object CaptureStore {
    private val captures = mutableListOf<String>()
    private val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)

    fun add(binary: String, sections: String) {
        val timestamp = formatter.format(Date())
        val entry = buildString {
            append("Time: ")
            append(timestamp)
            append('\n')
            if (sections.isNotBlank()) {
                append("Sections:\n")
                append(sections.trimEnd())
                append('\n')
            }
            append("Binary:\n")
            append(binary.trimEnd())
        }
        captures.add(0, entry)
    }

    fun all(): List<String> = captures.toList()
}
