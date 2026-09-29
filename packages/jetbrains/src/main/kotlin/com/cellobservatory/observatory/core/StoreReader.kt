package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.SessionInfo
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.exists
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.readText

/**
 * Read-only view of the on-disk store (log.jsonl + blobs). Mirrors core's store.ts read path:
 * the log is append-only with two line shapes — EditRecord lines and `{op:"status",id,status}`
 * ops that are FOLDED onto the matching record in file order. Unparseable/partial lines are
 * skipped (a concurrent capture may be mid-append). All mutations go through the CLI, never here.
 */
object StoreReader {

    /** Native rollout inventory used only to check whether a persisted pin still exists. */
    internal fun codexSessions(includeArchived: Boolean = false, home: Path = Paths.get(
        System.getenv("CODEX_HOME")?.takeIf { it.isNotBlank() } ?: Paths.get(System.getProperty("user.home"), ".codex").toString()
    )): List<Pair<String, Pair<Path, Long>>> = (if (includeArchived) listOf("sessions", "archived_sessions") else listOf("sessions")).flatMap { name ->
        val root = home.resolve(name)
        if (!Files.isDirectory(root)) emptyList() else runCatching {
            Files.walk(root, 5).use { files -> files.filter { Files.isRegularFile(it) && it.toString().endsWith(".jsonl") }.map { file ->
                runCatching {
                    val text = Files.newInputStream(file).use { String(it.readNBytes(65536), Charsets.UTF_8) }
                    val meta = text.lineSequence().mapNotNull { line -> runCatching { JsonParser.parseString(line).asJsonObject }.getOrNull() }
                        .firstOrNull { it.get("type")?.asString == "session_meta" }?.getAsJsonObject("payload")
                    val id = meta?.get("id")?.asString ?: meta?.get("session_id")?.asString
                    val cwd = meta?.get("cwd")?.asString
                    if (id != null && cwd != null) id to (Paths.get(cwd).toAbsolutePath().normalize() to Files.getLastModifiedTime(file).toMillis()) else null
                }.getOrNull()
            }.toList().filterNotNull() }
        }.getOrDefault(emptyList())
    }


    fun readLog(sessionId: String): List<EditRecord> {
        val path = ClaudePaths.logPath(sessionId)
        if (!path.exists()) return emptyList()
        val text = try {
            path.readText()
        } catch (_: Exception) {
            return emptyList()
        }
        val records = LinkedHashMap<Int, EditRecord>()
        var maxId = 0
        for (line in text.lineSequence()) {
            val t = line.trim()
            if (t.isEmpty()) continue
            val o = try {
                JsonParser.parseString(t).asJsonObject
            } catch (_: Exception) {
                continue
            }
            // Any line with an `op` is a CONTROL line, never an edit record — op wins over id,
            // exactly like core's parseLogFile: fold 'status', ignore the rest ('skip', 'swept',
            // 'batch', and anything future). Without the unconditional continue, an op line carrying
            // both `id` and `file` would fall through, parse as an EditRecord, and OVERWRITE the
            // real record at that id (resetting its status to "pending"). Pinned by the port test.
            val opKind = o.get("op")?.takeIf { it.isJsonPrimitive }?.asString
            if (opKind != null) {
                if (opKind == "capture-evidence") {
                    val id = o.get("id")?.asIntOrNull() ?: continue
                    records[id]?.let { rec -> if (rec.uid == o.get("uid")?.asStringOrNull()) records[id] = rec.copy(
                        beforeBlob = o.get("beforeBlob")?.asStringOrNull(), tool = o.get("tool")?.asStringOrNull() ?: rec.tool,
                        toolCallId = o.get("toolCallId")?.asStringOrNull(), beforeState = o.get("beforeState")?.asStringOrNull(),
                        source = "hook", provenance = "tool", attribution = "correlated", partial = false) }
                }
                if (opKind == "status") {
                    val id = o.get("id")?.asIntOrNull() ?: continue
                    val status = o.get("status")?.asStringOrNull() ?: continue
                    records[id]?.let { records[id] = it.copy(status = status) }
                }
                continue
            }
            var id = o.get("id")?.asIntOrNull() ?: continue
            if (id <= 0) continue
            // canonPath mirrors core's readLog heal (#43): pre-fix stores hold drive-letter case twins
            // for one file; normalizing here makes every panel see one file without rewriting disk.
            val file = o.get("file")?.asStringOrNull()?.let { ClaudePaths.canonPath(it) } ?: continue
            // Same append-order reconciliation as core: never hide an older edit or target
            // another record when historical writers reused a display ID.
            if (records.containsKey(id)) id = maxId + 1
            maxId = maxOf(maxId, id)
            records[id] = EditRecord(
                id = id,
                ts = o.get("ts")?.asLongOrNull() ?: 0L,
                tool = o.get("tool")?.asStringOrNull() ?: "",
                file = file,
                beforeBlob = o.get("beforeBlob")?.asStringOrNull(),
                afterBlob = o.get("afterBlob")?.asStringOrNull(),
                status = o.get("status")?.asStringOrNull() ?: "pending",
                uid = o.get("uid")?.asStringOrNull(), source = o.get("source")?.asStringOrNull(), toolCallId = o.get("toolCallId")?.asStringOrNull(),
                beforeState = o.get("beforeState")?.asStringOrNull(), model = o.get("model")?.asStringOrNull(), runtime = o.get("runtime")?.asStringOrNull(),
                provenance = o.get("provenance")?.asStringOrNull(), attribution = o.get("attribution")?.asStringOrNull(),
                nativeTurnId = o.get("nativeTurnId")?.asStringOrNull(),
                partial = o.get("partial")?.let { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean && it.asBoolean } ?: false,
            )
        }
        return records.values.toList()
    }

