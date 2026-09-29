package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObserveCache
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeSelectionModel

/**
 * File History: the ACTIVE editor's agent edits, oldest→newest (id · time · status · reasoning).
 * Follows the selected file via FileEditorManagerListener.selectionChanged; repaints on every store
 * change (service listener) and reasoning refresh (ObserveCache). Flat — no folder/class grouping.
 * The store read-primitive: service.log().filter { it.file == storeKey(<activeFile>.path) } — absolute-path
 * equality after the editor→store path bridge (#43).
 * Parity with the VS Code File History tree view.
 */
class FileHistoryPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = false
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "Open a file the agent has edited to see its history"
        cellRenderer = Renderer(project)
    }

    // The file whose history we render — seeded from the current selection, updated on selectionChanged.
    @Volatile private var currentFile: VirtualFile? =
        FileEditorManager.getInstance(project).selectedFiles.firstOrNull()

    init {
        setContent(JBScrollPane(tree))
        toolbar = buildToolbar()
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) selectedEdit()?.let { rec ->
                    service().currentSession()?.let { s -> Navigate.openFileAtEdit(project, s, rec) }
                }
            }
        })
        PopupHandler.installPopupMenu(tree, buildPopupGroup(), "ClaudeObservatoryFileHistoryPopup")
        service().addListener { rebuild() }                         // keep/undo/capture → repaint
        ObserveCache.getInstance(project).addListener { rebuild() } // reasoning lands async → enrich rows
        // Follow the active editor. Parent the subscription to the project (mirrors the panels' listener lifetime).
        project.messageBus.connect(project).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    currentFile = event.newFile ?: currentFile // sticky on null (diff/close) — less flicker
                    rebuild()
                }
            },
        )
        rebuild()
    }

    private fun service() = ObservatoryService.getInstance(project)

    private fun selectedEdit(): EditRecord? =
        (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? EditRecord

    fun rebuild() {
        val file = currentFile
        val edits = if (file == null) emptyList()
        else service().log().filter { it.file == ClaudePaths.storeKey(file.path) }.sortedWith(compareBy({ it.ts }, { it.id }))
        tree.emptyText.text =
            if (file == null) "Open a file the agent has edited to see its history"
            else "No agent edits in ${file.name}"
        root.removeAllChildren()
        for (rec in edits) root.add(DefaultMutableTreeNode(rec))
        model.reload()
        expandAllBounded(tree)
    }

    private fun buildToolbar(): JComponent {
        val group = DefaultActionGroup(
            action("Accept All Edits in File", NavTint.ACCEPT_FILE) { acceptFile() },
            action("Reject All Edits in File", NavTint.REJECT) { revertFile() },
            // Directional icons so prev/next read at a glance without hovering (they shared one Diff icon).
            action("Diff Previous Revision", AllIcons.Actions.Back) { stepRevision(-1) },
            action("Diff Next Revision", AllIcons.Actions.Forward) { stepRevision(1) },
            action("Refresh", AllIcons.Actions.Refresh) { service().sweepIgnoredThen { service().refresh(force = true) } },
        )
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryFileHistory", group, true)
        tb.targetComponent = tree
        return tb.component
    }

    private fun buildPopupGroup(): DefaultActionGroup = DefaultActionGroup(
        action("Open File at Edit", AllIcons.Actions.EditSource) {
            selectedEdit()?.let { rec -> withSession { s -> Navigate.openFileAtEdit(project, s, rec) } }
        },
        action("Show Diff", AllIcons.Actions.Diff) {
            selectedEdit()?.let { rec -> withSession { s -> Diffs.show(project, s, rec) } }
        },
        action("Keep", NavTint.KEEP) {
            selectedEdit()?.takeIf { it.pending }?.let { rec -> withSession { s -> ReviewOps.keep(project, s, rec.id) } }
        },
        action("Undo", NavTint.UNDO) {
            selectedEdit()?.takeIf { !it.undone }?.let { rec -> withSession { s -> ReviewOps.undoOrRedo(project, s, rec, redo = false) } }
        },
        action("Redo", NavTint.REDO) {
            selectedEdit()?.takeIf { it.undone }?.let { rec -> withSession { s -> ReviewOps.undoOrRedo(project, s, rec, redo = true) } }
        },
        action("Chat About Edit", NavTint.CHAT) {
            selectedEdit()?.let { rec -> withSession { s -> ReviewOps.chatAbout(project, s, rec.id) } }
        },
    )

    /** Step the active editor's agent revisions in a current-vs-revision diff (parity with the
     *  ⌥⌘[ / ⌥⌘] editor actions). Needs a text editor — the diff pane is not one. */
    private fun stepRevision(dir: Int) {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
            ?: return ReviewOps.notify(project, "Open a file to navigate its agent revisions")
        RevisionNav.step(project, editor, dir)
    }

    private fun acceptFile() = withSession { s ->
        val file = currentFile ?: return@withSession
        ReviewOps.keepAll(project, s, service().log().filter { it.file == ClaudePaths.storeKey(file.path) }, file.name)
    }

    private fun revertFile() = withSession { s ->
        val file = currentFile ?: return@withSession
        ReviewOps.undoAll(project, s, service().log().filter { it.file == ClaudePaths.storeKey(file.path) }, file.name, file.path)
    }

    private fun withSession(block: (String) -> Unit) {
        val s = service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
            return
        }
        block(s)
    }

    private fun action(text: String, icon: Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private class Renderer(private val project: Project) : ColoredTreeCellRenderer() {
        private val hhmm = SimpleDateFormat("HH:mm")

        // Reasoning first-line via the cached observe --json payload (same source Timeline uses).
        private fun summaryFor(id: Int): String? =
            ObserveCache.getInstance(project).payload()?.edits?.find { it.id == id }
                ?.let { it.reasoning?.lineSequence()?.firstOrNull() ?: it.summary }

        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            val rec = (value as? DefaultMutableTreeNode)?.userObject as? EditRecord ?: return
            icon = when {
                rec.kept -> NavTint.KEEP
                rec.undone -> AllIcons.Actions.Cancel
                else -> AllIcons.General.Modified
            }
            val style = when {
                rec.undone -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, null)
                rec.kept -> SimpleTextAttributes.GRAYED_ATTRIBUTES
                else -> SimpleTextAttributes.REGULAR_ATTRIBUTES
            }
            append("#${rec.id}  ${hhmm.format(Date(rec.ts))}", style)
            append("  ${rec.status} · ${rec.tool}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            summaryFor(rec.id)?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
            toolTipText = rec.file
        }
    }
}
