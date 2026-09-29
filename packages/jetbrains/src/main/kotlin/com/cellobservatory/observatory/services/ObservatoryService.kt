package com.cellobservatory.observatory.services

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.core.StoreWatcher
import com.cellobservatory.observatory.core.TranscriptWatcher
import com.cellobservatory.observatory.model.AuditParser
import com.cellobservatory.observatory.model.ChangeMap
import com.cellobservatory.observatory.model.ChangeMapParser
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.EditTree
import com.cellobservatory.observatory.model.Feed
import com.cellobservatory.observatory.model.FeedParser
import com.cellobservatory.observatory.model.MultitaskParser
import com.cellobservatory.observatory.model.MultitaskResult
import com.cellobservatory.observatory.model.Observations
import com.cellobservatory.observatory.model.ObservationsParser
import com.cellobservatory.observatory.model.ProcessesParser
import com.cellobservatory.observatory.model.ProcessesResult
import com.cellobservatory.observatory.model.PromptsParser
import com.cellobservatory.observatory.model.PromptsResult
import com.cellobservatory.observatory.model.SessionAudit
import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.model.TreeParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.util.concurrency.EdtScheduledExecutorService
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Project-level hub: resolves the active session for this project's root, caches the folded log
 * on the (mtime,size) key, and fans out refresh events (store watcher → trees, status bar, …).
 */
/** The four sort-order keys, in cycle order — the Kotlin peer of core.SORT_KEYS. */
internal val OAK_SORT_KEYS = listOf("time", "time-asc", "name", "name-desc")

@Service(Service.Level.PROJECT)
class ObservatoryService(private val project: Project) : Disposable {
    private val listeners = CopyOnWriteArrayList<Runnable>()
    // @Volatile because this pair is now read from BACKGROUND threads: ~20 toolbar actions moved to
    // ActionUpdateThread.BGT in 0.8.9 and every one of them calls log()/counts(). Two threads could
    // otherwise interleave the value/key writes and leave one session's log labelled with another
    // session's key, which then sticks until the key moves again.
    @Volatile private var cachedLog: List<EditRecord> = emptyList()
    @Volatile private var cachedKey: String = ""

    /** Memo for [pinStillExists] — currentSession() is hot (per cell renderer), the check is IO. */
    @Volatile private var checkedPin: Pair<String, Boolean>? = null
    private val pinLock = Any()

    /**
     * Validate a persisted pin against disk, ONCE per pin value (re-checked on [refresh], which
     * already re-resolves the session). On a PROVEN absence — no store dir and no transcript in any
     * project; [StoreReader.sessionExists] errs toward true on IO trouble — the pin is cleared so
     * settings and pickers agree, and the reader is told once why the observatory moved.
     */
    private fun pinStillExists(pin: String): Boolean {
        checkedPin?.let { (id, ok) -> if (id == pin) return ok }
        synchronized(pinLock) {
            checkedPin?.let { (id, ok) -> if (id == pin) return ok }
            val ok = StoreReader.sessionExists(pin)
            checkedPin = pin to ok
            if (!ok) {
                // Compare-and-clear: a picker may have re-pinned while this check's IO was in
                // flight, and clearing unconditionally would throw away that fresh, valid pick.
                val st = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
                if (st.session == pin) st.session = null
                // One balloon per stale pin for the whole IDE — the pin is application-wide, so
                // every open project's service detects the same one, and each would otherwise say it.
                if (staleNotifiedPins.add(pin)) {
                    ApplicationManager.getApplication().invokeLater {
                        if (!project.isDisposed) {
                            com.cellobservatory.observatory.ui.ReviewOps.notify(
                                project,
                                "Pinned session ${pin.take(8)} no longer exists on this machine (no store " +
                                    "or transcript found) — following the newest session again.",
                                com.intellij.notification.NotificationType.WARNING,
                            )
                        }
                    }
                }
            }
            return ok
        }
    }
    private val watchListener = Runnable { refresh() }

    /** True while a coalesced repaint is queued on the EDT — see [notifyListeners]. */
    private val repaintQueued = AtomicBoolean(false)

    init {
        StoreWatcher.instance.addListener(watchListener)
        // Store watcher only fires on EDITS; the transcript watcher fires on transcript growth (reads,
        // bash, subagent spawns, to-dos) so Actions/Observations/Timeline/Overview/Multitasking stay live.
        TranscriptWatcher.getInstance(project).addListener(watchListener)
    }

    val workspaceRoot: String? get() = project.basePath

    /**
     * Demo mode's session, held in MEMORY and deliberately never written to settings. Persisting it
     * would leave a pin behind after a crash pointing at a session demo cleanup has since deleted,
     * which shows as every panel being permanently empty for a non-obvious reason. Auto-resolution
     * already lands on a running demo unaided (its transcript is the newest); this is the guard against
     * a real agent session starting mid-tour.
     */
    @Volatile
    var demoSessionOverride: String? = null
        set(value) {
            field = value
            refresh(force = true)
        }

    fun currentSession(): String? {
        demoSessionOverride?.takeIf { it.isNotBlank() }?.let { return it }
        // A pinned session (Switch Session / settings) wins over auto-resolution — lets you review a
        // demo session or any past session instead of just the newest for this workspace. But only
        // while it still EXISTS: the pin is persisted and application-wide, so a session deleted
        // after pinning (demo Exit, `clean --drop`) otherwise blanks every panel in every project
        // for a non-obvious reason — the exact failure the demo override's in-memory design above
        // exists to avoid. A stale pin is dropped (with a notification) and auto-resolution resumes.
        com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.session
            ?.takeIf { it.isNotBlank() }
            ?.let { pin -> if (pinStillExists(pin)) return pin }
        if (workspaceRoot == null) return null
        // The CLI owns provenance and auto-selection. A cold listing starts off the UI thread;
        // an answered null stays null, including a project containing only mirrored transcripts.
        return (peekSessions() ?: sessionsFetch.get(""))?.active
    }

    @Volatile private var pendingByFile: Map<String, Int> = emptyMap()
    @Volatile private var pendingFilesCache: List<String> = emptyList()

