package com.liquidchat.meetings

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Long-form recorder for meetings.
 *
 * Captures 16 kHz mono PCM16 via AudioRecord and rotates it into WAV segments
 * sized for Whisper's 30 s window. Segment boundaries are placed in silence
 * (adaptive noise floor) between [minSegmentSec] and [maxSegmentSec] so words
 * are not cut in half. Each segment is a complete, valid WAV on disk; the
 * header of the in-flight segment is patched roughly once a second so a
 * process death loses at most ~1 s of audio.
 *
 * Process-wide singleton: the foreground service keeps the process alive, the
 * RN module observes it. Neither owns the capture thread.
 */
object MeetingRecorderEngine {
    private const val TAG = "MeetingRecorder"

    const val SAMPLE_RATE = 16000
    private const val FRAME_MS = 20
    private const val FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000 // 320
    private const val HEADER_PATCH_EVERY_FRAMES = 50 // ~1 s
    private const val LEVEL_EMIT_EVERY_FRAMES = 8 // ~160 ms
    private const val SILENCE_RUN_FRAMES_TO_CUT = 10 // 200 ms

    data class Config(
        val dir: String,
        val minSegmentSec: Double = 18.0,
        val maxSegmentSec: Double = 29.0,
        val startIndex: Int = 0,
        val startOffsetMs: Long = 0,
        val source: String = "voice_recognition",
    )

    data class Segment(
        val index: Int,
        val path: String,
        val startMs: Long, // on the meeting's audio timeline (pauses excluded)
        val durationMs: Long,
        val wallStartMs: Long,
        val speechRatio: Double,
        val meanDb: Double,
    )

    interface Listener {
        fun onSegment(segment: Segment) {}
        fun onLevel(db: Double, elapsedMs: Long, isSpeech: Boolean) {}
        fun onState(state: String, elapsedMs: Long) {}
        fun onError(message: String) {}
        fun onSilenced(silenced: Boolean) {}
    }

    @Volatile var state: String = "idle" // idle | recording | paused | stopping
        private set

    private val listeners = mutableSetOf<Listener>()
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var thread: Thread? = null
    @Volatile private var paused = false
    @Volatile private var stopRequested = false
    @Volatile private var config: Config? = null
    @Volatile private var elapsedMsAtomic: Long = 0
    @Volatile private var segmentCount = 0

    private var recordingCallback: Any? = null

    fun addListener(l: Listener) = synchronized(listeners) { listeners.add(l) }
    fun removeListener(l: Listener) = synchronized(listeners) { listeners.remove(l) }
    private fun each(block: (Listener) -> Unit) {
        val copy = synchronized(listeners) { listeners.toList() }
        main.post { copy.forEach { runCatching { block(it) } } }
    }

    val elapsedMs: Long get() = elapsedMsAtomic
    val segmentsWritten: Int get() = segmentCount
    val currentConfig: Config? get() = config

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(context: Context, cfg: Config) {
        if (state != "idle") throw IllegalStateException("Recorder already $state")
        File(cfg.dir).mkdirs()

        val source = when (cfg.source) {
            "mic" -> MediaRecorder.AudioSource.MIC
            "voice_communication" -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
            "camcorder" -> MediaRecorder.AudioSource.CAMCORDER
            else -> MediaRecorder.AudioSource.VOICE_RECOGNITION
        }
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) throw IllegalStateException("16 kHz mono PCM16 capture not supported")
        val record = AudioRecord(
            source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, max(minBuf, SAMPLE_RATE) // >= 0.5 s buffer
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("AudioRecord failed to initialize (mic in use?)")
        }

        config = cfg
        paused = false
        stopRequested = false
        elapsedMsAtomic = cfg.startOffsetMs
        segmentCount = 0
        state = "recording"
        registerSilenceCallback(context, record)

