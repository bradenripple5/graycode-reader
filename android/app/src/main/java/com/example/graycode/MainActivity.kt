package com.example.graycode

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Surface
import android.widget.ScrollView
import android.widget.Button
import android.widget.SeekBar
import android.widget.TextView
import android.view.View
import android.widget.LinearLayout
import android.content.Intent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

class MainActivity : AppCompatActivity() {
    private lateinit var previewView: PreviewView
    private lateinit var statusText: TextView
    private lateinit var binaryOutput: TextView
    private lateinit var overlayView: OverlayView
    private lateinit var angleText: TextView
    private lateinit var angleOutput: TextView
    private lateinit var menuBtn: Button
    private lateinit var startBtn: Button
    private lateinit var stopBtn: Button
    private lateinit var widthLabel: TextView
    private lateinit var heightLabel: TextView
    private lateinit var thresholdLabel: TextView
    private lateinit var sectionLabel: TextView
    private lateinit var redRatioLabel: TextView
    private lateinit var sectionOutput: TextView
    private lateinit var outputScroll: ScrollView
    private lateinit var lookupOutput: TextView
    private lateinit var controlsPanel: LinearLayout
    private lateinit var previewContainer: View
    private lateinit var toggleControls: Button
    private lateinit var togglePreview: Button
    private lateinit var toggleOutput: Button
    private lateinit var widthSeek: SeekBar
    private lateinit var heightSeek: SeekBar
    private lateinit var thresholdSeek: SeekBar
    private lateinit var sectionSeek: SeekBar
    private lateinit var redRatioSeek: SeekBar
    private lateinit var cameraExecutor: ExecutorService
    private var cameraProvider: ProcessCameraProvider? = null
    private var analysisUseCase: ImageAnalysis? = null
    private var previewUseCase: Preview? = null
    private var lastSectionBits: String = ""
    private var lastBinaryText: String = ""
    private var lastAngleOutput: String = ""
    private var lastCommonValue: Int? = null
    private var lastCommonBits: String = ""
    private var lastCommonOrder: Int? = null
    private var lastCommonAngle: Float? = null
    private var grayPositionMapsLoaded: Map<Int, IntArray> = emptyMap()

    private data class SectionResult(
        val bitsText: String,
        val anglesText: String,
        val commonValue: Int?,
        val commonBits: String,
        val commonOrder: Int?,
        val commonAngle: Float?
    )

