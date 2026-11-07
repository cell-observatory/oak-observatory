package com.cellobservatory.observatory.model

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of `oak sync`'s answers: its status (`oak sync status --json`), a run's result (`oak sync now --json`)
 * and setup's (`oak sync setup --json`). The CLI is the backend, and keeps sync's settings in prefs.json: this plugin
 * renders what it says and runs it to change them, and keeps no copy.
 */

/** One machine's line of the last run. [text] is what `oak sync status` prints after the machine's label. */
data class SyncLine(
    val label: String,
    val status: String,
    val detail: String?,
    val text: String?,
    val errors: List<String>,
    /** `unclaimed` or `other` on a backup folder's line that refused its record under this machine's name. */
    val record: String?,
) {
    /** A failure: a machine left out on purpose (disabled, excluded, the same as another, another account's) is none. */
    val failed: Boolean get() = errors.isNotEmpty() || status !in setOf("ok", "disabled", "excluded", "duplicate", "shared")

    /** In the CLI's words (an older CLI gives no [text]). */
    val said: String get() = text ?: detail ?: status
}

/** An open conflict: another machine's copy of a file, kept beside this machine's [file] (null where sync does not
 *  reach it) at [copy]. */
data class SyncConflict(val id: String, val family: String, val name: String, val from: String, val file: String?, val copy: String, val reason: String) {
    /** How it is resolved, as `oak inbox` says it: a diverged session only by deleting the copy. */
    val resolution: String get() = if (reason == "diverged") "delete the copy to keep yours" else "edit your file or delete the copy"
}

/** The project `oak sync status --root <folder>` names: its folder, its key as `oak sync exclude` keys it, and whether it
 *  is excluded here. */
data class SyncProject(val folder: String, val key: String, val excluded: Boolean)

data class SyncView(
    val setUp: Boolean,
    val auto: Boolean,
    val running: Boolean,
    val lastAt: Long?,
    val lastStatus: String?,
    val lastError: String?,
    val lines: List<SyncLine>,
    val warnings: List<String>,
    /** `machine` or `folder`, or null with no backup. */
    val backupKind: String?,
    val backupLabel: String?,
    val backupPath: String?,
    val keyPresent: Boolean,
    val keyFingerprint: String?,
    val keyError: String?,
    val conflicts: List<SyncConflict>,
    val excludeMachines: List<String>,
    val excludeProjects: List<String>,
    /** The project in the folder the status was read for (`--root`); null from a CLI before it. */
    val project: SyncProject? = null,
) {
    /** Sync is in use here: a run set it up, a backup is chosen, or a conflict is open. A machine that never chose to sync
     *  is shown nothing of it. */
    val inUse: Boolean get() = setUp || backupKind != null || conflicts.isNotEmpty()

    /** The backup folder's own line of the last run (`backup (<path>)`), while that folder is the backup: the line a run
     *  left for a folder no longer chosen says nothing of the backup now, nor which record to take over. */
    val backupLine: SyncLine? get() = if (backupKind == "folder") lines.firstOrNull { it.label == "backup ($backupPath)" } else null

    val failed: Boolean get() = lastError != null || lines.any { it.failed }

    /** The backup and its state, in a phrase. */
    val backupText: String
        get() = when (backupKind) {
            null -> "none: each session stays on the machine that made it"
            "machine" -> "the saved machine $backupLabel"
            else -> "the encrypted folder $backupPath, " + if (keyPresent) "key $keyFingerprint" else "no key here" + (keyError?.let { " ($it)" } ?: "")
        }

    /** The last run (or the one going on now), in a phrase. */
    val runText: String
        get() = if (running) "running now" else if (lastAt != null) "last run ${relTime(lastAt)} ($lastStatus)" else "no run yet"
}

