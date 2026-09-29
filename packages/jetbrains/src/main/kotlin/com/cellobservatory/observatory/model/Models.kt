package com.cellobservatory.observatory.model

/** One captured agent edit, as stored in log.jsonl (status already folded). */
data class EditRecord(
    val id: Int,
    val ts: Long,
    val tool: String,
    val file: String,
    val beforeBlob: String?,
    val afterBlob: String?,
    val status: String, // "pending" | "kept" | "undone"
    /** Review-only: an ACP record whose before-content never arrived — undo REFUSES with the
     *  stated reason, keep works. Marked BEFORE the reader acts, not explained after (parity
     *  with VS Code's badge and the TUI's marker). Tail-defaulted so other constructors stand. */
    val partial: Boolean = false,
    val uid: String? = null,
    val source: String? = null,
    val toolCallId: String? = null,
    val beforeState: String? = null,
    val model: String? = null,
    val runtime: String? = null,
    val provenance: String? = null,
    val attribution: String? = null,
    val nativeTurnId: String? = null,
) {
    val reviewOnly get() = partial || beforeBlob == null && beforeState != "absent" && (source == "acp" || tool in listOf("Bash", "Shell"))
    // Mirrors core's captureSummary (integrity.ts): the ambiguous-attribution and turn-id evidence
    // were dropped here, so an overlapping-capture record read as plain "tool capture".
    val captureDescription get() = listOfNotNull(
        if (reviewOnly) "review-only: before-state uncertain"
        else if (attribution == "ambiguous") "overlapping capture: attribution uncertain"
        else if (provenance == "snapshot") "snapshot interval — before/after captured from disk"
        else "tool capture",
        runtime, model?.let { "reported model $it" }, toolCallId?.let { "tool $it" }, nativeTurnId?.let { "turn $it" }
    ).joinToString(" · ")
    val pending get() = status == "pending"
    val kept get() = status == "kept"
    val undone get() = status == "undone"
}

data class SessionInfo(val id: String, val edits: Int, val pending: Int, val lastMs: Long)

/** Structured result of `undo/redo --json` — front-ends branch on [status], never on prose.
 *  [dependents]/[closure] arrive on a named-dependent undo conflict: the later units that rewrote
 *  this change's lines, and the raw id set `undo --ids` takes to revert them together in one call. */
data class UndoResult(
    val ok: Boolean,
    val status: String,
    val message: String,
    val dependents: List<Int> = emptyList(),
    val closure: List<Int> = emptyList(),
) {
    val conflict get() = status == "conflict"
}

/** Lines an edit REMOVED, from `locate --json`. They no longer exist in the buffer, so [anchor] is the
 *  surviving line they now follow (the last line, for a deletion at EOF) and [lines] is the removed text
 *  ready to paint as ghost text. */
data class Deletion(val anchor: Int, val lines: List<String>)

/** An edit's line churn, from `locate --json` — what a lens prints as "+A −R". */
data class Delta(val added: Int, val removed: Int)

/** One edit's geometry in the live buffer, from `locate --json`. [removed] and [delta] are absent from a
 *  pre-0.10 CLI (and [delta] from any placement that renders nothing), so both default to empty. */
data class Placement(
    val id: Int,
    val lines: List<Int>,
    val removed: List<Deletion> = emptyList(),
    val delta: Delta? = null,
)

/** The EXACT wall-clock time of an event, in the reader's zone — port of core's relTime after the
 *  2026-08-31 decision that every "3h ago" becomes the actual time. Precision falls with distance:
 *  today keeps the seconds ("14:32:05"), this year keeps the minute and gains the date
 *  ("Aug 31 14:32"), older keeps only the date ("2025-08-31"). ts 0 stays "—" — an event with no
 *  recorded time is never given an invented one. (The name survives from the relative era.) */
private val REL_MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
fun relTime(ts: Long, now: Long = System.currentTimeMillis()): String {
    if (ts == 0L) return "—"
    val z = java.time.ZoneId.systemDefault()
    val d = java.time.Instant.ofEpochMilli(ts).atZone(z)
    val n = java.time.Instant.ofEpochMilli(now).atZone(z)
    fun p(x: Int) = if (x < 10) "0$x" else "$x"
    return when {
        d.toLocalDate() == n.toLocalDate() -> "${p(d.hour)}:${p(d.minute)}:${p(d.second)}"
        d.year == n.year -> "${REL_MONTHS[d.monthValue - 1]} ${d.dayOfMonth} ${p(d.hour)}:${p(d.minute)}"
        else -> "${d.year}-${p(d.monthValue)}-${p(d.dayOfMonth)}"
    }
}

/** Compact byte size — port of core's `compactBytes` (format.ts): "165.0MB", "488KB", "173B", "1.2GB", so
 *  a session's store footprint reads identically in the picker, the TUI's session blobs and the CLI. ROOT
 *  locale so the decimal is always a dot — a European default would print "165,0MB" and break the match. */
fun compactBytes(n: Long): String = when {
    n >= 1024L * 1024L * 1024L -> String.format(java.util.Locale.ROOT, "%.1fGB", n / (1024.0 * 1024.0 * 1024.0))
    n >= 1024L * 1024L -> String.format(java.util.Locale.ROOT, "%.1fMB", n / (1024.0 * 1024.0))
    n >= 1024L -> "${Math.round(n / 1024.0)}KB"
    n > 0L -> "${n}B"
    else -> "0B"
}
