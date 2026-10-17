package com.liquidchat.meetings

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.File
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Decodes any audio (or video's audio track) the platform supports into 16 kHz mono PCM16
 * WAV segments shaped like the recorder's, so the meeting pipeline transcribes them unchanged.
 * Streams buffer by buffer: memory stays flat for hour-long files.
 */
class AudioFileImporter(
    private val context: Context,
    private val uri: Uri,
    private val dir: String,
    private val segmentSec: Int,
    private val startIndex: Int,
) {
    data class Segment(
        val index: Int,
        val path: String,
        val startMs: Long,
        val durationMs: Long,
        val speechRatio: Double,
        val meanDb: Double,
    )

    @Volatile var cancelled = false

    fun run(onProgress: (decodedMs: Long, totalMs: Long) -> Unit): Pair<List<Segment>, Long> {
        val extractor = MediaExtractor()
        extractor.setDataSource(context, uri, null)
        val track = (0 until extractor.trackCount).firstOrNull {
            extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: run {
            extractor.release()
            throw IllegalArgumentException("No audio track found in this file")
        }
        extractor.selectTrack(track)
        val inFormat = extractor.getTrackFormat(track)
        val mime = inFormat.getString(MediaFormat.KEY_MIME)!!
        val totalMs = if (inFormat.containsKey(MediaFormat.KEY_DURATION))
            inFormat.getLong(MediaFormat.KEY_DURATION) / 1000 else 0L

        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(inFormat, null, null, 0)
        codec.start()

        File(dir).mkdirs()
        val out = SegmentSink(dir, segmentSec, startIndex)
        val resampler = Resampler(TARGET_RATE)
        var channels = inFormat.safeInt(MediaFormat.KEY_CHANNEL_COUNT, 1)
        var rate = inFormat.safeInt(MediaFormat.KEY_SAMPLE_RATE, TARGET_RATE)
        var floatPcm = false
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var lastReport = 0L

        try {
            while (!cancelled) {
                if (!inputDone) {
                    val inIdx = codec.dequeueInputBuffer(10_000)
                    if (inIdx >= 0) {
                        val buf = codec.getInputBuffer(inIdx)!!
                        val n = extractor.readSampleData(buf, 0)
                        if (n < 0) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            codec.queueInputBuffer(inIdx, 0, n, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }
                val outIdx = codec.dequeueOutputBuffer(info, 10_000)
                when {
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val f = codec.outputFormat
                        channels = f.safeInt(MediaFormat.KEY_CHANNEL_COUNT, channels)
                        rate = f.safeInt(MediaFormat.KEY_SAMPLE_RATE, rate)
                        floatPcm = f.safeInt(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT) ==
                            AudioFormat.ENCODING_PCM_FLOAT
                    }
                    outIdx >= 0 -> {
                        val buf = codec.getOutputBuffer(outIdx)!!
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        buf.order(ByteOrder.nativeOrder())
                        val frames = if (floatPcm) info.size / 4 / channels else info.size / 2 / channels
                        for (i in 0 until frames) {
                            var acc = 0f
                            for (c in 0 until channels) {
                                acc += if (floatPcm) buf.float else buf.short / 32768f
                            }
                            resampler.push(acc / channels, rate) { out.write(it) }
                        }
                        codec.releaseOutputBuffer(outIdx, false)
                        val decodedMs = out.totalSamples * 1000 / TARGET_RATE
                        if (decodedMs - lastReport >= 2000) {
                            lastReport = decodedMs
                            onProgress(decodedMs, totalMs)
                        }
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                    }
                }
            }
            if (cancelled) {
                out.abort()
                throw InterruptedException("Import cancelled")
            }
            out.finish()
            val decodedMs = out.totalSamples * 1000 / TARGET_RATE
            onProgress(decodedMs, max(totalMs, decodedMs))
            return out.segments to decodedMs
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
            runCatching { extractor.release() }
        }
    }

    private fun MediaFormat.safeInt(key: String, def: Int) =
        if (containsKey(key)) getInteger(key) else def

    /** Linear-interpolation resampler that keeps its phase across buffers. */
    private class Resampler(private val outRate: Int) {
        private var prev = 0f
        private var pos = 0.0 // position of next output sample, in input samples since `prev`
        private var primed = false

        fun push(sample: Float, inRate: Int, emit: (Float) -> Unit) {
            if (inRate == outRate) { emit(sample); return }
            if (!primed) { prev = sample; primed = true; return }
            val step = inRate.toDouble() / outRate
            while (pos <= 1.0) {
                emit((prev + (sample - prev) * pos).toFloat())
                pos += step
            }
            pos -= 1.0
            prev = sample
        }
    }

    /** Rotates WAV files every [segmentSec] and tracks per-segment speech stats. */
    private class SegmentSink(val dir: String, segmentSec: Int, var index: Int) {
        val segments = mutableListOf<Segment>()
        var totalSamples = 0L
        private val maxSamples = segmentSec * TARGET_RATE
        private val frame = ShortArray(FRAME)
        private var frameN = 0
        private var writer: WavSegmentWriter? = null
        private var segSamples = 0
        private var segStartSamples = 0L
        private var frames = 0
        private var speechFrames = 0
        private var dbSum = 0.0

        fun write(v: Float) {
            frame[frameN++] = (min(1f, max(-1f, v)) * 32767f).toInt().toShort()
            if (frameN == FRAME) flushFrame()
        }

        private fun flushFrame() {
            val w = writer ?: WavSegmentWriter(File(dir, "seg_%05d.wav".format(index)).absolutePath, TARGET_RATE)
                .also { writer = it; segStartSamples = totalSamples }
            w.write(frame, frameN)
            var sum = 0.0
            for (i in 0 until frameN) { val x = frame[i] / 32768.0; sum += x * x }
            val rms = sqrt(sum / frameN)
            val db = if (rms <= 1e-6) -120.0 else 20 * log10(rms)
            dbSum += db; frames++
            if (db > -48.0) speechFrames++
            segSamples += frameN
            totalSamples += frameN
            frameN = 0
            if (segSamples >= maxSamples) closeSegment()
        }

        private fun closeSegment() {
            val w = writer ?: return
            writer = null
            w.close()
            if (segSamples >= TARGET_RATE / 5) {
                segments += Segment(
                    index = index,
                    path = w.path,
                    startMs = segStartSamples * 1000 / TARGET_RATE,
                    durationMs = segSamples * 1000L / TARGET_RATE,
                    speechRatio = if (frames > 0) speechFrames.toDouble() / frames else 0.0,
                    meanDb = if (frames > 0) dbSum / frames else -120.0,
                )
                index++
            } else {
                File(w.path).delete()
            }
            segSamples = 0; frames = 0; speechFrames = 0; dbSum = 0.0
        }

        fun finish() {
            if (frameN > 0) flushFrame()
            closeSegment()
        }

        fun abort() {
            writer?.close()
            writer?.let { File(it.path).delete() }
            writer = null
            segments.forEach { File(it.path).delete() }
            segments.clear()
        }
    }

    companion object {
        const val TARGET_RATE = 16_000
        private const val FRAME = 320 // 20 ms
    }
}
