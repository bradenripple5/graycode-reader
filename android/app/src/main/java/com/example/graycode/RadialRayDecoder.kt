package com.example.graycode


/**
 * Radial-ray decoder for your generated “Radial Binary Pattern” disk.
 *
 * What it does:
 *  1) Finds radiating gridlines ("rays") by scanning edge-energy around a circle at rGrid.
 *  2) Builds a uniform ray list using constant Δθ (median spacing).
 *  3) Samples along each ray at each band radius to produce S bits (your "Number of bands").
 *  4) Converts bits -> grayInt (LSB-first to match your existing bitsToIntLSBFirst).
 *  5) Majority votes across rays to produce the most common grayInt for the frame.
 *
 * Intended usage inside your analyzer:
 *   val cx = imageWidth / 2f
 *   val cy = imageHeight / 2f
 *   val lookup = grayPositionMapsLoaded[sections]
 *   val bestGray = decodeFrameByRays(
 *       cx, cy,
 *       rInner = ...,
 *       rOuter = ...,
 *       sections = sections,
 *       imageWidth = imageWidth,
 *       imageHeight = imageHeight,
 *       yBuffer = yBuffer,
 *       yRowStride = yRowStride,
 *       yPixelStride = yPixelStride,
 *       threshold = threshold,
 *       lookup = lookup
 *   )
 *
 * You still need rInner/rOuter. Quick ways:
 *  - If disk is centered + scale is stable: hardcode radii in px relative to your overlay.
 *  - Better: estimate rInner/rOuter using your red rings (radial scan + first/last red).
 */
object RadialRayDecoder {

    // --------------------------- Public entry point ---------------------------

    fun decodeFrameByRays(
        cx: Float,
        cy: Float,
        rInner: Float,
        rOuter: Float,
        sections: Int, // number of radial bands (bits)
        imageWidth: Int,
        imageHeight: Int,
        yBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        threshold: Int,
        lookup: IntArray?,               // grayInt -> order mapping (your loaded JSON)
        // Tuning:
        scoreSamples: Int = 2048,        // angular samples when finding rays
        edgeDeltaRad: Float = 0.0025f,   // ~0.14 degrees
        minPeak: Int = 25,               // edge score threshold for peak picking
        suppression: Int = 6,            // non-max suppression window (in sample bins)
        radialJitter: Int = 1,           // sample +- px in radius when reading bits
        angularJitter: Float = 0.0015f   // sample +- rad when reading bits
    ): DecodeResult? {
        if (lookup == null) return null
        if (sections <= 0) return null
        if (rOuter <= rInner) return null

        // band radii (center of each radial band)
        val dr = (rOuter - rInner) / sections.toFloat()
        val rBands = FloatArray(sections) { i -> rInner + (i + 0.5f) * dr }

        // choose a radius where the radiating gridlines are visible (mid-annulus is a good start)
        val rGrid = (rInner + rOuter) * 0.5f

        // 1) detect peaks = candidate gridlines
        val peakThetas = findRayAngles(
            cx, cy, rGrid,
            imageWidth, imageHeight,
            yBuffer, yRowStride, yPixelStride,
            samples = scoreSamples,
            delta = edgeDeltaRad,
            minPeak = minPeak,
            suppression = suppression
        )

        // 2) fit uniform Δθ stepping from peaks
        val uniform = buildUniformRaysFromPeaks(peakThetas) ?: return null
        val rays = uniform.rays
        val dTheta = uniform.dTheta

        // 3) read bits along rays and vote for the most common grayInt
        val counts = HashMap<Int, Int>(rays.size * 2)
        var bestGray: Int? = null
        var bestCount = 0

        for (theta in rays) {
            val bits = readBitsOnRay(
                cx, cy, theta, rBands,
                imageWidth, imageHeight,
                yBuffer, yRowStride, yPixelStride,
                threshold,
                radialJitter = radialJitter,
                angularJitter = angularJitter
            )
            val grayInt = bitsToIntLSBFirst(bits, sections)
            val newCount = (counts[grayInt] ?: 0) + 1
            counts[grayInt] = newCount
            if (newCount > bestCount) {
                bestCount = newCount
                bestGray = grayInt
            }
        }

        if (bestGray == null) return null

        val totalPositions = 1 shl sections
        val order = lookup.getOrNull(bestGray!!)
        val angleDeg = order?.let { (it.toFloat() / totalPositions.toFloat()) * 360f }

        return DecodeResult(
            bestGray = bestGray!!,
            bestBits = bestGray!!.toString(2).padStart(sections, '0'),
            bestOrder = order,
            bestAngleDeg = angleDeg,
            rayCount = rays.size,
            dThetaRad = dTheta,
            peakCount = peakThetas.size
        )
    }

