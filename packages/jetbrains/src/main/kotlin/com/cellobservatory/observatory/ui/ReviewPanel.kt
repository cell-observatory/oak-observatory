package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.ReviewParser
import com.cellobservatory.observatory.model.ReviewResult
import com.cellobservatory.observatory.model.ReviewUnit
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JPanel

/**
 * The REVIEW tab — THE review surface, in the Observatory Traces window.
 *
 * The body is the [EditsTreePanel] TREE (folder → file → class → unit): the format the removed Edits
 * tab had, brought back BY REQUEST after the flat stacked list — a JTree is virtualized, so a
 * 3,000-unit session renders instantly with no pagination, resolved rows keep their grey/strike
 * styling, and Keep / Undo / Redo / Diff ride the rows' own context menu. Selecting a prompt scopes
 * the tree to that ask's edit ids ([EditsTreePanel.idFilter]); clearing the pick falls back to the
 * whole session. Double-click opens the diff in the editor.
 *
 * This wrapper adds what the tree alone doesn't carry: the counts header and the whole-scope verbs —
 * Open all in editor (the stacked [ReviewAllEditor] over the pending units), Keep all / Undo all,
 * and Clear resolved. Counts and the scope's raw id set come from `review --json --no-patch`, the
 * same seam as ever.
 */
class ReviewPanel(private val project: Project) : JPanel(BorderLayout()) {

    private fun service() = ObservatoryService.getInstance(project)

    private val head = JBLabel().apply { border = JBUI.Borders.empty(6, 8, 2, 8) }
    private val openAll = JButton("Open all in editor").apply {
        isVisible = false
        toolTipText = "Every pending change in this scope in one editor tab (ten diffs at a time) — stacked or side by side, with a Spotlight that dims unmodified lines"
    }
    private val keepAll = JButton("Keep all").apply { isVisible = false }
    private val undoAll = JButton("Undo all").apply { isVisible = false }
    private val clearBtn = JButton("Clear resolved").apply {
        isVisible = false
        toolTipText = "Drop the kept/reverted records and keep the pending ones — shortens a long session"
    }
    // The cancelled-out footer: named, never a silent omission, and one click clears every one.
    private val cancelLabel = JBLabel().apply { isVisible = false; border = JBUI.Borders.empty(2, 8) }
    private val cancelBtn = JButton("Dismiss").apply {
        isVisible = false
        toolTipText = "Mark these kept — they were never a decision"
    }
    private val tree = EditsTreePanel(project, EditsTreePanel.Mode.DIFFS)

    /**
     * Per-EDIT verbs on a visible toolbar, not only in the row's context menu: a right-click-only
     * action reads as "this surface has no actions" to anyone who does not right-click, which is
     * exactly how it was reported twice.
     *
     * A platform ActionToolbar rather than a row of JButtons on purpose — this tab lives in a
     * narrow left dock, and a wrapping FlowLayout of buttons puts its last verbs BELOW the strip's
     * one-row height, i.e. invisible and unclickable (measured: "Chat" and "Diff" gone at 380 px).
     * The toolbar shows labels (SHOW_TEXT_IN_TOOLBAR) and moves whatever does not fit into its
     * chevron overflow, so no width can hide a verb. Enablement follows the tree's selection through
     * each action's own `update`, so the platform re-asks rather than us pushing state.
     */
    private fun selAction(
        text: String,
        icon: javax.swing.Icon,
        applies: (EditRecord) -> Boolean,
        run: (String, EditRecord) -> Unit,
    ): AnAction = object : AnAction(text, text, icon), DumbAware {
        init {
            templatePresentation.putClientProperty(ActionUtil.SHOW_TEXT_IN_TOOLBAR, true)
        }
        override fun getActionUpdateThread() = ActionUpdateThread.EDT // reads the tree's selection
        override fun update(e: AnActionEvent) {
            e.presentation.isEnabled = tree.selectedEdit()?.let(applies) == true
        }
        override fun actionPerformed(e: AnActionEvent) {
            val rec = tree.selectedEdit() ?: return
            val s = service().currentSession()
            if (s == null) {
                // Never a silent no-op: an enabled button that does nothing is the bug this bar exists
                // to fix (parity with the tree's own withSession).
                ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
                return
            }
            run(s, rec)
        }
    }

    /** What the panel is currently showing / fetching, so a stale answer never paints over a newer
     *  pick. Compared by (session, promptId, store generation). */
    @Volatile private var shownKey: String? = null

