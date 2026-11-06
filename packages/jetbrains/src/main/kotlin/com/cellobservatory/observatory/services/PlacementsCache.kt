package com.cellobservatory.observatory.services

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.Placement
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.util.concurrency.AppExecutorUtil
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList

private const val MAX_ENTRIES = 300

/** How long the buffer must sit still before a locate is spawned for it. Typing changes the document's
 *  modification stamp on EVERY keystroke, and each new stamp is a cache miss — without this quiet period
 *  a burst of typing spawns one `locate` subprocess per character, all but the last of them describing a
 *  buffer that no longer exists. The overlay keeps its previous lenses while the wait runs (its markers
 *  track the edits), so the delay costs nothing on screen. */
private const val QUIET_MS = 350L

/**
 * Where each pending edit currently sits in a file — the JetBrains analog of the VS Code
 * `cachedPlacements` (extension.ts:617). The mapping itself is the CLI's `locate` (positional
 * double-diff; never re-ported), which is a subprocess — so results are cached and computed in
 * the background: callers get `null` on a miss and a callback fires when fresh placements land.
 *
 * Entries are keyed by (file, textKey, session+log) — NOT per file — because two consumers read
 * the same file through different text sources (the overlay via the live Document, the tree via
 * disk) and a single per-file slot would let them invalidate each other in an endless locate loop.
 */
@Service(Service.Level.PROJECT)
class PlacementsCache(private val project: Project) : Disposable {

    private val cache = ConcurrentHashMap<String, List<Placement>>()
    private val insertionOrder = ConcurrentLinkedQueue<String>()
    private val inflight = ConcurrentHashMap.newKeySet<String>()
    private val listeners = CopyOnWriteArrayList<(String) -> Unit>()
    /** file → the newest key asked for. A scheduled locate that no longer matches has been superseded by
     *  a later keystroke and is dropped rather than run. */
    private val newest = ConcurrentHashMap<String, String>()

    /** Called on the EDT with the file path whenever fresh placements arrive. */
    fun addUpdateListener(l: (String) -> Unit) = listeners.add(l)

    /**
     * Cached placements for [file] against [text], or null if absent — in which case a background
     * locate is scheduled and the update listener fires when it completes. [textKey] must change
     * whenever [text] does (Document modificationStamp, or disk mtime:size).
     */
    fun placementsFor(file: String, text: String, textKey: String): List<Placement>? {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return emptyList()
        val mapped = com.cellobservatory.observatory.ui.RemoteEditorReview.mountedFile(project, file)
        if (service.currentMachine() != null && mapped == null) return emptyList()
        val fileKey = mapped?.remote ?: ClaudePaths.storeKey(file) // hoisted: runs per keystroke-burst placement check
        if (service.reviewRecords().none { (it.pending || mapped != null && it.undone) && it.file == fileKey }) return emptyList()
        // Accepted gap vs VS Code (0.9.0): the sibling keys per-file on the pending CHAIN, so a keep in
        // one file does not re-locate every open file. Here the whole-log key stands because the recompute
        // is already off-thread (pooled, 350ms quiet, superseded-checked) — the VS Code hazard was an EDT
        // stall, which this path structurally lacks; the cost is redundant background locates only.
        val key = "$file|$textKey|${service.currentMachine()}|$session:${if (mapped != null) service.remoteReview()?.lastSuccess else StoreReader.logKey(session)}"
        cache[key]?.let { return it }
        newest[file] = key
        if (inflight.add(key)) {
            AppExecutorUtil.getAppScheduledExecutorService().schedule({
                // Superseded while we waited: the buffer moved on, and the answer for this text would be
                // discarded the moment it landed. Spawning for it would be pure cost.
                if (newest[file] != key || project.isDisposed) {
                    inflight.remove(key)
                    return@schedule
                }
                try {
                    val placements = ObservatoryCli.onMachine(mapped?.machine) { ObservatoryCli.locate(session, fileKey, text, project.basePath, includeUndone = mapped != null) }
                    put(key, placements)
                } finally {
                    inflight.remove(key)
                }
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) listeners.forEach { it(file) }
                }
            }, QUIET_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        }
        return null
    }

    private fun put(key: String, placements: List<Placement>) {
        cache[key] = placements
        insertionOrder.add(key)
        while (cache.size > MAX_ENTRIES) {
            val oldest = insertionOrder.poll() ?: break
            cache.remove(oldest)
        }
    }

    override fun dispose() {
        cache.clear()
        insertionOrder.clear()
        newest.clear()
        listeners.clear()
    }

    companion object {
        fun getInstance(project: Project): PlacementsCache = project.getService(PlacementsCache::class.java)
    }
}
