package com.cellobservatory.observatory.model

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's session listing, parsed from `oak sessions --json` (0.8.8).
 *
 * The listing is deliberately CHEAP: core builds it from directory stats plus a bounded, sidecar-cached
 * title scan — it never parses a session's edit log, so no row carries a pending count. Ordering is by
 * CONVERSATION recency ([lastActiveMs] = transcript mtime), not by store writes, so accepting a batch of
 * old edits cannot resurrect a dead session to the top of the list.
 */
data class SessionAttention(val kind: String, val message: String, val ts: Long)

data class SessionRow(
    val id: String,
    /** the session's name (a rename, else its claude.ai Remote Control title, else the agent's ai-title, else its first prompt); blank when none exists. */
    val title: String?,
    val lastActiveMs: Long,
    /** ACTIVITY clock (0.10.0): newest of transcript, drive sidecar, store log — liveness judges on
     *  this; [lastActiveMs] stays the conversation clock. 0 on a CLI too old to send it. */
    val liveMs: Long = 0,
    /** What the agent is waiting on RIGHT NOW — kind permission|input|question|idle-done, with the
     *  question header / notification message. Null = nothing waiting (or a CLI too old to say). */
    val attention: SessionAttention? = null,
    /** True for the session this workspace resolves to right now — the one still being written. */
    val current: Boolean,
    /** What the session did, in the terms the store's log carries: captured edits, how many still await
     *  review, and how many files they touched. Zero for a conversation that changed nothing. */
    val edits: Int,
    val pending: Int,
    val files: Int,
    /** Lines added / removed across the session's captured edits (0.9.0). Sidecar-cached in core against
     *  the log's stamp, so a row still costs a stat once a finished session has been counted once. */
    val added: Int = 0,
    val removed: Int = 0,
    /** Tokens the conversation consumed and its wall-clock span — the same pair a fleet row shows. */
    val tokens: Long = 0,
    val durationMs: Long = 0,
    /** The session store's on-disk footprint in bytes (log + blobs), so a picker can show what a session
     *  costs to keep — the same figure the TUI's session blobs show. 0 on a CLI too old to send it, or a
     *  conversation that captured nothing; the renderer shows it by omitting the chip. */
    val storeBytes: Long = 0,
    /** The store's DIRECTORY on disk (served by the CLI so we need not replicate core's path-mangling), so
     *  "open this session's store folder" can reveal it. Blank on a CLI too old to send it. */
    val storePath: String = "",
    /** What it ran on, as recorded by the harness: display label ("Opus 5") and declared reasoning effort.
     *  Blank when the transcript never said — an unset effort is reported as unknown, never guessed, since
     *  the default differs by build and model. Older CLIs emit neither field and simply show nothing. */
    val model: String = "",
    val effort: String = "",
    /** Which workspace this session belongs to. The listing spans EVERY workspace, so a row that does
     *  not say where it came from is a row silently claiming to be this project's. */
    val workspace: String = "",
    /** WHO ran the session (0.10.0): `claude` (unmarked — most rows), `codex`, or a historical agent name.
     *  Rendered with [model] so every session menu says agent + model at a glance. */
    val agent: String = "claude",
    /** The newest edit id the listing counted [pending] from (0.10.0). A delete confirmed from this row
     *  passes it on, so an edit captured after the listing is refused rather than purged unseen. Null on
     *  a CLI too old to send it: the delete then checks the count alone. */
    val lastEdit: Long? = null,
) {
    /** What a row leads with: the agent's title, else a short id (never an empty label). */
    val displayName: String get() = title?.takeIf { it.isNotBlank() } ?: "session ${id.take(8)}"
}

/** CLI rows arrive grouped by workspace, the editor's workspace first. */
data class SessionsResult(val active: String?, val sessions: List<SessionRow>)

/** A session's conversation counts as LIVE within this long of its last transcript write. Mirrors core's
 *  `FLEET_ACTIVE_MS` (fleet.ts) — the fleet's ● and this selector's ● must mean the same thing, or two
 *  surfaces disagree about which sessions are running. */
private const val ACTIVE_WINDOW_MS = 60_000L