    companion object {
        private val grayIndexMaps: Map<Int, IntArray> = (5..11).associateWith { sections ->
            val size = 1 shl sections
            val map = IntArray(size)
            for (i in 0 until size) {
                val gray = i xor (i shr 1)
                map[gray] = i
            }
            map
        }

    }

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startCamera()
        } else {
            statusText.text = "Camera permission denied"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        grayPositionMapsLoaded = loadGrayLookupFromAssets()

        previewView = findViewById(R.id.preview_view)
        statusText = findViewById(R.id.status_text)
        binaryOutput = findViewById(R.id.binary_output)
        overlayView = findViewById(R.id.overlay_view)
        angleText = findViewById(R.id.angle_text)
        angleOutput = findViewById(R.id.angle_output)
        menuBtn = findViewById(R.id.menu_btn)
        startBtn = findViewById(R.id.start_btn)
        stopBtn = findViewById(R.id.stop_btn)
        widthLabel = findViewById(R.id.width_label)
        heightLabel = findViewById(R.id.height_label)
        thresholdLabel = findViewById(R.id.threshold_label)
        sectionLabel = findViewById(R.id.section_label)
        redRatioLabel = findViewById(R.id.red_ratio_label)
        sectionOutput = findViewById(R.id.section_output)
        outputScroll = findViewById(R.id.output_scroll)
        lookupOutput = findViewById(R.id.lookup_output)
        controlsPanel = findViewById(R.id.controls_panel)
        previewContainer = findViewById(R.id.preview_container)
        toggleControls = findViewById(R.id.toggle_controls)
        togglePreview = findViewById(R.id.toggle_preview)
        toggleOutput = findViewById(R.id.toggle_output)
        widthSeek = findViewById(R.id.width_seek)
        heightSeek = findViewById(R.id.height_seek)
        thresholdSeek = findViewById(R.id.threshold_seek)
        sectionSeek = findViewById(R.id.section_seek)
        redRatioSeek = findViewById(R.id.red_ratio_seek)
        cameraExecutor = Executors.newSingleThreadExecutor()

        widthSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            widthLabel.text = "Strip Width (px): $value"
            overlayView.updateStrip(value, heightSeek.progress)
        })

        heightSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            heightLabel.text = "Strip Height (px, bottom-fixed): $value"
            overlayView.updateStrip(widthSeek.progress, value)
        })

        thresholdSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            thresholdLabel.text = "Threshold (0-255): $value"
        })

        sectionSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            val sections = max(1, value)
            sectionLabel.text = "Sections: $sections"
            updateLookupOutput()
        })

        redRatioSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            val ratio = value / 10.0
            redRatioLabel.text = "Red ratio min: ${"%.1f".format(ratio)}"
        })

        overlayView.updateStrip(widthSeek.progress, heightSeek.progress)

        startBtn.setOnClickListener {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
            ) {
                startCamera()
            } else {
                requestPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }

        stopBtn.setOnClickListener {
            stopCamera()
        }

        toggleControls.setOnClickListener {
            toggleVisibility(controlsPanel, toggleControls, "Controls")
        }
        togglePreview.setOnClickListener {
            toggleVisibility(previewContainer, togglePreview, "Preview")
        }
        toggleOutput.setOnClickListener {
            toggleVisibility(outputScroll, toggleOutput, "Output")
        }

        menuBtn.setOnClickListener {
            startActivity(Intent(this, SavedCapturesActivity::class.java))
        }

        updateLookupOutput()
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
    }

    private fun startCamera() {
        startBtn.isEnabled = false
        stopBtn.isEnabled = true
        statusText.text = "Starting camera..."
        angleText.text = "index: --"
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)

        cameraProviderFuture.addListener({
            val provider = cameraProviderFuture.get()
            cameraProvider = provider

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }

            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageRotationEnabled(true)
                .setTargetRotation(previewView.display?.rotation ?: Surface.ROTATION_0)
                .build()

            analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                val imageWidth = imageProxy.width
                val imageHeight = imageProxy.height

                val stripWidth = max(1, min(widthSeek.progress, imageWidth))
                val stripHeight = max(1, min(heightSeek.progress, imageHeight))
                val threshold = thresholdSeek.progress
                val ratioMin = redRatioSeek.progress / 10.0f
                val sections = max(1, sectionSeek.progress)

                val startX = max(0, (imageWidth / 2) - (stripWidth / 2))
                val startY = max(0, (imageHeight / 2) - stripHeight)

                val yPlane = imageProxy.planes[0]
                val uPlane = imageProxy.planes[1]
                val vPlane = imageProxy.planes[2]
                val yBuffer = yPlane.buffer
                val uBuffer = uPlane.buffer
                val vBuffer = vPlane.buffer
                val yRowStride = yPlane.rowStride
                val yPixelStride = yPlane.pixelStride
                val uRowStride = uPlane.rowStride
                val uPixelStride = uPlane.pixelStride
                val vRowStride = vPlane.rowStride
                val vPixelStride = vPlane.pixelStride

                val redBounds = findRedBounds(
                    imageWidth,
                    imageHeight,
                    startX,
                    stripWidth,
                    yBuffer,
                    uBuffer,
                    vBuffer,
                    yRowStride,
                    yPixelStride,
                    uRowStride,
                    uPixelStride,
                    vRowStride,
                    vPixelStride,
                    ratioMin
                )

                val dataStartY: Int
                val dataHeight: Int
                if (redBounds != null) {
                    dataStartY = max(0, redBounds.first + 1)
                    dataHeight = max(0, redBounds.second - dataStartY)
                } else {
                    dataStartY = startY
                    dataHeight = stripHeight
                }

                val maxR = IntArray(stripWidth) { -1 }
                val maxG = IntArray(stripWidth)
                val maxB = IntArray(stripWidth)
                val redFound = BooleanArray(stripWidth)
                val sb = StringBuilder(stripWidth * max(1, dataHeight) + max(1, dataHeight) + stripWidth + 1)
                for (row in 0 until dataHeight) {
                    val rowY = dataStartY + row
                    val isRedRow = rowHasRed(
                        imageWidth,
                        rowY,
                        startX,
                        stripWidth,
                        yBuffer,
                        uBuffer,
                        vBuffer,
                        yRowStride,
                        yPixelStride,
                        uRowStride,
                        uPixelStride,
                        vRowStride,
                        vPixelStride,
                        ratioMin
                    )
                    val rowStart = rowY * yRowStride + startX * yPixelStride
                    for (col in 0 until stripWidth) {
                        val x = startX + col
                        val rgb = yuvToRgb(
                            x,
                            rowY,
                            yBuffer,
                            uBuffer,
                            vBuffer,
                            yRowStride,
                            yPixelStride,
                            uRowStride,
                            uPixelStride,
                            vRowStride,
                            vPixelStride
                        )
                        val isRedPixel = isRedByRatio(rgb.first, rgb.second, rgb.third, ratioMin)
                        if (isRedPixel && rgb.first > maxR[col]) {
                            maxR[col] = rgb.first
                            maxG[col] = rgb.second
                            maxB[col] = rgb.third
                            redFound[col] = true
                        }
                        if (isRedRow || isRedPixel) {
                            sb.append('2')
                        } else {
                            val index = rowStart + col * yPixelStride
                            val luma = yBuffer.get(index).toInt() and 0xFF
                            sb.append(if (luma >= threshold) '1' else '0')
                        }
                    }
                    sb.append('\n')
                }

                val sectionResult = if (redBounds != null && dataHeight > 0) {
                    buildSectionBitsFromColumns(
                        startX,
                        stripWidth,
                        dataStartY,
                        dataHeight,
                        sections,
                        yBuffer,
                        uBuffer,
                        vBuffer,
                        yRowStride,
                        yPixelStride,
                        uRowStride,
                        uPixelStride,
                        vRowStride,
                        vPixelStride,
                        threshold,
                        ratioMin
                    )
                } else {
                    SectionResult("", "", null, "", null, null)
                }

                runOnUiThread {
                    val scrollY = outputScroll.scrollY
                    overlayView.updateImageSize(imageWidth, imageHeight)
                    overlayView.updateStrip(stripWidth, stripHeight)
                    statusText.text = "Frame: ${imageWidth}x${imageHeight}"
                    val rgbHeader = buildRgbHeader(maxR, maxG, maxB, redFound)
                    val newBinary = rgbHeader + sb.toString()
                    binaryOutput.text = newBinary
                    if (sectionResult.bitsText.isNotEmpty()) {
                        lastSectionBits = sectionResult.bitsText
                        lastAngleOutput = sectionResult.anglesText
                        lastCommonValue = sectionResult.commonValue
                        lastCommonBits = sectionResult.commonBits
                        lastCommonOrder = sectionResult.commonOrder
                        lastCommonAngle = sectionResult.commonAngle
                        sectionOutput.text = sectionResult.bitsText
                        angleOutput.text = sectionResult.anglesText
                        angleText.text = formatIndexLabel(
                            sectionResult.commonBits,
                            sectionResult.commonValue,
                            sectionResult.commonOrder,
                            sectionResult.commonAngle
                        )
                    } else if (lastSectionBits.isNotEmpty()) {
                        sectionOutput.text = lastSectionBits
                        angleOutput.text = lastAngleOutput
                        angleText.text = formatIndexLabel(
                            lastCommonBits,
                            lastCommonValue,
                            lastCommonOrder,
                            lastCommonAngle
                        )
                    } else {
                        sectionOutput.text = "binary undetected"
                        angleOutput.text = ""
                        angleText.text = formatIndexLabel("", null, null, null)
                    }
                    lastBinaryText = newBinary
                    outputScroll.post { outputScroll.scrollTo(0, scrollY) }
                }
                imageProxy.close()
            }

            val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, cameraSelector, preview, analysis)
                previewUseCase = preview
                analysisUseCase = analysis
                statusText.text = "Camera running"
            } catch (exc: Exception) {
                statusText.text = "Camera failed: ${exc.message}"
                startBtn.isEnabled = true
                stopBtn.isEnabled = false
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun stopCamera() {
        cameraProvider?.unbindAll()
        analysisUseCase = null
        previewUseCase = null
        statusText.text = "Stopped"
        binaryOutput.text = ""
        angleText.text = formatIndexLabel("", null, null, null)
        sectionOutput.text = ""
        lastSectionBits = ""
        lastBinaryText = ""
        angleOutput.text = ""
        lastAngleOutput = ""
        lastCommonValue = null
        lastCommonBits = ""
        lastCommonOrder = null
        lastCommonAngle = null
        startBtn.isEnabled = true
        stopBtn.isEnabled = false
    }

    private fun updateLookupOutput() {
        val sections = max(1, sectionSeek.progress)
        val size = 1 shl sections
        val lines = StringBuilder()
        for (i in 0 until size) {
            val gray = i xor (i shr 1)
            val bits = gray.toString(2).padStart(sections, '0')
            lines.append(bits).append(" -> ").append(i)
            if (i < size - 1) {
                lines.append('\n')
            }
        }
        lookupOutput.text = lines.toString()
    }

    private fun findRedBounds(
        imageWidth: Int,
        imageHeight: Int,
        startX: Int,
        stripWidth: Int,
        yBuffer: java.nio.ByteBuffer,
        uBuffer: java.nio.ByteBuffer,
        vBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): Pair<Int, Int>? {
        var top = -1
        var bottom = -1
        val redThreshold = max(3, stripWidth / 3)
        val endX = min(imageWidth - 1, startX + stripWidth - 1)

        for (y in 0 until imageHeight) {
            var redCount = 0
            for (x in startX..endX) {
                val yIndex = y * yRowStride + x * yPixelStride
                val uvX = x / 2
                val uvY = y / 2
                val uIndex = uvY * uRowStride + uvX * uPixelStride
                val vIndex = uvY * vRowStride + uvX * vPixelStride

                val yVal = yBuffer.get(yIndex).toInt() and 0xFF
                val uVal = uBuffer.get(uIndex).toInt() and 0xFF
                val vVal = vBuffer.get(vIndex).toInt() and 0xFF

                val c = yVal - 16
                val d = uVal - 128
                val e = vVal - 128
                val r = clipRgb((298 * c + 409 * e + 128) shr 8)
                val g = clipRgb((298 * c - 100 * d - 208 * e + 128) shr 8)
                val b = clipRgb((298 * c + 516 * d + 128) shr 8)

                if (isRedByRatio(r, g, b, ratioMin)) {
                    redCount++
                }
            }
            if (redCount >= redThreshold) {
                if (top == -1) {
                    top = y
                }
                bottom = y
            }
        }

        return if (top != -1 && bottom != -1 && bottom > top) {
            Pair(top, bottom)
        } else {
            null
        }
    }

    private fun rowHasRed(
        imageWidth: Int,
        y: Int,
        startX: Int,
        stripWidth: Int,
        yBuffer: java.nio.ByteBuffer,
        uBuffer: java.nio.ByteBuffer,
        vBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): Boolean {
        var redCount = 0
        val redThreshold = max(3, stripWidth / 3)
        val endX = min(imageWidth - 1, startX + stripWidth - 1)

        for (x in startX..endX) {
            if (isRedPixel(
                    x,
                    y,
                    yBuffer,
                    uBuffer,
                    vBuffer,
                    yRowStride,
                    yPixelStride,
                    uRowStride,
                    uPixelStride,
                    vRowStride,
                    vPixelStride,
                    ratioMin
                )
            ) {
                redCount++
                if (redCount >= redThreshold) {
                    return true
                }
            }
        }

        return false
    }

    private fun isRedPixel(
        x: Int,
        y: Int,
        yBuffer: java.nio.ByteBuffer,
        uBuffer: java.nio.ByteBuffer,
        vBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): Boolean {
        val rgb = yuvToRgb(
            x,
            y,
            yBuffer,
            uBuffer,
            vBuffer,
            yRowStride,
            yPixelStride,
            uRowStride,
            uPixelStride,
            vRowStride,
            vPixelStride
        )
        return isRedByRatio(rgb.first, rgb.second, rgb.third, ratioMin)
    }

    private fun isRedByRatio(r: Int, g: Int, b: Int, ratioMin: Float): Boolean {
        val minR = 40
        if (r < minR) return false
        val gRatio = r.toFloat() / (g + 1)
        val bRatio = r.toFloat() / (b + 1)
        return gRatio >= ratioMin && bRatio >= ratioMin
    }

    private fun yuvToRgb(
        x: Int,
        y: Int,
        yBuffer: java.nio.ByteBuffer,
        uBuffer: java.nio.ByteBuffer,
        vBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int
    ): Triple<Int, Int, Int> {
        val yIndex = y * yRowStride + x * yPixelStride
        val uvX = x / 2
        val uvY = y / 2
        val uIndex = uvY * uRowStride + uvX * uPixelStride
        val vIndex = uvY * vRowStride + uvX * vPixelStride

        val yVal = yBuffer.get(yIndex).toInt() and 0xFF
        val uVal = uBuffer.get(uIndex).toInt() and 0xFF
        val vVal = vBuffer.get(vIndex).toInt() and 0xFF

        val c = yVal - 16
        val d = uVal - 128
        val e = vVal - 128
        val r = clipRgb((298 * c + 409 * e + 128) shr 8)
        val g = clipRgb((298 * c - 100 * d - 208 * e + 128) shr 8)
        val b = clipRgb((298 * c + 516 * d + 128) shr 8)

        return Triple(r, g, b)
    }

    private fun buildRgbHeader(
        maxR: IntArray,
        maxG: IntArray,
        maxB: IntArray,
        redFound: BooleanArray
    ): String {
        val sb = StringBuilder()
        sb.append(formatLine(maxR, redFound))
        sb.append(formatLine(maxG, redFound))
        sb.append(formatLine(maxB, redFound))
        return sb.toString()
    }

    private fun formatLine(values: IntArray, redFound: BooleanArray): String {
        val sb = StringBuilder()
        for (i in values.indices) {
            val value = if (redFound[i] && values[i] >= 0) values[i] else 0
            sb.append(value.toString())
            if (i < values.size - 1) {
                sb.append("  ")
            }
        }
        sb.append('\n')
        return sb.toString()
    }

    private fun buildSectionBitsFromColumns(
        startX: Int,
        stripWidth: Int,
        dataStartY: Int,
        dataHeight: Int,
        sections: Int,
        yBuffer: java.nio.ByteBuffer,
        uBuffer: java.nio.ByteBuffer,
        vBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        threshold: Int,
        ratioMin: Float
    ): SectionResult {
        val perColumnBits = Array(stripWidth) { IntArray(sections) }

        for (col in 0 until stripWidth) {
            val x = startX + col
            val values = ArrayList<Int>(dataHeight)
            for (y in dataStartY until dataStartY + dataHeight) {
                val rgb = yuvToRgb(
                    x,
                    y,
                    yBuffer,
                    uBuffer,
                    vBuffer,
                    yRowStride,
                    yPixelStride,
                    uRowStride,
                    uPixelStride,
                    vRowStride,
                    vPixelStride
                )
                val isRed = isRedByRatio(rgb.first, rgb.second, rgb.third, ratioMin)
                if (isRed) {
                    values.add(2)
                } else {
                    val index = y * yRowStride + x * yPixelStride
                    val luma = yBuffer.get(index).toInt() and 0xFF
                    values.add(if (luma >= threshold) 1 else 0)
                }
            }
            val bits = detectGrayCode(values, sections)
            for (i in 0 until sections) {
                perColumnBits[col][i] = if (i < bits.size) bits[i] else 0
            }
        }

        val sb = StringBuilder()
        for (sectionIdx in 0 until sections) {
            for (col in 0 until stripWidth) {
                sb.append(perColumnBits[col][sectionIdx])
                if (col < stripWidth - 1) {
                    sb.append("  ")
                }
            }
            if (sectionIdx < sections - 1) {
                sb.append('\n')
            }
        }
        val anglesLine = StringBuilder()
        val valueCounts = HashMap<Int, Int>()
        var commonValue: Int? = null
        var commonBits = ""
        var commonOrder: Int? = null
        var commonAngle: Float? = null
        var commonCount = -1
        val lookup = grayPositionMapsLoaded[sections]
        val totalPositions = 1 shl sections
        for (col in 0 until stripWidth) {
            val angle = convertToAngle(perColumnBits[col].toList(), sections)
            anglesLine.append(String.format("%.1f", angle))
            val intValue = angle.toInt()
            val newCount = (valueCounts[intValue] ?: 0) + 1
            valueCounts[intValue] = newCount
            if (newCount > commonCount) {
                commonCount = newCount
                commonValue = intValue
                commonBits = intValue.toString(2).padStart(sections, '0')
                commonOrder = if (lookup != null && intValue in lookup.indices) lookup[intValue] else null
                commonAngle = if (commonOrder != null) {
                    (commonOrder!!.toFloat() / totalPositions.toFloat()) * 360f
                } else {
                    null
                }
            }
            if (col < stripWidth - 1) {
                anglesLine.append("  ")
            }
        }
        return SectionResult(sb.toString(), anglesLine.toString(), commonValue, commonBits, commonOrder, commonAngle)
    }

    private fun formatIndexLabel(
        commonBits: String,
        commonValue: Int?,
        commonOrder: Int?,
        commonAngle: Float?
    ): String {
        return if (!commonValueIsEmpty(commonBits, commonValue, commonOrder, commonAngle)) {
            val bitsText = if (commonBits.isNotEmpty()) commonBits else "--"
            val valueText = commonValue?.toString() ?: "--"
            val orderText = commonOrder?.toString() ?: "--"
            val angleText = commonAngle?.let { String.format("%.1f", it) } ?: "--"
            "bits: $bitsText  common: $valueText  order: $orderText  angle: $angleText"
        } else {
            "bits: --  common: --  order: --  angle: --"
        }
    }

    private fun commonValueIsEmpty(
        commonBits: String,
        commonValue: Int?,
        commonOrder: Int?,
        commonAngle: Float?
    ): Boolean {
        return commonBits.isEmpty() && commonValue == null && commonOrder == null && commonAngle == null
    }

    private fun convertToAngle(binary: List<Int>, noOfSections: Int): Float {
        if (binary.isEmpty() || noOfSections <= 0) return 0f
        var value = 0
        val count = min(noOfSections, binary.size)
        for (i in count - 1 downTo 0) {
            value = (value shl 1) or (binary[i] and 1)
        }
        return value.toFloat()
    }

    private fun detectGrayCode(values: List<Int>, sections: Int): List<Int> {
        if (sections <= 0 || values.isEmpty()) return emptyList()

        val firstTwo = values.indexOf(2)
        if (firstTwo == -1) return emptyList()
        val lastTwo = values.lastIndexOf(2)
        if (lastTwo <= firstTwo) return emptyList()

        val trimmed = values.subList(firstTwo + 1, lastTwo).filter { it != 2 }
        if (trimmed.isEmpty()) return emptyList()

        val result = MutableList(sections) { 0 }
        for (sectionIdx in 0 until sections) {
            val start = sectionIdx * trimmed.size / sections
            val end = (sectionIdx + 1) * trimmed.size / sections
            if (end <= start) {
                result[sectionIdx] = 0
                continue
            }
            var ones = 0
            for (i in start until end) {
                if (trimmed[i] >= 1) {
                    ones++
                }
            }
            val avg = ones.toFloat() / (end - start)
            result[sectionIdx] = if (avg >= 0.5f) 1 else 0
        }
        return result
    }

    private fun loadGrayLookupFromAssets(): Map<Int, IntArray> {
        return try {
            val jsonText = assets.open("gray_lookup_ccw_3_to_12.json").bufferedReader().use { it.readText() }
            val root = org.json.JSONObject(jsonText)
            val result = HashMap<Int, IntArray>()
            val keys = root.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val sections = key.toIntOrNull() ?: continue
                val size = 1 shl sections
                val map = IntArray(size)
                val obj = root.getJSONObject(key)
                val bitKeys = obj.keys()
                while (bitKeys.hasNext()) {
                    val bits = bitKeys.next()
                    val gray = bits.toInt(2)
                    val pos = obj.getInt(bits)
                    if (gray in 0 until size && pos in 0 until size) {
                        map[gray] = pos
                    }
                }
                result[sections] = map
            }
            result
        } catch (e: Exception) {
            emptyMap()
        }
    }

    private fun clipRgb(value: Int): Int {
        return when {
            value < 0 -> 0
            value > 255 -> 255
            else -> value
        }
    }

    private fun toggleVisibility(target: View, button: Button, label: String) {
        if (target.visibility == View.VISIBLE) {
            target.visibility = View.GONE
            button.text = "$label (show)"
        } else {
            target.visibility = View.VISIBLE
            button.text = label
        }
    }

    private fun simpleSeekListener(onChange: (Int) -> Unit): SeekBar.OnSeekBarChangeListener {
        return object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                onChange(progress)
            }

            override fun onStartTrackingTouch(seekBar: SeekBar?) {}

            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        }
    }
}
