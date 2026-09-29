package com.cellobservatory.observatory.model

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's PROMPTS view-model, parsed from `oak prompts --json`: the
 * session as the list of things the USER asked for, each carrying what it produced.
 *
 * Every other axis here organizes work the way the AGENT saw it — tasks come from the agent's own
 * to-dos, rollups come from files, folders, subagents and workflow runs. None of them answer the
 * question a person actually has: *what happened when I asked for X?*
 *
 * Attribution is by START time, decided in core: a shell launched by prompt #4 belongs to #4 even when
 * it exits during #7, because #4 is what caused it. Nothing here re-attributes by completion.
 */
data class SessionPrompt(
    /** Stable id (content+time hash) — safe to key UI state and review ops on. */
    val id: String,
    /** 1-based chronological position — the way a person counts their own turns. */
    val index: Int,
    val ts: Long,
    /** When the NEXT prompt arrived; 0 while this is the one still being answered. */
    val endTs: Long,
    /** The prompt itself, whitespace-collapsed. */
    val text: String,
    /** First line, capped by core — what a row shows. */
    val title: String,
    /** Store edit ids committed in this window, in capture order — the review scope of the ask. */
    val editIds: List<Int>,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
    /** Distinct files and folders those edits touched. */
    val files: Int,
    val folders: Int,
    /** Main-chain assistant tokens spent answering this ask (input + output + cache, deduped by id). */
    val tokens: Long,
    /** Distinct to-dos worked (marked in_progress) while answering — "tasks touched" for this ask. */
    val tasks: Int,
    /** Tool calls made while answering, and how many reported an error. */
    val actions: Int,
    val errors: Int,
    val agents: List<String>,
    val workflows: List<String>,
    val processes: List<String>,
    val compactions: Int,
    val durationMs: Long,
) {
    /** True while this is the prompt being answered — core leaves [endTs] 0 until the next ask lands. */
    val current: Boolean get() = endTs == 0L
}

/** The Prompts headline (core.summarizePrompts) — the tab badge reads this. */
data class PromptSummary(val total: Int, val withEdits: Int, val edits: Int)

data class PromptsResult(
    val session: String,
    val summary: PromptSummary,
    /** Chronological, oldest first — exactly as core ordered them. */
    val prompts: List<SessionPrompt>,
)

/** the agent's prose reply to one ask (core.PromptResponse) — its tool calls stripped, so the reader gets
 *  the narrative. Fetched on demand (it can be large), never on the list payload. */
data class PromptResponse(
    val promptId: String,
    val index: Int,
    /** The concatenated assistant text, turns separated by a blank line, capped by core. */
    val text: String,
    val turns: Int,
    /** Bytes past the cap that are not shown (0 when the whole response fits). */
    val truncated: Long,
)

object PromptsParser {
    /** Parse `prompts --id N --response --json` → the response, or null when the CLI answered none. */
    fun parseResponse(json: String): PromptResponse? = try {
        val r = JsonParser.parseString(json).asJsonObject.getAsJsonObject("response") ?: return null
        PromptResponse(
            promptId = str(r, "promptId") ?: "",
            index = int(r, "index"),
            text = str(r, "text") ?: "",
            turns = int(r, "turns"),
            truncated = r.get("truncated")?.takeIf { !it.isJsonNull }?.asLong ?: 0L,
        )
    } catch (_: Exception) {
        null
    }

    fun parse(json: String): PromptsResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val sum = o.getAsJsonObject("summary")
        PromptsResult(
            session = str(o, "session") ?: "",
            summary = PromptSummary(
                total = sum?.let { int(it, "total") } ?: 0,
                withEdits = sum?.let { int(it, "withEdits") } ?: 0,
                edits = sum?.let { int(it, "edits") } ?: 0,
            ),
            prompts = (o.getAsJsonArray("prompts") ?: JsonArray())
                .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.let(::prompt) },
        )
    } catch (_: Exception) {
        null
    }

    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L
    private fun ints(o: JsonObject, k: String): List<Int> =
        o.getAsJsonArray(k)?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asInt } ?: emptyList()
    private fun strs(o: JsonObject, k: String): List<String> =
        o.getAsJsonArray(k)?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString } ?: emptyList()

    private fun prompt(o: JsonObject) = SessionPrompt(
        id = str(o, "id") ?: "",
        index = int(o, "index"),
        ts = long(o, "ts"),
        endTs = long(o, "endTs"),
        text = str(o, "text") ?: "",
        // An older CLI may carry no pre-trimmed title; the full text is the honest fallback (the row
        // clips it for display) rather than a blank row that names no ask at all.
        title = str(o, "title")?.takeIf { it.isNotBlank() } ?: (str(o, "text") ?: ""),
        editIds = ints(o, "editIds"),
        edits = int(o, "edits"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        pending = int(o, "pending"),
        kept = int(o, "kept"),
        undone = int(o, "undone"),
        files = int(o, "files"),
        folders = int(o, "folders"),
        tokens = long(o, "tokens"),
        tasks = int(o, "tasks"),
        actions = int(o, "actions"),
        errors = int(o, "errors"),
        agents = strs(o, "agents"),
        workflows = strs(o, "workflows"),
        processes = strs(o, "processes"),
        compactions = int(o, "compactions"),
        durationMs = long(o, "durationMs"),
    )
}