        thread = Thread({ captureLoop(context, record, cfg) }, "MeetingRecorder").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
        each { it.onState("recording", elapsedMsAtomic) }
    }

    fun pause() {
        if (state == "recording") {
            paused = true
            state = "paused"
            each { it.onState("paused", elapsedMsAtomic) }
        }
    }

    fun resume() {
        if (state == "paused") {
            paused = false
            state = "recording"
            each { it.onState("recording", elapsedMsAtomic) }
        }
    }

    /** Blocks until the capture thread has flushed the final segment. */
    fun stop(timeoutMs: Long = 5000) {
        val t = thread ?: return
        stopRequested = true
        state = "stopping"
        t.join(timeoutMs)
    }

    // ---------------------------------------------------------------------

    private fun captureLoop(context: Context, record: AudioRecord, cfg: Config) {
        val frame = ShortArray(FRAME_SAMPLES)
        var writer: WavSegmentWriter? = null
        var segIndex = cfg.startIndex
        var segStartMs = elapsedMsAtomic
        var segWallStart = System.currentTimeMillis()
        var segFrames = 0
        var segSpeechFrames = 0
        var segDbSum = 0.0
        var silenceRun = 0
        var floorDb = -60.0
        var levelAcc = 0.0
        var levelN = 0
        var speechInWindow = false
        val minFrames = (cfg.minSegmentSec * 1000 / FRAME_MS).toInt()
        val maxFrames = (cfg.maxSegmentSec * 1000 / FRAME_MS).toInt()

        fun closeSegment() {
            val w = writer ?: return
            writer = null
            w.close()
            if (segFrames < 10) { // < 200 ms: not worth transcribing
                File(w.path).delete()
                return
            }
            val seg = Segment(
                index = segIndex,
                path = w.path,
                startMs = segStartMs,
                durationMs = segFrames.toLong() * FRAME_MS,
                wallStartMs = segWallStart,
                speechRatio = segSpeechFrames.toDouble() / segFrames,
                meanDb = segDbSum / segFrames,
            )
            segIndex++
            segmentCount++
            each { it.onSegment(seg) }
        }

        fun openSegment() {
            val name = "seg_%05d.wav".format(segIndex)
            writer = WavSegmentWriter(File(cfg.dir, name).absolutePath, SAMPLE_RATE)
            segStartMs = elapsedMsAtomic
            segWallStart = System.currentTimeMillis()
            segFrames = 0; segSpeechFrames = 0; segDbSum = 0.0; silenceRun = 0
        }

        try {
            record.startRecording()
            while (!stopRequested) {
                var read = 0
                while (read < FRAME_SAMPLES && !stopRequested) {
                    val n = record.read(frame, read, FRAME_SAMPLES - read)
                    if (n < 0) throw IllegalStateException("AudioRecord.read error $n")
                    read += n
                }
                if (stopRequested) break

                if (paused) {
                    // Pausing closes the segment so no audio straddles a gap.
                    if (writer != null) closeSegment()
                    continue
                }
                if (writer == null) openSegment()

                val db = frameDb(frame)
                // Adaptive noise floor: drops instantly, rises ~1 dB/s.
                floorDb = if (db < floorDb) db else min(floorDb + 0.02, db)
                val isSilence = db < floorDb + 6.0 || db < -55.0
                val isSpeech = db > floorDb + 10.0 && db > -48.0

                writer!!.write(frame, FRAME_SAMPLES)
                segFrames++
                segDbSum += db
                if (isSpeech) segSpeechFrames++
                silenceRun = if (isSilence) silenceRun + 1 else 0
                elapsedMsAtomic += FRAME_MS

                if (segFrames % HEADER_PATCH_EVERY_FRAMES == 0) writer!!.patchHeader()

                levelAcc += db; levelN++
                speechInWindow = speechInWindow || isSpeech
                if (levelN >= LEVEL_EMIT_EVERY_FRAMES) {
                    val avg = levelAcc / levelN
                    val sp = speechInWindow
                    val el = elapsedMsAtomic
                    each { it.onLevel(avg, el, sp) }
                    levelAcc = 0.0; levelN = 0; speechInWindow = false
                }

                val cutAtSilence = segFrames >= minFrames && silenceRun >= SILENCE_RUN_FRAMES_TO_CUT
                if (cutAtSilence || segFrames >= maxFrames) closeSegment()
            }
        } catch (e: Throwable) {
            Log.e(TAG, "capture failed", e)
            each { it.onError(e.message ?: e.toString()) }
        } finally {
            runCatching { closeSegment() }
            runCatching { record.stop() }
            runCatching { record.release() }
            unregisterSilenceCallback(context)
            thread = null
            state = "idle"
            val el = elapsedMsAtomic
            each { it.onState("stopped", el) }
        }
    }

    private fun frameDb(frame: ShortArray): Double {
        var sum = 0.0
        for (s in frame) { val v = s / 32768.0; sum += v * v }
        val rms = sqrt(sum / frame.size)
        return if (rms <= 1e-6) -120.0 else 20 * log10(rms)
    }

    /** Android 10+: tells us when another app (e.g. a phone call) steals the mic. */
    private fun registerSilenceCallback(context: Context, record: AudioRecord) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val sessionId = record.audioSessionId
        val cb = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                val mine = configs.firstOrNull { it.clientAudioSessionId == sessionId } ?: return
                val silenced = mine.isClientSilenced
                each { it.onSilenced(silenced) }
            }
        }
        am.registerAudioRecordingCallback(cb, main)
        recordingCallback = cb
    }

    private fun unregisterSilenceCallback(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val cb = recordingCallback as? AudioManager.AudioRecordingCallback ?: return
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        main.post { runCatching { am.unregisterAudioRecordingCallback(cb) } }
        recordingCallback = null
    }
}

