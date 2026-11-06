package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.model.relTime
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import java.util.concurrent.CopyOnWriteArraySet

/** One background read per saved machine, shared by all projects, lists and worker logs. */
object SavedMachines {
    const val READ_MS = 10_000L
    const val DEADLINE_MS = 45_000
    data class Machine(val label: String, val listing: SessionsResult? = null, val readAt: Long? = null,
        val error: String? = null, val reading: Boolean = true, val nextAt: Long = 0, val syncedAt: Long? = null, val workersRead: Boolean = false) {
        fun status(): String = (when {
            error != null -> "could not list sessions — $error · last read ${readAt?.let { relTime(it) } ?: "never"}"
            listing == null -> "has not answered yet"
            syncedAt != null -> "from records synced ${relTime(syncedAt)}"
            else -> "read ${readAt?.let { relTime(it) } ?: "at a time not recorded"}"
        }) + if (reading) " · reading again…" else ""

    }
    data class Snapshot(val machines: List<Machine>, val error: String?)
    private val lock = Any()
    private var source = ""
    private var labels: List<String>? = null
    private var labelsAt = 0L
    private var labelsReading = false
    private var error: String? = null
    private val machines = LinkedHashMap<String, Machine>()
    private val reviews = HashMap<String, String>()
    val listeners = CopyOnWriteArraySet<Runnable>()
    private val workerViews = java.util.WeakHashMap<javax.swing.JComponent, Unit>()

    /** The actual Workers component knows whether its tab, grouped column and window are showing. */
    fun watchWorkers(view: javax.swing.JComponent) {
        synchronized(lock) { workerViews[view] = Unit }
        view.addHierarchyListener {
            if (it.changeFlags and java.awt.event.HierarchyEvent.SHOWING_CHANGED.toLong() != 0L && view.isShowing) refresh()
        }
    }
    private fun workersVisible(): Boolean = workerViews.keys.any { it.isShowing }


    fun snapshot(): Snapshot = synchronized(lock) { Snapshot(labels.orEmpty().map { machines[it] ?: Machine(it) }, error) }
    private fun changed() { ApplicationManager.getApplication().invokeLater { listeners.forEach { it.run() } } }

    /** Never waits for a child process, including on the EDT. Changing the CLI/config retires its cache. */
    fun refresh(machine: String? = null, session: String? = null) {
        val key = ObservatoryCli.resolveBin() + "\u0000" + ClaudePaths.configDir()
        synchronized(lock) {
            if (source != key) {
                source = key; labels = null; labelsAt = 0; labelsReading = false; error = null; machines.clear(); reviews.clear()
            }
            if (machine != null && session != null) reviews[machine] = session
            if (labelsReading) return
            if (labelsAt > 0 && System.currentTimeMillis() - labelsAt < 30_000) {
                labels.orEmpty().forEach { read(it, key) }
                return
            }
            labelsReading = true
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val r = ObservatoryCli.run(listOf("machine", "list", "--json"))
            val found = runCatching {
                check(r.ok)
                JsonParser.parseString(r.stdout).asJsonArray.mapNotNull { e ->
                    val m = e.asJsonObject
                    if (m.get("enabled")?.asBoolean == false) null
                    else m.get("label")?.asString?.takeIf { it.isNotBlank() }
                }.distinct()
            }.getOrNull()
            synchronized(lock) {
                if (source != key) return@executeOnPooledThread
                if (found != null) { labels = found; error = null; machines.keys.retainAll(found.toSet()) }
                else error = ObservatoryCli.failureMessage(r.stdout, r.stderr, "oak machine list did not answer")
                labelsAt = System.currentTimeMillis(); labelsReading = false
                labels.orEmpty().forEach { read(it, key) }
            }
            changed()
        }
    }

    private fun read(label: String, sourceKey: String) {
        val old = machines[label]
        val workers = workersVisible()
        if (old != null && (old.reading || (System.currentTimeMillis() < old.nextAt && (!workers || old.workersRead)))) return
        machines[label] = (old ?: Machine(label)).copy(reading = true, workersRead = workers)
        val named = reviews[label]?.let { listOf("--session", it) } ?: emptyList()
        ApplicationManager.getApplication().executeOnPooledThread {
            val started = System.currentTimeMillis()
            val r = ObservatoryCli.run(listOf("sessions", "--json") + (if (workers) listOf("--workers") else emptyList()) + named + listOf("--machine", label))
            val parsed = if (r.ok) runCatching {
                check(JsonParser.parseString(r.stdout).asJsonObject.get("sessions")?.isJsonArray == true)
                SessionsParser.parse(r.stdout, localOnly = false)
            }.getOrNull() else null
            synchronized(lock) {
                if (source != sourceKey || label !in labels.orEmpty()) return@executeOnPooledThread
                machines[label] = Machine(label, parsed, if (parsed != null) started else old?.readAt,
                    if (parsed != null) null else ObservatoryCli.failureMessage(r.stdout, r.stderr, "oak sessions --machine $label did not answer"),
                    reading = false, nextAt = System.currentTimeMillis() + maxOf(READ_MS, System.currentTimeMillis() - started),
                    syncedAt = if (parsed == null) null else runCatching { JsonParser.parseString(r.stdout).asJsonObject.get("syncedAt")?.asLong }.getOrNull(), workersRead = workers)
                if (!workers && workersVisible()) read(label, sourceKey)
            }
            changed()
        }
    }
}
