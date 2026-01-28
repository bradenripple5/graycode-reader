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
    private val centerPaint = Paint().apply {
        color = 0xFFFFFF00.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 2.5f
    }
    private val markerPaint = Paint().apply {
        color = 0xFFFFFF00.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }
    private val readLinePaint = Paint().apply {
        color = 0xFFFFFF00.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }

    private var imageWidth = 0
    private var imageHeight = 0
    private var stripWidth = 5
    private var stripHeight = 200
    private var centerPoint: android.graphics.PointF? = null
    private var bisectorAngle: Float? = null
    private var bottomMarkers: List<android.graphics.PointF> = emptyList()
    private var readLineSegments: List<Pair<android.graphics.PointF, android.graphics.PointF>> = emptyList()

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

    fun updateCenterGuide(center: android.graphics.PointF?, angleRad: Float?) {
        centerPoint = center
        bisectorAngle = angleRad
        invalidate()
    }

    fun updateBottomMarkers(markers: List<android.graphics.PointF>) {
        bottomMarkers = markers
        invalidate()
    }

    fun updateReadLineSegments(
        segments: List<Pair<android.graphics.PointF, android.graphics.PointF>>
    ) {
        readLineSegments = segments
        invalidate()
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

        if (readLineSegments.isNotEmpty()) {
            for (segment in readLineSegments) {
                val start = segment.first
                val end = segment.second
                val sx = offsetX + start.x * scale
                val sy = offsetY + start.y * scale
                val ex = offsetX + end.x * scale
                val ey = offsetY + end.y * scale
                canvas.drawLine(sx, sy, ex, ey, readLinePaint)
            }
        }

        val center = centerPoint
        val angle = bisectorAngle
        if (center != null && angle != null) {
            val cx = offsetX + center.x * scale
            val cy = offsetY + center.y * scale
            drawBisectorLine(canvas, cx, cy, angle, centerPaint)
        }

        if (bottomMarkers.isNotEmpty()) {
            val left = offsetX + roiX * scale
            val top = offsetY + roiY * scale
            for (point in bottomMarkers) {
                val px = left + point.x * scale
                val py = top + point.y * scale
                drawPlus(canvas, px, py, 6f, markerPaint)
            }
        }
    }

    private fun drawPlus(canvas: Canvas, x: Float, y: Float, size: Float, paint: Paint) {
        canvas.drawLine(x - size, y, x + size, y, paint)
        canvas.drawLine(x, y - size, x, y + size, paint)
    }

    private fun drawBisectorLine(canvas: Canvas, cx: Float, cy: Float, angle: Float, paint: Paint) {
        val dx = kotlin.math.cos(angle.toDouble()).toFloat()
        val dy = kotlin.math.sin(angle.toDouble()).toFloat()
        val tForward = maxRayToBounds(cx, cy, dx, dy, width.toFloat(), height.toFloat())
        val tBackward = maxRayToBounds(cx, cy, -dx, -dy, width.toFloat(), height.toFloat())
        if (tForward == null || tBackward == null) return
        val x1 = cx + dx * tForward
        val y1 = cy + dy * tForward
        val x2 = cx - dx * tBackward
        val y2 = cy - dy * tBackward
        canvas.drawLine(x1, y1, x2, y2, paint)
    }

    private fun maxRayToBounds(
        cx: Float,
        cy: Float,
        dx: Float,
        dy: Float,
        w: Float,
        h: Float
    ): Float? {
        var best: Float? = null
        fun consider(t: Float, x: Float, y: Float) {
            if (t <= 0f) return
            if (x < -1f || x > w + 1f || y < -1f || y > h + 1f) return
            if (best == null || t < best!!) best = t
        }
        if (kotlin.math.abs(dx) > 1e-6f) {
            val t1 = (0f - cx) / dx
            consider(t1, 0f, cy + dy * t1)
            val t2 = (w - cx) / dx
            consider(t2, w, cy + dy * t2)
        }
        if (kotlin.math.abs(dy) > 1e-6f) {
            val t3 = (0f - cy) / dy
            consider(t3, cx + dx * t3, 0f)
            val t4 = (h - cy) / dy
            consider(t4, cx + dx * t4, h)
        }
        return best
    }
}
