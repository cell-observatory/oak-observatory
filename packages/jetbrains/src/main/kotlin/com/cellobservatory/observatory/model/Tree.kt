package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's EditTree view-model, parsed from `oak tree --json`.
 * Folder compaction, class grouping, exact deltas, and Search filtering are all computed server-side
 * in core.buildEditTree — this plugin only renders the result (no more local tree/class logic).
 */
data class TreeEditNode(val rec: EditRecord, val added: Int, val removed: Int)
data class TreeClassNode(val name: String, val edits: List<TreeEditNode>)
data class TreeFileNode(
    val rel: String,
    val file: String,
    val classes: List<TreeClassNode>,
    val loose: List<TreeEditNode>,
    val maxTs: Long = 0L, // most-recent edit time — the "N min ago" column + time sort
    val ext: String = "", // extension filter key
    val category: String = "other", // file-type filter key
) {
    /** Every edit under this file (class-grouped + loose), for the file-scoped Undo-All action. */
    val allEdits: List<EditRecord> get() = classes.flatMap { c -> c.edits.map { it.rec } } + loose.map { it.rec }
}
data class TreeFolderNode(val label: String, val path: String, val folders: List<TreeFolderNode>, val files: List<TreeFileNode>) {
    /** Every edit at-or-beneath this folder — for the folder-scoped Accept / Revert / Clear actions. */
    val allEdits: List<EditRecord> get() = files.flatMap { it.allEdits } + folders.flatMap { it.allEdits }
}
/** @property hiddenIds every record inside a chain that cancels out — what no count may include.
 *  Rides this payload rather than a spawn of its own: the plugin's status bar, nav axes and
 *  project-view badges are derived from the raw store, so they need the same set the tree was built
 *  with or they contradict it. Empty from an older CLI, which degrades to the previous behaviour. */
data class EditTree(
    val folders: List<TreeFolderNode>,
    val files: List<TreeFileNode>,
    val hiddenIds: Set<Int> = emptySet(),
)

object TreeParser {
    fun parse(json: String): EditTree? = try {
        val o = JsonParser.parseString(json).asJsonObject
        EditTree(
            o.getAsJsonArray("folders").map { folder(it.asJsonObject) },
            o.getAsJsonArray("files").map { file(it.asJsonObject) },
            o.getAsJsonArray("hiddenIds")?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asInt }?.toSet() ?: emptySet(),
        )
    } catch (_: Exception) {
        null
    }

    private fun folder(o: JsonObject): TreeFolderNode = TreeFolderNode(
        o.get("label").asString,
        o.get("path")?.takeIf { !it.isJsonNull }?.asString ?: "", // tolerate an older CLI that predates the field
        o.getAsJsonArray("folders").map { folder(it.asJsonObject) },
        o.getAsJsonArray("files").map { file(it.asJsonObject) },
    )

    private fun file(o: JsonObject): TreeFileNode = TreeFileNode(
        o.get("rel").asString,
        o.get("file").asString,
        o.getAsJsonArray("classes").map { cls(it.asJsonObject) },
        o.getAsJsonArray("loose").map { edit(it.asJsonObject) },
        o.get("maxTs")?.takeIf { !it.isJsonNull }?.asLong ?: 0L,
        o.get("ext")?.takeIf { !it.isJsonNull }?.asString ?: "",
        o.get("category")?.takeIf { !it.isJsonNull }?.asString ?: "other",
    )

    private fun cls(o: JsonObject): TreeClassNode =
        TreeClassNode(o.get("name").asString, o.getAsJsonArray("edits").map { edit(it.asJsonObject) })

    private fun edit(o: JsonObject): TreeEditNode {
        val rec = EditRecord(
            o.get("id").asInt,
            o.get("ts").asLong,
            o.get("tool").asString,
            o.get("file").asString,
            o.get("beforeBlob").let { if (it.isJsonNull) null else it.asString },
            o.get("afterBlob").let { if (it.isJsonNull) null else it.asString },
            o.get("status").asString,
            partial = o.get("partial")?.let { !it.isJsonNull && it.asBoolean } ?: false,
        )
        return TreeEditNode(rec, o.get("added").asInt, o.get("removed").asInt)
    }
}