    data class DecodeResult(
        val bestGray: Int,
        val bestBits: String,
        val bestOrder: Int?,
        val bestAngleDeg: Float?,
        val rayCount: Int,
        val dThetaRad: Float,
        val peakCount: Int
    )

    // --------------------------- Finding ray angles ---------------------------

    /**
     * Compute edge score on a circle at radius rGrid:
     * score(θ) ~ |I(θ+δ) - I(θ-δ)|
     * Peaks correspond to radiating gridlines that create strong tangential edges.
     */
    private fun findRayAngles(
        cx: Float,
        cy: Float,
        rGrid: Float,
        imageWidth: Int,
        imageHeight: Int,
        yBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        samples: Int = 2048,
        delta: Float = 0.0025f,
        minPeak: Int = 25,
        suppression: Int = 6
    ): List<Float> {
        if (samples < 64) return emptyList()
        val twoPi = (2.0 * Math.PI).toFloat()

        val scores = IntArray(samples)
        for (i in 0 until samples) {
            val theta = (i.toFloat() / samples.toFloat()) * twoPi
            scores[i] = edgeScoreAtTheta(
                cx, cy, rGrid,
                theta, delta,
                imageWidth, imageHeight,
                yBuffer, yRowStride, yPixelStride
            )
        }

        // Simple non-max peak pick with circular wrap
        val peaksIdx = ArrayList<Int>()
        for (i in 0 until samples) {
            val v = scores[i]
            if (v < minPeak) continue
            var isMax = true
            for (k in 1..suppression) {
                val a = scores[(i - k + samples) % samples]
                val b = scores[(i + k) % samples]
                if (a > v || b > v) { isMax = false; break }
            }
            if (isMax) peaksIdx.add(i)
        }

        return peaksIdx.map { idx ->
            (idx.toFloat() / samples.toFloat()) * twoPi
        }
    }

    private fun edgeScoreAtTheta(
        cx: Float,
        cy: Float,
        r: Float,
        theta: Float,
        delta: Float,
        imageWidth: Int,
        imageHeight: Int,
        yBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int
    ): Int {
        fun lumaAt(t: Float): Int {
            val x = (cx + r * kotlin.math.cos(t)).toInt()
            val y = (cy + r * kotlin.math.sin(t)).toInt()
            val xi = clampInt(x, 0, imageWidth - 1)
            val yi = clampInt(y, 0, imageHeight - 1)
            return sampleLuma(xi, yi, yBuffer, yRowStride, yPixelStride)
        }
        val a = lumaAt(theta - delta)
        val b = lumaAt(theta + delta)
        return kotlin.math.abs(b - a)
    }

    // --------------------------- Uniform ray list from peaks ---------------------------

    private data class UniformRays(val rays: List<Float>, val dTheta: Float)