/** PCM16 mono WAV writer whose header stays valid while the file grows. */
class WavSegmentWriter(val path: String, private val sampleRate: Int) {
    private val raf = RandomAccessFile(path, "rw")
    private var dataBytes = 0L
    private val buf = ByteArray(2 * 4096)

    init {
        raf.setLength(0)
        raf.write(header(0))
    }

    fun write(samples: ShortArray, count: Int) {
        var i = 0
        var b = 0
        while (i < count) {
            val s = samples[i].toInt()
            buf[b++] = (s and 0xff).toByte()
            buf[b++] = ((s shr 8) and 0xff).toByte()
            i++
        }
        raf.write(buf, 0, b)
        dataBytes += b
    }

    fun patchHeader() {
        val pos = raf.filePointer
        raf.seek(0)
        raf.write(header(dataBytes))
        raf.seek(pos)
    }

    fun close() {
        patchHeader()
        raf.fd.sync()
        raf.close()
    }

    private fun header(dataLen: Long): ByteArray {
        val byteRate = sampleRate * 2
        val h = ByteArray(44)
        fun str(o: Int, s: String) = s.forEachIndexed { i, c -> h[o + i] = c.code.toByte() }
        fun i32(o: Int, v: Long) { for (k in 0..3) h[o + k] = ((v shr (8 * k)) and 0xff).toByte() }
        fun i16(o: Int, v: Int) { h[o] = (v and 0xff).toByte(); h[o + 1] = ((v shr 8) and 0xff).toByte() }
        str(0, "RIFF"); i32(4, 36 + dataLen); str(8, "WAVE")
        str(12, "fmt "); i32(16, 16); i16(20, 1); i16(22, 1)
        i32(24, sampleRate.toLong()); i32(28, byteRate.toLong()); i16(32, 2); i16(34, 16)
        str(36, "data"); i32(40, dataLen)
        return h
    }

    companion object {
        /** Fixes the header of a WAV left behind by a crash. Returns data length. */
        fun repair(path: String): Long {
            val f = File(path)
            if (!f.exists() || f.length() < 44) return 0
            RandomAccessFile(f, "rw").use { raf ->
                val dataLen = (raf.length() - 44) and 0x7FFFFFFFFFFFFFFE
                val w = ByteArray(8)
                fun i32(o: Int, v: Long) { for (k in 0..3) w[o + k] = ((v shr (8 * k)) and 0xff).toByte() }
                i32(0, 36 + dataLen); raf.seek(4); raf.write(w, 0, 4)
                i32(0, dataLen); raf.seek(40); raf.write(w, 0, 4)
                return dataLen
            }
        }
    }
}