    init {
        val bar = JPanel(FlowLayout(FlowLayout.LEFT, 6, 2)).apply {
            add(openAll)
            add(keepAll)
            add(undoAll)
            add(clearBtn)
        }
        val north = JPanel(BorderLayout()).apply {
            add(head, BorderLayout.CENTER)
            add(bar, BorderLayout.EAST)
        }
        add(north, BorderLayout.NORTH)
        // The SELECTED row's verbs. `advance` is left at its default, so these behave exactly like
        // the same row's context-menu Keep/Undo/Redo — one gesture, one outcome, whichever way the
        // reader reaches it.
        val selGroup = DefaultActionGroup(
            selAction("Keep", NavTint.KEEP, { it.pending }) { s, rec -> ReviewOps.keep(project, s, rec.id) },
            selAction("Undo", NavTint.UNDO, { !it.undone }) { s, rec -> ReviewOps.undoOrRedo(project, s, rec, redo = false) },
            selAction("Redo", NavTint.REDO, { it.undone }) { s, rec -> ReviewOps.undoOrRedo(project, s, rec, redo = true) },
            selAction("Chat", NavTint.CHAT, { true }) { s, rec -> ReviewOps.chatAbout(project, s, rec.id) },
            selAction("Diff", AllIcons.Actions.Diff, { true }) { s, rec -> Diffs.show(project, s, rec) },
        )
        val selTb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryReviewSelection", selGroup, true)
        selTb.targetComponent = tree
        val footer = JPanel(FlowLayout(FlowLayout.LEFT, 4, 2)).apply {
            add(cancelLabel)
            add(cancelBtn)
        }
        add(JPanel(BorderLayout()).apply {
            add(selTb.component, BorderLayout.NORTH)
            add(tree, BorderLayout.CENTER)
            add(footer, BorderLayout.SOUTH)
        }, BorderLayout.CENTER)
        service().addListener(Runnable { refresh() })
        refresh()
    }

    /** Re-derive what to show. Cheap when nothing moved (key compare); a real change fetches the
     *  rows-only review payload on a pooled thread and lands on the EDT. The TREE fetches its own
     *  `tree` payload inside rebuild(); this fetch supplies the counts, the scope's raw id set, and
     *  the open-all specs. */
    fun refresh() {
        val session = service().currentSession()
        val promptId = service().selectedPromptId
        if (session == null) {
            if (shownKey != "empty") {
                shownKey = "empty"
                ApplicationManager.getApplication().invokeLater { renderEmpty() }
            }
            return
        }
        val key = "$session|${promptId ?: "ALL"}|${StoreReader.logKey(session)}"
        if (key == shownKey) return
        shownKey = key
        ApplicationManager.getApplication().executeOnPooledThread {
            val json = ObservatoryCli.reviewJson(session, promptId, project.basePath)
            val result = json?.let { ReviewParser.parse(it) }
            ApplicationManager.getApplication().invokeLater {
                if (shownKey != key) return@invokeLater // the reader moved on while this was in flight
                if (result == null) {
                    // Retry on the next tick (parity with ObservatoryService's editTree fetch): a
                    // sticky key would park the header on one transient spawn failure AND leave the
                    // previous pick's idFilter silently active on the tree.
                    shownKey = null
                    renderError()
                } else {
                    tree.idFilter = if (promptId != null) result.ids.toSet() else null
                    tree.hiddenIds = result.hiddenIds.toSet()
                    // The integrity evidence rides the review units, not the `tree --json` the tree
                    // renders from — so feed it down, per RAW member id: the review-only badge (on
                    // review's wider rule) and the authoritative capture tooltip (model/tool/turn).
                    val reviewOnly = HashSet<Int>()
                    val captureById = HashMap<Int, String>()
                    for (u in result.units) for (m in u.members) {
                        if (u.partial) reviewOnly.add(m)
                        if (u.capture.isNotBlank()) captureById[m] = u.capture
                    }
                    tree.reviewOnlyIds = reviewOnly
                    tree.captureById = captureById
                    tree.rebuild()
                    renderHead(session, result)
                }
            }
        }
    }

    private fun renderEmpty() {
        head.text = "<html><i>No session is under observation yet. Once the agent works in this project, this " +
            "tab lists the session's changes as a tree — folder, file, class, unit — with Keep/Undo/Redo " +
            "on every row; picking a prompt in the Prompts window scopes it to that ask.</i></html>"
        openAll.isVisible = false
        keepAll.isVisible = false
        undoAll.isVisible = false
        clearBtn.isVisible = false
        // …and the footer, or a Dismiss stays on screen bound to the PREVIOUS session's ids — one
        // click reaching into a session this panel is no longer showing.
        cancelLabel.isVisible = false
        cancelBtn.isVisible = false
        tree.idFilter = null
        tree.hiddenIds = emptySet()
        tree.reviewOnlyIds = emptySet()
        tree.captureById = emptyMap()
        tree.rebuild()
    }