    /** Folded log for the current session, cached on the log file's (mtime,size). */
    fun log(): List<EditRecord> {
        val session = currentSession() ?: run {
            pendingByFile = emptyMap()
            pendingFilesCache = emptyList()
            return emptyList()
        }
        val key = "$session:${StoreReader.logKey(session)}"
        if (key != cachedKey) {
            cachedLog = StoreReader.readLog(session)
            pendingByFile = cachedLog.filter { it.pending && !isHidden(it) }.groupingBy { it.file }.eachCount() // for the Project-view decorator
            // …and the FILE AXIS, derived here for the same reason: it was recomputed by every caller
            // on every toolbar tick — a filter, a distinct and a SORT over every record in the session
            // — and there are a lot of callers. The floating bar alone expands 14 actions per tick, the
            // status-bar nav bar and the editor banner ask again, and three of them had their own copy
            // of the expression. One derivation, cached on the same key as the log it comes from.
            pendingFilesCache = cachedLog.filter { it.pending && !isHidden(it) }.map { it.file }.distinct().sorted()
            cachedKey = key
        }
        return cachedLog
    }

    /**
     * Every file with pending edits, distinct and path-sorted — THE File axis, for the status-bar nav
     * bar, the floating review bar and the editor banner.
     *
     * `log()` first, so the cache is current: this is derived there, and reading the field without
     * that would answer from the previous session after a switch.
     */
    fun pendingFiles(): List<String> {
        log()
        return pendingFilesCache
    }

    /** Pending-edit count for a file path — O(1), cached with the log (drives the Project-view badge).
     *  The badge hands over VirtualFile paths, so bridge to the store key (#43). */
    fun pendingCount(path: String): Int {
        log() // ensure the cache is current
        return pendingByFile[ClaudePaths.storeKey(path)] ?: 0
    }

    // Review-loop cursor: id of the pending edit last opened, so repeated ←/→ invocations step
    // backward/forward through every pending edit (wrapping at the ends). Shared by the toolbar
    // buttons, the ⌥⌘N/⌥⌘P actions, the status-bar cluster, and the editor banner.
    @Volatile private var reviewCursorId: Int? = null

    /** The pending edit the review cursor is parked on (null when unset or no longer pending) —
     *  the anchor for the editor banner's per-edit Keep/Undo. */
    fun currentPendingEdit(): EditRecord? = reviewCursorId?.let { id -> log().find { it.id == id && it.pending } }

    /**
     * Move the review cursor without navigating.
     *
     * The floating review bar's ‹/› and the auto-advance after a resolve both have to step from a KNOWN
     * position, and both are outside this class. Giving them their own cursor is what produced the
     * three-cursor drift VS Code documents; they park this one instead. A plain volatile write, so it is
     * callable from a background action `update()`/`actionPerformed` as well as the EDT.
     */
    fun parkReviewCursor(id: Int?) {
        reviewCursorId = id
    }

    /** Next pending edit in the review loop, advancing the cursor. Returns null when none are pending. */
    fun nextPendingEdit(): EditRecord? = stepPendingEdit(1)

    /** Previous pending edit in the review loop, retreating the cursor. Returns null when none are pending. */
    fun prevPendingEdit(): EditRecord? = stepPendingEdit(-1)

    private fun stepPendingEdit(dir: Int): EditRecord? {
        // Step review UNITS, not raw records. `tree --json` already carries core's collapse (its edit
        // rows are unit representatives), so filtering the raw walk to ids the tree shows makes this
        // cursor visit each combined change ONCE — the other two front ends already did, and stepping
        // through a unit's superseded members one by one was this plugin's last raw-record surface.
        // With no tree yet (first refresh, or a CLI too old to answer), the raw walk is the honest
        // fallback: visiting more stops loses nothing, where visiting none would strand the cursor.
        val reps = editTree()?.let { t -> (t.files.flatMap { it.allEdits } + t.folders.flatMap { it.allEdits }).map { it.id }.toSet() }
        val all = log().filter { it.pending }
        val pending = (if (reps.isNullOrEmpty()) all else all.filter { it.id in reps }.ifEmpty { all }).sortedBy { it.id }
        if (pending.isEmpty()) {
            reviewCursorId = null
            return null
        }
        val cursor = reviewCursorId
        val idx = if (cursor == null) -1 else pending.indexOfFirst { it.id == cursor }
        val next = when {
            idx >= 0 -> pending[(idx + dir + pending.size) % pending.size]     // step ±1, wrapping at the ends
            cursor == null -> if (dir > 0) pending.first() else pending.last()  // first review: oldest (→) / newest (←)
            dir > 0 -> pending.firstOrNull { it.id > cursor } ?: pending.first() // resolved — resume just past it
            else -> pending.lastOrNull { it.id < cursor } ?: pending.last()
        }
        reviewCursorId = next.id
        return next
    }

    // Active "Search edits" filter — shared across the Edits and Diffs trees so they filter together
    // (parity with the VS Code module-level filter). Matches on workspace-relative path.
    @Volatile var filterQuery: String = ""
        private set
    // The rest of the filter control: extension/type narrowing, session-transient like the Search
    // query. Applied on top of filterQuery by the ledger and the Review tree, so all surfaces narrow
    // together (parity with VS Code's module-level spec). There is no regex flag — the query reads as
    // a regex on its own when it carries regex syntax.
    @Volatile var filterExts: List<String> = emptyList()
        private set
    @Volatile var filterCats: List<String> = emptyList()
        private set

    /** Set the Search filter and re-render every surface. Empty/blank clears it. */
    fun setFilter(query: String) {
        filterQuery = query.trim()
        refresh()
    }
    /** Alias the inline toolbar's search field and its Clear call, so the intent reads at the call site. */
    fun setFilterQuery(query: String) = setFilter(query)

    /** Set the extension/type part of the filter and re-render. (Regex is automatic — no flag.) */
    fun setFilterSpec(exts: List<String>, cats: List<String>) {
        filterExts = exts
        filterCats = cats
        refresh()
    }

