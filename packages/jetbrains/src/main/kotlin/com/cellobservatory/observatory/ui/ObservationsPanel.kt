package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.ContextSource
import com.cellobservatory.observatory.model.ObsEdit
import com.cellobservatory.observatory.model.ObservationEdit
import com.cellobservatory.observatory.model.ObservationRun
import com.cellobservatory.observatory.model.Observations
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.services.ObserveCache
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.JComponent
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel

/**
 * Observations (0.8.0 r4 — the single reasoning feed): the session recap on top, then the edit timeline in
 * chronological-run STYLE (files by most-recent activity; adjacent same-file edits coalesce into ×N runs with
 * a combined delta, expandable to their per-edit rows with Keep/Undo), the agent's own reasoning inline on each
 * edit, and the still-open Next steps at the end. Backed by one `observations --json` payload (assembled in
 * core). The Actions tool-call timeline now lives in the Edits sidebar (ActionsPanel).
 *
 * This panel only paints — parity with the VS Code Observations view. Keep/Undo route through the store-
 * mutation CLI (ReviewOps), zero-token.
 */
/**
 * The line a ×N run row shows: the first non-blank line of its NEWEST edit's reasoning, as VS Code's run row shows
 * (`firstLine`), or none when that edit has none. [ObservationRun.edits] is chronological, so the newest is last.
 * An older edit's words beside the newest edit's time describe a change the row does not show: reading the edits
 * front to back showed the oldest's, and borrowing an older edit's for a newest edit without any did the same.
 */
internal fun runReasoningLine(run: ObservationRun): String? =
    run.edits.lastOrNull()?.reasoning?.lineSequence()?.firstOrNull { it.isNotBlank() }

class ObservationsPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    private object RecapMarker
    private object StepsMarker
    private object ContextMarker

    @Volatile private var data: Observations? = null

    /** Per-edit issue flags + cross-session file memory, by edit id — from the `observe --json` payload
     *  ObserveCache already holds for the reasoning shown elsewhere. The observations view-model carries
     *  neither, and dropping them left this panel silently quieter than the same view in VS Code, which
     *  decorates every row it has a flag or a memory line for. */
    @Volatile private var obsById: Map<Int, ObsEdit> = emptyMap()

    // The user-triggered `claude -p` recap (Refresh Recap), preferred over the auto recap until the next
    // manual regeneration — guarantees the freshly generated text is what the recap row shows.
    @Volatile private var freshRecap: String? = null

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tracked agent edits in this project yet"
        cellRenderer = Renderer()
    }

    init {
        setContent(JBScrollPane(tree))
        toolbar = buildToolbar()
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount != 2) return
                // A context row opens the file behind it (a CLAUDE.md, a memory doc, a plan) — same
                // LocalFileSystem open the Actions panel's conflict rows use.
                val ctx = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? ContextSource
                if (ctx != null) {
                    openContext(ctx)
                    return
                }
                selectedEdit()?.let { openEdit(it.id) }
            }
        })
        PopupHandler.installPopupMenu(tree, buildPopupGroup(), "ClaudeObservatoryObsPopup")

        ObservatoryService.getInstance(project).addListener { rebuild() }
        ObserveCache.getInstance(project).addListener { rebuild() } // flags/memory land async → decorate then
        rebuild()
    }

    // --- selection: an ObservationEdit row, or a single-edit run (which stands in for its lone edit) ---

    private fun selectedEdit(): ObservationEdit? =
        when (val o = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject) {
            is ObservationEdit -> o
            is ObservationRun -> if (o.count == 1) o.edits.firstOrNull() else null
            else -> null
        }

    // --- data / paint (one observations --json payload; off the EDT, repaint back on it) ---

    fun rebuild() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        // Same three-way honesty split as EditsTreePanel: never claim setup is missing when it isn't.
        tree.emptyText.clear()
        when {
            !com.cellobservatory.observatory.core.ClaudePaths.hooksInstalled() -> {
                tree.emptyText.appendLine("No tracked agent edits in this project yet")
                tree.emptyText.appendLine("Run `oak init`, then let Claude Code edit.")
            }
            session != null && service.log().isEmpty() -> {
                tree.emptyText.appendLine("No edits in this session yet — the hooks are working.")
                tree.emptyText.appendLine("Observations fill in as agent edits files.")
            }
            else -> tree.emptyText.appendLine("No tracked agent edits in this project yet")
        }
        // The same way in the Edits tree offers (VS Code offers it from this panel's empty state too):
        // an empty Observations pane is exactly where a first-time reader is looking for something to see.
        if (!ReviewOps.demoPresent(project)) {
            tree.emptyText.appendLine(
                "Try the demo — no agent session needed",
                com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES,
            ) { ReviewOps.startDemo(project) }
        }
        if (session == null) {
            data = null
            ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) repaintTree() }
            return
        }
        // The SHARED throttled observations view (0.8.0 stabilization) — one spawn per ~3s across the
        // window; get() serves the latest cached view now and re-fires the listener when fresh data lands.
        val res = service.observations()
        // Cached and keyed on the store, so this is a stat() when nothing moved; joined once per repaint
        // rather than per row (the renderer runs for every visible row on every paint).
        val obs = ObserveCache.getInstance(project).payload()?.edits?.associateBy { it.id } ?: emptyMap()
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            data = res
            obsById = obs
            repaintTree()
        }
    }

    private fun repaintTree() {
        root.removeAllChildren()
        val d = data
        if (d != null && d.runs.isNotEmpty()) {
            root.add(DefaultMutableTreeNode(RecapMarker)) // the session recap heads the timeline
            for (r in d.runs) {
                val runNode = DefaultMutableTreeNode(r)
                // A lone edit is its own run (count 1) — render it as a leaf so its row IS the edit; only
                // multi-edit runs expand into per-edit rows (with Keep/Undo).
                if (r.count > 1) for (e in r.edits) runNode.add(DefaultMutableTreeNode(e))
                root.add(runNode)
            }
        }
        // Context: what shaped this session (0.8.6). Its rows nest UNDER the marker (unlike the two
        // sections around it, which flatten onto root) so a long list collapses as one unit.
        val ctxSources = d?.context?.sources ?: emptyList()
        val ctxNode = if (ctxSources.isEmpty()) null else DefaultMutableTreeNode(ContextMarker).also { n ->
            for (s in ctxSources) n.add(DefaultMutableTreeNode(s))
            root.add(n)
        }
        // Next-steps: the agent's own open to-dos + heuristic follow-ups (shown independently of the timeline).
        if (d != null && d.nextSteps.isNotEmpty()) {
            root.add(DefaultMutableTreeNode(StepsMarker))
            for (s in d.nextSteps) root.add(DefaultMutableTreeNode(s))
        }
        model.reload()
        expandAllBounded(tree)
        // expandAll just opened every section; a long Context list would push the recap and timeline off
        // screen, so fold it back when it runs past a handful of rows (its header still carries the count).
        ctxNode?.takeIf { it.childCount > 5 }?.let { tree.collapsePath(TreePath(it.path)) }
    }

    // --- keep / undo (per-edit — expand a run to its rows), + open / diff / chat ---

    private fun session(): String? = ObservatoryService.getInstance(project).currentSession()

    private fun keepSelected() {
        val session = session() ?: return
        val edit = selectedEdit() ?: return ReviewOps.notify(project, "Select an edit to keep (expand a run to its rows)")
        if (edit.status != "pending") return ReviewOps.notify(project, "Edit #${edit.id} is already ${edit.status}")
        ReviewOps.keep(project, session, edit.id)
    }

    private fun undoSelected() {
        val session = session() ?: return
        val edit = selectedEdit() ?: return ReviewOps.notify(project, "Select an edit to undo (expand a run to its rows)")
        val rec = ObservatoryService.getInstance(project).log().find { it.id == edit.id }
            ?: return ReviewOps.notify(project, "Edit #${edit.id} is no longer in the store")
        ReviewOps.undoOrRedo(project, session, rec, redo = false)
    }

    /** Open the file behind a Context row. A source with no path (nothing on disk to show) says so rather
     *  than doing nothing — a dead double-click reads as a bug. */
    private fun openContext(s: ContextSource) {
        val path = s.path ?: return ReviewOps.notify(project, "${s.label} isn't a file on disk")
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(path)
        if (vf == null) ReviewOps.notify(project, "File not found: $path", NotificationType.WARNING)
        else com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
    }

    private fun openEdit(id: Int) {
        val session = session() ?: return
        ObservatoryService.getInstance(project).log().find { it.id == id }?.let { Navigate.openFileAtEdit(project, session, it) }
    }

    private fun diffEdit(id: Int) {
        val session = session() ?: return
        ObservatoryService.getInstance(project).log().find { it.id == id }?.let { Diffs.show(project, session, it) }
    }

    private fun chatEdit(id: Int) {
        val session = session() ?: return
        ReviewOps.chatAbout(project, session, id)
    }

    // --- toolbar / menu / renderer ---

    private fun service() = ObservatoryService.getInstance(project)

    private fun withSession(block: (String) -> Unit) {
        val s = service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
            return
        }
        block(s)
    }

    private fun buildToolbar(): JComponent {
        val group = DefaultActionGroup(
            action("Accept All Edits", NavTint.ACCEPT_ALL) { withSession { s -> ReviewOps.keepAll(project, s) } },
            action("Reject All Edits", NavTint.REVERT_ALL) {
                withSession { s -> ReviewOps.undoAll(project, s, service().log(), "this session") }
            },
            action("Clear Resolved Edits", NavTint.CLEAR) {
                withSession { s ->
                    val resolved = service().log().count { !it.pending }
                    if (resolved > 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
                }
            },
            action("Install Capture Hooks", AllIcons.Actions.Install) { ReviewOps.installHooks(project) },
            action("Clean Store…", AllIcons.Vcs.Remove) { ReviewOps.cleanStore(project, tree) },
            action("Switch Session", AllIcons.Vcs.Branch) { ReviewOps.chooseSession(project, tree) },
            // Opt-in `claude -p` recap (spends tokens): regenerate, then repaint the recap row with it.
            action("Refresh Recap", Icons.Star) {
                withSession { s -> ReviewOps.refreshRecap(project, s) { text -> freshRecap = text; repaintTree() } }
            },
            action("Refresh", AllIcons.Actions.Refresh) { service().sweepIgnoredThen { service().observations(force = true); service().refresh(force = true) } },
            action("Setup Check (doctor)", AllIcons.General.Information) { ReviewOps.openDoctor(project) },
        )
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryObs", group, true)
        tb.targetComponent = tree
        return tb.component
    }

    private fun buildPopupGroup() = DefaultActionGroup(
        action("Keep", NavTint.KEEP) { keepSelected() },
        action("Undo", NavTint.UNDO) { undoSelected() },
        action("Open File at Edit", AllIcons.Actions.EditSource) { selectedEdit()?.let { openEdit(it.id) } },
        action("Show Diff", AllIcons.Actions.Diff) { selectedEdit()?.let { diffEdit(it.id) } },
        action("Chat About This Edit", AllIcons.General.Balloon) { selectedEdit()?.let { chatEdit(it.id) } },
        // Opt-in `claude -p` deep analysis (spends tokens): open the result as a markdown tab.
        action("Analyze Edit with Claude", Icons.Star) {
            selectedEdit()?.let { e -> withSession { s -> ReviewOps.analyzeEdit(project, s, e.id) } }
        },
    )

    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private inner class Renderer : ColoredTreeCellRenderer() {
        private val hhmm = SimpleDateFormat("HH:mm")
        // Warn-level flags share the review palette's amber (the same hue the Actions timeline uses for a
        // flagged call); an info flag and the memory line stay grey — they are context, not an alarm.
        private val amber = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, JBColor.ORANGE)

        /** A row earns the warning icon when the edit was flagged at warn level, or when this file's
         *  cross-session history says edits to it get reverted often (VS Code's `warn`). */
        private fun warned(ob: ObsEdit?): Boolean = ob != null && (ob.risky || ob.flags.any { it.level == "warn" })

        /** The row's flag + memory decoration: the FIRST flag inline (warn wins), a "+N" for the rest, and
         *  the file's cross-session verdict summary. Everything else goes to the tooltip — a row is one
         *  line, and a flag that only exists on hover is a flag nobody reads. */
        private fun appendObs(ob: ObsEdit?) {
            if (ob == null) return
            val flag = ob.flags.firstOrNull { it.level == "warn" } ?: ob.flags.firstOrNull()
            if (flag != null) {
                val warn = flag.level == "warn"
                append("  ${if (warn) "⚠" else "·"} ${flag.message}", if (warn) amber else SimpleTextAttributes.GRAYED_ATTRIBUTES)
                if (ob.flags.size > 1) append(" +${ob.flags.size - 1}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            ob.memorySummary.takeIf { it.isNotBlank() }?.let {
                append("  ⚑ $it", if (ob.risky) amber else SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES)
            }
        }

        /** Every flag + the memory line, for the tooltip (the row shows only the first). */
        private fun obsTip(ob: ObsEdit?): String = buildString {
            if (ob == null) return@buildString
            ob.flags.forEach { append("\n${if (it.level == "warn") "⚠" else "ℹ"} ${it.message}") }
            ob.memorySummary.takeIf { it.isNotBlank() }?.let {
                append("\n⚑ $it")
                if (ob.risky) append(" — edits to this file get reverted often; review carefully")
            }
        }

        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is RecapMarker -> {
                    icon = Icons.Microscope
                    val recap = (freshRecap ?: data?.recap)?.takeIf { it.isNotBlank() }
                    append(recap ?: "No recap yet — it fills in from the agent's session title / last summary.")
                    append("  session recap", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is StepsMarker -> {
                    icon = AllIcons.Actions.IntentionBulb
                    append("Next steps", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    append("  from the agent's to-dos + heuristics", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is ContextMarker -> {
                    icon = AllIcons.General.InspectionsEye
                    append("Context", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    val ctx = data?.context
                    val sources = ctx?.sources ?: emptyList()
                    val observed = sources.count { it.evidence == "transcript" }
                    append("  what shaped this session · ${sources.size} source(s), $observed observed", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    // core's caveat, verbatim and ON the row — left in a tooltip, the section over-claims.
                    ctx?.note?.takeIf { it.isNotBlank() }?.let { append("  $it", SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES) }
                    toolTipText = ctx?.note
                }
                is ContextSource -> {
                    icon = when (node.kind) {
                        "skill" -> AllIcons.Nodes.Plugin
                        "plan" -> AllIcons.Actions.ListFiles
                        "memory" -> AllIcons.Nodes.DataTables
                        "compact-summary" -> AllIcons.Actions.Collapseall
                        "claude-md" -> AllIcons.FileTypes.Text
                        else -> AllIcons.General.Information
                    }
                    append(node.label)
                    if (node.count > 1) append("  ×${node.count}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    node.detail?.takeIf { it.isNotBlank() }?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    // The evidence axis belongs ON the row, not buried in a tooltip: a file that merely
                    // exists where Claude Code auto-loads it is not something this session was seen doing.
                    if (node.evidence != "transcript") {
                        append("  present, not observed", SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES)
                    }
                    toolTipText = buildString {
                        append(node.path ?: node.label)
                        append("\n")
                        append(
                            if (node.evidence == "transcript") "Observed in this session's transcript"
                            else "Present where Claude Code auto-loads it — the injection isn't recorded per session"
                        )
                        if (node.path != null) append("\nDouble-click to open")
                    }
                }
                is String -> {
                    icon = AllIcons.General.ArrowRight
                    append(node, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                }
                is ObservationRun -> {
                    // A single-edit run IS its edit's row (it never expands), so it carries that edit's
                    // flags/memory too — otherwise the decoration would appear only on multi-edit files.
                    val ob = if (node.count == 1) node.edits.firstOrNull()?.let { obsById[it.id] } else null
                    icon = if (warned(ob)) AllIcons.General.Warning else when (node.status) {
                        "pending" -> AllIcons.General.Modified
                        "undone" -> AllIcons.Actions.Cancel
                        else -> NavTint.KEEP
                    }
                    val ts = node.edits.lastOrNull()?.ts ?: 0L
                    append((if (ts > 0) "${hhmm.format(Date(ts))}  " else "") + File(node.file).name)
                    if (node.count > 1) append("  ×${node.count}", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    if (node.added > 0 || node.removed > 0) append("  +${node.added} -${node.removed}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    val why = runReasoningLine(node)
                    if (why != null) append("  $why", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    appendObs(ob)
                    toolTipText = buildString {
                        append(node.rel)
                        append("\n${node.count} edit(s) · +${node.added} -${node.removed} · ${node.status}")
                        if (node.count == 1) node.edits.firstOrNull()?.reasoning?.let { append("\n💭 $it") }
                        append(obsTip(ob))
                    }
                }
                is ObservationEdit -> {
                    val ob = obsById[node.id]
                    icon = if (warned(ob)) AllIcons.General.Warning else when (node.status) {
                        "kept" -> NavTint.KEEP
                        "undone" -> AllIcons.Actions.Cancel
                        else -> AllIcons.General.Modified
                    }
                    val style = when (node.status) {
                        "undone" -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, null)
                        "kept" -> SimpleTextAttributes.GRAYED_ATTRIBUTES
                        else -> SimpleTextAttributes.REGULAR_ATTRIBUTES
                    }
                    append("#${node.id}", style)
                    if (node.added > 0 || node.removed > 0) append("  +${node.added} -${node.removed}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    node.reasoning?.lineSequence()?.firstOrNull()?.takeIf { it.isNotBlank() }
                        ?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    appendObs(ob)
                    toolTipText = buildString {
                        node.reasoning?.let { append("💭 $it\n") }
                        append("edit #${node.id} · +${node.added} -${node.removed} · ${node.status}")
                        append(obsTip(ob))
                    }
                }
            }
        }
    }
}