private fun JsonObject.str(k: String): String? = get(k)?.takeIf { it.isJsonPrimitive }?.asString
private fun JsonObject.bool(k: String): Boolean = get(k)?.takeIf { it.isJsonPrimitive }?.asBoolean == true
private fun JsonObject.obj(k: String): JsonObject? = get(k)?.takeIf { it.isJsonObject }?.asJsonObject
private fun JsonObject.strings(k: String): List<String> =
    get(k)?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { e: JsonElement -> e.takeIf { it.isJsonPrimitive }?.asString } ?: emptyList()

object SyncStatusParser {
    /** `oak sync status --json`; null for anything else (no CLI, an older one, garbage). */
    fun parse(json: String?): SyncView? {
        if (json.isNullOrBlank()) return null
        return try {
            val o = JsonParser.parseString(json).takeIf { it.isJsonObject }?.asJsonObject ?: return null
            if (o.get("syncStatus")?.takeIf { it.isJsonPrimitive }?.asInt != 1) return null
            val last = o.obj("last")
            val backup = o.obj("backup")
            val key = o.obj("key")
            val exclude = o.obj("exclude")
            SyncView(
                setUp = o.bool("setUp"),
                auto = o.bool("auto"),
                running = o.bool("running"),
                lastAt = last?.get("at")?.takeIf { it.isJsonPrimitive }?.asLong,
                lastStatus = last?.str("status"),
                lastError = last?.str("error"),
                lines = last?.get("machines")?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { e ->
                    val m = e.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                    SyncLine(m.str("label") ?: return@mapNotNull null, m.str("status") ?: "", m.str("detail"), m.str("text"), m.strings("errors"), m.str("record"))
                } ?: emptyList(),
                warnings = last?.strings("warnings") ?: emptyList(),
                backupKind = backup?.str("kind"),
                backupLabel = backup?.str("label"),
                backupPath = backup?.str("path"),
                keyPresent = key?.bool("present") == true,
                keyFingerprint = key?.str("fingerprint"),
                keyError = key?.str("error"),
                conflicts = o.get("conflicts")?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { e ->
                    val c = e.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                    SyncConflict(c.str("id") ?: return@mapNotNull null, c.str("family") ?: "", c.str("name") ?: "", c.str("from") ?: "", c.str("file"), c.str("copy") ?: "", c.str("reason") ?: "")
                } ?: emptyList(),
                excludeMachines = exclude?.strings("machines") ?: emptyList(),
                excludeProjects = exclude?.strings("projects") ?: emptyList(),
                project = o.obj("project")?.let { p -> SyncProject(p.str("folder") ?: return@let null, p.str("key") ?: return@let null, p.bool("excluded")) },
            )
        } catch (_: Exception) {
            null
        }
    }
}

/** The status bar's words: the last run, or the one going on now, and what needs the reader (a conflict, a failure). */
fun syncItemText(v: SyncView): String {
    val n = v.conflicts.size
    return "OAK sync" + when {
        v.running -> ": running now"
        n > 0 -> ": $n conflict${if (n == 1) "" else "s"}"
        v.failed && v.lastAt != null -> ": failed ${relTime(v.lastAt)}"
        v.lastAt != null -> " ${relTime(v.lastAt)}"
        else -> ""
    }
}

/** The status bar's tooltip, a line each, every line whole: the run, each machine's line in the CLI's words, the
 *  backup, the conflicts and the warnings. */
fun syncTooltipLines(v: SyncView): List<String> = buildList {
    add("OAK sync · ${v.runText} · background ${if (v.auto) "on" else "off"}")
    v.lastError?.let { add("the run stopped: $it") }
    v.lines.forEach { add("${it.label}: ${it.said}") }
    add("backup: ${v.backupText}")
    if (v.conflicts.isNotEmpty()) add("${v.conflicts.size} open conflict${if (v.conflicts.size == 1) "" else "s"}: the Overview's Sessions tab has ${if (v.conflicts.size == 1) "it" else "them"}")
    v.warnings.forEach { add("warning: $it") }
    add("Click for its actions and settings.")
}

/** One row of the machines-and-projects choice: what `oak sync include|exclude` is given, how the row reads, and whether
 *  it syncs now (ticked). */
data class SyncChoice(val arg: String, val text: String, val synced: Boolean)

