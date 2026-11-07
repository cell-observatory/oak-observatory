package com.cellobservatory.observatory.core

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import java.io.BufferedWriter
import java.nio.file.Path
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * One long-lived `oak query --serve` (0.11.0) answering this plugin's reads of the local index: one JSON request per line
 * in, its answer per line out, so a read costs a line rather than a process. Started at the first read, and again after
 * it ends; stopped with the plugin. Every read catches the index up first (for at most half a second), as `oak query`
 * does.
 *
 * A read answers null when the index cannot (no index on this machine, an `oak` from before it, a child that died or
 * missed its deadline), and on the EDT, which never waits on a process: the caller then reads the way it did before the
 * index.
 */
@Service
class QueryServe : Disposable {
    private val lock = Any()
    private var proc: Process? = null
    private var input: BufferedWriter? = null
    private var lines = LinkedBlockingQueue<String>()
    private var next = 0L
    /** A child that was stopped before it answered a read (an `oak` with no `query --serve`, one that ended or missed its
     *  deadline while starting), could not start, or answered that it has no index, is not started again before this for
     *  the same CLI and config folder ([failedFor]); another is tried at once. */
    private var retryAt = 0L
    private var failedFor = ""
    /** Whether the child running now has answered a read. Without this a child that could not serve was started again at
     *  every read: every two seconds from each project's Codex watcher, each one killed at its deadline. */
    private var answeredThis = false
    /** The CLI and config folder the child was started with: another (the settings changed) starts another child. */
    private var startedFor = ""
    /** How many reads it answered (a test's proof that a read went to the index). */
    @Volatile internal var answered = 0

    /** The named query's answer (`{ v, query, params, columns, rows, … }`), or null when there is none. */
    fun ask(query: String, params: Map<String, Any>, timeoutMs: Long = 5_000): JsonObject? {
        if (ApplicationManager.getApplication()?.isDispatchThread == true) return null
        synchronized(lock) {
            val p = alive() ?: return null
            val id = ++next
            val req = JsonObject().apply { addProperty("id", id); addProperty("query", query); add("params", Gson().toJsonTree(params)) }
            try {
                input!!.write(req.toString())
                input!!.write("\n")
                input!!.flush()
            } catch (_: Exception) {
                stop()
                return null
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val line = lines.poll(100, TimeUnit.MILLISECONDS)
                if (line == null) {
                    if (!p.isAlive && lines.isEmpty()) break
                    continue
                }
                val o = runCatching { JsonParser.parseString(line).asJsonObject }.getOrNull() ?: continue
                if (o.get("id")?.takeIf { it.isJsonPrimitive }?.asLong != id) continue // a late answer to an earlier read
                if (o.has("error")) {
                    // No index this CLI can read here: the child is of no use until something changes, so it goes.
                    if (o.getAsJsonObject("error")?.get("code")?.takeIf { it.isJsonPrimitive }?.asString == "index_unavailable") {
                        stop()
                        retryAt = System.currentTimeMillis() + 60_000
                        failedFor = startedFor
                    }
                    return null
                }
                answered++
                answeredThis = true
                return o
            }
            stop()
            return null
        }
    }

    private fun alive(): Process? {
        val now = System.currentTimeMillis()
        val target = runCatching { "${ObservatoryCli.resolveBin()}\u0000${ClaudePaths.configDir()}" }.getOrDefault("")
        proc?.takeIf { it.isAlive && startedFor == target }?.let { return it }
        stop()
        if (now < retryAt && failedFor == target) return null
        return try {
            val p = ObservatoryCli.commandLine(listOf("query", "--serve"), null).createProcess()
            startedFor = target
            val queue = LinkedBlockingQueue<String>()
            Thread({ runCatching { p.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { queue.put(it) } } }, "oak-query-serve-out").apply { isDaemon = true }.start()
            Thread({ runCatching { p.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { } } }, "oak-query-serve-err").apply { isDaemon = true }.start()
            proc = p
            input = p.outputStream.bufferedWriter(Charsets.UTF_8)
            lines = queue
            answeredThis = false
            p
        } catch (_: Exception) {
            retryAt = now + 60_000
            failedFor = target
            null
        }
    }

    private fun stop() {
        val p = proc ?: return
        // One stopped before it answered a read cannot serve here (an `oak` before `query --serve`, one that ended or missed
        // its deadline while starting): asked again in a minute, not at every read. How long it took to end is no proof:
        // under load an `oak` with no serve took more than a second to exit, and was started again at every read.
        if (!answeredThis) {
            retryAt = System.currentTimeMillis() + 60_000
            failedFor = startedFor
        }
        runCatching { input?.close() }
        p.destroy()
        proc = null
        input = null
    }

    override fun dispose() {
        synchronized(lock) { stop() }
    }

    companion object {
        private val instance: QueryServe? get() = ApplicationManager.getApplication()?.getService(QueryServe::class.java)

        /** How many reads the serve answered (a test's proof that a read went to the index). */
        internal val answered: Int get() = instance?.answered ?: 0

        /** The named query's answer, or null when there is none (see [QueryServe]). */
        fun ask(query: String, params: Map<String, Any>, timeoutMs: Long = 5_000): JsonObject? = instance?.ask(query, params, timeoutMs)

        /** True when [sessionId] is one of this machine's sessions the index holds (its own, or one oak sync pulled here,
         *  Auto-review threads included), its files not gone; else null: what the index has not read yet proves no absence,
         *  so the caller looks on disk. */
        fun sessionKnown(sessionId: String): Boolean? {
            val rows = ask("sessions", mapOf("id" to sessionId, "all" to true, "limit" to 10))?.getAsJsonArray("rows") ?: return null
            return true.takeIf {
                rows.any { r ->
                    val o = r.takeIf { it.isJsonObject }?.asJsonObject ?: return@any false
                    o.get("origin")?.asString.let { it == "local" || it == "pulled" } && o.get("archived")?.asInt == 0
                }
            }
        }

        /** What changes when a Codex session that matters to this project is written: [session] (the one under review,
         *  wherever it ran) and each that ran in one of [folders] or below it, with when it was last written, among the
         *  machine's newest Codex sessions as the index holds them after catching up (a write makes its session the
         *  newest); null when the index cannot say (an answer from an index that could not catch up may not have seen the
         *  write). Folders are compared as paths, whatever separators each is written with. */
        fun codexStamp(folders: List<String>, session: String?): String? {
            val answer = ask("sessions", mapOf("agent" to "codex", "limit" to 50)) ?: return null
            if (answer.getAsJsonObject("freshness")?.get("caughtUp")?.asBoolean != true) return null
            val rows = answer.getAsJsonArray("rows") ?: return null
            val roots = folders.mapNotNull { runCatching { Path.of(it).normalize() }.getOrNull() }
            val ours = rows.mapNotNull { it.takeIf { r -> r.isJsonObject }?.asJsonObject }.filter { r ->
                if (session != null && r.get("id")?.asString == session) return@filter true
                val cwd = r.get("cwd")?.takeIf { it.isJsonPrimitive }?.asString ?: return@filter false
                val at = runCatching { Path.of(cwd).normalize() }.getOrNull() ?: return@filter false
                roots.any { at.startsWith(it) }
            }
            return ours.joinToString("|") { "${it.get("id")?.asString}:${it.get("last_active_ms")?.asLong}" }
        }
    }
}
