package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's guided-tour script, parsed from `oak demo --tour --json`.
 *
 * The script is NOT written here. It lives in core (`packages/core/src/tour.ts`) so the CLI's printed
 * tour, the VS Code panel and this one are the same tour — a step added to a panel reaches every editor
 * at once, and none of them can drift into its own wording.
 *
 * Unknown values degrade rather than throw: a `view` or `anchor` this plugin build has never heard of
 * parses fine and simply activates nothing, so a newer CLI can name a surface an older plugin lacks and
 * the step still reads.
 */
data class DemoStep(
    val id: String,
    val title: String,
    val body: String,
    /** 'overview' | 'prompts' | 'stats' | 'edits' | 'diffs' | 'fileHistory' | 'actions' | 'observations' | 'feed' | 'editor' */
    val view: String,
    /** The Overview left-nav tab, when [view] is 'overview'. */
    val tab: String?,
    /** A one-line gloss of the panel this step is about, rendered in the TOUR WINDOW under the body —
     *  never inside the panel itself (see the note on core's DemoStep.tip). */
    val tip: String?,
    /** One control in that view to highlight — see the anchor names in core's tour module. */
    val anchor: String?,
    /** One concrete thing the reader can do from where they are standing. */
    val tryIt: String?,
    /** What this step asks the reader to do, or does on their behalf. Null for a step that only reads. */
    val action: DemoAction?,
)

/**
 * A step's action. `wait` pauses until the reader does it and the tour detects it; `auto` performs it and
 * narrates. An unrecognized `mode` is treated as a WAIT with no watcher — inert text — never as `auto`:
 * a plugin must not execute something because it failed to recognize a value.
 */
data class DemoAction(
    val mode: String,
    val kind: String,
    val hint: String,
    /** Past tense; present only on `auto`. */
    val done: String?,
)

object TourParser {
    /** Steps from `demo --tour --json`, or an empty list when the payload is unusable (an older CLI on
     *  PATH, a failed spawn): a tour that cannot be read is reported by its caller, never half-rendered. */
    fun parse(json: String): List<DemoStep> = try {
        (JsonParser.parseString(json).asJsonObject.getAsJsonArray("steps") ?: com.google.gson.JsonArray())
            .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.let(::step) }
            .filter { it.id.isNotBlank() && it.title.isNotBlank() }
    } catch (_: Exception) {
        emptyList()
    }

    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString

    private fun step(o: JsonObject) = DemoStep(
        id = str(o, "id") ?: "",
        title = str(o, "title") ?: "",
        body = str(o, "body") ?: "",
        view = str(o, "view") ?: "",
        tab = str(o, "tab"),
        tip = str(o, "tip"),
        anchor = str(o, "anchor"),
        tryIt = str(o, "tryIt"),
        action = o.getAsJsonObject("action")?.let {
            DemoAction(
                mode = str(it, "mode") ?: "wait",
                kind = str(it, "kind") ?: "",
                hint = str(it, "hint") ?: "",
                done = str(it, "done"),
            )
        },
    )
}
