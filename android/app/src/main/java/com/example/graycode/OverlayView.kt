package com.example.graycode

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import kotlin.math.max
import kotlin.math.min

class OverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {
    private val paint = Paint().apply {
        color = 0xFF00FF00.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }

    private var imageWidth = 0
    private var imageHeight = 0
    private var stripWidth = 5
    private var stripHeight = 200

    fun updateImageSize(width: Int, height: Int) {
        if (width <= 0 || height <= 0) return
        if (imageWidth != width || imageHeight != height) {
            imageWidth = width
            imageHeight = height
            invalidate()
        }
    }

    fun updateStrip(width: Int, height: Int) {
        if (stripWidth != width || stripHeight != height) {
            stripWidth = max(1, width)
            stripHeight = max(1, height)
            invalidate()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (imageWidth <= 0 || imageHeight <= 0) return

        val scale = min(width.toFloat() / imageWidth, height.toFloat() / imageHeight)
        val displayW = imageWidth * scale
        val displayH = imageHeight * scale
        val offsetX = (width - displayW) / 2f
        val offsetY = (height - displayH) / 2f

        val roiX = (imageWidth / 2f) - (stripWidth / 2f)
        val roiY = (imageHeight / 2f) - stripHeight.toFloat()

        val left = offsetX + roiX * scale
        val top = offsetY + roiY * scale
        val right = left + stripWidth * scale
        val bottom = top + stripHeight * scale

        canvas.drawRect(left, top, right, bottom, paint)
    }
}