    /** True when anything narrows the file lists — for the "filter active" affordance. */
    fun filterActive(): Boolean = filterQuery.isNotBlank() || filterExts.isNotEmpty() || filterCats.isNotEmpty()

    /** A query is read as a regex the moment it carries regex syntax — a dot or slash is NOT a signal
     *  (they sit in every literal path). Kotlin peer of core.isRegexQuery. */
    private fun isRegexQuery(q: String): Boolean = q.any { it in "^\$*+?()[]{}|\\" }

    /** The shared match predicate (query/ext/type over one file's path). Kotlin peer of
     *  core.matchesFileFilter: the query is a case-insensitive regex when it carries regex syntax, a
     *  substring otherwise; a pattern that will not compile falls back to substring. */
    fun matchesFile(rel: String, ext: String, category: String): Boolean {
        val q = filterQuery
        if (q.isNotBlank()) {
            val ok = if (isRegexQuery(q))
                runCatching { Regex(q, RegexOption.IGNORE_CASE).containsMatchIn(rel) }.getOrElse { rel.contains(q, ignoreCase = true) }
            else rel.contains(q, ignoreCase = true)
            if (!ok) return false
        }
        if (filterExts.isNotEmpty() && !filterExts.contains(ext)) return false
        if (filterCats.isNotEmpty() && !filterCats.contains(category)) return false
        return true
    }

    /** A one-line summary of what the filter narrows by — the query (shown /…/ when a live regex,
     *  quoted when literal), then the type buckets and extensions. Empty when nothing is applied.
     *  Backs the Filter button's "what is applied" label. */
    fun filterSummary(): String {
        val bits = ArrayList<String>()
        val q = filterQuery.trim()
        if (q.isNotEmpty()) bits.add(if (isRegexQuery(q)) "/$q/" else "\"$q\"")
        for (c in filterCats) bits.add(when (c) { "code" -> "Code"; "tests" -> "Tests"; "config" -> "Config"; "docs" -> "Docs"; "styles" -> "Styles"; else -> "Other" })
        for (e in filterExts) bits.add(".$e")
        return bits.joinToString(", ")
    }

    /** The sort order (persisted in settings) — one of the four keys, with `time` as the fallback for
     *  any unknown / legacy value. Kotlin peer of core.SortKey / normalizeSort. */
    fun sortKey(): String {
        val raw = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.overviewSort
        return if (raw in OAK_SORT_KEYS) raw else "time"
    }
    fun setSortKey(key: String) {
        com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.overviewSort = if (key in OAK_SORT_KEYS) key else "time"
        refresh()
    }
    /** Label for the sort dropdown row, one per key. */
    fun sortLabel(key: String): String = when (key) {
        "time-asc" -> "Time (oldest first)"
        "name" -> "Name (A→Z)"
        "name-desc" -> "Name (Z→A)"
        else -> "Time (newest first)"
    }

    // Edit-tree view-model from the CLI `tree --json` (the single source; VS Code renders the same
    // core.buildEditTree). Folder compaction, class grouping, exact deltas, and Search filtering all
    // happen server-side. Fetched in the background, cached on session+filter+log key; primes itself
    // on first read and repaints when it lands.
    @Volatile private var editTreeCache: EditTree? = null
    @Volatile private var editTreeKey: String = ""

    /** True while the LAST `tree --json` spawn failed — so an empty Review tree can say "the CLI did
     *  not answer" instead of the silently-wrong "no edits in this session yet". Cleared by the next
     *  fetch that lands (each refresh retries). */
    @Volatile var treeFetchFailed: Boolean = false
        private set

    /** When that failure landed — retries hold off for a few seconds, because the failure repaint
     *  itself re-enters [refreshEditTree] via [editTree], and an unthrottled loop would spawn the
     *  missing CLI forever. */
    @Volatile private var failedTreeAt: Long = 0L

    /**
     * Records inside a chain that CANCELS OUT — a file created then deleted, or an edit put back.
     * They are not decisions, so no count, badge, axis or lens may include them: this plugin derives
     * those from the raw store, and without the set they contradicted the very tree they sit beside
     * (status bar "5", Review tree "1"). Filled by `tree --json`; empty until the first one lands,
     * which is the pre-0.9.4 behaviour rather than a wrong answer of its own.
     */
    @Volatile var hiddenIds: Set<Int> = emptySet()
        private set

    /** True when this record is one of the above — the single test every derived count uses. */
    fun isHidden(rec: EditRecord): Boolean = hiddenIds.isNotEmpty() && rec.id in hiddenIds

    fun editTree(): EditTree? {
        refreshEditTree()
        return editTreeCache
    }

    private fun refreshEditTree() {
        val session = currentSession() ?: run {
            editTreeCache = null
            // No session is not a fetch failure — a flag left over from one would make the empty
            // tree claim "the CLI did not answer" about a project with nothing to ask it for.
            treeFetchFailed = false
            failedTreeAt = 0L
            return
        }
        // The CLI applies a SUBSTRING query; regex/extension/type narrowing is client-side (over the
        // parsed tree, in EditsTreePanel), so when the query is a regex the CLI fetches the full tree
        // and the client filters it. The key tracks the CLI-side filter only — client-side changes
        // just re-render.
        val cliFilter = if (isRegexQuery(filterQuery)) "" else filterQuery
        val key = "$session|$cliFilter|${StoreReader.logKey(session)}"
        if (key == editTreeKey) return
        if (failedTreeAt != 0L && System.currentTimeMillis() - failedTreeAt < 5_000) return // failure backoff
        editTreeKey = key // claim this fetch so rapid refreshes don't stack
        ApplicationManager.getApplication().executeOnPooledThread {
            val parsed = ObservatoryCli.treeJson(session, workspaceRoot, cliFilter)?.let { TreeParser.parse(it) }
            // Ignore a result the key has already moved past: a mutation re-keys mid-flight and starts a
            // second fetch, and the two land in whatever order the CLI finishes them — an older answer
            // winning would park a pre-mutation tree in the cache that nothing would refetch.
            if (editTreeKey != key) return@executeOnPooledThread
            if (parsed == null) {
                editTreeKey = "" // fetch failed — retry on the next refresh (held off by the backoff)
                failedTreeAt = System.currentTimeMillis()
                treeFetchFailed = true
                notifyListeners() // repaint so the tree's empty state can SAY the CLI failed
            } else {
                failedTreeAt = 0L
                treeFetchFailed = false
                editTreeCache = parsed
                // Publish the set BEFORE the fan-out, so the counts every listener recomputes below
                // agree with the tree that just landed rather than lagging it by one tick.
                if (parsed.hiddenIds != hiddenIds) {
                    hiddenIds = parsed.hiddenIds
                    cachedKey = "" // the derived pending caches were built with the previous set
                }
                ApplicationManager.getApplication().invokeLater { listeners.forEach { it.run() } }
            }
        }
    }