/**
 * The rows the Timeline's session selector offers: the sessions still live in this workspace, plus the one
 * being reviewed even when it has gone quiet.
 *
 * Current FIRST — it is the answer most of the time, and a selector that makes you find your own session
 * in a recency list is a worse selector. Then the live ones, newest conversation first. The full browser
 * stays in the Overview's Sessions tab; this list is deliberately short.
 *
 * The reviewed session is pinned in even when inactive because it is the thing every panel is showing: a
 * list that omitted it would let a click land you somewhere else with no way back to where you were.
 */
fun activeSessionRows(rows: List<SessionRow>, currentId: String?, nowMs: Long): List<SessionRow> {
    val current = currentId?.let { id -> rows.firstOrNull { it.id == id } }
    val live = rows
        .filter { it.id != currentId && nowMs - maxOf(it.lastActiveMs, it.liveMs) <= ACTIVE_WINDOW_MS }
        .sortedByDescending { it.lastActiveMs }
    return listOfNotNull(current) + live
}

/** Whether a row's conversation is still live, by the same window [activeSessionRows] filters on — so the
 *  selector's ● / ○ cannot disagree with the list it decorates. */
fun isSessionActive(lastActiveMs: Long, nowMs: Long): Boolean =
    lastActiveMs > 0 && nowMs - lastActiveMs <= ACTIVE_WINDOW_MS

object SessionsParser {
    /**
     * Parse `sessions --json`, or null when the CLI on PATH predates 0.8.8.
     *
     * The old shape carried `edits`/`pending`/`lastMs` and no `lastActiveMs`. Coercing those missing
     * fields to 0/false would fabricate a listing: every row "last active at the epoch", none of them
     * live, ordered by nothing. Returning null instead lets both surfaces fall back honestly — the tab
     * says the CLI could not answer, and the popup lists ids from the in-process store reader.
     */
    fun parse(json: String): SessionsResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val arr = o.getAsJsonArray("sessions") ?: JsonArray()
        val rows = arr.mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject }
        val local = rows.filter { (it.get("origin")?.asString ?: "local") == "local" }
        if (local.any { !it.has("lastActiveMs") }) null
        else SessionsResult(
            active = o.get("active")?.takeIf { it.isJsonPrimitive }?.asString,
            sessions = local.map { row(it) }.distinctBy { it.id },
        )
    } catch (_: Exception) {
        null
    }

    private fun row(o: JsonObject) = SessionRow(
        id = o.get("id")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
        title = o.get("title")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() },
        lastActiveMs = o.get("lastActiveMs")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        liveMs = o.get("liveMs")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        current = o.get("current")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
        attention = o.get("attention")?.takeIf { it.isJsonObject }?.asJsonObject?.let { a ->
            SessionAttention(
                kind = a.get("kind")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
                message = a.get("message")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
                ts = a.get("ts")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
            ).takeIf { it.kind.isNotBlank() }
        },
        edits = o.get("edits")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        pending = o.get("pending")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        files = o.get("files")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        workspace = o.get("workspace")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
        // 0.9.0 badge fields. Absent on an older CLI, and 0/"" is the honest reading of absent here —
        // unlike `lastActiveMs` above, a missing count says "this build does not report it", which the
        // renderer shows by omitting the badge rather than by drawing a zero.
        added = o.get("added")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        removed = o.get("removed")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        tokens = o.get("tokens")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        durationMs = o.get("durationMs")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        // On-disk store size (log + blobs). Absent on an older CLI → 0, which the picker shows by omission.
        storeBytes = o.get("storeBytes")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        // The store directory, for the "open this session's store folder" row. Absent on an older CLI → "".
        storePath = o.get("storePath")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
        model = o.get("model")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
        effort = o.get("effort")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
        // 0.10.0: absent on an older CLI means hook-observed — exactly what the default says.
        // 0.10.0: absent means a Claude Code session — the only agent older CLIs could observe.
        agent = (o.get("agent") ?: o.get("kind"))?.takeIf { it.isJsonPrimitive }?.asString ?: "claude",
        // 0.10.0: absent on an older CLI, and absent must stay unknown: a 0 here would tell the delete that
        // the listing saw no edit at all.
        lastEdit = o.get("lastEdit")?.takeIf { it.isJsonPrimitive }?.asLong,
    )
}
