package com.example.multiupcreader

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.util.Size
import android.widget.Button
import android.widget.ImageView
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {
    private lateinit var previewView: PreviewView
    private lateinit var overlayView: OverlayView
    private lateinit var resultText: TextView
    private lateinit var statusText: TextView
    private lateinit var centerRowBitsView: TextView
    private lateinit var compressedBitsView: TextView
    private lateinit var compressedUpcView: TextView
    private lateinit var compressedRowsView: TextView
    private lateinit var rowUpcsView: TextView
    private lateinit var rowUpcsCommonView: TextView
    private lateinit var stillImageView: ImageView
    private lateinit var thresholdValue: TextView
    private lateinit var rowsValue: TextView
    private lateinit var roiWidthValue: TextView
    private lateinit var roiHeightValue: TextView
    private lateinit var nonwhiteValue: TextView
    private lateinit var minRowsValue: TextView
    private lateinit var maxRowsValue: TextView

    private val cameraExecutor = Executors.newSingleThreadExecutor()

    @Volatile private var rowsToScan = 25
    @Volatile private var adaptiveThreshold = true
    @Volatile private var thresholdBias = 0
    @Volatile private var roiWidthFrac = 0.7f
    @Volatile private var roiHeightFrac = 0.35f
    @Volatile private var nonwhiteThreshold = 200
    @Volatile private var minRows = 6
    @Volatile private var maxRows = 40
    @Volatile private var showGreenOverlay = true
    @Volatile private var lastUiUpdateMs = 0L
    @Volatile private var frameCounter = 0

    private val pickImage =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri == null) return@registerForActivityResult
            val input = contentResolver.openInputStream(uri) ?: return@registerForActivityResult
            val bitmap = BitmapFactory.decodeStream(input)
            input.close()
            if (bitmap != null) {
                processStillImage(bitmap)
            }
        }

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) startCamera()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        previewView = findViewById(R.id.previewView)
        overlayView = findViewById(R.id.overlayView)
        resultText = findViewById(R.id.resultText)
        statusText = findViewById(R.id.statusText)
        centerRowBitsView = findViewById(R.id.centerRowBits)
        compressedBitsView = findViewById(R.id.compressedBits)
        compressedUpcView = findViewById(R.id.compressedUpc)
        compressedRowsView = findViewById(R.id.compressedRows)
        rowUpcsView = findViewById(R.id.rowUpcs)
        rowUpcsCommonView = findViewById(R.id.rowUpcsCommon)
        stillImageView = findViewById(R.id.stillImageView)
        thresholdValue = findViewById(R.id.thresholdValue)
        rowsValue = findViewById(R.id.rowsValue)
        roiWidthValue = findViewById(R.id.roiWidthValue)
        roiHeightValue = findViewById(R.id.roiHeightValue)
        nonwhiteValue = findViewById(R.id.nonwhiteValue)
        minRowsValue = findViewById(R.id.minRowsValue)
        maxRowsValue = findViewById(R.id.maxRowsValue)
        statusText.text = statusLine()

        val thresholdSeek = findViewById<SeekBar>(R.id.thresholdSeek)
        thresholdSeek.progress = 128
        thresholdValue.text = "128"
        thresholdSeek.setOnSeekBarChangeListener(simpleSeek { value ->
            thresholdBias = value - 128
            thresholdValue.text = value.toString()
        })

        val rowsSeek = findViewById<SeekBar>(R.id.rowsSeek)
        rowsSeek.progress = rowsToScan
        rowsValue.text = rowsToScan.toString()
        rowsSeek.setOnSeekBarChangeListener(simpleSeek { value ->
            rowsToScan = max(1, value)
            rowsValue.text = rowsToScan.toString()
        })

        val roiWidthSeek = findViewById<SeekBar>(R.id.roiWidthSeek)
        roiWidthSeek.progress = (roiWidthFrac * 100).roundToInt()
        roiWidthValue.text = (roiWidthFrac * 100).roundToInt().toString()
        roiWidthSeek.setOnSeekBarChangeListener(simpleSeek { value ->
            roiWidthFrac = (max(10, value) / 100f).coerceIn(0.1f, 1.0f)
            roiWidthValue.text = (roiWidthFrac * 100).roundToInt().toString()
        })

        val roiHeightSeek = findViewById<SeekBar>(R.id.roiHeightSeek)
        roiHeightSeek.progress = (roiHeightFrac * 100).roundToInt()
        roiHeightValue.text = (roiHeightFrac * 100).roundToInt().toString()
        roiHeightSeek.setOnSeekBarChangeListener(simpleSeek { value ->
            roiHeightFrac = (max(10, value) / 100f).coerceIn(0.1f, 1.0f)
            roiHeightValue.text = (roiHeightFrac * 100).roundToInt().toString()
        })

        val adaptiveSwitch = findViewById<Switch>(R.id.adaptiveSwitch)
        adaptiveSwitch.isChecked = adaptiveThreshold
        adaptiveSwitch.setOnCheckedChangeListener { _, isChecked ->
            adaptiveThreshold = isChecked
        }

        val nonwhiteSeek = findViewById<SeekBar>(R.id.nonwhiteSeek)
        nonwhiteSeek.progress = nonwhiteThreshold
        nonwhiteValue.text = nonwhiteThreshold.toString()
        nonwhiteSeek.setOnSeekBarChangeListener(simpleSeek { value ->
            nonwhiteThreshold = value
            nonwhiteValue.text = value.toString()
        })

        val minRowsSeek = findViewById<SeekBar>(R.id.minRowsSeek)
        minRowsSeek.progress = minRows
        minRowsValue.text = minRows.toString()
        minRowsSeek.setOnSeekBarChangeListener(simpleSeek { value ->
            minRows = max(1, value)
            minRowsValue.text = minRows.toString()
        })

        val maxRowsSeek = findViewById<SeekBar>(R.id.maxRowsSeek)
        maxRowsSeek.progress = maxRows
        maxRowsValue.text = maxRows.toString()
        maxRowsSeek.setOnSeekBarChangeListener(simpleSeek { value ->
            maxRows = max(1, value)
            maxRowsValue.text = maxRows.toString()
        })

        val greenSwitch = findViewById<Switch>(R.id.greenOverlaySwitch)
        greenSwitch.isChecked = showGreenOverlay
        greenSwitch.setOnCheckedChangeListener { _, isChecked ->
            showGreenOverlay = isChecked
        }

        findViewById<Button>(R.id.pickImageBtn).setOnClickListener {
            pickImage.launch("image/*")
        }

        findViewById<Button>(R.id.copyCenterRowBtn).setOnClickListener {
            copyToClipboard(centerRowBitsView.text.toString())
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            requestPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder()
                .build()
                .also { it.setSurfaceProvider(previewView.surfaceProvider) }

            val analyzer = ImageAnalysis.Builder()
                .setTargetResolution(Size(1280, 720))
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()

            analyzer.setAnalyzer(cameraExecutor) { imageProxy ->
                processFrame(imageProxy)
            }

            val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

            cameraProvider.unbindAll()
            cameraProvider.bindToLifecycle(this, cameraSelector, preview, analyzer)
        }, ContextCompat.getMainExecutor(this))
    }

    private fun processFrame(image: ImageProxy) {
        frameCounter += 1
        val yPlane = image.planes[0]
        val buffer = yPlane.buffer
        val data = ByteArray(buffer.remaining())
        buffer.get(data)

        val width = image.width
        val height = image.height
        val rowStride = yPlane.rowStride
        val pixelStride = yPlane.pixelStride
        val rotation = image.imageInfo.rotationDegrees

        val uprightWidth = if (rotation == 90 || rotation == 270) height else width
        val uprightHeight = if (rotation == 90 || rotation == 270) width else height

        val roiW = max(1, (uprightWidth * roiWidthFrac).roundToInt())
        val roiH = max(1, (uprightHeight * roiHeightFrac).roundToInt())
        val roiX = (uprightWidth - roiW) / 2
        val roiY = (uprightHeight - roiH) / 2

        val centerY = roiY + roiH / 2
        val half = rowsToScan / 2
        val yStart = max(roiY, centerY - half)
        val yEnd = min(roiY + roiH - 1, centerY + half)

        val counts = HashMap<String, Int>()

        for (y in yStart..yEnd) {
            val rowBits = getRowBitsAtY(
                data, width, height, rowStride, pixelStride, rotation, y, roiX, roiW
            )
            val decoded = decodeRowBits(rowBits)
            if (decoded != null) {
                counts[decoded] = (counts[decoded] ?: 0) + 1
            }
        }

        val best = counts.maxByOrNull { it.value }?.key
        val centerBits = getRowBitsAtY(
            data, width, height, rowStride, pixelStride, rotation, centerY, roiX, roiW
        )
        val centerBitsStr = bitsToString(centerBits)
        val compressed = compressBits(centerBitsStr)
        val compressedUpc = decodeUpcFromBitString(compressed)

        val now = System.currentTimeMillis()
        val shouldUpdateHeavy = (frameCounter % 5 == 0) && (now - lastUiUpdateMs > 200)
        val compressedRows = if (shouldUpdateHeavy) {
            buildCompressedRowsText(
                data, width, height, rowStride, pixelStride, rotation, roiX, roiW, yStart, yEnd
            )
        } else null
        val rowUpcs = if (shouldUpdateHeavy) {
            buildRowUpcsText(
                data, width, height, rowStride, pixelStride, rotation, roiX, roiW, yStart, yEnd
            )
        } else null

        runOnUiThread {
            val count = if (best != null) counts[best] ?: 0 else 0
            resultText.text = if (best != null) "$best ($count/$rowsToScan)" else "-"
            statusText.text = statusLine(rotation)
            centerRowBitsView.text = centerBitsStr
            compressedBitsView.text = compressed
            compressedUpcView.text = "UPC: ${compressedUpc ?: "-"}"
            if (compressedRows != null && rowUpcs != null) {
                compressedRowsView.text = compressedRows
                rowUpcsView.text = rowUpcs.lines
                rowUpcsCommonView.text = rowUpcs.summary
                lastUiUpdateMs = now
            }
            overlayView.updateRoi(
                roiX, roiY, roiW, roiH, centerY, uprightWidth, uprightHeight
            )
        }

        image.close()
    }

    private fun getRowBitsAtY(
        luma: ByteArray,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
        rotation: Int,
        y: Int,
        xStart: Int,
        roiWidth: Int
    ): IntArray {
        var threshold = 128 + thresholdBias
        if (adaptiveThreshold) {
            var sum = 0
            for (x in xStart until xStart + roiWidth) {
                val v = sampleLuma(luma, width, height, rowStride, pixelStride, rotation, x, y)
                sum += v
            }
            val mean = sum.toFloat() / roiWidth
            threshold = (mean + thresholdBias).roundToInt().coerceIn(0, 255)
        }

        val bits = IntArray(roiWidth)
        var idx = 0
        for (x in xStart until xStart + roiWidth) {
            val v = sampleLuma(luma, width, height, rowStride, pixelStride, rotation, x, y)
            bits[idx] = if (v < threshold) 1 else 0
            idx++
        }
        return bits
    }

    private fun sampleLuma(
        luma: ByteArray,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
        rotation: Int,
        ux: Int,
        uy: Int
    ): Int {
        val (bx, by) = when (rotation) {
            90 -> Pair(uy, height - 1 - ux)
            180 -> Pair(width - 1 - ux, height - 1 - uy)
            270 -> Pair(width - 1 - uy, ux)
            else -> Pair(ux, uy)
        }
        val index = by * rowStride + bx * pixelStride
        return luma[index].toInt() and 0xFF
    }

    private fun decodeRowBits(bits: IntArray): String? {
        if (bits.isEmpty()) return null
        val compressed = compressBits(bitsToString(bits))
        return decodeUpcFromBitString(compressed)
    }

    private fun compressBits(bits: String): String {
        if (bits.isEmpty()) return ""
        val runs = ArrayList<Pair<Char, Int>>()
        var current = bits[0]
        var len = 1
        for (i in 1 until bits.length) {
            if (bits[i] == current) {
                len++
            } else {
                runs.add(current to len)
                current = bits[i]
                len = 1
            }
        }
        runs.add(current to len)

        val zeroRuns = runs.filter { it.first == '0' }.map { it.second }
        if (zeroRuns.isEmpty()) return bits
        val minZero = max(1, zeroRuns.minOrNull() ?: 1)

        val out = StringBuilder()
        for ((bit, runLen) in runs) {
            val count = max(1, (runLen.toFloat() / minZero).roundToInt())
            repeat(count) { out.append(bit) }
        }
        return out.toString()
    }

    private fun decodeUpcFromBitString(bitString: String): String? {
        if (bitString.isEmpty()) return null
        for (i in 0..bitString.length - 95) {
            val window = bitString.substring(i, i + 95)
            val decoded = decodeUpcFromModules(window)
            if (decoded != null) return decoded
        }
        return null
    }

    private fun decodeUpcFromModules(bits: String): String? {
        if (bits.length != 95) return null
        val start = bits.substring(0, 3)
        val middle = bits.substring(45, 50)
        val end = bits.substring(92, 95)
        if (start != "101" || middle != "01010" || end != "101") return null

        val lCodes = mapOf(
            "0001101" to '0',
            "0011001" to '1',
            "0010011" to '2',
            "0111101" to '3',
            "0100011" to '4',
            "0110001" to '5',
            "0101111" to '6',
            "0111011" to '7',
            "0110111" to '8',
            "0001011" to '9'
        )
        val rCodes = mapOf(
            "1110010" to '0',
            "1100110" to '1',
            "1101100" to '2',
            "1000010" to '3',
            "1011100" to '4',
            "1001110" to '5',
            "1010000" to '6',
            "1000100" to '7',
            "1001000" to '8',
            "1110100" to '9'
        )

        val out = StringBuilder()
        for (i in 0 until 6) {
            val seg = bits.substring(3 + i * 7, 3 + (i + 1) * 7)
            val d = lCodes[seg] ?: return null
            out.append(d)
        }
        for (i in 0 until 6) {
            val seg = bits.substring(50 + i * 7, 50 + (i + 1) * 7)
            val d = rCodes[seg] ?: return null
            out.append(d)
        }

        val nums = out.map { it - '0' }
        val oddSum = nums[0] + nums[2] + nums[4] + nums[6] + nums[8] + nums[10]
        val evenSum = nums[1] + nums[3] + nums[5] + nums[7] + nums[9] + nums[11]
        val checksum = (oddSum * 3 + evenSum) % 10
        if (checksum != 0) return null
        return out.toString()
    }

    private fun statusLine(rotation: Int? = null): String {
        val rot = rotation?.let { " | Rot: $it" } ?: ""
        val w = (roiWidthFrac * 100).roundToInt()
        val h = (roiHeightFrac * 100).roundToInt()
        return "Rows: $rowsToScan | Adaptive: ${if (adaptiveThreshold) "On" else "Off"} | ROI: $w% x $h%$rot"
    }

    private fun simpleSeek(onChange: (Int) -> Unit): SeekBar.OnSeekBarChangeListener {
        return object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                onChange(progress)
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        }
    }

    private fun bitsToString(bits: IntArray): String {
        val sb = StringBuilder(bits.size)
        for (b in bits) sb.append(if (b == 1) '1' else '0')
        return sb.toString()
    }

    private fun buildCompressedRowsText(
        luma: ByteArray,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
        rotation: Int,
        xStart: Int,
        roiWidth: Int,
        yStart: Int,
        yEnd: Int
    ): String {
        val lines = ArrayList<String>()
        for (y in yStart..yEnd) {
            val bits = getRowBitsAtY(luma, width, height, rowStride, pixelStride, rotation, y, xStart, roiWidth)
            lines.add(compressBits(bitsToString(bits)))
        }
        return lines.joinToString("\n")
    }

    private data class RowUpcResult(val lines: String, val summary: String)

    private fun buildRowUpcsText(
        luma: ByteArray,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
        rotation: Int,
        xStart: Int,
        roiWidth: Int,
        yStart: Int,
        yEnd: Int
    ): RowUpcResult {
        val lines = ArrayList<String>()
        val counts = HashMap<String, Int>()
        var total = 0
        for (y in yStart..yEnd) {
            val bits = getRowBitsAtY(luma, width, height, rowStride, pixelStride, rotation, y, xStart, roiWidth)
            val decoded = decodeRowBits(bits)
            val value = decoded ?: "-"
            lines.add(value)
            total++
            if (decoded != null) {
                counts[decoded] = (counts[decoded] ?: 0) + 1
            }
        }

        val best = counts.maxByOrNull { it.value }
        val summary = if (best != null) {
            "Most common: ${best.key} (${best.value}/$total)"
        } else {
            "Most common: -"
        }
        return RowUpcResult(lines.joinToString("\n"), summary)
    }

    private fun processStillImage(bitmap: Bitmap) {
        val src = bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val width = src.width
        val height = src.height

        val roiW = max(1, (width * roiWidthFrac).roundToInt())
        val roiH = max(1, (height * roiHeightFrac).roundToInt())
        val roiX = (width - roiW) / 2
        val roiY = (height - roiH) / 2

        val centerY = roiY + roiH / 2
        val half = rowsToScan / 2
        val yStart = max(roiY, centerY - half)
        val yEnd = min(roiY + roiH - 1, centerY + half)

        if (showGreenOverlay) {
            applyGreenOverlay(src, nonwhiteThreshold, minRows, maxRows)
        }

        val centerBits = getRowBitsAtYBitmap(src, centerY, roiX, roiW)
        val centerBitsStr = bitsToString(centerBits)
        val compressed = compressBits(centerBitsStr)
        val compressedUpc = decodeUpcFromBitString(compressed)
        val compressedRows = buildCompressedRowsTextBitmap(src, roiX, roiW, yStart, yEnd)
        val rowUpcs = buildRowUpcsTextBitmap(src, roiX, roiW, yStart, yEnd)

        val barcode = detectBarcodeRowBitmap(src, roiX, roiW, roiY, roiH)
        if (barcode != null) {
            val canvas = Canvas(src)
            val paint = Paint().apply {
                color = Color.GREEN
                style = Paint.Style.STROKE
                strokeWidth = 4f
            }
            val rectW = max(1, barcode.xEnd - barcode.xStart)
            canvas.drawRect(
                (roiX + barcode.xStart).toFloat(),
                (barcode.y - 20).toFloat(),
                (roiX + barcode.xStart + rectW).toFloat(),
                (barcode.y + 20).toFloat(),
                paint
            )
        }

        stillImageView.setImageBitmap(src)

        centerRowBitsView.text = centerBitsStr
        compressedBitsView.text = compressed
        compressedUpcView.text = "UPC: ${compressedUpc ?: "-"}"
        compressedRowsView.text = compressedRows
        rowUpcsView.text = rowUpcs.lines
        rowUpcsCommonView.text = rowUpcs.summary
    }

    private data class BarcodeHit(val value: String, val xStart: Int, val xEnd: Int, val y: Int)

    private fun detectBarcodeRowBitmap(
        bitmap: Bitmap,
        xStart: Int,
        roiWidth: Int,
        roiY: Int,
        roiH: Int
    ): BarcodeHit? {
        val y = roiY + roiH / 2
        val bits = getRowBitsAtYBitmap(bitmap, y, xStart, roiWidth)
        val bitString = bitsToString(bits)
        val compressed = compressBits(bitString)
        val decoded = decodeUpcFromBitString(compressed) ?: return null
        val startIdx = compressed.indexOf("101")
        val xs = if (startIdx >= 0) startIdx else 0
        val xe = xs + 95
        return BarcodeHit(decoded, xs, xe, y)
    }

    private fun getRowBitsAtYBitmap(bitmap: Bitmap, y: Int, xStart: Int, roiWidth: Int): IntArray {
        val width = bitmap.width
        val rowPixels = IntArray(width)
        bitmap.getPixels(rowPixels, 0, width, 0, y, width, 1)

        var threshold = 128 + thresholdBias
        if (adaptiveThreshold) {
            var sum = 0
            for (x in xStart until xStart + roiWidth) {
                val c = rowPixels[x]
                val g = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000
                sum += g
            }
            val mean = sum.toFloat() / roiWidth
            threshold = (mean + thresholdBias).roundToInt().coerceIn(0, 255)
        }

        val bits = IntArray(roiWidth)
        var idx = 0
        for (x in xStart until xStart + roiWidth) {
            val c = rowPixels[x]
            val g = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000
            bits[idx] = if (g < threshold) 1 else 0
            idx++
        }
        return bits
    }

    private fun buildCompressedRowsTextBitmap(
        bitmap: Bitmap,
        xStart: Int,
        roiWidth: Int,
        yStart: Int,
        yEnd: Int
    ): String {
        val lines = ArrayList<String>()
        for (y in yStart..yEnd) {
            val bits = getRowBitsAtYBitmap(bitmap, y, xStart, roiWidth)
            lines.add(compressBits(bitsToString(bits)))
        }
        return lines.joinToString("\n")
    }

    private fun buildRowUpcsTextBitmap(
        bitmap: Bitmap,
        xStart: Int,
        roiWidth: Int,
        yStart: Int,
        yEnd: Int
    ): RowUpcResult {
        val lines = ArrayList<String>()
        val counts = HashMap<String, Int>()
        var total = 0
        for (y in yStart..yEnd) {
            val bits = getRowBitsAtYBitmap(bitmap, y, xStart, roiWidth)
            val decoded = decodeRowBits(bits)
            val value = decoded ?: "-"
            lines.add(value)
            total++
            if (decoded != null) {
                counts[decoded] = (counts[decoded] ?: 0) + 1
            }
        }
        val best = counts.maxByOrNull { it.value }
        val summary = if (best != null) {
            "Most common: ${best.key} (${best.value}/$total)"
        } else {
            "Most common: -"
        }
        return RowUpcResult(lines.joinToString("\n"), summary)
    }

    private fun applyGreenOverlay(
        bitmap: Bitmap,
        threshold: Int,
        minRows: Int,
        maxRows: Int
    ) {
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        val alpha = 120
        for (x in 0 until width) {
            var runStart = -1
            var runLen = 0
            for (y in 0 until height) {
                val idx = y * width + x
                val c = pixels[idx]
                val g = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000
                if (g <= threshold) {
                    if (runLen == 0) runStart = y
                    runLen++
                } else {
                    if (runLen in minRows..maxRows) {
                        for (yy in runStart until runStart + runLen) {
                            val k = yy * width + x
                            pixels[k] = blendGreen(pixels[k], alpha)
                        }
                    }
                    runLen = 0
                    runStart = -1
                }
            }
            if (runLen in minRows..maxRows) {
                for (yy in runStart until runStart + runLen) {
                    val k = yy * width + x
                    pixels[k] = blendGreen(pixels[k], alpha)
                }
            }
        }

        bitmap.setPixels(pixels, 0, width, 0, 0, width, height)
    }

    private fun blendGreen(src: Int, alpha: Int): Int {
        val srcR = Color.red(src)
        val srcG = Color.green(src)
        val srcB = Color.blue(src)
        val a = alpha / 255f
        val r = (srcR * (1 - a) + 0 * a).roundToInt()
        val g = (srcG * (1 - a) + 255 * a).roundToInt()
        val b = (srcB * (1 - a) + 0 * a).roundToInt()
        return Color.argb(255, r, g, b)
    }

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("UPC", text)
        clipboard.setPrimaryClip(clip)
    }
}