    // --- Shared throttled CLI views (0.8.0 stabilization) -------------------------------------------
    // One refresh() cycle used to spawn ~4 CLI processes (ChangeMapPanel: multitask + changemap;
    // ActionsPanel: multitask again; ObservationsPanel: observations) as often as every ~2s during
    // active work. Each view below is fetched at most once per MIN_FETCH_MS, shared by every panel
    // (multitask now spawns once per window, not twice), and fanned out via the listener ring when it
    // lands — VS Code parity: its Overview webview self-throttles its spawns at 3s.

    private inner class ThrottledFetch<T : Any>(private val fetch: (String) -> T?) {
        @Volatile var value: T? = null
            private set
        /** True once a fetch has COMPLETED at least once, successfully or not. A null [value] means two
         *  very different things — "not asked yet" and "asked, and the CLI could not answer" — and a
         *  panel that blurs them states as fact something it never observed. */
        @Volatile var attempted = false
            private set
        @Volatile private var fetchedKey = ""
        @Volatile private var fetchedAt = 0L
        @Volatile private var inFlight = false
        /** Consecutive failures, for the back-off below. Reset the moment one succeeds. */
        @Volatile private var misses = 0

        /** A refresh that must NOT be dropped — armed by the Refresh button and by [refresh]`(force=true)`
         *  after a MUTATION. It outlives an in-flight spawn on purpose: see [spawn]. */
        @Volatile private var forced = false

        /** Arm a forced refresh without asking for the value (the mutation path — the panel's next
         *  [get] on the same tick then spawns even if the throttle window has not elapsed). */
        fun forceNext() {
            forced = true
        }

        /** Latest cached view (possibly null before the first fetch lands); kicks a background refresh
         *  when stale. `force` bypasses the throttle (the toolbar Refresh button). */
        fun get(key: String, force: Boolean = false): T? {
            if (force) forced = true
            val now = System.currentTimeMillis()
            // Back off after failures instead of re-asking every three seconds forever. A view that
            // cannot answer usually cannot answer for a reason that will still be true in three seconds
            // (an unbuildable session, a CLI that is not there), and retrying at full cadence turns one
            // broken view into a permanently busy core. Doubles to a minute, and any success clears it.
            val wait = if (misses == 0) MIN_FETCH_MS else minOf(MIN_FETCH_MS shl minOf(misses, 5), 60_000L)
            val stale = key != fetchedKey || now - fetchedAt >= wait
            if (!inFlight && (stale || forced)) spawn(key)
            return value
        }

        private fun spawn(key: String) {
            inFlight = true
            forced = false // this spawn answers the pending force…
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val v = fetch(key)
                    fetchedAt = System.currentTimeMillis() // set on failure too — back off, don't spin
                    if (v != null) {
                        misses = 0
                        value = v
                        fetchedKey = key
                        notifyListeners()
                    } else {
                        misses++
                    }
                } finally {
                    attempted = true
                    inFlight = false
                    // …but a force that arrived WHILE this ran asked about a state this spawn could not
                    // have seen — it started BEFORE the mutation. Dropping it (the old `!inFlight` guard
                    // did) let the stale answer stand, which is how the panel kept showing pre-mutation
                    // pending/accepted counts after Clear Resolved. Re-run instead.
                    if (forced) ApplicationManager.getApplication().invokeLater { get(key) }
                }
            }
        }
    }

    // Keyed on the ACTIVE session and pinned with it: `multitask --json` decides its `self` fleet row and
    // its session-scoped sections (actions, tasks) from --session, so a pinned session must be passed or
    // every one of those keeps describing whatever the CLI resolves as newest for the cwd.
    private val multitaskFetch = ThrottledFetch { session ->
        ObservatoryCli.multitaskJson(session.takeIf { it.isNotBlank() }, workspaceRoot)?.let { MultitaskParser.parse(it) }
    }
    private val changemapFetch = ThrottledFetch { session ->
        ObservatoryCli.changemapJson(session, workspaceRoot)?.let { ChangeMapParser.parse(it) }
    }
    private val observationsFetch = ThrottledFetch { session ->
        ObservatoryCli.observationsJson(session, workspaceRoot)?.let { ObservationsParser.parse(it) }
    }
    private val processesFetch = ThrottledFetch { session ->
        ObservatoryCli.processesJson(session, workspaceRoot)?.let { ProcessesParser.parse(it) }
    }
    // The user's own turns (0.8.7) — the Overview's first nav tab AND the Prompt review axis. Rides the
    // same throttled tick as every other view; never a timer of its own.
    private val promptsFetch = ThrottledFetch { session ->
        ObservatoryCli.promptsJson(session, workspaceRoot)?.let { PromptsParser.parse(it) }
    }
    // Every session in this workspace, newest CONVERSATION first (0.8.8) — the Overview's Sessions tab
    // and the Switch Session popup read the same rows. Cheap by construction in core (stats + a bounded,
    // sidecar-cached title scan; no store log is parsed), so it rides the shared tick like any other view.
    /** One balloon per raised hand: session id → the attention ts already announced. */
    private val attnNotified = java.util.concurrent.ConcurrentHashMap<String, Long>()
    /** One DESKTOP hand-off per raised hand (idle-done included — the reader's prefs decide in core). */
    private val attnDesktop = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val sessionsFetch = ThrottledFetch { session ->
        ObservatoryCli.sessionsJson(workspaceRoot, session.takeIf { it.isNotBlank() }, buildBatch = true)?.let { SessionsParser.parse(it) }?.let { r ->
            // ATTENTION: a session whose agent raised its hand — a question, a
            // permission ask, an input wait — balloons ONCE per raise (keyed by the attention ts).
            // idle-done stays quiet: shown by the panels, never announced.
            for (row in r.sessions) {
                val a = row.attention ?: continue
                // …and the DESKTOP announcement (2026-09-15): core's once-per-machine claim decides,
                // reached through the CLI, off this fetch thread so a slow notifier never delays the rows.
                if ((attnDesktop[row.id] ?: 0L) < a.ts) {
                    attnDesktop[row.id] = a.ts
                    val wd = workspaceRoot
                    ApplicationManager.getApplication().executeOnPooledThread {
                        ObservatoryCli.notifyHand(row.id, a.kind, a.ts, row.title, a.message, row.agent, wd)
                    }
                }
                if (a.kind == "idle-done") continue
                if ((attnNotified[row.id] ?: 0L) >= a.ts) continue
                attnNotified[row.id] = a.ts
                val label = com.cellobservatory.observatory.model.attentionLabel(a.kind)
                val name = row.title?.takeIf { it.isNotBlank() } ?: ("session " + row.id.take(8))
                com.cellobservatory.observatory.ui.ReviewOps.notify(
                    project,
                    "“$name” $label" + (a.message.takeIf { it.isNotBlank() }?.let { " — $it" } ?: ""),
                    com.intellij.notification.NotificationType.WARNING,
                )
            }
            r
        }
    }
    // The folded footprint's two surviving facts (0.8.7): the writes that left the workspace (`risk`) and
    // the reads that did (`egress`'s `file` channels). Neither rides the shared multitask payload, so both
    // are fetched here — in ONE throttled slot, on the panel's existing refresh tick, never a new timer.
    private val auditFetch = ThrottledFetch { session ->
        val risk = ObservatoryCli.riskJson(session, workspaceRoot)
        val egress = ObservatoryCli.egressJson(session, workspaceRoot)
        if (risk == null || egress == null) null else AuditParser.parse(risk, egress)
    }

    /** Which feed to tail. Carries the SESSION as well as core's ref, because a fleet row can name a
     *  sibling session rather than this project's active one. [limit] is how deep the tail reads —
     *  part of the key, so the Feed tab's "load more" is a NEW fetch, never a stale cache hit. */
    data class FeedRef(val session: String, val kind: String, val id: String, val limit: Int = FEED_LIMIT) {
        internal val key: String get() = listOf(session, kind, id, limit.toString()).joinToString(KEY_SEP)
    }

    /** One shared slot serves every feed, so the cached tail carries the ref it was fetched FOR — a tail
     *  that landed for a previous selection must never be handed back under the new one. ONE consumer
     *  (the Timeline's FeedPanel, 0.10.0): a second surface asking for a different ref every tick would
     *  key-thrash the slot into a spawn per call. */
    private val feedFetch = ThrottledFetch { key ->
        val p = key.split(KEY_SEP)
        ObservatoryCli.feedJson(p[0], p[1], p[2], p[3].toIntOrNull() ?: FEED_LIMIT, workspaceRoot)
            ?.let { FeedParser.parse(it) }
            // The rows' inline diffs are built HERE, on this pooled thread: a log read plus two blob
            // reads and a line comparison per edit, which the Feed tab used to do on the EDT.
            ?.let { key to it.copy(previews = com.cellobservatory.observatory.ui.DiffPreviews.forFeed(p[0], it.entries)) }
    }

    /**
     * The Overview's feed SUBJECT — what its nav last selected (a worker session, a subagent, a
     * workflow run, a task, a background shell), published for the Timeline's Feed tab to follow.
     * Null = nothing picked, and the Feed tab shows the reviewed session's own feed. [forSession]
     * remembers which session the pick belonged to, so a session switch drops it. The precedent is
     * [selectedPromptId] below: shared cross-window selection, setter notifies every surface.
     */
    data class FeedSel(val ref: FeedRef, val forSession: String?)
    @Volatile var selectedFeed: FeedSel? = null
        set(value) {
            if (field == value) return
            field = value
            notifyListeners()
        }

    /** The shared `multitask --json` view (fleet + workflows + curated actions). Keyed on the active
     *  session so a session switch refetches immediately. */
    fun multitask(force: Boolean = false): MultitaskResult? = multitaskFetch.get(currentSession() ?: "", force)

    /** The shared `changemap --json` view (the Overview detail). */
    fun changemap(force: Boolean = false): ChangeMap? = currentSession()?.let { changemapFetch.get(it, force) }

    /** The shared `observations --json` view-model. */
    fun observations(force: Boolean = false): Observations? = currentSession()?.let { observationsFetch.get(it, force) }

    /** The shared `risk` + `egress` audit view — the Actions surface's out-of-workspace writes and its
     *  full destination list (incl. the `file` reads that left the workspace). */
    fun audit(force: Boolean = false): SessionAudit? = currentSession()?.let { auditFetch.get(it, force) }

    /** The shared `processes --json` view (the Overview's Processes tab). */
    fun processes(force: Boolean = false): ProcessesResult? = currentSession()?.let { processesFetch.get(it, force) }

    /** True once a `processes --json` fetch has completed — with [processes] null, this separates "still
     *  reading" from "this CLI cannot answer for background shells" (an older one on PATH). */
    val processesAttempted: Boolean get() = processesFetch.attempted

    /** The shared `prompts --json` view (the Overview's Prompts tab + the Prompt review axis). */
    fun prompts(force: Boolean = false): PromptsResult? = currentSession()?.let { promptsFetch.get(it, force) }

    /** The shared `sessions --json` view (the Overview's Sessions tab). Keyed on the active session so
     *  switching re-marks which row is live. */
    fun sessions(force: Boolean = false): SessionsResult? = sessionsFetch.get(currentSession() ?: "", force)

    /**
     * The last `sessions --json` answer, or null when none has landed — and it NEVER spawns.
     *
     * For callers that run in an action `update()`, where a spawn is measured per toolbar tick. Nothing
     * polls this view: [sessions] is its only fetcher and ChangeMapPanel is its only caller, so the slot
     * stays null until the Dashboards window has been opened once. A caller must therefore render an
     * unknown state rather than wait on it, and prime the fetch from `actionPerformed`.
     */
    fun peekSessions(): SessionsResult? = sessionsFetch.value

    /** True once a `sessions --json` fetch has completed — with [sessions] null, this separates "still
     *  reading" from "this CLI cannot answer for sessions" (an older one on PATH). */
    val sessionsAttempted: Boolean get() = sessionsFetch.attempted

    /** True once a `prompts --json` fetch has completed — with [prompts] null, this separates "still
     *  reading" from "this CLI cannot answer for prompts" (an older one on PATH). */
    val promptsAttempted: Boolean get() = promptsFetch.attempted

    /**
     * The ask picked in the Prompts window — the SCOPE every other dashboard narrows to (0.8.7).
     *
     * It lives on the service rather than in either panel because two windows have to agree about it:
     * the Prompts window owns the pick, the Overview filters its fleet · runs · tasks · shells and its
     * whole change map by it, and either one can clear it. Setting it re-renders every registered
     * surface through the existing listener path — no new channel, no new timer.
     */
    var selectedPromptId: String? = null
        set(value) {
            if (field == value) return
            field = value
            notifyListeners()
        }

    /** One-shot: the Prompts window asks the Feed tab to seat its feed on an ask's ANSWER
     * Consumed by [takeResponseJump] on the next listener pass. */
    @Volatile private var responseJumpId: String? = null
    fun requestResponseJump(promptId: String) {
        responseJumpId = promptId
        notifyListeners()
    }
    fun takeResponseJump(): String? {
        val v = responseJumpId
        if (v != null) responseJumpId = null
        return v
    }

    /**
     * The `feed --json` tail for [ref], on the same throttled path as every other view — the panel gets
     * its feed on its existing refresh tick, no extra timer.
     *
     * An 'audit' feed is a RECORD of something that already finished, so it is fetched once and then
     * left alone: re-polling a completed run would spend a CLI spawn per tick to re-read a file that
     * can no longer change. `force` (the Refresh button) still refetches.
     */
    fun feed(ref: FeedRef, force: Boolean = false): Feed? {
        val loaded = feedFetch.value?.takeIf { it.first == ref.key }?.second
        if (!force && loaded != null && !loaded.live) return loaded
        return feedFetch.get(ref.key, force)?.takeIf { it.first == ref.key }?.second
    }

    data class Counts(val pending: Int, val kept: Int, val undone: Int, val oldestPendingTs: Long?)

    fun counts(): Counts {
        // Cancelled-out chains are not work at any status — the same rule the Review tree, the change
        // map and every VS Code counter follow. Without this the status bar read 5 where the tree read 1.
        val log = log().filter { !isHidden(it) }
        return Counts(
            pending = log.count { it.pending },
            kept = log.count { it.kept },
            undone = log.count { it.undone },
            oldestPendingTs = log.filter { it.pending }.minOfOrNull { it.ts },
        )
    }

    fun addListener(l: Runnable) = listeners.add(l)
    fun removeListener(l: Runnable) = listeners.remove(l)

    /**
     * Invalidate caches and re-render every registered surface. Call on the EDT.
     *
     * [force] is for MUTATIONS (keep/undo/redo/clear): their refresh must never be swallowed by the
     * throttle, and must never be answered by a spawn that started BEFORE the mutation — either one
     * leaves the panel stating pre-mutation counts as current fact. Watcher-driven refreshes stay
     * throttled: they fire on every transcript byte.
     */
    fun refresh(force: Boolean = false) {
        cachedKey = "" // force re-read
        checkedPin = null // …and re-validate a pin (a re-pinned or re-created session must not stay condemned)
        if (force) {
            // A forced refresh follows a MUTATION. The batched views are cached for ~2.5 s, so without
            // this the Overview would repaint with pre-mutation counts while the Edits tree — which reads
            // the store directly — already showed the new ones: the two panels disagreeing on screen.
            ObservatoryCli.invalidateViewBatch()
            sharedViews.forEach { it.forceNext() }
            // …and the tree's failure backoff yields to it: "must never be swallowed" includes the
            // user's own Refresh right after installing the CLI this backoff is waiting out.
            failedTreeAt = 0L
        }
        refreshEditTree() // kick a background tree fetch; repaints when it lands
        notifyListeners()
        warmRecentSessions()
    }

    /**
     * A USER Refresh: sweep a newly-added `.observatoryignore` for the reviewed session, THEN run [then]
     * (the panel's own refresh). Adding the ignore file fires no capture hook, so the capture-time sweep
     * never runs and a plain refresh — a read — leaves the now-ignored records in the store.
     * The sweep is `dropIgnored` (self-gating, a no-op when nothing matches) via the CLI, on a
     * background thread; [then] runs on the EDT once it finishes. NEVER wire this to the file-watch tick —
     * only to a button — since it rewrites the store and must not race the auto readers.
     */
    fun sweepIgnoredThen(then: () -> Unit) {
        val session = currentSession()
        if (session == null) { then(); return }
        com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit {
            ObservatoryCli.ignoreSweep(project.basePath, session)
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) then()
            }
        }
    }

    /** When this project last pre-built its recent sessions, so an idle IDE does not loop on it. */
    @Volatile private var warmedAt = 0L

    /**
     * Spend idle time pre-building the sessions you are likely to switch to (0.9.0).
     *
     * Detached and rate-limited to once every ten minutes: the point is to remove the 6.2 s a cold switch
     * used to cost, not to add a background job that competes with the refresh that just ran.
     */
    private fun warmRecentSessions() {
        val now = System.currentTimeMillis()
        if (now - warmedAt < 10 * 60_000L) return
        warmedAt = now
        ApplicationManager.getApplication().executeOnPooledThread { ObservatoryCli.warmRecent(project.basePath) }
    }

    /**
     * Fan a repaint out to every registered surface, coalescing bursts (0.8.8).
     *
     * Eight throttled CLI views land within milliseconds of each other on a single refresh tick, and each
     * landing used to rebuild all six registered panels synchronously — dozens of full Swing rebuilds per
     * tick, every one of them discarded by the next. The first notification now schedules one repaint on
     * the EDT and every notification arriving before it runs folds into that repaint; the delay is far
     * below the threshold where a repaint reads as delayed, and no notification is ever dropped.
     */
    private fun notifyListeners() {
        if (!repaintQueued.compareAndSet(false, true)) return
        EdtScheduledExecutorService.getInstance().schedule({
            repaintQueued.set(false)
            if (!project.isDisposed) {
                // Per-listener isolation: one throwing listener must not abort the fan-out — that
                // failure mode starved every later-registered panel of repaints and blanked the
                // whole product (field failure, 2026-08-20: a panel that died mid-construction had
                // already registered, and its NPE ate everyone behind it). LOG.error keeps the bug
                // LOUD: the test framework turns it into a failure, production logs a SEVERE per
                // tick — a broken panel, not a broken product.
                listeners.forEach {
                    try {
                        it.run()
                    } catch (e: Throwable) {
                        LOG.error("observatory listener failed — its panel is broken, siblings continue", e)
                    }
                }
            }
        }, NOTIFY_COALESCE_MS, TimeUnit.MILLISECONDS)
    }

    /** Every shared throttled view, so a forced refresh reaches all of them (feeds included — a reverted
     *  edit changes what the selected row's window shows). */
    private val sharedViews: List<ThrottledFetch<*>>
        get() = listOf(
            multitaskFetch, changemapFetch, observationsFetch, processesFetch,
            promptsFetch, sessionsFetch, auditFetch, feedFetch,
        )

    override fun dispose() {
        StoreWatcher.instance.removeListener(watchListener)
        TranscriptWatcher.getInstance(project).removeListener(watchListener)
    }

    companion object {
        private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance(ObservatoryService::class.java)

        fun getInstance(project: Project): ObservatoryService = project.getService(ObservatoryService::class.java)

        /** Stale pins already announced this run — shared across the per-project services, see
         *  [pinStillExists]. */
        private val staleNotifiedPins: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

        /** Minimum interval between spawns of the same CLI view (matches VS Code's Overview throttle). */
        private const val MIN_FETCH_MS = 3_000L

        /** Window over which listener notifications collapse into one repaint (see [notifyListeners]). */
        private const val NOTIFY_COALESCE_MS = 90L

        /** Feed rows per fetch — enough scrollback to be useful, bounded so a busy agent's tail stays
         *  cheap to post on every tick. Anything older comes back as the feed's `truncated` count.
         *  Internal: the FeedPanel's base depth (its load-more grows a per-subject copy of it). */
        internal const val FEED_LIMIT = 80

        /** Field separator for the feed's composite cache key (session · kind · id) — a control char, so
         *  no id can ever split into the wrong fields. */
        private const val KEY_SEP = "\u0000"
    }
}