    private fun renderError() {
        head.text = "<html><i>No answer for <b>review</b> — the oak CLI on PATH did not return it " +
            "(a CLI older than 0.9.4 has no <code>review</code> command).</i></html>"
        openAll.isVisible = false
        keepAll.isVisible = false
        undoAll.isVisible = false
        clearBtn.isVisible = false
        // Same reason: without an answer there is no dismissible set, and the stale one is not it.
        cancelLabel.isVisible = false
        cancelBtn.isVisible = false
    }

    private fun renderHead(session: String, r: ReviewResult) {
        val counts = "${r.unitCount} unit(s) · ${r.pending} pending · +${r.added} −${r.removed}"
        head.text = if (r.prompt != null) {
            "<html><b>#${r.prompt.index}</b> &nbsp;${escape(r.prompt.title)}<br><small>$counts</small></html>"
        } else {
            "<html><b>Changes this session</b> &nbsp;<i>pick a prompt (Prompts window) to scope</i>" +
                "<br><small>$counts</small></html>"
        }

        val resolved = r.units.count { !it.pending }
        openAll.isVisible = r.units.any { it.pending }
        keepAll.isVisible = r.pending > 0
        undoAll.isVisible = r.pending > 0
        clearBtn.isVisible = resolved > 0
        for (l in openAll.actionListeners) openAll.removeActionListener(l)
        for (l in keepAll.actionListeners) keepAll.removeActionListener(l)
        for (l in undoAll.actionListeners) undoAll.removeActionListener(l)
        for (l in clearBtn.actionListeners) clearBtn.removeActionListener(l)
        openAll.addActionListener {
            Diffs.showAll(project, session, r.units.filter { it.pending }.mapNotNull { u -> netRecord(u)?.let { Triple(it, u.rel, u.added + u.removed) } })
        }
        // Keep all / Undo all — the scope's whole mutation set, RAW and group-expanded (r.ids),
        // through the same id-set verbs every other bulk path uses.
        val idSet = r.ids.toSet()
        val targets = service().log().filter { it.id in idSet }
        val scopeLabel = r.prompt?.let { "prompt #${it.index}" } ?: "this session"
        keepAll.addActionListener { ReviewOps.keepAll(project, session, targets, scopeLabel) }
        undoAll.addActionListener {
            ReviewOps.undoIds(project, session, targets, scopeLabel, r.prompt?.let { "prompt #${it.index} (${it.title})" } ?: "this session")
        }
        // NULL count: the clear is SESSION-WIDE (parity with VS Code's Clear Resolved), and under a
        // prompt scope the scope's resolved count would put a false small number on a dialog that is
        // about to drop every resolved record in the session.
        clearBtn.addActionListener { ReviewOps.clearResolved(project, session, null) }

        val cancelled = r.cancelled.size
        cancelLabel.isVisible = cancelled > 0
        cancelBtn.isVisible = cancelled > 0
        cancelLabel.text = "<html><small>$cancelled cancelled-out chain${if (cancelled == 1) "" else "s"} — " +
            "created then deleted, or put back: nothing to review</small></html>"
        for (l in cancelBtn.actionListeners) cancelBtn.removeActionListener(l)
        cancelBtn.addActionListener {
            ReviewOps.keepAll(project, session, service().log().filter { it.id in r.cancelledIds.toSet() }, "cancelled-out chains")
        }
    }

    /** The unit's pair as a record, mirroring core's reviewEdits exactly: a PENDING unit is the
     *  synthetic net pair (span-first `before` + the unit's `after`); a RESOLVED row arrives RAW —
     *  core stops collapsing after keep/undo, so each member is its own record and synthesizing here
     *  would diff v0→v2/v0→v3, double-counting earlier members. */
    private fun netRecord(u: ReviewUnit): EditRecord? {
        val log = service().log()
        val rep = log.find { it.id == u.id } ?: return null
        if (!u.pending) return rep
        val first = log.find { it.id == (u.members.firstOrNull() ?: u.id) } ?: rep
        return if (first.id == rep.id) rep else rep.copy(beforeBlob = first.beforeBlob)
    }

    private fun escape(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}
