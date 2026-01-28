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
import android.widget.CheckBox
import android.graphics.PointF
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
import kotlin.math.abs
import kotlin.math.roundToInt
import java.nio.ByteBuffer

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
    private lateinit var centerOnlyToggle: CheckBox
    private lateinit var widthLabel: TextView
    private lateinit var heightLabel: TextView
    private lateinit var thresholdLabel: TextView
    private lateinit var sectionLabel: TextView
    private lateinit var lineCountLabel: TextView
    private lateinit var convergenceLabel: TextView
    private lateinit var redRatioLabel: TextView
    private lateinit var greenRatioLabel: TextView
    private lateinit var sectionOutput: TextView
    private lateinit var outputScroll: ScrollView
    private lateinit var lookupOutput: TextView
    private lateinit var controlsPanel: LinearLayout
    private lateinit var previewContainer: View
    private lateinit var toggleControls: Button
    private lateinit var togglePreview: Button
    private lateinit var toggleOutput: Button
    private lateinit var toggleAngleDetails: Button
    private lateinit var widthSeek: SeekBar
    private lateinit var heightSeek: SeekBar
    private lateinit var thresholdSeek: SeekBar
    private lateinit var sectionSeek: SeekBar
    private lateinit var lineCountSeek: SeekBar
    private lateinit var convergenceSeek: SeekBar
    private lateinit var redRatioSeek: SeekBar
    private lateinit var greenRatioSeek: SeekBar
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
    private var lastBitWidthPx: Int? = null
    // UNUSED: retained for disabled center-line detection.
    private var lastCenter: PointF? = null
    // UNUSED: retained for disabled center-line detection.
    private var lastBisectorAngle: Float? = null
    private var lastBottomMarkers: List<PointF> = emptyList()
    private var showAngleDetails: Boolean = true
    private var grayPositionMapsLoaded: Map<Int, IntArray> = emptyMap()

    private data class SectionResult(
        val bitsText: String,
        val anglesText: String,
        val commonValue: Int?,   // <-- now: COMMON GRAY INT (not “angle”)
        val commonBits: String,  // <-- now: bits of the common gray int
        val commonOrder: Int?,   // <-- lookup[commonGrayInt]
        val commonAngle: Float?,  // <-- degrees from order
        val bitWidthPx: Int?      // <-- estimated column width (px)
    )

    private data class Band(val start: Int, val end: Int) {
        val center: Int
            get() = (start + end) / 2
        val span: Int
            get() = end - start + 1
    }

    private data class Segment(val start: Int, val end: Int, val center: Int, val isGreen: Boolean)
    private data class SegmentMatch(val topIndex: Int, val bottomIndex: Int)
    // UNUSED: retained for disabled center-line detection.
    private data class CenterResult(val center: PointF, val lines: List<LineModel>)

    /*
    companion object {
        // Unused right now, but keeping it since it was in your file.
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
    */

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
        centerOnlyToggle = findViewById(R.id.center_only_toggle)
        startBtn = findViewById(R.id.start_btn)
        stopBtn = findViewById(R.id.stop_btn)
        widthLabel = findViewById(R.id.width_label)
        heightLabel = findViewById(R.id.height_label)
        thresholdLabel = findViewById(R.id.threshold_label)
        sectionLabel = findViewById(R.id.section_label)
        lineCountLabel = findViewById(R.id.line_count_label)
        convergenceLabel = findViewById(R.id.convergence_label)
        redRatioLabel = findViewById(R.id.red_ratio_label)
        greenRatioLabel = findViewById(R.id.green_ratio_label)
        sectionOutput = findViewById(R.id.section_output)
        outputScroll = findViewById(R.id.output_scroll)
        lookupOutput = findViewById(R.id.lookup_output)
        controlsPanel = findViewById(R.id.controls_panel)
        previewContainer = findViewById(R.id.preview_container)
        toggleControls = findViewById(R.id.toggle_controls)
        togglePreview = findViewById(R.id.toggle_preview)
        toggleOutput = findViewById(R.id.toggle_output)
        toggleAngleDetails = findViewById(R.id.toggle_angle_details)
        widthSeek = findViewById(R.id.width_seek)
        heightSeek = findViewById(R.id.height_seek)
        thresholdSeek = findViewById(R.id.threshold_seek)
        sectionSeek = findViewById(R.id.section_seek)
        lineCountSeek = findViewById(R.id.line_count_seek)
        convergenceSeek = findViewById(R.id.convergence_seek)
        redRatioSeek = findViewById(R.id.red_ratio_seek)
        greenRatioSeek = findViewById(R.id.green_ratio_seek)
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
            sectionLabel.text = "Read bits (rows): $sections"
            updateLookupOutput()
        })

        lineCountSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            val count = max(1, value)
            lineCountLabel.text = "Read lines (columns): $count"
        })

        convergenceSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            convergenceLabel.text = "Convergence distance (px): $value"
        })

        redRatioSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            val ratio = value / 10.0
            redRatioLabel.text = "Red ratio min: ${"%.1f".format(ratio)}"
        })

        greenRatioSeek.setOnSeekBarChangeListener(simpleSeekListener { value ->
            val ratio = value / 10.0
            greenRatioLabel.text = "Green ratio min: ${"%.1f".format(ratio)}"
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

        stopBtn.setOnClickListener { stopCamera() }

        toggleControls.setOnClickListener { toggleVisibility(controlsPanel, toggleControls, "Controls") }
        togglePreview.setOnClickListener { toggleVisibility(previewContainer, togglePreview, "Preview") }
        toggleOutput.setOnClickListener { toggleVisibility(outputScroll, toggleOutput, "Output") }
        toggleAngleDetails.setOnClickListener {
            showAngleDetails = !showAngleDetails
            toggleAngleDetails.text = if (showAngleDetails) "Angles only" else "Show details"
            angleText.text = formatIndexLabel(
                lastCommonBits,
                lastCommonValue,
                lastCommonOrder,
                lastCommonAngle,
                lastBitWidthPx
            )
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
        angleText.text = formatIndexLabel("", null, null, null, null)
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
                val greenRatioMin = greenRatioSeek.progress / 10.0f
                val blueRatioMin = 1.4f
                val orderWindow = 0
                val sections = max(1, sectionSeek.progress)
                val lineCount = max(1, lineCountSeek.progress)
                val convergencePx = max(0, convergenceSeek.progress)
                val centerOnly = centerOnlyToggle.isChecked

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

                val redBounds = if (centerOnly) {
                    null
                } else {
                    findRedBounds(
                        imageWidth,
                        imageHeight,
                        startX,
                        startY,
                        stripWidth,
                        stripHeight,
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
                }

                val greenBands = if (centerOnly) {
                    null
                } else {
                    findGreenBands(
                        imageWidth,
                        imageHeight,
                        startX,
                        startY,
                        stripWidth,
                        stripHeight,
                        yBuffer,
                        uBuffer,
                        vBuffer,
                        yRowStride,
                        yPixelStride,
                        uRowStride,
                        uPixelStride,
                        vRowStride,
                        vPixelStride,
                        greenRatioMin
                    )
                }

                val dataStartY: Int
                val dataHeight: Int
                if (redBounds != null) {
                    dataStartY = max(0, redBounds.first + 1)
                    dataHeight = max(0, redBounds.second - dataStartY)
                } else {
                    dataStartY = startY
                    dataHeight = stripHeight
                }
                val readLineXs = buildReadLineXs(
                    startX,
                    stripWidth,
                    lineCount
                )
                val readLineSegments = buildReadLineSegments(
                    readLineXs,
                    dataStartY,
                    dataHeight,
                    convergencePx
                )

                // Center line detection disabled.
                /*
                val edgeSeeds = findBlueEdgeSeedsBottomRow(
                    startX,
                    dataStartY,
                    stripWidth,
                    dataHeight,
                    yBuffer,
                    uBuffer,
                    vBuffer,
                    yRowStride,
                    yPixelStride,
                    uRowStride,
                    uPixelStride,
                    vRowStride,
                    vPixelStride,
                    blueRatioMin,
                    blueWhiteRatio,
                    blueEdgeExpand
                )
                lastBottomMarkers = traceBlueEdgeFromSeeds(
                    startX,
                    dataStartY,
                    stripWidth,
                    dataHeight,
                    yBuffer,
                    uBuffer,
                    vBuffer,
                    yRowStride,
                    yPixelStride,
                    uRowStride,
                    uPixelStride,
                    vRowStride,
                    vPixelStride,
                    blueRatioMin,
                    blueWhiteRatio,
                    blueEdgeExpand,
                    edgeSeeds,
                    null
                )
                */

                val maxR = IntArray(stripWidth) { -1 }
                val maxG = IntArray(stripWidth)
                val maxB = IntArray(stripWidth)
                val redFound = BooleanArray(stripWidth)
                val sb = StringBuilder(stripWidth * max(1, dataHeight) + max(1, dataHeight) + stripWidth + 1)

                val sectionResult = if (centerOnly) {
                    appendBinaryWindow(
                        sb,
                        startX,
                        dataStartY,
                        stripWidth,
                        dataHeight,
                        yBuffer,
                        yRowStride,
                        yPixelStride
                    )
                    SectionResult("", "", null, "", null, null, null)
                } else {
                    // Debug visualization (uses RGB + red ratio threshold).
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
                                x, rowY,
                                yBuffer, uBuffer, vBuffer,
                                yRowStride, yPixelStride,
                                uRowStride, uPixelStride,
                                vRowStride, vPixelStride
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

                    if (redBounds != null && dataHeight > 0) {
                        buildSectionBitsFromLines(
                            startX,
                            stripWidth,
                            dataStartY,
                            dataHeight,
                            sections,
                            readLineXs,
                            convergencePx,
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
                            ratioMin,
                            orderWindow
                        )
                    } else {
                        SectionResult("", "", null, "", null, null, null)
                    }
                }

                runOnUiThread {
                    val scrollY = outputScroll.scrollY
                    overlayView.updateImageSize(imageWidth, imageHeight)
                    overlayView.updateStrip(stripWidth, stripHeight)
                    overlayView.updateCenterGuide(null, null)
                    overlayView.updateBottomMarkers(lastBottomMarkers)
                    overlayView.updateReadLineSegments(readLineSegments)
                    statusText.text = "Frame: ${imageWidth}x${imageHeight}"

                    val newBinary = if (centerOnly) {
                        sb.toString()
                    } else {
                        val rgbHeader = buildRgbHeader(maxR, maxG, maxB, redFound)
                        rgbHeader + sb.toString()
                    }
                    binaryOutput.text = newBinary

                    if (!centerOnly && sectionResult.bitsText.isNotEmpty()) {
                        val displayAngle = sectionResult.commonAngle
                        lastSectionBits = sectionResult.bitsText
                        lastAngleOutput = sectionResult.anglesText
                        lastCommonValue = sectionResult.commonValue
                        lastCommonBits = sectionResult.commonBits
                        lastCommonOrder = sectionResult.commonOrder
                        lastCommonAngle = displayAngle
                        lastBitWidthPx = sectionResult.bitWidthPx
                        sectionOutput.text = sectionResult.bitsText
                        angleOutput.text = sectionResult.anglesText
                        angleText.text = formatIndexLabel(
                            sectionResult.commonBits,
                            sectionResult.commonValue,
                            sectionResult.commonOrder,
                            displayAngle,
                            sectionResult.bitWidthPx
                        )
                    } else if (!centerOnly && lastSectionBits.isNotEmpty()) {
                        sectionOutput.text = lastSectionBits
                        angleOutput.text = lastAngleOutput
                        angleText.text = formatIndexLabel(
                            lastCommonBits,
                            lastCommonValue,
                            lastCommonOrder,
                            lastCommonAngle,
                            lastBitWidthPx
                        )
                    } else {
                        sectionOutput.text = "binary undetected"
                        angleOutput.text = ""
                        angleText.text = formatIndexLabel("", null, null, null, null)
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
        angleText.text = formatIndexLabel("", null, null, null, null)
        sectionOutput.text = ""
        lastSectionBits = ""
        lastBinaryText = ""
        angleOutput.text = ""
        lastAngleOutput = ""
        lastCommonValue = null
        lastCommonBits = ""
        lastCommonOrder = null
        lastCommonAngle = null
        lastBitWidthPx = null
        lastCenter = null
        lastBisectorAngle = null
        lastBottomMarkers = emptyList()
        overlayView.updateReadLineSegments(emptyList())
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
            if (i < size - 1) lines.append('\n')
        }
        lookupOutput.text = lines.toString()
    }

    private fun findRedBounds(
        imageWidth: Int,
        imageHeight: Int,
        startX: Int,
        startY: Int,
        stripWidth: Int,
        stripHeight: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
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
        val endY = min(imageHeight - 1, startY + stripHeight - 1)

        for (y in startY..endY) {
            var redCount = 0
            for (x in startX..endX) {
                if (isRedPixelByRatio(
                        x, y,
                        yBuffer, uBuffer, vBuffer,
                        yRowStride, yPixelStride,
                        uRowStride, uPixelStride,
                        vRowStride, vPixelStride,
                        ratioMin
                    )
                ) {
                    redCount++
                }
            }
            if (redCount >= redThreshold) {
                if (top == -1) top = y
                bottom = y
            }
        }

        return if (top != -1 && bottom != -1 && bottom > top) Pair(top, bottom) else null
    }

    private fun findGreenBands(
        imageWidth: Int,
        imageHeight: Int,
        startX: Int,
        startY: Int,
        stripWidth: Int,
        stripHeight: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): Pair<Band, Band>? {
        val bands = ArrayList<Band>()
        val greenThreshold = max(3, stripWidth / 3)
        val endX = min(imageWidth - 1, startX + stripWidth - 1)
        val endY = min(imageHeight - 1, startY + stripHeight - 1)

        var runStart = -1
        for (y in startY..endY) {
            var greenCount = 0
            for (x in startX..endX) {
                if (isGreenPixelByRatio(
                        x, y,
                        yBuffer, uBuffer, vBuffer,
                        yRowStride, yPixelStride,
                        uRowStride, uPixelStride,
                        vRowStride, vPixelStride,
                        ratioMin
                    )
                ) {
                    greenCount++
                }
            }
            val isGreenRow = greenCount >= greenThreshold
            if (isGreenRow) {
                if (runStart == -1) runStart = y
            } else if (runStart != -1) {
                bands.add(Band(runStart, y - 1))
                runStart = -1
            }
        }
        if (runStart != -1) {
            bands.add(Band(runStart, endY))
        }

        if (bands.size < 2) return null
        val top = bands.first()
        val bottom = bands.last()
        if (bottom.start <= top.end) return null
        return Pair(top, bottom)
    }

    // UNUSED: retained for disabled center-line detection.
    private fun findCenter(
        imageWidth: Int,
        imageHeight: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMinBlue: Float
    ): CenterResult? {
        val guess = lastCenter ?: PointF(imageWidth / 2f, imageHeight / 2f)
        val maxScanRows = min(imageHeight, 400)
        val points = ArrayList<PointF>()

        for (y in imageHeight - 1 downTo imageHeight - maxScanRows) {
            var prevBlue = false
            for (x in 0 until imageWidth) {
                val isBlue = isBluePixelByRatio(
                    x, y,
                    yBuffer, uBuffer, vBuffer,
                    yRowStride, yPixelStride,
                    uRowStride, uPixelStride,
                    vRowStride, vPixelStride,
                    ratioMinBlue
                )
                if (x > 0 && isBlue != prevBlue) {
                    points.add(PointF(x.toFloat(), y.toFloat()))
                }
                prevBlue = isBlue
            }
        }

        val minPoints = 200
        if (points.size < minPoints) return null

        val angles = points.mapNotNull { p ->
            val dx = p.x - guess.x
            val dy = p.y - guess.y
            if (dx == 0f && dy == 0f) null else normalizeAngle(kotlin.math.atan2(dy, dx).toFloat(), Math.PI.toFloat())
        }
        if (angles.size < minPoints) return null

        val clusters = clusterAngles(points, angles, 4, Math.PI.toFloat()) ?: return null
        val lines = ArrayList<LineModel>()
        for (cluster in clusters) {
            val line = fitLineTLS(cluster) ?: return null
            lines.add(line)
        }

        val center = intersectLeastSquares(lines) ?: return null
        return CenterResult(center, lines)
    }

    // UNUSED: retained for disabled center-line detection.
    private data class LineModel(val a: Float, val b: Float, val c: Float)

    // UNUSED: retained for disabled center-line detection.
    private fun fitLineTLS(points: List<PointF>): LineModel? {
        if (points.size < 2) return null
        var sumX = 0.0
        var sumY = 0.0
        for (p in points) {
            sumX += p.x
            sumY += p.y
        }
        val cx = sumX / points.size
        val cy = sumY / points.size
        var sxx = 0.0
        var syy = 0.0
        var sxy = 0.0
        for (p in points) {
            val dx = p.x - cx
            val dy = p.y - cy
            sxx += dx * dx
            syy += dy * dy
            sxy += dx * dy
        }
        val trace = sxx + syy
        val det = sxx * syy - sxy * sxy
        val disc = trace * trace - 4 * det
        if (disc < 0) return null
        val lambda = (trace + kotlin.math.sqrt(disc)) / 2.0
        var dx = sxy
        var dy = lambda - sxx
        if (kotlin.math.abs(dx) + kotlin.math.abs(dy) < 1e-6) {
            dx = lambda - syy
            dy = sxy
        }
        val norm = kotlin.math.hypot(dx, dy)
        if (norm < 1e-6) return null
        dx /= norm
        dy /= norm
        val a = dy
        val b = -dx
        val c = -(a * cx + b * cy)
        return LineModel(a.toFloat(), b.toFloat(), c.toFloat())
    }

    // UNUSED: retained for disabled center-line detection.
    private fun clusterAngles(
        points: List<PointF>,
        angles: List<Float>,
        k: Int,
        period: Float
    ): List<List<PointF>>? {
        if (points.size != angles.size || points.isEmpty() || k <= 0) return null
        val sorted = angles.sorted()
        val centers = FloatArray(k) { i ->
            val idx = ((i + 0.5f) / k * (sorted.size - 1)).toInt()
            sorted[idx]
        }
        val assignments = IntArray(points.size)
        repeat(6) {
            for (i in angles.indices) {
                var best = 0
                var bestDist = Float.MAX_VALUE
                for (c in centers.indices) {
                    val dist = circularAngleDistance(angles[i], centers[c], period)
                    if (dist < bestDist) {
                        bestDist = dist
                        best = c
                    }
                }
                assignments[i] = best
            }
            for (c in centers.indices) {
                var sumSin = 0.0
                var sumCos = 0.0
                var count = 0
                for (i in angles.indices) {
                    if (assignments[i] == c) {
                        val angle = angles[i].toDouble()
                        sumSin += kotlin.math.sin(2.0 * angle)
                        sumCos += kotlin.math.cos(2.0 * angle)
                        count++
                    }
                }
                if (count > 0) {
                    val mean = 0.5 * kotlin.math.atan2(sumSin, sumCos)
                    centers[c] = normalizeAngle(mean.toFloat(), period)
                }
            }
        }
        val clusters = ArrayList<MutableList<PointF>>(k)
        repeat(k) { clusters.add(ArrayList()) }
        for (i in points.indices) {
            clusters[assignments[i]].add(points[i])
        }
        val minClusterPoints = 40
        if (clusters.any { it.size < minClusterPoints }) return null
        return clusters
    }

    private fun appendBinaryWindow(
        sb: StringBuilder,
        startX: Int,
        dataStartY: Int,
        stripWidth: Int,
        dataHeight: Int,
        yBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int
    ) {
        if (stripWidth <= 0 || dataHeight <= 0) return
        val window = min(10, dataHeight)
        val halfWindow = window / 2

        val prefix = Array(stripWidth) { IntArray(dataHeight + 1) }
        for (col in 0 until stripWidth) {
            val x = startX + col
            for (row in 0 until dataHeight) {
                val y = dataStartY + row
                val idx = y * yRowStride + x * yPixelStride
                val luma = yBuffer.get(idx).toInt() and 0xFF
                prefix[col][row + 1] = prefix[col][row] + luma
            }
        }

        for (row in 0 until dataHeight) {
            val start = max(0, row - halfWindow)
            val end = min(dataHeight - 1, start + window - 1)
            val denom = (end - start + 1).coerceAtLeast(1)
            for (col in 0 until stripWidth) {
                val sum = prefix[col][end + 1] - prefix[col][start]
                val avg = sum.toFloat() / denom.toFloat()
                val norm = avg / 255f
                sb.append(if (norm >= 0.5f) '1' else '0')
            }
            sb.append('\n')
        }
    }

    private fun findBlueEdgeSeedsBottomRow(
        startX: Int,
        dataStartY: Int,
        stripWidth: Int,
        dataHeight: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMinBlue: Float,
        blueWhiteRatio: Float,
        expandPixels: Int
    ): List<PointF> {
        if (stripWidth <= 0 || dataHeight <= 0) return emptyList()
        val y = dataStartY + dataHeight - 1
        if (y < 0) return emptyList()
        val rg = IntArray(stripWidth)
        val isBlue = BooleanArray(stripWidth)
        for (col in 0 until stripWidth) {
            val x = startX + col
            val rgb = yuvToRgb(
                x, y,
                yBuffer, uBuffer, vBuffer,
                yRowStride, yPixelStride,
                uRowStride, uPixelStride,
                vRowStride, vPixelStride
            )
            rg[col] = rgb.first + rgb.second
            isBlue[col] = isBlueByRatio(rgb.first, rgb.second, rgb.third, ratioMinBlue)
        }

        val transitions = ArrayList<PointF>()
        val maxOffset = max(1, expandPixels)
        var runStart = -1
        for (col in maxOffset until stripWidth - maxOffset) {
            var edge = false
            for (offset in 1..maxOffset) {
                val left = rg[col - offset]
                val right = rg[col + offset]
                val high = max(left, right)
                val low = min(left, right)
                if (low > 0 && high.toFloat() / low.toFloat() >= blueWhiteRatio) {
                    val leftBlue = isBlue[col - offset]
                    val rightBlue = isBlue[col + offset]
                    if (leftBlue != rightBlue) {
                        edge = true
                        break
                    }
                }
            }
            if (edge) {
                if (runStart == -1) runStart = col
            } else if (runStart != -1) {
                val center = (runStart + col - 1) / 2
                transitions.add(PointF(center.toFloat(), (dataHeight - 1).toFloat()))
                runStart = -1
            }
        }
        if (runStart != -1) {
            val center = (runStart + (stripWidth - maxOffset - 1)) / 2
            transitions.add(PointF(center.toFloat(), (dataHeight - 1).toFloat()))
        }

        return transitions
    }

    private fun traceBlueEdgeFromSeeds(
        startX: Int,
        dataStartY: Int,
        stripWidth: Int,
        dataHeight: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMinBlue: Float,
        blueWhiteRatio: Float,
        expandPixels: Int,
        seeds: List<PointF>,
        edgeMaskOverride: BooleanArray?
    ): List<PointF> {
        if (stripWidth <= 0 || dataHeight <= 0 || seeds.isEmpty()) return emptyList()
        val edgeMask = edgeMaskOverride ?: run {
            val rg = IntArray(stripWidth * dataHeight)
            val isBlue = BooleanArray(stripWidth * dataHeight)
            for (row in 0 until dataHeight) {
                val y = dataStartY + row
                for (col in 0 until stripWidth) {
                    val x = startX + col
                    val rgb = yuvToRgb(
                        x, y,
                        yBuffer, uBuffer, vBuffer,
                        yRowStride, yPixelStride,
                        uRowStride, uPixelStride,
                        vRowStride, vPixelStride
                    )
                    val idx = row * stripWidth + col
                    rg[idx] = rgb.first + rgb.second
                    isBlue[idx] = isBlueByRatio(rgb.first, rgb.second, rgb.third, ratioMinBlue)
                }
            }

            val maxOffset = max(1, expandPixels)
            val mask = BooleanArray(stripWidth * dataHeight)
            for (row in 0 until dataHeight) {
                for (col in 0 until stripWidth) {
                    var edge = false
                    for (offset in 1..maxOffset) {
                        val left = col - offset
                        val right = col + offset
                        if (left >= 0 && right < stripWidth) {
                            val leftIdx = row * stripWidth + left
                            val rightIdx = row * stripWidth + right
                            val high = max(rg[leftIdx], rg[rightIdx])
                            val low = min(rg[leftIdx], rg[rightIdx])
                            if (low > 0 && high.toFloat() / low.toFloat() >= blueWhiteRatio) {
                                if (isBlue[leftIdx] != isBlue[rightIdx]) {
                                    edge = true
                                    break
                                }
                            }
                        }
                        val up = row - offset
                        val down = row + offset
                        if (!edge && up >= 0 && down < dataHeight) {
                            val upIdx = up * stripWidth + col
                            val downIdx = down * stripWidth + col
                            val high = max(rg[upIdx], rg[downIdx])
                            val low = min(rg[upIdx], rg[downIdx])
                            if (low > 0 && high.toFloat() / low.toFloat() >= blueWhiteRatio) {
                                if (isBlue[upIdx] != isBlue[downIdx]) {
                                    edge = true
                                    break
                                }
                            }
                        }
                    }
                    mask[row * stripWidth + col] = edge
                }
            }
            mask
        }

        val visited = BooleanArray(stripWidth * dataHeight)
        val output = ArrayList<PointF>()
        val queue: ArrayDeque<Int> = ArrayDeque()
        val maxPoints = 2000
        val sampleStride = 2

        fun enqueueIfEdge(col: Int, row: Int) {
            if (col < 0 || col >= stripWidth || row < 0 || row >= dataHeight) return
            val idx = row * stripWidth + col
            if (!edgeMask[idx] || visited[idx]) return
            visited[idx] = true
            queue.add(idx)
        }

        for (seed in seeds) {
            enqueueIfEdge(seed.x.toInt(), seed.y.toInt())
        }

        while (queue.isNotEmpty() && output.size < maxPoints) {
            val idx = queue.removeFirst()
            val row = idx / stripWidth
            val col = idx % stripWidth
            if ((col + row) % sampleStride == 0) {
                output.add(PointF(col.toFloat(), row.toFloat()))
            }
            enqueueIfEdge(col + 1, row)
            enqueueIfEdge(col - 1, row)
            enqueueIfEdge(col, row + 1)
            enqueueIfEdge(col, row - 1)
        }

        return output
    }

    // UNUSED: retained for disabled center-line detection.
    private fun intersectLeastSquares(lines: List<LineModel>): PointF? {
        if (lines.size < 2) return null
        var sumA2 = 0.0
        var sumAB = 0.0
        var sumB2 = 0.0
        var sumAC = 0.0
        var sumBC = 0.0
        for (line in lines) {
            val a = line.a.toDouble()
            val b = line.b.toDouble()
            val c = line.c.toDouble()
            sumA2 += a * a
            sumAB += a * b
            sumB2 += b * b
            sumAC += a * c
            sumBC += b * c
        }
        val det = sumA2 * sumB2 - sumAB * sumAB
        if (kotlin.math.abs(det) < 1e-6) return null
        val x = -(sumB2 * sumAC - sumAB * sumBC) / det
        val y = -(-sumAB * sumAC + sumA2 * sumBC) / det
        return PointF(x.toFloat(), y.toFloat())
    }

    // UNUSED: retained for disabled center-line detection.
    private fun bisectorAngle(lines: List<LineModel>): Float? {
        if (lines.size < 2) return null
        val angles = lines.mapNotNull { lineAngle(it) }
        if (angles.size < 2) return null
        val normAngles = angles.map { normalizeAngle(it, Math.PI.toFloat()) }
        var bestPair: Pair<Float, Float>? = null
        var bestDist = Float.MAX_VALUE
        for (i in 0 until normAngles.size - 1) {
            for (j in i + 1 until normAngles.size) {
                val dist = circularAngleDistance(normAngles[i], normAngles[j], Math.PI.toFloat())
                if (dist < bestDist) {
                    bestDist = dist
                    bestPair = Pair(normAngles[i], normAngles[j])
                }
            }
        }
        val pair = bestPair ?: return null
        val a = pair.first
        val b = pair.second
        val x = kotlin.math.cos(2.0 * a) + kotlin.math.cos(2.0 * b)
        val y = kotlin.math.sin(2.0 * a) + kotlin.math.sin(2.0 * b)
        if (kotlin.math.abs(x) < 1e-6 && kotlin.math.abs(y) < 1e-6) return null
        val angle = 0.5 * kotlin.math.atan2(y, x)
        return normalizeAngle(angle.toFloat(), Math.PI.toFloat())
    }

    // UNUSED: retained for disabled center-line detection.
    private fun lineAngle(line: LineModel): Float? {
        val dx = line.b.toDouble()
        val dy = (-line.a).toDouble()
        if (kotlin.math.abs(dx) < 1e-6 && kotlin.math.abs(dy) < 1e-6) return null
        return kotlin.math.atan2(dy, dx).toFloat()
    }

    // UNUSED: retained for disabled center-line detection.
    private fun normalizeAngle(angle: Float, period: Float): Float {
        var out = angle % period
        if (out < 0f) out += period
        return out
    }

    // UNUSED: retained for disabled center-line detection.
    private fun circularAngleDistance(a: Float, b: Float, period: Float): Float {
        val diff = kotlin.math.abs(a - b) % period
        return kotlin.math.min(diff, period - diff)
    }

    private fun greenFlagsForBand(
        imageWidth: Int,
        imageHeight: Int,
        startX: Int,
        stripWidth: Int,
        bandCenterY: Int,
        bandWindow: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): BooleanArray {
        val flags = BooleanArray(stripWidth)
        val startY = max(0, bandCenterY - bandWindow)
        val endY = min(imageHeight - 1, bandCenterY + bandWindow)
        val rows = max(1, endY - startY + 1)

        for (col in 0 until stripWidth) {
            val x = startX + col
            var greenCount = 0
            for (y in startY..endY) {
                if (isGreenPixelByRatio(
                        x, y,
                        yBuffer, uBuffer, vBuffer,
                        yRowStride, yPixelStride,
                        uRowStride, uPixelStride,
                        vRowStride, vPixelStride,
                        ratioMin
                    )
                ) {
                    greenCount++
                }
            }
            flags[col] = greenCount.toFloat() / rows >= 0.5f
        }
        return flags
    }

    private fun smoothBoolean(values: BooleanArray, radius: Int): BooleanArray {
        if (values.isEmpty()) return values
        val out = BooleanArray(values.size)
        for (i in values.indices) {
            var count = 0
            var total = 0
            val start = max(0, i - radius)
            val end = min(values.lastIndex, i + radius)
            for (j in start..end) {
                total++
                if (values[j]) count++
            }
            out[i] = count >= (total + 1) / 2
        }
        return out
    }

    private fun segmentsFromFlags(flags: BooleanArray): List<Segment> {
        if (flags.isEmpty()) return emptyList()
        val segments = ArrayList<Segment>()
        var current = flags[0]
        var start = 0
        for (i in 1..flags.size) {
            val atEnd = i == flags.size
            if (atEnd || flags[i] != current) {
                val end = i - 1
                val center = (start + end) / 2
                segments.add(Segment(start, end, center, current))
                if (!atEnd) {
                    start = i
                    current = flags[i]
                }
            }
        }
        return segments
    }

    private fun smoothedCenter(segments: List<Segment>, index: Int, radius: Int): Int {
        if (segments.isEmpty()) return 0
        val start = max(0, index - radius)
        val end = min(segments.lastIndex, index + radius)
        var sum = 0
        var count = 0
        for (i in start..end) {
            sum += segments[i].center
            count++
        }
        return if (count > 0) sum / count else segments[index].center
    }

    private fun matchSegments(top: List<Segment>, bottom: List<Segment>): List<SegmentMatch> {
        if (top.isEmpty() || bottom.isEmpty()) return emptyList()
        val topPattern = top.map { it.isGreen }
        val bottomPattern = bottom.map { it.isGreen }
        if (top.size == bottom.size && topPattern == bottomPattern) {
            return top.indices.map { SegmentMatch(it, it) }
        }

        val used = BooleanArray(bottom.size)
        val matches = ArrayList<SegmentMatch>()
        for (i in top.indices) {
            val seg = top[i]
            var bestIndex = -1
            var bestDist = Int.MAX_VALUE
            for (j in bottom.indices) {
                if (used[j] || bottom[j].isGreen != seg.isGreen) continue
                val dist = abs(bottom[j].center - seg.center)
                if (dist < bestDist) {
                    bestDist = dist
                    bestIndex = j
                }
            }
            if (bestIndex != -1) {
                used[bestIndex] = true
                matches.add(SegmentMatch(i, bestIndex))
            }
        }
        matches.sortBy { top[it.topIndex].center }
        return matches
    }

    private fun estimateBitWidth(segments: List<Segment>): Int? {
        if (segments.isEmpty()) return null
        val widths = segments.filter { it.isGreen }.map { it.end - it.start + 1 }
        val target = if (widths.isNotEmpty()) widths else segments.map { it.end - it.start + 1 }
        if (target.isEmpty()) return null
        val sorted = target.sorted()
        return sorted[sorted.size / 2]
    }

    private fun rowHasRed(
        imageWidth: Int,
        y: Int,
        startX: Int,
        stripWidth: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
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
            if (isRedPixelByRatio(
                    x, y,
                    yBuffer, uBuffer, vBuffer,
                    yRowStride, yPixelStride,
                    uRowStride, uPixelStride,
                    vRowStride, vPixelStride,
                    ratioMin
                )
            ) {
                redCount++
                if (redCount >= redThreshold) return true
            }
        }
        return false
    }

    private fun isRedPixelByRatio(
        x: Int,
        y: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): Boolean {
        val rgb = yuvToRgb(
            x, y,
            yBuffer, uBuffer, vBuffer,
            yRowStride, yPixelStride,
            uRowStride, uPixelStride,
            vRowStride, vPixelStride
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

    private fun isGreenPixelByRatio(
        x: Int,
        y: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): Boolean {
        val rgb = yuvToRgb(
            x, y,
            yBuffer, uBuffer, vBuffer,
            yRowStride, yPixelStride,
            uRowStride, uPixelStride,
            vRowStride, vPixelStride
        )
        return isGreenByRatio(rgb.first, rgb.second, rgb.third, ratioMin)
    }

    private fun isGreenByRatio(r: Int, g: Int, b: Int, ratioMin: Float): Boolean {
        val minG = 40
        if (g < minG) return false
        val rRatio = g.toFloat() / (r + 1)
        val bRatio = g.toFloat() / (b + 1)
        return rRatio >= ratioMin && bRatio >= ratioMin
    }

    private fun isBluePixelByRatio(
        x: Int,
        y: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        ratioMin: Float
    ): Boolean {
        val rgb = yuvToRgb(
            x, y,
            yBuffer, uBuffer, vBuffer,
            yRowStride, yPixelStride,
            uRowStride, uPixelStride,
            vRowStride, vPixelStride
        )
        return isBlueByRatio(rgb.first, rgb.second, rgb.third, ratioMin)
    }

    private fun isBlueByRatio(r: Int, g: Int, b: Int, ratioMin: Float): Boolean {
        val minB = 40
        if (b < minB) return false
        val rRatio = b.toFloat() / (r + 1)
        val gRatio = b.toFloat() / (g + 1)
        return rRatio >= ratioMin && gRatio >= ratioMin
    }

    private fun yuvToRgb(
        x: Int,
        y: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
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
            if (i < values.size - 1) sb.append("  ")
        }
        sb.append('\n')
        return sb.toString()
    }

    // Helper: interpret your perColumnBits (LSB-first) as an integer
    private fun bitsToIntLSBFirst(bits: IntArray, count: Int): Int {
        var v = 0
        val n = min(count, bits.size)
        for (i in n - 1 downTo 0) {
            v = (v shl 1) or (bits[i] and 1)
        }
        return v
    }

    // ===== CHANGE #1: buildSectionBitsFromColumns now treats per-column bits as a GRAY integer,
    // counts that, and uses lookup[grayInt] for order/angle. =====
    private fun buildSectionBitsFromLines(
        startX: Int,
        stripWidth: Int,
        dataStartY: Int,
        dataHeight: Int,
        sections: Int,
        readLineXs: FloatArray,
        convergencePx: Int,
        yBuffer: ByteBuffer,
        uBuffer: ByteBuffer,
        vBuffer: ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        uRowStride: Int,
        uPixelStride: Int,
        vRowStride: Int,
        vPixelStride: Int,
        threshold: Int,
        ratioMin: Float,
        orderWindow: Int
    ): SectionResult {
        if (dataHeight <= 0 || readLineXs.isEmpty()) {
            return SectionResult("", "", null, "", null, null, null)
        }
        val perColumnBits = Array(readLineXs.size) { IntArray(sections) }
        val perColumnValid = BooleanArray(readLineXs.size)
        val bitWidthPx = estimateLineSpacing(readLineXs)
        val anchorY = dataStartY + dataHeight - 1
        val centerX = readLineXs.average().toFloat()
        val centerY = anchorY + convergencePx.toFloat()

        for (colIdx in readLineXs.indices) {
            val anchorX = readLineXs[colIdx]
            val values = ArrayList<Int>(dataHeight)
            var sawFirstRed = false
            for (row in 0 until dataHeight) {
                val y = dataStartY + row
                val xFloat = computeReadLineX(anchorX, anchorY.toFloat(), centerX, centerY, y.toFloat())
                val x = xFloat.roundToInt().coerceIn(startX, startX + stripWidth - 1)
                val rgb = yuvToRgb(
                    x, y,
                    yBuffer, uBuffer, vBuffer,
                    yRowStride, yPixelStride,
                    uRowStride, uPixelStride,
                    vRowStride, vPixelStride
                )
                val isRed = isRedByRatio(rgb.first, rgb.second, rgb.third, ratioMin)
                if (isRed) {
                    values.add(2)
                    if (sawFirstRed) break
                    sawFirstRed = true
                    continue
                }
                if (!sawFirstRed) continue
                val index = y * yRowStride + x * yPixelStride
                val luma = yBuffer.get(index).toInt() and 0xFF
                values.add(if (luma >= threshold) 1 else 0)
            }
            val bits = detectGrayCode(values, sections)
            val isValid = bits.size == sections
            perColumnValid[colIdx] = isValid && values.count { it == 2 } >= 2
            for (i in 0 until sections) {
                perColumnBits[colIdx][i] = if (i < bits.size) bits[i] else 0
            }
        }
        return buildSectionResult(perColumnBits, perColumnValid, sections, orderWindow, bitWidthPx)
    }

    private fun buildReadLineXs(
        startX: Int,
        stripWidth: Int,
        lineCount: Int
    ): FloatArray {
        if (stripWidth <= 0 || lineCount <= 0) return FloatArray(0)
        val xs = FloatArray(lineCount)
        val span = stripWidth.toFloat()
        for (i in 0 until lineCount) {
            val t = (i + 0.5f) / lineCount.toFloat()
            xs[i] = startX + t * span
        }
        return xs
    }

    private fun buildReadLineSegments(
        readLineXs: FloatArray,
        dataStartY: Int,
        dataHeight: Int,
        convergencePx: Int
    ): List<Pair<PointF, PointF>> {
        if (readLineXs.isEmpty() || dataHeight <= 0) return emptyList()
        val anchorY = dataStartY + dataHeight - 1
        val centerX = readLineXs.average().toFloat()
        val centerY = anchorY + convergencePx.toFloat()
        val yTop = dataStartY.toFloat()
        val yBottom = anchorY.toFloat()
        val segments = ArrayList<Pair<PointF, PointF>>(readLineXs.size)
        for (anchorX in readLineXs) {
            val xTop = computeReadLineX(anchorX, yBottom, centerX, centerY, yTop)
            val xBottom = computeReadLineX(anchorX, yBottom, centerX, centerY, yBottom)
            segments.add(Pair(PointF(xTop, yTop), PointF(xBottom, yBottom)))
        }
        return segments
    }

    private fun computeReadLineX(
        anchorX: Float,
        anchorY: Float,
        centerX: Float,
        centerY: Float,
        y: Float
    ): Float {
        val denom = centerY - anchorY
        if (kotlin.math.abs(denom) < 1e-6f) return anchorX
        val t = (y - anchorY) / denom
        return anchorX + (centerX - anchorX) * t
    }

    private fun estimateLineSpacing(lineXs: FloatArray): Int? {
        if (lineXs.size < 2) return null
        val spacing = lineXs[1] - lineXs[0]
        return kotlin.math.abs(spacing).roundToInt().coerceAtLeast(1)
    }

    private fun buildSectionResult(
        perColumnBits: Array<IntArray>,
        perColumnValid: BooleanArray,
        sections: Int,
        orderWindow: Int,
        bitWidthPx: Int? = null
    ): SectionResult {
        val columnCount = perColumnBits.size

        val sb = StringBuilder()
        for (sectionIdx in 0 until sections) {
            for (col in 0 until columnCount) {
                sb.append(perColumnBits[col][sectionIdx])
                if (col < columnCount - 1) sb.append("  ")
            }
            if (sectionIdx < sections - 1) sb.append('\n')
        }

        val anglesLine = StringBuilder()
        val valueCounts = HashMap<Int, Int>()
        var commonGray: Int? = null
        var commonBits = ""
        var commonOrder: Int? = null
        var commonAngle: Float? = null
        var commonCount = -1
        var sumSin = 0.0
        var sumCos = 0.0
        var angleCount = 0

        val lookup = grayPositionMapsLoaded[sections]
        val totalPositions = 1 shl sections

        val filteredValid = BooleanArray(columnCount)
        val orders = ArrayList<Int>()
        for (col in 0 until columnCount) {
            if (!perColumnValid.getOrNull(col).orFalse()) continue
            val grayInt = bitsToIntLSBFirst(perColumnBits[col], sections)
            val order = lookup?.getOrNull(grayInt)
            if (order != null) orders.add(order)
        }

        if (orderWindow > 0 && lookup != null && orders.isNotEmpty()) {
            val centerOrder = circularMedian(orders, totalPositions)
            for (col in 0 until columnCount) {
                if (!perColumnValid.getOrNull(col).orFalse()) continue
                val grayInt = bitsToIntLSBFirst(perColumnBits[col], sections)
                val order = lookup.getOrNull(grayInt) ?: continue
                val dist = circularDistance(order, centerOrder, totalPositions)
                if (dist <= orderWindow) {
                    filteredValid[col] = true
                }
            }
            val kept = filteredValid.count { it }
            val minRequired = max(1, orderWindow * 2 + 1)
            if (kept < minRequired) {
                val message = "not enough samples (have $kept, need $minRequired)"
                return SectionResult(message, "", null, "", null, null, bitWidthPx)
            }
        } else {
            for (col in 0 until columnCount) {
                filteredValid[col] = perColumnValid.getOrNull(col).orFalse()
            }
        }

        for (col in 0 until columnCount) {
            val isValid = filteredValid[col]
            if (isValid) {
                val grayInt = bitsToIntLSBFirst(perColumnBits[col], sections)
                val deg = lookup?.getOrNull(grayInt)?.let { (it.toFloat() / totalPositions.toFloat()) * 360f }
                if (deg != null) {
                    anglesLine.append(String.format("%.1f", deg))
                    val rad = Math.toRadians(deg.toDouble())
                    sumSin += kotlin.math.sin(rad)
                    sumCos += kotlin.math.cos(rad)
                    angleCount++
                } else {
                    anglesLine.append(grayInt.toString())
                }

                val newCount = (valueCounts[grayInt] ?: 0) + 1
                valueCounts[grayInt] = newCount

                if (newCount > commonCount) {
                    commonCount = newCount
                    commonGray = grayInt
                    commonBits = grayInt.toString(2).padStart(sections, '0')
                    commonOrder = lookup?.getOrNull(grayInt)
                    commonAngle = commonOrder?.let { (it.toFloat() / totalPositions.toFloat()) * 360f }
                }
            } else {
                anglesLine.append("--")
            }
            if (col < columnCount - 1) anglesLine.append("  ")
        }

        if (angleCount > 0) {
            val meanRad = kotlin.math.atan2(sumSin, sumCos)
            var meanDeg = Math.toDegrees(meanRad).toFloat()
            if (meanDeg < 0f) meanDeg += 360f
            commonAngle = meanDeg
        }

        return SectionResult(
            bitsText = sb.toString(),
            anglesText = anglesLine.toString(),
            commonValue = commonGray,
            commonBits = commonBits,
            commonOrder = commonOrder,
            commonAngle = commonAngle,
            bitWidthPx = bitWidthPx
        )
    }

    private fun circularDistance(a: Int, b: Int, mod: Int): Int {
        val diff = abs(a - b) % mod
        return min(diff, mod - diff)
    }

    private fun circularMedian(values: List<Int>, mod: Int): Int {
        if (values.isEmpty()) return 0
        var bestValue = values[0]
        var bestScore = Int.MAX_VALUE
        val candidates = values.distinct()
        for (candidate in candidates) {
            var score = 0
            for (v in values) {
                score += circularDistance(v, candidate, mod)
            }
            if (score < bestScore) {
                bestScore = score
                bestValue = candidate
            }
        }
        return bestValue
    }

    private fun formatIndexLabel(
        commonBits: String,
        commonValue: Int?,
        commonOrder: Int?,
        commonAngle: Float?,
        bitWidthPx: Int?
    ): String {
        val bitsText = if (commonBits.isNotEmpty()) commonBits else "--"
        val valueText = commonValue?.toString() ?: "--"
        val orderText = commonOrder?.toString() ?: "--"
        val angleText = commonAngle?.let { String.format("%.1f", it) } ?: "--"
        val bitWidthText = bitWidthPx?.toString() ?: "--"
        return if (showAngleDetails) {
            "angle: $angleText\nbits: $bitsText  common: $valueText  order: $orderText\nbitwidth: $bitWidthText"
        } else {
            "angle: $angleText"
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

    private fun Boolean?.orFalse(): Boolean {
        return this ?: false
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
                if (trimmed[i] >= 1) ones++
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