/**
 * The pre-rename plugin's retirement, apart from [ObservatoryStartup] so a test can drive it: the startup
 * skips it in unit-test and headless runs, and the three platform calls are swappable. It only ever
 * DISABLES the old id; nothing in this plugin enables or installs it again.
 */
internal object OldPluginRetirement {
    val OLD_ID: com.intellij.openapi.extensions.PluginId = com.intellij.openapi.extensions.PluginId.getId("com.cell-observatory.claude-observatory")

    enum class Outcome { ABSENT, ALREADY_DISABLED, DISABLED, REFUSED }

    @Volatile internal var installed: () -> Boolean = { com.intellij.ide.plugins.PluginManagerCore.getPlugin(OLD_ID) != null }
    @Volatile internal var disabled: () -> Boolean = { com.intellij.ide.plugins.PluginManagerCore.isDisabled(OLD_ID) }
    @Volatile internal var disable: () -> Unit = { com.intellij.ide.plugins.PluginEnabler.getInstance().disableById(setOf(OLD_ID)) }

    /**
     * Disable the old plugin when it is installed and still enabled. An old plugin already disabled (the
     * run after the restart this asks for) is left alone, so the retirement cannot loop.
     *
     * disableById's Boolean answers "unloaded dynamically, no restart needed" — NOT "disable succeeded":
     * the disabled state is persisted unconditionally before the dynamic-unload attempt (verified against
     * 2025.2's DynamicPluginEnabler bytecode). So the only real failure is the call THROWING; a
     * false return still wants the restart offer — more so, since the old plugin is then still resident.
     */
    fun retire(): Outcome = when {
        !installed() -> Outcome.ABSENT
        disabled() -> Outcome.ALREADY_DISABLED
        runCatching { disable() }.isSuccess -> Outcome.DISABLED
        else -> Outcome.REFUSED
    }
}

