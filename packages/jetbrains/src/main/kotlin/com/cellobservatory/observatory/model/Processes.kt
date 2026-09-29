package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's background-shell view-model, parsed from `oak processes --json`:
 * the commands the agent launched with `run_in_background` and left running, carrying the detail the
 * harness's own Background panel omits — runtime, exit code, output volume.
 *
 * There is deliberately NO OS pid here. The transcript never records one, and inferring it by scanning
 * local processes would be wrong the moment the agent runs somewhere else (SSH, devcontainer, another
 * worktree) — the harness's shell id IS the identity, and it is what the agent itself uses to read or
 * kill the shell.
 */
data class BackgroundProcess(
    /** The harness's background shell id (e.g. `bpkyyxbff`). */
    val id: String,
    /** The tool_use that launched it — the join back to the action timeline. */
    val toolUseId: String?,
    val command: String,
    /** The agent's one-line description of what the shell is for, when it gave one. */
    val description: String?,
    val startedTs: Long,
    /** 0 while still running. */
    val endedTs: Long,
    val running: Boolean,
    /** Harness status when it finished ('completed', 'failed', …); 'running' until then. */
    val status: String,
    /** Exit code parsed from the completion summary; null when the shell never reported one. */
    val exitCode: Int?,
    /** Wall-clock so far (live) or total (finished). */
    val runtimeMs: Long,
    val outputPath: String?,
    val outputBytes: Long,
    /** Last write to the output file — a running shell that stopped writing shows here. */
    val lastOutputTs: Long,
)

/** The Processes headline (core.summarizeProcesses) — the tab badge and the empty-state copy read this. */
data class ProcessSummary(val total: Int, val running: Int, val failed: Int)

data class ProcessesResult(
    val session: String,
    val summary: ProcessSummary,
    /** Oldest first, exactly as core ordered them. */
    val processes: List<BackgroundProcess>,
)

object ProcessesParser {
    fun parse(json: String): ProcessesResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val sum = o.getAsJsonObject("summary")
        ProcessesResult(
            session = str(o, "session") ?: "",
            summary = ProcessSummary(
                total = sum?.let { int(it, "total") } ?: 0,
                running = sum?.let { int(it, "running") } ?: 0,
                failed = sum?.let { int(it, "failed") } ?: 0,
            ),
            processes = (o.getAsJsonArray("processes") ?: com.google.gson.JsonArray())
                .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.let(::process) },
        )
    } catch (_: Exception) {
        null
    }

    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L

    private fun process(o: JsonObject) = BackgroundProcess(
        id = str(o, "id") ?: "",
        toolUseId = str(o, "toolUseId"),
        command = str(o, "command") ?: "",
        description = str(o, "description"),
        startedTs = long(o, "startedTs"),
        endedTs = long(o, "endedTs"),
        running = o.get("running")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
        status = str(o, "status") ?: "",
        // An explicit null means the shell never reported an exit code — distinct from exit 0, which is
        // the difference between "finished cleanly" and "we don't know how it ended".
        exitCode = o.get("exitCode")?.takeIf { !it.isJsonNull }?.asInt,
        runtimeMs = long(o, "runtimeMs"),
        outputPath = str(o, "outputPath"),
        outputBytes = long(o, "outputBytes"),
        lastOutputTs = long(o, "lastOutputTs"),
    )
}
