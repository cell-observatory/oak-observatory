package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.model.activeSessionRows
import com.cellobservatory.observatory.model.compactBytes
import com.cellobservatory.observatory.model.isSessionActive
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.util.concurrency.AppExecutorUtil
import javax.swing.JComponent

/**
 * The Timeline window's session selector — the chip on its title bar naming which conversation the
 * observatory is reviewing, and a short list of the ones still live in this workspace.
 *
 * It switches the WHOLE observatory, not just this window: the Timeline is where a person watches a
 * session happen, so "which session" is a question they ask here, but every other panel is already showing
 * that same session and a Timeline-only scope would put two answers on screen at once. The picks therefore
 * route through the one place a session choice is applied, which is also what keeps demo mode's in-memory
 * override from being overwritten with a persisted pin.
 *
 * Live sessions only. The FULL browser is the Overview's Sessions tab, and the last row here falls through
 * to the existing all-sessions chooser rather than growing into a second one.
 */
class TimelineSessionAction(private val project: Project) : AnAction(), DumbAware {

    /** BGT: this runs on every title-bar tick, and nothing below touches Swing or the EDT. */
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the session name
    override fun displayTextInToolbar() = true

    /**
     * The chip's label, from the CACHED sessions payload only — [ObservatoryService.peekSessions] never
     * spawns, and this is a per-tick path.
     *
     * Nothing polls that view, so the cache is empty until either the Dashboards window has been opened or
     * this action has been clicked once. Until then the chip names the session by its short id: that is
     * what is actually known, where "no session selected" would be a false claim about a workspace that
     * has one.
     */
    override fun update(e: AnActionEvent) {
        val service = ObservatoryService.getInstance(project)
        val current = service.currentSession()
        e.presentation.isEnabledAndVisible = true
        if (current == null) {
            e.presentation.text = "○ no session selected"
            e.presentation.description = "No Claude Code session for this workspace yet"
            return
        }
        val row = service.peekSessions()?.sessions?.firstOrNull { it.id == current }
        val live = row != null && isSessionActive(maxOf(row.lastActiveMs, row.liveMs), System.currentTimeMillis())
        val name = row?.displayName ?: "session ${current.take(8)}"
        e.presentation.text = (if (live) "● " else "○ ") + name
        e.presentation.description =
            "Reviewing $name (${current.take(8)})" +
                (if (row != null && row.lastActiveMs > 0) " · last active ${relTime(row.lastActiveMs)}" else "") +
                " — click to switch to another live session"
    }

    override fun actionPerformed(e: AnActionEvent) {
        val anchor = e.inputEvent?.component as? JComponent
        val service = ObservatoryService.getInstance(project)
        AppExecutorUtil.getAppExecutorService().submit {
            // The shared slot first — free when it is warm, and asking for it also kicks the fetch that
            // fills the chip's label. It answers null on a cold slot, so fall back to a direct read rather
            // than opening a popup that lists nothing. Batch-peeking (not batch-building) is deliberate:
            // the Switch-Session picker takes the same route for the same reason.
            val payload = service.sessions()
                ?: ObservatoryCli.sessionsJson(project.basePath, service.currentSession())?.let { SessionsParser.parse(it) }
            val current = service.currentSession()
            val now = System.currentTimeMillis()
            // Every locally reviewable session, current first, matching VS Code's selector.
            // The CLI scopes the listing to this machine. The popup's own
            // speed search covers the long list.
            var rows = payload?.let { p2 -> p2.sessions.let { local ->
                listOfNotNull(local.firstOrNull { it.id == current }) + local.filter { it.id != current }
            } } ?: emptyList()
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                showChooser(rows, current, now, anchor)
            }
        }
    }

    private fun showChooser(rows: List<SessionRow>, current: String?, now: Long, anchor: JComponent?) {
        val labelToId = LinkedHashMap<String, String?>()
        for (r in rows) {
            val waiting = r.attention != null && r.attention.kind != "idle-done"
            val mark = if (waiting) "⚠ " else if (isSessionActive(maxOf(r.lastActiveMs, r.liveMs), now)) "● " else "○ "
            // The 8-char id keeps labels unique when two live sessions share a title (the map is keyed by
            // label). Recency is omitted for a synthesized row rather than shown as an epoch date.
            val label = "$mark${r.displayName}  —  ${r.id.take(8)}" +
                // Agent + model: Claude unmarked, other agents named, the
                // model shown whenever recorded — same rule as every other session chooser.
                (if (r.agent.isNotBlank() && r.agent != "claude") " · [${r.agent}]" else "") +
                " · ${r.model.ifBlank { "model unknown" }}" +
                " · ${r.workspace.ifBlank { "Unknown workspace" }} · ${r.edits} edit${if (r.edits == 1) "" else "s"} · ${fmtTok(r.tokens)} tok · ${fmtDur(r.durationMs)}" +
                // What this session COSTS to keep on disk: the same store size the TUI's
                // session blobs show. Omitted when zero — a conversation that captured nothing, or a CLI
                // too old to report it, so the chip never draws a misleading "0B".
                (if (r.storeBytes > 0) " · ${compactBytes(r.storeBytes)}" else "") +
                (if (r.lastActiveMs > 0) " · ${relTime(r.lastActiveMs, now)}" else "") +
                (if (r.id == current) " · reviewing" else "")
            labelToId[label] = r.id
        }
        labelToId[ALL_SESSIONS] = null
        if (rows.isNotEmpty()) labelToId[ReviewOps.DELETE_SESSION] = null
        // THIS session's OWN store folder on disk, revealed in the OS file manager. A plain-string
        // chooser cannot make the per-row size a click target, so the reviewed session's folder gets this
        // row instead — shown only when we know its path (a listed session that has a store).
        val reviewedStore = current?.let { c -> rows.firstOrNull { it.id == c }?.storePath }?.takeIf { it.isNotBlank() }
        if (reviewedStore != null) labelToId[STORE_FOLDER] = null
        // …and where the data itself lives. "Where does this thing keep my files" had no answer in
        // any of the three front ends until now.
        labelToId[STORE] = null
        val popup = JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labelToId.keys.toList())
            .setTitle(if (rows.size > 1) "Which live session?" else "Which session?")
            .setItemChosenCallback { chosen ->
                if (chosen == STORE_FOLDER) ReviewOps.revealStoreFolder(project, reviewedStore)
                else if (chosen == STORE) ReviewOps.storeLocation(project, anchor)
                else if (chosen == ALL_SESSIONS) ReviewOps.chooseSession(project, anchor)
                else if (chosen == ReviewOps.DELETE_SESSION) ReviewOps.chooseSessionToDelete(project, rows, anchor)
                else labelToId[chosen]?.let { ReviewOps.applySessionChoice(project, it) }
            }
            .createPopup()
        if (anchor != null && anchor.isShowing) popup.showUnderneathOf(anchor)
        else popup.showCenteredInCurrentWindow(project)
    }

    companion object {
        /** The fall-through row. `null` in the map would mean "auto-resolve" to applySessionChoice, so this
         *  row is matched by label and handed to the full chooser instead. */
        const val ALL_SESSIONS = "All sessions…"
        const val STORE_FOLDER = "📂  Open this session's store folder"
        const val STORE = "🗄  Store location…"
    }
}