/** Startup: arm the watcher and the inline overlay even before the tool window is first opened. */
class ObservatoryStartup : ProjectActivity {

    /** One shot per IDE run — [retireOldPlugin] is application-level work in a per-project activity. */
    private companion object {
        val oldPluginChecked = java.util.concurrent.atomic.AtomicBoolean(false)
    }

    /**
     * 0.10.0 renamed the plugin id (com.cell-observatory.claude-observatory → …oak-observatory), and
     * the platform treats the pre-rename install as a SEPARATE plugin — both then race to register
     * the SAME tool-window and action ids, and the loser's registrations are dropped: the visible
     * symptom is an empty or half-working Observatory window with nothing naming the cause. (VS
     * Code's activate has carried this guard since its own 0.8.6 rename.) Disable the old one and
     * offer the restart that unloads it; if the platform refuses, name what to uninstall by hand.
     */
    private fun retireOldPlugin(project: Project) {
        if (!oldPluginChecked.compareAndSet(false, true)) return
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        if (app.isUnitTestMode || app.isHeadlessEnvironment) return
        val outcome = OldPluginRetirement.retire()
        if (outcome == OldPluginRetirement.Outcome.ABSENT || outcome == OldPluginRetirement.Outcome.ALREADY_DISABLED) return
        val group = com.intellij.notification.NotificationGroupManager.getInstance().getNotificationGroup("OAK")
        if (outcome == OldPluginRetirement.Outcome.DISABLED) {
            group.createNotification(
                "Claude Observatory is OAK now — the old plugin was disabled (both register the same " +
                    "windows and actions, and the two fight). Restart to finish.",
                com.intellij.notification.NotificationType.WARNING,
            ).addAction(com.intellij.notification.NotificationAction.createSimpleExpiring("Restart now") {
                com.intellij.openapi.application.ApplicationManager.getApplication().restart()
            }).notify(project)
        } else {
            group.createNotification(
                "OAK is installed twice: the old \"Claude Observatory\" plugin is still enabled and " +
                    "registers the same windows and actions. Uninstall it in Settings → Plugins, then restart.",
                com.intellij.notification.NotificationType.WARNING,
            ).notify(project)
        }
    }

