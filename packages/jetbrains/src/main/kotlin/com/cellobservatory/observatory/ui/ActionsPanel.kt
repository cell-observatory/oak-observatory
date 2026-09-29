package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.ActionGroup
import com.cellobservatory.observatory.model.ActionRecord
import com.cellobservatory.observatory.model.Collision
import com.cellobservatory.observatory.model.EgressChannel
import com.cellobservatory.observatory.model.MtActions
import com.cellobservatory.observatory.model.OutsideWrite
import com.cellobservatory.observatory.model.SessionAudit
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.ide.CommonActionsManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel

/** How many out-of-workspace files the risk section lists before it says how many it is hiding. Capped
 *  at all because core's list is uncapped: a session that churned a hundred files elsewhere would bury
 *  every category below it. */
private const val OUTSIDE_CAP = 20

/**
 * Actions (0.8.0 r4 — moved out of the Observations window into the Edits sidebar): the active session's
 * curated tool-call timeline in the same timeline STYLE — collapsible category subsections (Edits · Commands ·
 * Reads · Searches · Egress · To-dos), each action stamped with its HH:mm time; a file-edit action links to
 * its review (double-click opens the diff, right-click hands off a zero-token chat). Backed by
 * `multitask --json`'s `actions` section (buildActionGroups + egress, curated in core).
 *
 * This is also the session's AUDIT surface, and as of 0.8.7 the only one: the footprint badge row folded
 * into the two audits that were already here — writes that left the workspace are risk (they changed files
 * you did not point the agent at), reads that left it are egress (reach, exactly like a fetch). Both ride
 * `risk --json` / `egress --json` off the service's shared throttled fetch.
 *
 * This panel only paints — parity with the VS Code Actions view. Zero-token.
 */
class ActionsPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    @Volatile private var actions: MtActions? = null
    /** Live cross-agent file conflicts — moved here from the Overview's fleet nav (0.8.3): this is the
     *  session's audit surface, and a contested file is exactly the kind of thing it should lead with. */
    @Volatile private var collisions: List<Collision> = emptyList()
    /** The `risk` + `egress` audits (0.8.7): the out-of-workspace writes, and the destination list that
     *  alone carries the `file` reads. Null until the first fetch lands, or when the CLI can't answer. */
    @Volatile private var audit: SessionAudit? = null

    private val actionsRoot = DefaultMutableTreeNode()
    private val actionsModel = DefaultTreeModel(actionsRoot)
    private val actionsTree = Tree(actionsModel).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tool calls yet — the active session's Edits / Commands / Reads / Searches / Egress / To-dos appear here"
        cellRenderer = ActionsRenderer()
    }

    init {
        // Collapse-all / expand-all for the category-grouped timeline — IntelliJ's own tree actions, the
        // platform equivalent of VS Code's Collapse-All button on this same sidebar tree.
        val expander = DefaultTreeExpander(actionsTree)
        val cam = CommonActionsManager.getInstance()
        val group = DefaultActionGroup(
            cam.createCollapseAllAction(expander, actionsTree),
            cam.createExpandAllAction(expander, actionsTree),
        )
        val tb = ActionManager.getInstance().createActionToolbar(ActionPlaces.TOOLWINDOW_CONTENT, group, true)
        tb.targetComponent = actionsTree
        toolbar = tb.component
        setContent(JBScrollPane(actionsTree))

        // Double-click a file-edit action → open it for review; right-click → zero-token chat.
        actionsTree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount != 2) return
                // A conflict row opens the contested file itself.
                ((actionsTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? Collision)?.let { c ->
                    val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(c.file)
                    if (vf == null) ReviewOps.notify(project, "File not found: ${c.file}", com.intellij.notification.NotificationType.WARNING)
                    else com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
                    return
                }
                val a = (actionsTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? ActionRecord ?: return
                val id = a.editId ?: return // only file-edit actions link to a reviewable store record
                val session = session() ?: return
                val rec = StoreReader.findRecord(session, id) ?: return
                Navigate.openFileAtEdit(project, session, rec)
            }

            override fun mousePressed(e: MouseEvent) = maybePopup(e)
            override fun mouseReleased(e: MouseEvent) = maybePopup(e)
            private fun maybePopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val path = actionsTree.getPathForLocation(e.x, e.y) ?: return
                actionsTree.selectionPath = path
                val action = (path.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? ActionRecord ?: return
                val editId = action.editId ?: return // only file-edit actions carry a store link to chat about
                val session = session() ?: return
                javax.swing.JPopupMenu().apply {
                    add(javax.swing.JMenuItem("Chat About This Action").apply {
                        addActionListener { ReviewOps.chatContext(project, session, ChatRef.Edit(editId), "${action.tool} action") }
                    })
                }.show(actionsTree, e.x, e.y)
            }
        })

        ObservatoryService.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    private fun session(): String? = ObservatoryService.getInstance(project).currentSession()

    // --- data / paint (multitask --json's curated actions section, off the EDT; repaint back on it) ---

    fun rebuild() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        if (session == null) {
            actions = null
            audit = null
            ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) repaintActions() }
            return
        }
        // The SHARED throttled multitask view (0.8.0 stabilization) — this panel used to spawn its own
        // `multitask --json` on every watcher tick, duplicating the Overview's spawn in the same window.
        // The audit rides the same shared throttle, on this same tick — no timer of its own.
        val mt = service.multitask()
        val au = service.audit()
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            actions = mt?.actions
            collisions = mt?.collisions ?: emptyList()
            audit = au
            repaintActions()
        }
    }

    /** Paint the curated category groups (Edits / Commands / Reads / Searches / To-dos …), then the two
     *  audit sections: the writes that left the workspace and the Egress destinations. The fleet/subagent
     *  categories are already dropped in core — the panel only paints. */
    private fun repaintActions() {
        actionsRoot.removeAllChildren()
        // Conflicts lead — they need eyes NOW (unlike the calm categories below, they start expanded).
        val cols = collisions
        var conflictsNode: DefaultMutableTreeNode? = null
        if (cols.isNotEmpty()) {
            conflictsNode = DefaultMutableTreeNode(ConflictsRoot(cols))
            cols.forEach { conflictsNode.add(DefaultMutableTreeNode(it)) }
            actionsRoot.add(conflictsNode)
        }
        val a = actions
        a?.groups?.forEach { g ->
            val gNode = DefaultMutableTreeNode(g)
            // NEWEST FIRST inside a category — core hands them over oldest-first, and every other timeline
            // in the product (VS Code's Actions tree, Observations, the CLI) leads with the newest. A
            // 500-row category that buries what just happened at the bottom is unusable.
            g.actions.asReversed().forEach { gNode.add(DefaultMutableTreeNode(it)) }
            actionsRoot.add(gNode)
        }
        // The risk audit's other half (0.8.7): edits that landed OUTSIDE the workspace. It follows the
        // categories — the flagged commands are already stamped ⚠ on their own rows above — because it is
        // the same audit's other kind of damage, and the one the Edits category cannot state: every path
        // there is shown workspace-relative, so a write to ~/.zshrc reads like any other file.
        val writes = audit?.outsideWrites ?: emptyList()
        if (writes.isNotEmpty()) {
            val owNode = DefaultMutableTreeNode(OutsideRoot(writes))
            writes.take(OUTSIDE_CAP).forEach { owNode.add(DefaultMutableTreeNode(it)) }
            val hidden = (writes.size - OUTSIDE_CAP).coerceAtLeast(0)
            if (hidden > 0) owNode.add(DefaultMutableTreeNode(OutsideMore(hidden)))
            actionsRoot.add(owNode)
        }
        // Egress prefers the `egress --json` audit over the multitask payload's sub-report: only the audit
        // carries the `file` channels (reads that left the workspace), so rendering the sub-report once the
        // audit has landed would silently drop them. Both compute web/MCP/shell from the same core call.
        val channels = audit?.egress ?: a?.egress ?: emptyList()
        if (channels.isNotEmpty()) { // "where did this session reach — off-machine, or just out of here"
            val egNode = DefaultMutableTreeNode(EgressRoot(channels))
            channels.forEach { egNode.add(DefaultMutableTreeNode(it)) }
            actionsRoot.add(egNode)
        }
        actionsModel.reload()
        // Categories collapsed by default: expand only the (hidden) root so the category headers show,
        // but leave each category's rows collapsed — the user expands the ones they want. Live conflicts
        // are the exception: they start expanded.
        actionsTree.expandPath(TreePath(actionsRoot))
        conflictsNode?.let { actionsTree.expandPath(TreePath(it.path)) }
    }

    /** Marker userObject for the Egress root — carries every destination this session reached. */
    private class EgressRoot(val channels: List<EgressChannel>)

    /** Marker userObject for the Live-conflicts root (files pending in 2+ both-active agents). */
    private class ConflictsRoot(val collisions: List<Collision>)

    /** Marker userObject for the out-of-workspace writes root (the folded risk audit). */
    private class OutsideRoot(val writes: List<OutsideWrite>)

    /** The tail row of the capped writes list: [hidden] files this section is NOT showing. Stated, never
     *  swallowed — a capped list that reads as complete understates where the work actually landed. */
    private class OutsideMore(val hidden: Int)

    /** Renders the Actions timeline: category groups (Edits / Commands / Reads / Searches / To-dos …), their
     *  tool calls (each stamped HH:mm), and the Egress destinations root — the same timeline style. */
    private inner class ActionsRenderer : ColoredTreeCellRenderer() {
        private val hhmm = SimpleDateFormat("HH:mm")
        private val amber = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, JBColor.ORANGE)

        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is ConflictsRoot -> {
                    icon = AllIcons.General.Warning
                    append("Live conflicts", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, JBColor.ORANGE))
                    val pend = node.collisions.count { it.anyPending }
                    append("  ${node.collisions.size}" + if (pend > 0) " · $pend pending" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "Files being touched by more than one active agent right now — double-click one to open it"
                }
                is Collision -> {
                    icon = AllIcons.Actions.Copy
                    append(node.file.substringAfterLast('/'), amber)
                    append("  ${node.agents.size} agents" + if (node.anyPending) " · pending" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "${node.file} — ${node.agents.joinToString(", ") { it.take(8) }} · double-click to open"
                }
                is OutsideRoot -> {
                    icon = AllIcons.General.Warning
                    append("Outside the workspace", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, JBColor.ORANGE))
                    val edits = node.writes.sumOf { it.count }
                    append("  $edits edit${if (edits == 1) "" else "s"} across ${node.writes.size} file${if (node.writes.size == 1) "" else "s"}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "Files this session EDITED outside this workspace. The Edits ledger cannot show them — it presents every path workspace-relative — so they are reported here, as an observation about where the work landed rather than a judgement that it was dangerous."
                }
                is OutsideWrite -> {
                    icon = AllIcons.Actions.EditSource
                    append("↗ ", amber)
                    append(node.file, amber)
                    if (node.count > 1) append("  ×${node.count}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "${node.file}\n${node.count} edit${if (node.count == 1) "" else "s"} landed here, outside this workspace"
                }
                is OutsideMore -> {
                    append("… ${node.hidden} more not listed", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "This list shows the $OUTSIDE_CAP most-edited files — ${node.hidden} further file(s) were also edited outside this workspace (`oak risk --all` lists them)"
                }
                is EgressRoot -> {
                    icon = AllIcons.General.Web
                    append("Egress")
                    val remote = node.channels.count { it.scope == "remote" }
                    val outside = node.channels.count { it.scope == "local" }
                    val counts = listOfNotNull(
                        "${node.channels.size} destination${if (node.channels.size == 1) "" else "s"}",
                        remote.takeIf { it > 0 }?.let { "$it remote" },
                        outside.takeIf { it > 0 }?.let { "$it outside" },
                    )
                    append("  ${counts.joinToString(" · ")}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "Everywhere this session reached beyond here — web hosts, MCP servers, network shell commands, and the files it READ from outside this workspace"
                }
                is EgressChannel -> {
                    icon = when {
                        node.scope == "remote" -> AllIcons.General.Web
                        node.kind == "file" -> AllIcons.Actions.Preview // a read that left the workspace
                        else -> AllIcons.General.Information
                    }
                    append("${node.kind}  ")
                    append(node.target, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                    // 'local' is a FACT — it stayed on this machine but crossed the workspace boundary;
                    // 'unknown' is an admission that the destination could not be classified. The CLI
                    // prints the first as "outside"; collapsing the two would state one as the other.
                    val local = node.scope == "local"
                    append("  ${if (local) "outside" else node.scope}", if (local) amber else SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    if (node.count > 1) append(" ×${node.count}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is ActionGroup -> {
                    icon = catIcon(node.category)
                    append(node.label)
                    val shown = if (node.actions.size < node.count) "${node.actions.size} of ${node.count}" else "${node.count}"
                    append("  $shown", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    if (node.errors > 0) append("  · ${node.errors} error${if (node.errors == 1) "" else "s"}", SimpleTextAttributes.ERROR_ATTRIBUTES)
                }
                is ActionRecord -> {
                    val risk = node.risk
                    icon = when {
                        node.isError -> AllIcons.Actions.Cancel
                        risk != null -> AllIcons.General.Warning
                        else -> catIcon(node.category)
                    }
                    val style = if (node.isError) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_ATTRIBUTES
                    if (node.ts > 0) append("${hhmm.format(Date(node.ts))}  ", SimpleTextAttributes.GRAYED_ATTRIBUTES) // the timestamp
                    append("${node.tool}  ", if (node.isError) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    append(node.target.replace(Regex("\\s+"), " "), style)
                    if (risk != null) append("  ⚠ ${risk.level}", if (risk.level == "high") SimpleTextAttributes.ERROR_ATTRIBUTES else amber)
                    node.detail?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    toolTipText = listOfNotNull(node.target, risk?.let { "⚠ ${it.reasons.joinToString(" · ")}" }, node.reasoning?.lineSequence()?.firstOrNull()?.let { "💭 $it" }).joinToString("\n")
                }
            }
        }

        private fun catIcon(cat: String): javax.swing.Icon = when (cat) {
            "edit" -> AllIcons.Actions.EditSource
            "exec" -> AllIcons.Debugger.Console
            "read" -> AllIcons.Actions.Preview
            "search" -> AllIcons.Actions.Find
            "web" -> AllIcons.General.Web
            "agent" -> AllIcons.Actions.RunAll
            "todo" -> AllIcons.Actions.Checked
            "mcp" -> AllIcons.Nodes.Plugin
            "compact" -> AllIcons.Actions.Collapseall
            "meta" -> AllIcons.General.Settings
            else -> AllIcons.General.Information
        }
    }
}
