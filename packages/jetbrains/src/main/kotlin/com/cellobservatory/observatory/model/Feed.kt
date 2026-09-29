package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's live-feed view-model, parsed from `oak feed --json`: what ONE
 * thing in the Overview is doing — an agent, a workflow run, a task, a background shell, or the session
 * itself — as a bounded tail of the file that thing writes as it works.
 */
data class FeedEntry(
    /** ms epoch; 0 for raw output lines, which carry no timestamp of their own. */
    val ts: Long,
    /** 'action' | 'output' | 'reasoning' | 'permission' | 'prompt'. */
    val kind: String,
    /** The headline: a tool call, or one line of output. */
    val label: String,
    /** WHAT the call acted on — the path, the command, the query. It belongs beside the verb: a row
     *  naming only its tool ("Edit") tells a reader nothing they can act on. */
    val target: String?,
    /** Secondary context — which agent produced it. Never the target: that has its own field. */
    val detail: String?,
    /** false when the call reported an error; null when not applicable. */
    val ok: Boolean?,
    /** core's tool category (edit · exec · read · search · web · agent · todo · mcp · meta · …).
     *  `exec` is the one renderers key on: a shell call draws as a shell call, never as a tool name. */
    val category: String?,
    /** The tool's own secondary context (a Bash description, a Grep path) — a rail row, not the target. */
    val note: String?,
    /** The reasoning core carried FORWARD per message — consecutive calls share it, so a renderer
     *  prints it only where it CHANGED. */
    val reasoning: String?,
    /** 'thinking' | 'text' — labels the reasoning row (thinking vs what the agent said out loud). */
    val reasoningKind: String?,
    /** kind 'prompt' only: the user's ask, complete — renderers wrap it. */
    val promptText: String?,
    /** A shell call's full, un-flattened command (`target` holds the capped one-line form). */
    val cmd: String?,
    /** Strict attribution to a captured edit — the id keep/undo may act on. Null when unattributed. */
    val editId: Int?,
    /** DISPLAY-ONLY recovery when strict attribution refused: the diff may be shown, never mutated. */
    val previewId: Int?,
)

data class Feed(
    /** core's echo of the ref this feed answers — a renderer checks it before painting, so a tail that
     *  landed for the previously selected row can never be shown under the new one. */
    val kind: String,
    val id: String,
    /** What is being watched, ready to render as the pane's heading. */
    val title: String,
    val running: Boolean,
    /** What this feed IS, decided in core so both editors agree: 'live' — still writing, so follow it
     *  and keep polling; 'audit' — finished, so it is a RECORD of what happened, not a stream, and a
     *  renderer stops asking for it. */
    val mode: String,
    /** Chronological, OLDEST first — a feed reads downward, like a terminal. */
    val entries: List<FeedEntry>,
    /** How many older entries core dropped to honour the limit — said out loud, never swallowed. */
    val truncated: Int,
    /** Newest evidence seen (ms epoch, 0 when none) — a renderer shows this AGE rather than claiming
     *  realtime it cannot verify. */
    val lastTs: Long,
    /** Set when the feed can only be partial, and why — rendered instead of a blank pane. */
    val note: String?,
    /** The session recap, riding session-kind feeds only (the CLI merges recapOf into the payload). */
    val recap: String?,
    /** Where the recap came from: 'analysis' | 'title' | 'summary' | '' — labels the recap line. */
    val recapSource: String?,
    /** Each attributed row's bounded inline diff, by edit id: removed then added lines, and how many the
     *  bound left out. Built where the feed is FETCHED, off the EDT — never by the renderer. */
    val previews: Map<Int, Pair<List<String>, Int>> = emptyMap(),
) {
    val live: Boolean get() = mode == "live"
}

object FeedParser {
    fun parse(json: String): Feed? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val ref = o.getAsJsonObject("ref")
        Feed(
            kind = ref?.let { str(it, "kind") } ?: "session",
            id = ref?.let { str(it, "id") } ?: "",
            title = str(o, "title") ?: "",
            running = bool(o, "running"),
            // Unknown/absent mode degrades to 'audit': a feed we can't confirm is live must not be
            // labelled live, and must not be polled forever.
            mode = str(o, "mode")?.takeIf { it == "live" } ?: "audit",
            entries = (o.getAsJsonArray("entries") ?: com.google.gson.JsonArray())
                .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.let(::entry) },
            truncated = int(o, "truncated"),
            lastTs = long(o, "lastTs"),
            note = str(o, "note"),
            recap = str(o, "recap"),
            recapSource = str(o, "recapSource"),
        )
    } catch (_: Exception) {
        null
    }

    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L
    private fun bool(o: JsonObject, k: String): Boolean = o.get(k)?.takeIf { !it.isJsonNull }?.asBoolean ?: false

    private fun entry(o: JsonObject) = FeedEntry(
        ts = long(o, "ts"),
        kind = str(o, "kind") ?: "action",
        label = str(o, "label") ?: "",
        target = str(o, "target"),
        detail = str(o, "detail"),
        // Absent = not applicable; only an explicit false marks a failure.
        ok = o.get("ok")?.takeIf { !it.isJsonNull }?.asBoolean,
        category = str(o, "category"),
        note = str(o, "note"),
        reasoning = str(o, "reasoning"),
        reasoningKind = str(o, "reasoningKind"),
        promptText = str(o, "promptText"),
        cmd = str(o, "cmd"),
        editId = o.get("editId")?.takeIf { !it.isJsonNull }?.asInt,
        previewId = o.get("previewId")?.takeIf { !it.isJsonNull }?.asInt,
    )
}
