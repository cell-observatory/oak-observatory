package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's Observations view-model, parsed from `oak observations --json`
 * (0.8.0 — the folded Timeline+Observations view). A session recap on top, the edit timeline as coalesced
 * same-file ×N runs (most-recent first) each edit carrying the agent's own reasoning, and the still-open next
 * steps at the end. Every field is assembled in core — this plugin only paints, so VS Code and JetBrains
 * can never disagree.
 */

/** One edit inside a coalesced run — its ±lines, review status, and the agent's reasoning for it. */
data class ObservationEdit(
    val id: Int,
    val ts: Long,
    val added: Int,
    val removed: Int,
    val status: String, // pending | kept | undone
    val reasoning: String?, // the agent's own words for this edit, null when uncorrelated
)

/** A run of adjacent same-file edits — the timeline's ×N unit, with a combined delta. */
data class ObservationRun(
    val file: String, // absolute path
    val rel: String, // root-relative, forward slashes
    val count: Int,
    val added: Int,
    val removed: Int,
    val status: String, // worst-unreviewed-wins rollup (pending > undone > kept)
    val edits: List<ObservationEdit>, // chronological order (expand for per-edit Keep/Undo)
)

/**
 * One thing that shaped this session's context — an instruction file, a memory doc, a plan, a skill, or a
 * compaction summary (core.ContextSource).
 *
 * [evidence] is the whole point of the row, not a detail: `transcript` rows are things the session
 * demonstrably did; `file-present` rows are files that merely exist where Claude Code auto-loads them,
 * because current builds inject CLAUDE.md and memory system-prompt-side and leave no transcript trace.
 * Renderers must keep the two visibly distinct rather than presenting both as observed facts.
 */
data class ContextSource(
    /** 'claude-md' | 'memory' | 'plan' | 'skill' | 'compact-summary' — core owns the vocabulary. */
    val kind: String,
    val label: String,
    /** The file a row opens on double-click; null for sources that aren't a file. */
    val path: String?,
    val evidence: String,
    val detail: String?,
    /** Transcript evidence only: how many times it appeared. 0 on a file-present row. */
    val count: Int,
    val ts: Long,
)

/** The Context section: what shaped this session + core's caveat, which is rendered VERBATIM (the
 *  section over-claims without it). */
data class ContextReport(val sources: List<ContextSource>, val note: String)

data class Observations(
    val recap: String,
    val runs: List<ObservationRun>, // most-recent activity first
    val nextSteps: List<String>,
    /** What shaped this session — null for an older CLI without the field (the section hides). */
    val context: ContextReport?,
)

object ObservationsParser {
    fun parse(json: String): Observations? = try {
        val o = JsonParser.parseString(json).asJsonObject
        Observations(
            recap = o.get("recap")?.takeIf { !it.isJsonNull }?.asString ?: "",
            runs = arr(o, "runs").map { run(it.asJsonObject) },
            nextSteps = arr(o, "nextSteps").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
            context = o.get("context")?.takeIf { it.isJsonObject }?.asJsonObject?.let { c ->
                ContextReport(
                    sources = arr(c, "sources").map { contextSource(it.asJsonObject) },
                    note = str(c, "note") ?: "",
                )
            },
        )
    } catch (_: Exception) {
        null
    }

    private fun arr(o: JsonObject, k: String) = o.getAsJsonArray(k) ?: com.google.gson.JsonArray()
    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L

    private fun run(o: JsonObject) = ObservationRun(
        file = str(o, "file") ?: "",
        rel = str(o, "rel") ?: "",
        count = int(o, "count"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        status = str(o, "status") ?: "kept",
        edits = arr(o, "edits").map { edit(it.asJsonObject) },
    )

    private fun contextSource(o: JsonObject) = ContextSource(
        kind = str(o, "kind") ?: "",
        label = str(o, "label") ?: "",
        path = str(o, "path"),
        // Version-skew tolerance: a payload that predates the evidence axis only ever carried rows the
        // transcript actually showed, so that is the honest default for a missing key.
        evidence = str(o, "evidence") ?: "transcript",
        detail = str(o, "detail"),
        count = int(o, "count"),
        ts = long(o, "ts"),
    )

    private fun edit(o: JsonObject) = ObservationEdit(
        id = int(o, "id"),
        ts = long(o, "ts"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        status = str(o, "status") ?: "pending",
        reasoning = str(o, "reasoning"),
    )
}