/** The rows: each saved machine (and one excluded before it left herdr's list), this project ([SyncView.project]), and
 *  each other project excluded before, by its key. */
fun syncChoices(saved: List<String>, v: SyncView?): List<SyncChoice> {
    val offM = v?.excludeMachines.orEmpty()
    val here = v?.project
    return (saved + offM).distinct().map { SyncChoice(it, "$it (saved machine)", it !in offM) } +
        listOfNotNull(here?.let { SyncChoice(it.folder, "this project (${it.folder})", !it.excluded) }) +
        v?.excludeProjects.orEmpty().filter { it != here?.key }.map { SyncChoice(it, "$it (project)", false) }
}

/** What a run did, in a sentence: what it pulled, the conflicts it left, each machine that failed in the CLI's words, and
 *  the run's warnings, as `oak sync now` prints them (`oak sync now --json`); null when that is not what [json] is. */
data class SyncRunSaid(val text: String, val failed: Boolean)

object SyncNowParser {
    fun parse(json: String?): SyncRunSaid? {
        if (json.isNullOrBlank()) return null
        return try {
            val o = JsonParser.parseString(json).takeIf { it.isJsonObject }?.asJsonObject ?: return null
            if (o.get("syncNow")?.takeIf { it.isJsonPrimitive }?.asInt != 1) return null
            if (o.str("status") == "busy") return SyncRunSaid("another oak sync is running on this machine; it pulls the same", false)
            val done = o.get("done")?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject } ?: emptyList()
            val pulled = done.filter { it.str("action") != "conflict" && it.str("action") != "skipped" }
            val conflicts = done.count { it.str("action") == "conflict" }
            val bad = o.get("machines")?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { e ->
                val m = e.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                SyncLine(m.str("label") ?: "", m.str("status") ?: "", m.str("detail"), null, m.strings("errors"), m.str("record"))
            }?.filter { it.failed } ?: emptyList()
            val bytes = pulled.sumOf { it.get("bytes")?.takeIf { b -> b.isJsonPrimitive }?.asLong ?: 0L }
            val got = if (pulled.isNotEmpty()) "pulled ${pulled.size} file${if (pulled.size == 1) "" else "s"}, ${compactBytes(bytes)}"
                else if (o.str("status") == "ok") "nothing to pull" else "nothing pulled"
            val parts = listOf(got) + (if (conflicts > 0) listOf("$conflicts conflict${if (conflicts == 1) "" else "s"}, in the Overview's Sessions tab") else emptyList()) +
                bad.map { "${it.label}: ${it.errors.firstOrNull() ?: it.detail ?: it.status}" } + o.strings("warnings").map { "warning: $it" }
            SyncRunSaid(parts.joinToString("; "), bad.isNotEmpty())
        } catch (_: Exception) {
            null
        }
    }
}