    override suspend fun execute(project: Project) {
        ObservatoryService.getInstance(project)
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) {
                retireOldPlugin(project)
                com.cellobservatory.observatory.ui.inline.InlineOverlay.getInstance(project).install()
                val svc = ObservatoryService.getInstance(project)
                // Keep the editor-top review banner live: re-run the notification provider on every store change.
                val notifications = com.intellij.ui.EditorNotifications.getInstance(project)
                svc.addListener { notifications.updateAllNotifications() }
                // Tool-window stripe badge: overlay a dot while edits are pending (parity with VS Code's title count).
                val updateBadge = Runnable {
                    com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                        .getToolWindow("Observatory Traces")
                        ?.setIcon(com.cellobservatory.observatory.ui.Icons.toolWindowIcon(svc.counts().pending))
                }
                svc.addListener(updateBadge)
                updateBadge.run()
                // Re-run the Project-view decorator (pending-edit badges) on each store change; keep the
                // tree expansion so it never collapses under the user.
                svc.addListener {
                    if (!project.isDisposed) {
                        com.intellij.ide.projectView.ProjectView.getInstance(project).currentProjectViewPane?.updateFromRoot(true)
                    }
                }
                offerDemo(project)
            }
        }
    }

    /**
     * Offer the demo on a first install and after an update, once, with a way to decline for good.
     *
     * Every gate matters, and the last one most: an unsolicited notification that interrupts a live
     * agent session is worse than never offering, so a busy project is skipped WITHOUT stamping the
     * version — it is offered next launch, when the reader is idle.
     */
    private fun offerDemo(project: Project) {
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        if (app.isUnitTestMode || app.isHeadlessEnvironment) return
        // The demo WRITES into the reader's project. Never offer that in a project they have not trusted
        // (VS Code gates on workspace.isTrusted for the same reason).
        if (!com.intellij.ide.trustedProjects.TrustedProjects.isProjectTrusted(project)) return
        val state = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        if (state.demoOfferNever) return
        val current = com.intellij.ide.plugins.PluginManagerCore
            .getPlugin(com.intellij.openapi.extensions.PluginId.getId("com.cell-observatory.oak-observatory"))
            ?.version ?: return
        if (state.demoOfferLastSeenVersion == current) return
        val root = project.basePath ?: return
        // An empty version stamp cannot tell a fresh install from an upgrade on its own.
        val kind = if (state.demoOfferLastSeenVersion != null || state.everRan) "update" else "install"

        val busy = {
            val id = ObservatoryService.getInstance(project).currentSession()
            if (id == null || com.cellobservatory.observatory.core.ObservatoryCli.isDemoSession(id)) false
            else runCatching {
                val f = java.io.File(com.cellobservatory.observatory.core.ClaudePaths.projectDir(root).toFile(), "$id.jsonl")
                f.exists() && System.currentTimeMillis() - f.lastModified() <= 5 * 60_000
            }.getOrDefault(false)
        }
        // Stamped only once we are actually going to ask. Setting it above the busy gate turned a reader's
        // FIRST EVER offer into the "is now 0.8.9" update copy: launch one stamps everRan and returns
        // without stamping the version, and launch two then computes kind == "update".
        if (busy()) return // and deliberately NOT stamped — try again next launch
        state.everRan = true

        // A balloon at t=0 on a cold IDE is hostile; startup is already doing enough.
        com.intellij.util.concurrency.EdtScheduledExecutorService.getInstance().schedule({
            if (project.isDisposed || busy()) return@schedule
            // The action below hides itself once a demo is on disk (StartDemoAction.update), so offering
            // then would show a balloon with nothing to press. Stamp and stay quiet: they have already
            // found it.
            if (com.cellobservatory.observatory.ui.ReviewOps.demoPresent(project)) {
                state.demoOfferLastSeenVersion = current
                return@schedule
            }
            state.demoOfferLastSeenVersion = current // stamp BEFORE showing: an ignored balloon never re-asks
            val text = if (kind == "install") {
                "OAK is installed. There is nothing to set up to look around: the demo replays a real agent session through the real capture pipeline in about twenty seconds, every button in it works, and leaving removes every trace."
            } else {
                "OAK is now $current. The guided tour walks what changed alongside everything else — the demo replays in about twenty seconds and removes every trace when you leave."
            }
            com.intellij.notification.NotificationGroupManager.getInstance()
                .getNotificationGroup("OAK")
                .createNotification(text, com.intellij.notification.NotificationType.INFORMATION)
                // startDemo replays AND then tours: there is no demo yet, so the tour alone would walk
                // the reader through an empty product.
                .addAction(com.intellij.notification.NotificationAction.createSimpleExpiring("Take the tour") {
                    com.cellobservatory.observatory.ui.ReviewOps.startDemo(project)
                })
                .addAction(com.intellij.notification.NotificationAction.createSimpleExpiring("Never ask") {
                    com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.demoOfferNever = true
                })
                .notify(project)
        }, 4, java.util.concurrent.TimeUnit.SECONDS)
    }
}
