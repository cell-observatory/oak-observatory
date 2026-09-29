package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord

/**
 * Bounded CLI-style diff previews for one edit — the store's own blob pair through the platform's
 * line comparison (no spawn, no Myers of our own). Used by the Feed tab's inline diffs, with one cache for each preview. Removed lines then
 * added lines per changed fragment, ≤14 shown, the overflow counted rather than swallowed.
 *
 * Heavy calls — [StoreReader.findRecord] (a full log parse) and two blob reads — so a feed batch goes
 * through [forFeed], which reads the log once for the whole window, and runs where the feed is fetched,
 * off the EDT. The cache is a bounded LRU: a >120-edit feed evicts the oldest keys rather than
 * clear()-ing the lot and re-computing everything on the next refresh.
 */
internal object DiffPreviews {
    private const val MAX = 120
    private val EMPTY: Pair<List<String>, Int> = emptyList<String>() to 0
    // access-order LinkedHashMap → eldest (least-recently-used) entry falls out past MAX.
    private val cache = object : LinkedHashMap<String, Pair<List<String>, Int>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: Map.Entry<String, Pair<List<String>, Int>>): Boolean = size > MAX
    }

    /**
     * The bounded preview for edit [id] in [session]. When [byId] is given (a batch that already
     * read the session log), the record is looked up there — no per-call findRecord/log re-parse;
     * otherwise the record is fetched with [StoreReader.findRecord].
     */
    fun preview(session: String, id: Int?, byId: Map<Int, EditRecord>? = null): Pair<List<String>, Int> {
        if (id == null) return EMPTY
        val key = "$session:$id"
        synchronized(cache) { cache[key]?.let { return it } }
        val out = runCatching {
            val rec = (if (byId != null) byId[id] else StoreReader.findRecord(session, id)) ?: return@runCatching EMPTY
            val before = StoreReader.readBlobOrNull(session, rec.beforeBlob) ?: ""
            val after = StoreReader.readBlobOrNull(session, rec.afterBlob) ?: ""
            if (before.length + after.length > 400_000) return@runCatching EMPTY // a rewrite this big is the diff door's job
            val frags = com.intellij.diff.comparison.ComparisonManager.getInstance().compareLines(
                before, after, com.intellij.diff.comparison.ComparisonPolicy.DEFAULT,
                com.intellij.openapi.progress.DumbProgressIndicator.INSTANCE,
            )
            val bLines = before.split("\n")
            val aLines = after.split("\n")
            val lines = ArrayList<String>()
            var total = 0
            for (f in frags) {
                for (i in f.startLine1 until f.endLine1) { total++; if (lines.size < 14) lines.add("-" + (bLines.getOrNull(i) ?: "")) }
                for (i in f.startLine2 until f.endLine2) { total++; if (lines.size < 14) lines.add("+" + (aLines.getOrNull(i) ?: "")) }
            }
            lines to (total - lines.size).coerceAtLeast(0)
        }.getOrDefault(EMPTY)
        synchronized(cache) { cache[key] = out }
        return out
    }

    /** Every attributed row's preview for one feed payload, keyed by edit id. The session log is read at
     *  most once, and only when a preview is not already cached. Blocking — call it off the EDT. */
    fun forFeed(session: String, entries: List<com.cellobservatory.observatory.model.FeedEntry>): Map<Int, Pair<List<String>, Int>> {
        val ids = entries.mapNotNull { it.editId ?: it.previewId }.distinct()
        if (ids.isEmpty()) return emptyMap()
        val byId by lazy { runCatching { StoreReader.readLog(session).associateBy { it.id } }.getOrDefault(emptyMap()) }
        return ids.associateWith { id -> synchronized(cache) { cache["$session:$id"] } ?: preview(session, id, byId) }
    }
}