/** `oak sync setup --json`: what was set up, or that the folder needs its key from elsewhere ([needsKey], [error]). */
data class SyncSetupAnswer(
    val needsKey: Boolean,
    val error: String?,
    /** With [needsKey]: this machine's own key, which one brought for the folder replaces (`--replace`); null with none. */
    val keyHere: String? = null,
    val backupKind: String?,
    val backupLabel: String?,
    val backupPath: String?,
    val keyFingerprint: String?,
    val keyMade: Boolean,
    val keyImported: Boolean,
    /** The folder's record under this machine's name: `none`, `mine`, `unclaimed` or `other`. */
    val recordState: String?,
    val recordLastWrite: String?,
    val recordClaimed: Boolean,
    /** The files a first run here would pull, and their bytes; null when no plan was made. */
    val planPulls: Int?,
    val planBytes: Long,
    val planError: String?,
) {
    /** A record this machine has not written, not taken over: setup asks whether this machine is a reinstall. */
    val asksRestore: Boolean get() = (recordState == "unclaimed" || recordState == "other") && !recordClaimed

    /** What is set up, as setup's last line says it. */
    val what: String
        get() = when (backupKind) {
            null -> "no backup: each session stays on the machine that made it"
            "machine" -> "the backup is $backupLabel"
            else -> "the backup is the encrypted folder $backupPath" + (keyFingerprint?.let { " (key $it)" } ?: "")
        }

    /** What else setup says: a new key's advice, a key kept, a record taken over, and the first run's preview. */
    val notes: List<String>
        get() = listOfNotNull(
            if (keyMade) "A new backup key was made here. Keep a copy where you keep passwords (oak sync key --show, in a terminal): without it the backup cannot be read. On each of your other machines, run oak sync setup --folder <the folder’s path there> --key-from <the label that machine saved this one under> --replace (a key that machine kept for another folder is kept beside this one), or set sync up there." else null,
            if (keyImported) "The backup key $keyFingerprint is kept here now." else null,
            if (recordClaimed) "This machine took the folder’s record over: the next run restores its sessions from it." else null,
            if (asksRestore) "The folder holds a record under this machine’s name that this machine has not written (${recordLastWrite ?: "by another machine"}): until this machine takes it over (oak sync setup --restore), nothing is restored from the folder or written to it." else null,
            // A plan made without the backup folder says why, unless the note above said all of it (a record this machine
            // never wrote; another machine's writer, or a copy of this one's, is said here); only no plan at all was not made.
            planPulls?.let {
                "A first run here would pull ${if (it > 0) "$it file${if (it == 1) "" else "s"}, ${compactBytes(planBytes)}" else "nothing"}." +
                    (planError?.takeIf { !(asksRestore && recordState == "unclaimed") }?.let { e -> " The backup folder cannot be used: ${e.removeSuffix(".")}." } ?: "")
            } ?: planError?.let { "The first plan could not be made: $it" },
        )
}

object SyncSetupParser {
    fun parse(json: String?): SyncSetupAnswer? {
        if (json.isNullOrBlank()) return null
        return try {
            val o = JsonParser.parseString(json).takeIf { it.isJsonObject }?.asJsonObject ?: return null
            if (o.get("syncSetup")?.takeIf { it.isJsonPrimitive }?.asInt != 1) return null
            val backup = o.obj("backup")
            val key = o.obj("key")
            val record = o.obj("record")
            val me = o.obj("plan")?.get("machines")?.takeIf { it.isJsonArray }?.asJsonArray?.firstOrNull()?.takeIf { it.isJsonObject }?.asJsonObject
            val pulls = me?.get("pulls")?.takeIf { it.isJsonArray }?.asJsonArray
            SyncSetupAnswer(
                needsKey = o.bool("needsKey"),
                error = o.str("error"),
                keyHere = o.str("keyHere"),
                backupKind = backup?.str("kind"),
                backupLabel = backup?.str("label"),
                backupPath = backup?.str("path"),
                keyFingerprint = key?.str("fingerprint"),
                keyMade = key?.bool("made") == true,
                keyImported = key?.bool("imported") == true,
                recordState = record?.str("state"),
                recordLastWrite = record?.str("lastWrite"),
                recordClaimed = record?.bool("claimed") == true,
                planPulls = pulls?.size(),
                planBytes = pulls?.sumOf { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.get("bytes")?.takeIf { b -> b.isJsonPrimitive }?.asLong ?: 0L } ?: 0L,
                planError = o.str("planError"),
            )
        } catch (_: Exception) {
            null
        }
    }
}

/** What deleting a session purges and what `oak sessions --undelete` brings back, as `oak sessions --delete` says it
 *  (core's deleteWords): its edits for good, or, with a backup folder set (which keeps its copy of the session's store),
 *  here only, and the next `oak sync now` after an undelete brings back what of them the folder holds. */
data class DeleteWords(val folder: Boolean, val purged: String, val after: String)

fun deleteWords(folder: Boolean): DeleteWords =
    if (folder) DeleteWords(true, "here (the backup folder keeps its copy)", "and the next oak sync now brings back what of its edits the backup folder holds")
    else DeleteWords(false, "for good", "without its edits")
