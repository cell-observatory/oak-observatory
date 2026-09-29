package com.cellobservatory.observatory.model

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of `oak review --prompt <id> --json --no-patch` — ONE ask's work as
 * review UNITS. No patch field: the plugin's Review tab is a LIST, every diff renders in the editor
 * from the store's blobs, so this parser mirrors only what the panel consumes (the CLI still emits
 * patches without `--no-patch`, for CLI consumers).
 *
 * This payload is where the plugin gets core's same-code collapse at all: everywhere else it reads raw
 * records off disk (StoreReader), and a unit — repeated edits to the same code, combined, bounded by
 * the ask that produced them — exists only in core.
 */
data class ReviewUnit(
    /** The unit's display id — its newest member. `keep`/`undo` on it resolve the whole unit. */
    val id: Int,
    /** Every RAW record id in the unit, ascending. What `--ids` mutations must act on. */
    val members: List<Int>,
    val file: String,
    val rel: String,
    val tool: String,
    val status: String,
    val ts: Long,
    val added: Int,
    val removed: Int,
    /** Review-only: the before-content never arrived (ACP) or is uncertain, so undo refuses and
     *  keep works. Marked BEFORE the reader acts, not explained after (parity with VS Code's badge
     *  and the store-backed tree). The wire carries `partial:true` only when set. */
    val partial: Boolean = false,
    /** core.captureSummary for the unit's record — the authoritative capture-evidence string
     *  (fidelity · runtime · model · tool · turn). Rendered verbatim rather than re-derived. */
    val capture: String = "",
) {
    val pending: Boolean get() = status == "pending"
}

data class ReviewPromptHead(
    val id: String,
    val index: Int,
    val ts: Long,
    val endTs: Long,
    val title: String,
    val text: String,
)

data class ReviewResult(
    val session: String,
    /** Null for the session-wide answer (no `--prompt`) — the Review tab's default view. */
    val prompt: ReviewPromptHead?,
    val units: List<ReviewUnit>,
    /** Chains that CANCEL OUT — created then deleted, or put back. Never rows: the panel accounts
     *  for them in one footer whose Dismiss keeps [cancelledIds] at once. */
    val cancelled: List<ReviewUnit>,
    /** Every raw record id behind [cancelled] — what Dismiss acts on. */
    val cancelledIds: List<Int>,
    /** Every cancelled member at ANY status — what the tree must not draw. A superset of
     *  [cancelledIds]: dismissing keeps those records, and a chain that goes nowhere is still
     *  nothing to look at once it has been decided. */
    val hiddenIds: List<Int>,
    /** Every RAW id across the units, group-expanded and ascending — the whole ask's mutation set. */
    val ids: List<Int>,
    val unitCount: Int,
    val pending: Int,
    val added: Int,
    val removed: Int,
    /** Named omissions (budget cuts, ids with no record). NEVER silently empty when something was cut. */
    val errors: List<String>,
)

object ReviewParser {
    fun parse(json: String): ReviewResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        // A null prompt is the legitimate session-wide answer; garbage is the payload that carries
        // NEITHER an ask nor a unit list — that is no answer at all.
        val p = o.get("prompt")?.takeIf { it.isJsonObject }?.asJsonObject
        if (p == null && o.getAsJsonArray("units") == null) return null
        val sum = o.getAsJsonObject("summary")
        ReviewResult(
            session = str(o, "session") ?: "",
            prompt = p?.let {
                ReviewPromptHead(
                    id = str(it, "id") ?: "",
                    index = int(it, "index"),
                    ts = long(it, "ts"),
                    endTs = long(it, "endTs"),
                    title = str(it, "title")?.takeIf { t -> t.isNotBlank() } ?: (str(it, "text") ?: ""),
                    text = str(it, "text") ?: "",
                )
            },
            units = (o.getAsJsonArray("units") ?: JsonArray())
                .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.let(::unit) },
            cancelled = (o.getAsJsonArray("cancelled") ?: JsonArray())
                .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.let(::unit) },
            cancelledIds = ints(o, "cancelledIds"),
            // An older CLI has no `hiddenIds`; falling back to the dismissible set keeps the tree
            // exactly as honest as that build could make it, rather than hiding nothing.
            hiddenIds = ints(o, "hiddenIds").ifEmpty { ints(o, "cancelledIds") },
            ids = ints(o, "ids"),
            unitCount = sum?.let { int(it, "units") } ?: 0,
            pending = sum?.let { int(it, "pending") } ?: 0,
            added = sum?.let { int(it, "added") } ?: 0,
            removed = sum?.let { int(it, "removed") } ?: 0,
            errors = strs(o, "errors"),
        )
    } catch (_: Exception) {
        null
    }

    private fun unit(o: JsonObject) = ReviewUnit(
        id = int(o, "id"),
        members = ints(o, "members").ifEmpty { listOf(int(o, "id")) },
        file = str(o, "file") ?: "",
        rel = str(o, "rel")?.takeIf { it.isNotBlank() } ?: (str(o, "file") ?: ""),
        tool = str(o, "tool") ?: "",
        status = str(o, "status") ?: "pending",
        ts = long(o, "ts"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        partial = o.get("partial")?.let { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean && it.asBoolean } ?: false,
        capture = str(o, "capture") ?: "",
    )

    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L
    private fun ints(o: JsonObject, k: String): List<Int> =
        o.getAsJsonArray(k)?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asInt } ?: emptyList()
    private fun strs(o: JsonObject, k: String): List<String> =
        o.getAsJsonArray(k)?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString } ?: emptyList()
}
