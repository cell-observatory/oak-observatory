package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.compactBytes
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.EditTree
import com.cellobservatory.observatory.model.TreeFileNode
import com.cellobservatory.observatory.model.TreeFolderNode
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.inline.InlineOverlay
import com.intellij.icons.AllIcons
import com.intellij.ide.CommonActionsManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeSelectionModel

/**
 * The Edits / Diffs trees: folder (compacted chains) → file → edit, mirroring the VS Code views.
 * EDITS mode double-click opens the file at the edit; DIFFS mode opens the before⟷after diff.
 * Class-level grouping arrives with the Phase-2 placements cache (a locate() subprocess per file
 * per refresh would be too heavy here).
 */
class EditsTreePanel(private val project: Project, private val mode: Mode) :
    SimpleToolWindowPanel(true, true) {

    enum class Mode { EDITS, DIFFS }

    sealed class NodeData {
        data class Folder(val label: String, val path: String, val edits: List<EditRecord>) : NodeData()
        data class FileN(val rel: String, val file: String, val edits: List<EditRecord>) : NodeData()
        data class Cls(val name: String, val edits: Int, val pending: Int) : NodeData()
        data class Edit(val rec: EditRecord, val added: Int, val removed: Int) : NodeData()
    }

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tracked agent edits yet"
        emptyText.appendLine("Run `oak init`, then let Claude Code edit.")
        cellRenderer = Renderer()
    }
    private val refreshListener = Runnable { rebuild() }

    // EVERYTHING the init block's own calls touch must be declared ABOVE it: Kotlin runs property
    // initializers in declaration order, and the init below calls buildToolbar() and rebuild() —
    // when idFilter/hiddenIds/storeAction sat further down, they were still NULL here, the panel
    // died mid-construction with its refresh listener already registered, and that half-built
    // listener then threw on every service tick, aborting the fan-out and starving every
    // later-registered panel of repaints: the WHOLE product blank (field failure, 2026-08-20;
    // pinned by PanelConstructionTest).

    /** When set, the tree shows ONLY these raw edit ids — the Review tab's prompt scope. Pruned
     *  client-side over the shared view-model, so one `tree` payload serves every scope. */
    @Volatile var idFilter: Set<Int>? = null

    /** Ids the tree must NOT show whatever the scope says — the cancelled-out chains, which the
     *  Review tab accounts for in its footer instead of as rows. */
    @Volatile var hiddenIds: Set<Int> = emptySet()

    /** Raw edit ids `review --json` marked review-only, and the authoritative capture-evidence
     *  string per raw id (core.captureSummary). The tree renders from `tree --json`, whose per-edit
     *  projection carries neither the full evidence (model/tool/turn) nor review's wider
     *  review-only rule (it emits `partial` only for `rec.partial`, not `uncertainCreation`), so
     *  the Review tab feeds both down here. Empty for any other host → the renderer falls back to
     *  the record's own fields. Set by ReviewPanel before rebuild; mirrors the idFilter seam. */
    @Volatile var reviewOnlyIds: Set<Int> = emptySet()
    @Volatile var captureById: Map<Int, String> = emptyMap()

    /** Open the reviewed session's store folder on disk, next to Export — where
     *  every edit's before/after blobs and the review log live. The label carries the CURRENT size
     *  (refreshed with the tree), so "how big has this session's store grown" reads on hover. */
    private val storeAction: AnAction = action("Open Store Folder", AllIcons.Nodes.Folder) {
        ReviewOps.revealStoreFolder(project, service().currentSession()?.let { com.cellobservatory.observatory.core.ClaudePaths.storeDir(it).toString() })
    }

    init {
        setContent(JBScrollPane(tree))
        toolbar = buildToolbar()
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    val edit = selectedEdit()
                    if (edit != null) {
                        activate(edit)
                    } else {
                        // A FILE row: the filename opens the file itself — parity with the VS Code
                        // Review list, whose filename click does the same. Edit rows keep opening
                        // at the edit / as the diff.
                        selectedFile()?.let { Navigate.openFile(project, it.file) }
                    }
                }
            }
        })
        PopupHandler.installPopupMenu(tree, buildPopupGroup(), "ClaudeObservatoryTreePopup")
        ObservatoryService.getInstance(project).addListener(refreshListener)
        rebuild()
    }

    private fun service() = ObservatoryService.getInstance(project)

    private fun activate(rec: EditRecord) {
        val session = service().currentSession() ?: return
        when (mode) {
            Mode.EDITS -> Navigate.openFileAtEdit(project, session, rec)
            Mode.DIFFS -> Diffs.show(project, session, rec)
        }
    }

    /** The selected edit. PUBLIC because the Review tab draws its own per-edit action toolbar over
     *  this tree: a context menu alone reads as "there are no actions" to anyone who does not
     *  right-click, which is exactly how it was reported. */
    fun selectedEdit(): EditRecord? =
        ((tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Edit)?.rec

    private fun selectedFile(): NodeData.FileN? =
        (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.FileN

    private fun selectedFolder(): NodeData.Folder? =
        (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Folder

    // --- tree building (renders core's `tree --json` view-model; no local tree/class logic) ---

    /** Every edit id the payload carries — the base set when only [hiddenIds] is narrowing. */
    private fun allTreeIds(vm: EditTree?): Set<Int> {
        if (vm == null) return emptySet()
        val out = mutableSetOf<Int>()
        fun file(f: TreeFileNode) {
            for (c in f.classes) for (e in c.edits) out.add(e.rec.id)
            for (e in f.loose) out.add(e.rec.id)
        }
        fun folder(f: TreeFolderNode) {
            f.folders.forEach(::folder)
            f.files.forEach(::file)
        }
        vm.folders.forEach(::folder)
        vm.files.forEach(::file)
        return out
    }

    private fun filterFile(file: TreeFileNode, ids: Set<Int>): TreeFileNode? {
        val classes = file.classes.mapNotNull { cls ->
            val kept = cls.edits.filter { it.rec.id in ids }
            if (kept.isEmpty()) null else cls.copy(edits = kept)
        }
        val loose = file.loose.filter { it.rec.id in ids }
        if (classes.isEmpty() && loose.isEmpty()) return null
        return file.copy(classes = classes, loose = loose)
    }

    private fun filterFolder(f: TreeFolderNode, ids: Set<Int>): TreeFolderNode? {
        val folders = f.folders.mapNotNull { filterFolder(it, ids) }
        val files = f.files.mapNotNull { filterFile(it, ids) }
        if (folders.isEmpty() && files.isEmpty()) return null
        return f.copy(folders = folders, files = files)
    }

    fun rebuild() {
        val vm0 = service().editTree()
        val hidden = hiddenIds
        // One predicate for both prunes: the scope's id set (when scoped) minus whatever the host
        // hides outright, so a cancelled chain cannot reappear through the scope filter.
        val ids = when {
            idFilter == null && hidden.isEmpty() -> null
            idFilter == null -> allTreeIds(vm0) - hidden
            else -> (idFilter as Set<Int>) - hidden
        }
        val vm = if (vm0 == null || ids == null) vm0 else EditTree(
            folders = vm0.folders.mapNotNull { filterFolder(it, ids) },
            files = vm0.files.mapNotNull { filterFile(it, ids) },
        )
        val q = service().filterQuery
        tree.emptyText.clear()
        when {
            // The fetch FAILED — an empty tree must say so, not claim "no edits in this session yet":
            // this plugin renders the CLI's answer, and a missing/older CLI otherwise presents as a
            // convincing, silent blank (reported as exactly that from PyCharm, 2026-08-20).
            vm0 == null && service().treeFetchFailed -> {
                tree.emptyText.appendLine("No answer from the oak CLI — the Review tree could not be fetched.")
                tree.emptyText.appendLine("Is the CLI installed and on PATH? Hit Refresh to retry.")
                tree.emptyText.appendLine(
                    "Run the Setup Check (doctor)",
                    com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES
                ) { ReviewOps.openDoctor(project) }
            }
            // A prompt scope with nothing left is about the SCOPE, never about the session — the
            // "no edits in this session / switch session" copy would be false here, and its
            // session-switch link a trap inside the Review tab. Keyed on the PROMPT scope, not on
            // whether anything was pruned: hidden cancelled chains narrow the same id set without
            // an ask being picked at all.
            idFilter != null -> {
                tree.emptyText.appendLine("Nothing from this ask to show")
                tree.emptyText.appendLine("Its records may have been cleared — Clear Scope shows the whole session.")
            }
            q.isNotBlank() -> tree.emptyText.appendLine("No edits match \"$q\"")
            !com.cellobservatory.observatory.core.ClaudePaths.hooksInstalled() -> {
                tree.emptyText.appendLine("No tracked agent edits yet")
                tree.emptyText.appendLine("Run `oak init`, then let Claude Code edit.")
                tryTheDemoLine()
            }
            else -> {
                // Hooks are fine — never imply otherwise. A fresh session with prior work gets a
                // one-click switch (parity with the VS Code welcome-view split).
                val current = service().currentSession()
                // listSessions() is store-GLOBAL: intersect with THIS project's transcript ids or
                // the empty state would advertise an unrelated repo's session (parity: extension.ts).
                val here: Set<String> = project.basePath?.let { base ->
                    runCatching {
                        java.nio.file.Files.list(com.cellobservatory.observatory.core.ClaudePaths.projectDir(base)).use { s ->
                            s.map { it.fileName.toString() }
                                .filter { it.endsWith(".jsonl") }
                                .map { it.removeSuffix(".jsonl") }
                                .toList()
                                .toSet()
                        }
                    }.getOrNull()
                } ?: emptySet()
                val prior = com.cellobservatory.observatory.core.StoreReader.listSessions()
                    .firstOrNull { it.id != current && it.edits > 0 && it.id in here }
                if (prior != null) {
                    tree.emptyText.appendLine("No edits in this session yet — the hooks are working.")
                    tree.emptyText.appendLine(
                        "Switch to previous session (${prior.id.take(8)} · ${prior.edits} edit${if (prior.edits == 1) "" else "s"})",
                        com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES
                    ) {
                        ReviewOps.applySessionChoice(project, prior.id)
                    }
                    tree.emptyText.appendLine(
                        "Pick a session…",
                        com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES
                    ) { ReviewOps.chooseSession(project, tree) }
                } else {
                    tree.emptyText.appendLine("No edits in this session yet.")
                    tryTheDemoLine()
                    tree.emptyText.appendLine("Let agent edit a file and it will appear here.")
                }
            }
        }
        // The store ticks whenever ANY session on this machine writes, and `reload()` clears the
        // selection — so without this the reader's selected row (and every action that acts on it)
        // vanished every couple of seconds while the agent worked anywhere. Re-select the same EDIT ID
        // after the rebuild; no scrolling, or the tree would yank itself around under the reader.
        val keepId = selectedEdit()?.id
        root.removeAllChildren()
        if (vm != null) {
            for (f in sortFolders(vm.folders.filter { folderVisible(it) })) addFolderNode(root, f)
            for (file in sortFiles(vm.files.filter { fileVisible(it) })) addFileNode(root, file)
        }
        // The store button's label tracks the store it opens
        // — refreshed here, where the tree already rebuilds on every store tick.
        run {
            val s = service().currentSession()
            val sz = s?.let { storeSizeText(it) }
            storeAction.templatePresentation.text = if (sz != null) "Open Store Folder ($sz)" else "Open Store Folder"
        }
        model.reload()
        expandAllBounded(tree)
        if (keepId != null) reselect(keepId)
    }

    /** Put the selection back on edit [id] after a rebuild, if that row still exists. */
    private fun reselect(id: Int) {
        val stack = ArrayDeque<DefaultMutableTreeNode>().apply { add(root) }
        while (stack.isNotEmpty()) {
            val node = stack.removeLast()
            if ((node.userObject as? NodeData.Edit)?.rec?.id == id) {
                tree.selectionPath = javax.swing.tree.TreePath(node.path)
                return
            }
            for (i in 0 until node.childCount) stack.add(node.getChildAt(i) as DefaultMutableTreeNode)
        }
    }

    // The filter control's regex/extension/type narrowing (the Search query is applied CLI-side, or
    // client-side in regex mode via service.matchesFile) and the time/name sort — client-side over the
    // parsed tree, so all three surfaces order and narrow the same way.
    private fun fileVisible(f: TreeFileNode): Boolean = service().matchesFile(f.rel, f.ext, f.category)
    private fun folderVisible(f: TreeFolderNode): Boolean = f.files.any { fileVisible(it) } || f.folders.any { folderVisible(it) }
    private fun sortFiles(files: List<TreeFileNode>): List<TreeFileNode> = when (service().sortKey()) {
        "name" -> files.sortedBy { it.rel }
        "name-desc" -> files.sortedByDescending { it.rel }
        "time-asc" -> files.sortedWith(compareBy<TreeFileNode> { it.maxTs }.thenBy { it.rel })
        else -> files.sortedWith(compareByDescending<TreeFileNode> { it.maxTs }.thenBy { it.rel }) // time
    }
    private fun sortFolders(folders: List<TreeFolderNode>): List<TreeFolderNode> {
        fun newest(fo: TreeFolderNode) = fo.files.maxOfOrNull { it.maxTs } ?: 0L
        return when (service().sortKey()) {
            "name" -> folders.sortedBy { it.label }
            "name-desc" -> folders.sortedByDescending { it.label }
            "time-asc" -> folders.sortedWith(compareBy<TreeFolderNode> { newest(it) }.thenBy { it.label })
            else -> folders.sortedWith(compareByDescending<TreeFolderNode> { newest(it) }.thenBy { it.label }) // time
        }
    }

    private fun addFolderNode(parent: DefaultMutableTreeNode, f: TreeFolderNode) {
        val node = DefaultMutableTreeNode(NodeData.Folder(f.label, f.path, f.allEdits))
        parent.add(node)
        for (sub in sortFolders(f.folders.filter { folderVisible(it) })) addFolderNode(node, sub)
        for (file in sortFiles(f.files.filter { fileVisible(it) })) addFileNode(node, file)
    }

    private fun addFileNode(parent: DefaultMutableTreeNode, file: TreeFileNode) {
        val fileNode = DefaultMutableTreeNode(NodeData.FileN(file.rel, file.file, file.allEdits))
        parent.add(fileNode)
        for (cls in file.classes) {
            val clsNode = DefaultMutableTreeNode(NodeData.Cls(cls.name, cls.edits.size, cls.edits.count { it.rec.pending }))
            fileNode.add(clsNode)
            for (e in cls.edits) clsNode.add(DefaultMutableTreeNode(NodeData.Edit(e.rec, e.added, e.removed)))
        }
        for (e in file.loose) fileNode.add(DefaultMutableTreeNode(NodeData.Edit(e.rec, e.added, e.removed)))
    }

    // --- rendering ---

    // inner: the edit rows read the panel's reviewOnlyIds/captureById (the Review tab's evidence).
    private inner class Renderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            val node = (value as? DefaultMutableTreeNode)?.userObject ?: return
            when (node) {
                is NodeData.Folder -> {
                    icon = AllIcons.Nodes.Folder
                    append(node.label)
                }
                is NodeData.FileN -> {
                    icon = AllIcons.FileTypes.Any_type
                    append(File(node.file).name)
                    val pending = node.edits.count { it.pending }
                    val maxTs = node.edits.maxOfOrNull { it.ts } ?: 0L
                    append("  ${node.edits.size} edit(s) · $pending pending" + (if (maxTs > 0) " · ${relTime(maxTs)}" else ""), SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = node.file
                }
                is NodeData.Cls -> {
                    icon = AllIcons.Nodes.Class
                    append(node.name)
                    append("  ${node.edits} edit(s) · ${node.pending} pending", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is NodeData.Edit -> {
                    val r = node.rec
                    icon = when {
                        r.kept -> NavTint.KEEP
                        r.undone -> AllIcons.Actions.Cancel
                        else -> AllIcons.General.Modified
                    }
                    val style = when {
                        r.undone -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, null)
                        r.kept -> SimpleTextAttributes.GRAYED_ATTRIBUTES
                        else -> SimpleTextAttributes.REGULAR_ATTRIBUTES
                    }
                    append("#${r.id}  +${node.added} −${node.removed}", style)
                    if (r.reviewOnly || r.id in reviewOnlyIds) {
                        // Marked BEFORE the reader acts: a partial record's undo refuses with the
                        // stated reason, and without this badge it renders as an ordinary create.
                        // `reviewOnlyIds` carries review --json's wider rule (uncertainCreation),
                        // which the tree payload's own `partial` does not.
                        append("  review-only", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, com.intellij.ui.JBColor.ORANGE))
                    }
                    append("  ${r.status} · ${r.tool} · ${relTime(r.ts)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    // core.captureSummary (from review --json) when the Review tab supplied it —
                    // it carries model/tool/turn the tree payload drops; else the record's own.
                    toolTipText = "${r.file} — " + (captureById[r.id] ?: r.captureDescription)
                }
            }
        }
    }

    // --- toolbar + context menu ---

    private fun buildToolbar(): javax.swing.JComponent {
        val group = DefaultActionGroup(
            FilterSortActions.searchField(project),
            FilterSortActions.filterGroup(project),
            FilterSortActions.sortGroup(project),
            action("Review Previous Pending Edit", AllIcons.Actions.Back) { reviewPrev() },
            action("Review Next Pending Edit", AllIcons.Actions.Forward) { reviewNext() },
            action("Accept All Edits", NavTint.ACCEPT_ALL) {
                withSession { s -> ReviewOps.keepAll(project, s) }
            },
            action("Reject All Edits", NavTint.REVERT_ALL) {
                withSession { s -> ReviewOps.undoAll(project, s, service().log(), "this session") }
            },
            action("Redo All Edits", NavTint.REDO) {
                withSession { s -> ReviewOps.redoAll(project, s, service().log(), "this session") }
            },
            fileScopedAction("Accept All Edits in Current File", NavTint.ACCEPT_FILE) { s, vf ->
                ReviewOps.keepAll(project, s, service().log().filter { it.file == ClaudePaths.storeKey(vf.path) }, vf.name)
            },
            fileScopedAction("Reject All Edits in Current File", NavTint.REJECT) { s, vf ->
                ReviewOps.undoAll(project, s, service().log().filter { it.file == ClaudePaths.storeKey(vf.path) }, vf.name, vf.path)
            },
            action("Clear Resolved Edits", NavTint.CLEAR) {
                withSession { s ->
                    val resolved = service().log().count { !it.pending }
                    if (resolved > 0) ReviewOps.clearResolved(project, s, resolved)
                    else ReviewOps.notify(project, "No resolved edits to clear")
                }
            },
            action("Switch Session", AllIcons.Vcs.Branch) { ReviewOps.chooseSession(project, tree) },
            action("Refresh", AllIcons.Actions.Refresh) { service().sweepIgnoredThen { service().refresh(force = true) } },
            toggle("Toggle Inline Review", AllIcons.Actions.Show,
                { ObservatorySettings.instance.state.inlineReview },
                { on ->
                    ObservatorySettings.instance.state.inlineReview = on
                    InlineOverlay.getInstance(project).refreshAll()
                    // Transient status text, not a persistent balloon (parity with VS Code's toggle).
                    ReviewOps.status(project, "Inline review " + (if (on) "on" else "off"))
                }),
            action("Export Review Summary", AllIcons.ToolbarDecorator.Export) { exportSummary() },
            storeAction,
            action("Setup Check (doctor)", AllIcons.General.Information) { ReviewOps.openDoctor(project) },
        )
        // No demo buttons here. This toolbar is for reviewing the session in front of you; demo mode lives
        // on the Overview's nav bar, which is one panel away and is where both editors now offer it. The
        // empty state below still links straight into the demo — that is the first-run path, and it is a
        // link in the place a reader is already looking, not a button competing with the review actions.
        // Collapse-all / expand-all for the folder → file → class tree — IntelliJ's own tree actions,
        // the platform equivalent of VS Code's file-Explorer Collapse-All button.
        val expander = DefaultTreeExpander(tree)
        val cam = CommonActionsManager.getInstance()
        group.addSeparator()
        group.add(cam.createCollapseAllAction(expander, tree))
        group.add(cam.createExpandAllAction(expander, tree))
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryTree", group, true)
        tb.targetComponent = tree
        return tb.component
    }

    private fun buildPopupGroup(): DefaultActionGroup = DefaultActionGroup(
        action("Review Previous Pending Edit", AllIcons.Actions.Back) { reviewPrev() },
        action("Review Next Pending Edit", AllIcons.Actions.Forward) { reviewNext() },
        action("Open File at Edit", AllIcons.Actions.EditSource) {
            selectedEdit()?.let { rec -> withSession { s -> Navigate.openFileAtEdit(project, s, rec) } }
        },
        action("Show Diff", AllIcons.Actions.Diff) {
            selectedEdit()?.let { rec -> withSession { s -> Diffs.show(project, s, rec) } }
        },
        // Opt-in `claude -p` deep analysis (spends tokens): open the result as a markdown tab.
        action("Analyze Edit with Claude", Icons.Star) {
            selectedEdit()?.let { rec -> withSession { s -> ReviewOps.analyzeEdit(project, s, rec.id) } }
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
        // Zero-token handoff: assembles this edit's context onto the clipboard (parity with the
        // diff viewer's Chat action and VS Code's per-edit Chat).
        action("Chat About This Edit", NavTint.CHAT) {
            selectedEdit()?.let { rec -> withSession { s -> ReviewOps.chatAbout(project, s, rec.id) } }
        },
        action("Open File", AllIcons.Actions.MenuOpen) {
            val file = selectedEdit()?.file ?: selectedFile()?.file
            file?.let {
                LocalFileSystem.getInstance().refreshAndFindFileByPath(it)?.let { vf ->
                    FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, vf), true)
                }
            }
        },
        action("Keep All in File", NavTint.ACCEPT_FILE) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, f.edits, File(f.file).name) } }
        },
        action("Undo All in File", NavTint.REJECT) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, f.edits, File(f.file).name, f.file) } }
        },
        action("Redo All in File", NavTint.REDO) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.redoAll(project, s, f.edits, File(f.file).name, f.file) } }
        },
        action("Clear Resolved in File", NavTint.CLEAR) {
            selectedFile()?.let { f ->
                withSession { s -> ReviewOps.clearResolvedScoped(project, s, f.edits.count { !it.pending }, File(f.file).name, f.file) }
            }
        },
        // Folder-scoped: accept / revert / clear every edit at-or-beneath the selected folder (parity
        // with VS Code's folder-row inline actions; reuses the file-scoped keep/undo plumbing).
        action("Accept All in Folder", NavTint.ACCEPT_FILE) {
            selectedFolder()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, f.edits, f.label) } }
        },
        action("Reject All in Folder", NavTint.REJECT) {
            selectedFolder()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, f.edits, f.label, f.path) } }
        },
        action("Redo All in Folder", NavTint.REDO) {
            selectedFolder()?.let { f -> withSession { s -> ReviewOps.redoAll(project, s, f.edits, f.label, f.path) } }
        },
        action("Clear Resolved in Folder", NavTint.CLEAR) {
            selectedFolder()?.let { f ->
                withSession { s -> ReviewOps.clearResolvedScoped(project, s, f.edits.count { !it.pending }, f.label, f.path) }
            }
        },
    )

    /** Export a shareable markdown review summary (kept/reverted per file) and open it in an editor tab.
     *  Runs the CLI off the EDT (parity with VS Code's core-in-process export — same markdown). */
    private fun exportSummary() = withSession { s ->
        ReviewOps.openMarkdown(
            project,
            "claude-review-summary",
            "Could not generate a review summary (is the oak CLI installed?)",
        ) { com.cellobservatory.observatory.core.ObservatoryCli.summaryMarkdown(s, project.basePath) }
    }

    /** Filter the Edits/Diffs trees by file path (empty clears). Shared via the service so both trees filter together. */
    private fun searchEdits() {
        val q = com.intellij.openapi.ui.Messages.showInputDialog(
            project,
            "Filter edits by file path (empty to clear):",
            "Search Edits",
            null,
            service().filterQuery,
            null,
        )
        if (q != null) service().setFilter(q)
    }

    /** Step to the next (⏭) / previous (⏮) pending edit, cycling through all of them (parity with VS Code). */
    private fun reviewNext() = withSession { s ->
        val next = service().nextPendingEdit()
        if (next == null) ReviewOps.notify(project, "No pending agent edits — all caught up")
        else Navigate.openFileAtEdit(project, s, next)
    }

    private fun reviewPrev() = withSession { s ->
        val prev = service().prevPendingEdit()
        if (prev == null) ReviewOps.notify(project, "No pending agent edits — all caught up")
        else Navigate.openFileAtEdit(project, s, prev)
    }

    private fun withSession(block: (String) -> Unit) {
        val s = service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", com.intellij.notification.NotificationType.WARNING)
            return
        }
        block(s)
    }

    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** The store's on-disk footprint: the log plus one shallow pass over the blobs directory — a
     *  single readdir, cheap enough to ride every tree refresh. */
    private fun storeSizeText(session: String): String? = try {
        val dir = com.cellobservatory.observatory.core.ClaudePaths.storeDir(session)
        val log = dir.resolve("log.jsonl").toFile().let { if (it.exists()) it.length() else return null }
        val blobs = dir.resolve("blobs").toFile()
        val total = log + (blobs.listFiles()?.sumOf { it.length() } ?: 0L)
        if (total > 0) compactBytes(total) else null
    } catch (_: Exception) {
        null
    }

    /**
     * The empty state's way into demo mode — the entry point that decides whether a first-time reader
     * ever finds it. Offered even when the capture hooks are missing, because the replay drives the
     * pipeline through the CLI directly and does not need them. Says "sidebar" rather than "every
     * panel": the dock panels shell out to the CLI, so a machine without it on PATH fills the trees and
     * the inline review and reports the missing CLI in the dock, which is what actually happens.
     */
    private fun tryTheDemoLine() {
        if (ReviewOps.demoPresent(project)) return
        tree.emptyText.appendLine(
            "Try the demo — no agent session needed",
            com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES
        ) { ReviewOps.startDemo(project) }
    }

    private fun toggle(text: String, icon: javax.swing.Icon, isOn: () -> Boolean, set: (Boolean) -> Unit): ToggleAction =
        object : ToggleAction(text, null, icon), DumbAware {
            // Reads a settings flag, nothing UI. Staying on the EDT made the platform hop for it.
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun isSelected(e: AnActionEvent) = isOn()
            override fun setSelected(e: AnActionEvent, state: Boolean) = set(state)
        }

    /** The path of the tab in front, read from the background-safe tracker (see ActiveFileTracker). */
    private fun activeFilePath(): String? =
        com.cellobservatory.observatory.services.ActiveFileTracker.getInstance(project).activePath()

    private fun activeFile(): VirtualFile? = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()

    /** A bulk action scoped to the ACTIVE editor's file, gated (enabled+visible) on that file having
     *  pending edits. The tree toolbar has no VIRTUAL_FILE in its data context, so we read the active
     *  file from FileEditorManager (parity with VS Code's keepOpenFile/undoOpenFile).
     *
     *  The gate runs on a BGT thread and must therefore read the tracker, while the click runs on the
     *  EDT where FileEditorManager is available — two sources that can name different files across a tab
     *  switch. These are bulk, destructive verbs (accept/reject EVERY pending edit in a file), so the
     *  click resolves the SAME path the gate approved and only falls back to the editor's own answer
     *  when that path is still what is in front. Disagreement cancels rather than guesses: silently
     *  accepting a file the user was not looking at is unrecoverable. */
    private fun fileScopedAction(text: String, icon: javax.swing.Icon, run: (String, VirtualFile) -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun update(e: AnActionEvent) {
                val path = activeFilePath()
                // `hiddenIds` too: a file whose only pending records sit in a cancelled-out chain shows
                // no rows in this tree, so offering a verb for it promises work that is not there.
                e.presentation.isEnabledAndVisible = path != null &&
                    service().log().any { it.pending && it.file == ClaudePaths.storeKey(path) && it.id !in hiddenIds }
            }

            override fun actionPerformed(e: AnActionEvent) {
                val path = activeFilePath() ?: return
                val vf = activeFile()?.takeIf { it.path == path }
                    ?: com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(path)
                    ?: return
                withSession { s -> run(s, vf) }
            }
        }
}