    fun findRecord(sessionId: String, id: Int): EditRecord? = readLog(sessionId).find { it.id == id }

    fun readBlob(sessionId: String, sha: String?): String {
        if (sha == null) return ""
        return try {
            Files.readString(ClaudePaths.blobPath(sessionId, sha))
        } catch (_: Exception) {
            ""
        }
    }

    /** Like [readBlob], but a MISSING or unreadable blob answers null instead of "" — "" is real
     *  content (an empty file), and a surface that must not render a vanished blob as an empty side
     *  needs to tell the two apart. A null sha still answers "" (no file on that side, honestly). */
    fun readBlobOrNull(sessionId: String, sha: String?): String? {
        if (sha == null) return ""
        return try {
            Files.readString(ClaudePaths.blobPath(sessionId, sha))
        } catch (_: Exception) {
            null
        }
    }

    fun listSessions(): List<SessionInfo> {
        val root = ClaudePaths.rootDir()
        if (!root.exists()) return emptyList()
        return root.listDirectoryEntries()
            .filter { Files.isDirectory(it) && it.resolve("log.jsonl").exists() }
            .map { dir ->
                val log = readLog(dir.fileName.toString())
                // mtime of log.jsonl — matches core.listSessions (store.ts). Status ops (keep/undo)
                // bump the mtime but not any record.ts, so max(edit.ts) would drift after review.
                val lastMs = try {
                    Files.getLastModifiedTime(dir.resolve("log.jsonl")).toMillis()
                } catch (_: Exception) {
                    0L
                }
                SessionInfo(
                    id = dir.fileName.toString(),
                    edits = log.size,
                    pending = log.count { it.pending },
                    lastMs = lastMs,
                )
            }
            .sortedByDescending { it.lastMs }
    }

    /**
     * Whether [sessionId] is still reviewable ANYWHERE on this machine: its store directory exists,
     * or some project's transcript does. The transcript half scans every <config>/projects/<dir> —
     * the session pin is application-wide, so the session may belong to a different project than the
     * one asking — one readdir plus a stat per project dir; callers memoize per pin value. On an
     * UNREADABLE layout this answers true: the caller heals state off a proven absence, and an IO
     * hiccup is not proof.
     */
    fun sessionExists(sessionId: String): Boolean {
        if (sessionId.isBlank()) return false
        return try {
            if (ClaudePaths.storeDir(sessionId).exists()) return true
            if (codexSessions(includeArchived = true).any { it.first == sessionId }) return true
            val projects = ClaudePaths.configDir().resolve("projects")
            projects.exists() && projects.listDirectoryEntries().any { dir ->
                Files.isDirectory(dir) && dir.resolve("$sessionId.jsonl").exists()
            }
        } catch (_: java.nio.file.InvalidPathException) {
            // An id no path can spell (a legacy "!host" synthetic pin on Windows) is PROVEN unable
            // to exist on disk — treating it as an IO hiccup would keep it pinned forever.
            false
        } catch (_: Exception) {
            true
        }
    }

    /** (mtime, size) freshness key for the session log — cheap cache invalidation, same as core. */
    fun logKey(sessionId: String): String {
        val p = ClaudePaths.logPath(sessionId)
        return try {
            val attrs = Files.readAttributes(p, java.nio.file.attribute.BasicFileAttributes::class.java)
            "${attrs.lastModifiedTime().toMillis()}:${attrs.size()}"
        } catch (_: Exception) {
            "absent"
        }
    }
}

private fun com.google.gson.JsonElement.asIntOrNull(): Int? =
    if (isJsonPrimitive && asJsonPrimitive.isNumber) asInt else null

private fun com.google.gson.JsonElement.asLongOrNull(): Long? =
    if (isJsonPrimitive && asJsonPrimitive.isNumber) asLong else null

private fun com.google.gson.JsonElement.asStringOrNull(): String? =
    if (isJsonPrimitive && asJsonPrimitive.isString) asString else null
