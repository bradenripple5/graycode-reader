package com.example.multiupcreader

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View

class OverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {
    private val roiPaint = Paint().apply {
        color = Color.YELLOW
        style = Paint.Style.STROKE
        strokeWidth = 4f
    }
    private val centerPaint = Paint().apply {
        color = Color.GREEN
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }

    private var roiLeft = 0f
    private var roiTop = 0f
    private var roiRight = 0f
    private var roiBottom = 0f
    private var centerY = -1f

    fun updateRoi(
        roiX: Int,
        roiY: Int,
        roiW: Int,
        roiH: Int,
        centerRowY: Int,
        uprightW: Int,
        uprightH: Int
    ) {
        if (uprightW <= 0 || uprightH <= 0) return
        val w = width.toFloat()
        val h = height.toFloat()
        roiLeft = (roiX.toFloat() / uprightW) * w
        roiTop = (roiY.toFloat() / uprightH) * h
        roiRight = ((roiX + roiW).toFloat() / uprightW) * w
        roiBottom = ((roiY + roiH).toFloat() / uprightH) * h
        centerY = (centerRowY.toFloat() / uprightH) * h
        postInvalidateOnAnimation()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (roiRight > roiLeft && roiBottom > roiTop) {
            canvas.drawRect(roiLeft, roiTop, roiRight, roiBottom, roiPaint)
        }
        if (centerY >= 0f) {
            canvas.drawLine(roiLeft, centerY, roiRight, centerY, centerPaint)
        }
    }
}