    /**
     * Turn a set of detected peak angles into a constant-step ray list.
     * Uses median peak spacing as Δθ and generates rays = θ0 + k*Δθ.
     */
    private fun buildUniformRaysFromPeaks(peaks: List<Float>): UniformRays? {
        if (peaks.size < 8) return null
        val twoPi = (2.0 * Math.PI).toFloat()

        val sorted = peaks.map { normalizeAngle(it) }.sorted()

        // circular diffs
        val diffs = FloatArray(sorted.size)
        for (i in sorted.indices) {
            val a = sorted[i]
            val b = if (i == sorted.lastIndex) sorted[0] + twoPi else sorted[i + 1]
            diffs[i] = b - a
        }

        val dTheta = diffs.sortedArray()[diffs.size / 2] // median

        // sanity checks
        if (dTheta <= 1e-6f || dTheta > twoPi / 2f) return null

        val count = kotlin.math.round(twoPi / dTheta).toInt().coerceIn(1, 8192)

        // Use the first peak as the phase start (better: choose strongest peak if you store scores)
        val theta0 = sorted[0]

        val rays = ArrayList<Float>(count)
        for (k in 0 until count) {
            rays.add(normalizeAngle(theta0 + k * dTheta))
        }
        return UniformRays(rays, dTheta)
    }

    // --------------------------- Read bits along one ray ---------------------------

    /**
     * Reads bits along a ray at angle theta, sampling at radii rBands[i].
     * Uses majority vote over a small neighborhood in (radius, angle) to reduce jitter.
     *
     * Returns bits[0..sections-1] where bit 0 corresponds to rBands[0].
     * If you want MSB/LSB reversed, change bitsToIntLSBFirst() accordingly.
     */
    private fun readBitsOnRay(
        cx: Float,
        cy: Float,
        theta: Float,
        rBands: FloatArray,
        imageWidth: Int,
        imageHeight: Int,
        yBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int,
        threshold: Int,
        radialJitter: Int = 1,
        angularJitter: Float = 0.0015f
    ): IntArray {
        val bits = IntArray(rBands.size)
        for (i in rBands.indices) {
            var ones = 0
            var total = 0

            for (dr in -radialJitter..radialJitter) {
                val r = rBands[i] + dr.toFloat()
                for (da in floatArrayOf(-angularJitter, 0f, angularJitter)) {
                    val t = theta + da
                    val x = (cx + r * kotlin.math.cos(t)).toInt()
                    val y = (cy + r * kotlin.math.sin(t)).toInt()
                    val xi = clampInt(x, 0, imageWidth - 1)
                    val yi = clampInt(y, 0, imageHeight - 1)

                    val luma = sampleLuma(xi, yi, yBuffer, yRowStride, yPixelStride)
                    if (luma >= threshold) ones++
                    total++
                }
            }

            bits[i] = if (ones * 2 >= total) 1 else 0
        }
        return bits
    }

    // --------------------------- Bit packing (LSB-first) ---------------------------

    /**
     * Interprets bits[0] as LSB, bits[count-1] as MSB.
     * This matches your earlier helper you posted (v = (v shl 1) or bits[i] from high->low).
     */
    private fun bitsToIntLSBFirst(bits: IntArray, count: Int): Int {
        var v = 0
        val n = kotlin.math.min(count, bits.size)
        for (i in n - 1 downTo 0) {
            v = (v shl 1) or (bits[i] and 1)
        }
        return v
    }

    // --------------------------- Low-level helpers ---------------------------

    private fun sampleLuma(
        x: Int,
        y: Int,
        yBuffer: java.nio.ByteBuffer,
        yRowStride: Int,
        yPixelStride: Int
    ): Int {
        val idx = y * yRowStride + x * yPixelStride
        return yBuffer.get(idx).toInt() and 0xFF
    }

    private fun clampInt(v: Int, lo: Int, hi: Int): Int =
        when {
            v < lo -> lo
            v > hi -> hi
            else -> v
        }

    private fun normalizeAngle(theta: Float): Float {
        val twoPi = (2.0 * Math.PI).toFloat()
        var t = theta % twoPi
        if (t < 0f) t += twoPi
        return t
    }
}
