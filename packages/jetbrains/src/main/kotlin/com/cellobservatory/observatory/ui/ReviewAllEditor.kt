package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.tools.fragmented.UnifiedDiffTool
import com.intellij.diff.tools.simple.SimpleDiffTool
import com.intellij.diff.tools.util.base.TextDiffSettingsHolder
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.impl.EditorComponentImpl
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.InplaceButton
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.UIUtil
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.beans.PropertyChangeListener
import java.io.File
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.ScrollPaneConstants

/** One unit of the stacked review WITHOUT its texts — blobs are read per PAGE. A 2,922-unit session
 *  must not read (or hold) every blob pair up front, and must never build thousands of Swing diff
 *  panels in one EDT breath: the eager version measurably froze the IDE. */
data class ReviewAllSpec(val rec: EditRecord, val rel: String, val delta: Int)

/** The payload behind the "Open all in editor" tab. A snapshot of the moment it opened — reviewing
 *  from it mutates the store (the panels refresh), but the tab itself does not re-derive. */
class ReviewAllVirtualFile(
    val session: String,
    val specs: List<ReviewAllSpec>,
    name: String,
) : LightVirtualFile(name) {
    init {
        isWritable = false
    }
}

/**
 * "Open all in editor", as ONE editor tab stacking the listed pending units: a header row per unit
 * (Keep / Undo / Chat, then #id · path) above an embedded hunks-only unified diff.
 *
 * PAGED, ten blocks at a time: each page's blob pairs are read on a pooled thread, its panels built
 * on the EDT, and a "next ten" button carries on — so opening the tab costs ten diffs however large
 * the session, and a missing blob skips its block with a warning instead of rendering as an empty
 * side. Each block hosts its own [BlockDiffProcessor] (a DiffRequestProcessor subclass whose
 * CONTEXT arrives preloaded — the forced stacked/side-by-side view travels no other channel); the
 * platform's combined diff is internal surface with no per-block action seam.
 */
class ReviewAllEditor(private val project: Project, private val file: ReviewAllVirtualFile) :
    UserDataHolderBase(), FileEditor {

    private companion object {
        const val PAGE = 10
    }

    // TRACKS VIEWPORT WIDTH: the blocks scale with the window (headers here are short "#id · rel",
    // so nothing needs the horizontal-overflow escape the Review rows once used — without tracking,
    // BoxLayout sized blocks to their preferred width and a wide window left dead space beside every
    // diff).
    private val stack = object : JPanel(), javax.swing.Scrollable {
        init {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(8, 10)
        }
        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
        override fun getScrollableUnitIncrement(visible: java.awt.Rectangle, orientation: Int, direction: Int): Int = JBUI.scale(19)
        override fun getScrollableBlockIncrement(visible: java.awt.Rectangle, orientation: Int, direction: Int): Int = visible.height
        override fun getScrollableTracksViewportWidth(): Boolean = true
        override fun getScrollableTracksViewportHeight(): Boolean = false
    }
    // Horizontal scrollbar NEVER: with the stack width-tracking the viewport it could never engage,
    // and a policy that can never fire is a claim the layout does not honor.
    private val scroll = JBScrollPane(
        stack,
        ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED,
        ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER,
    )
    private val more = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
        alignmentX = JComponent.LEFT_ALIGNMENT
    }
    private var built = 0

    /** Set by [dispose]: a page whose blob read lands AFTER the tab closed (re-open replaces the
     *  file; the platform disposes this editor) must not build panels parented to a disposed
     *  Disposable — `Disposer.register` throws on that. */
    @Volatile private var disposed = false

    // ---- the two views + Spotlight ------------------------------------------
    /** false = STACKED (unified — removed/added inline, the reading-column default this tab has
     *  always been); true = SIDE BY SIDE (the platform's two-pane viewer, halves each block). */
    private var sideBySide = false

    /** Dim every unmodified line inside the built diffs, so the changes carry the column.
     *  ON by default — the changes are what this tab is for. */
    private var spotlightOn = true

    /** Every built diff processor, so a view switch can dispose them EXPLICITLY — each is parented
     *  to this editor, and a rebuild that only removed the Swing nodes would leak one full set of
     *  viewers per toggle until the tab closed. */
    private val diffPanels = mutableListOf<BlockDiffProcessor>()

    /** One built block's action row, re-skinned in place as the record's status moves. */
    private class ActsRow(val rec: EditRecord, val panel: JPanel, var shown: String)
    private val actsRows = mutableListOf<ActsRow>()

    /** The log freshness key the rows were last synced against — one stat per store tick, a full
     *  re-read only when the log actually moved. */
    @Volatile private var actsLogKey = ""

    /** True while the pane is too narrow for worded verbs — the rows show ✓/✗/↺/↻ glyphs alone
     *  (the words ride the tooltips), so the pair never clips away at the pane edge. */
    @Volatile private var compactActs = false

    /** Re-derive [compactActs] from the stack's width and re-label every built row on a change.
     *  Internal so the platform test can drive the swap without a real resize pump. */
    internal fun syncCompact(width: Int = stack.width) {
        val compact = width in 1 until JBUI.scale(440)
        if (compact == compactActs) return
        compactActs = compact
        for (row in actsRows) if (row.shown.isNotEmpty()) fillActs(row, row.shown)
    }

    /** Fill [row] for [status]: verbs while pending, verdict + the remaining verb once decided —
     *  the same offer the VS Code stacked page patches in (kept → ↺ Revert, reverted → ↻ Redo).
     *  The verbs stay on ONE row at every width (the row sits in BorderLayout.WEST at preferred
     *  size); what narrowness changes is the LABELS — see [syncCompact]. */
    private fun fillActs(row: ActsRow, status: String) {
        val rec = row.rec
        fun t(full: String, glyph: String) = if (compactActs) glyph else full
        row.panel.removeAll()
        when (status) {
            "kept" -> {
                row.panel.add(JBLabel(t("✓ kept", "✓")).apply {
                    foreground = JBColor(0x2E7D32, 0x59A869)
                    toolTipText = "kept"
                })
                row.panel.add(JButton(t("↺ Revert", "↺")).apply {
                    toolTipText = "Revert kept #${rec.id} — its change comes off disk"
                    addActionListener { ReviewOps.undoOrRedo(project, file.session, rec, redo = false, advance = false) }
                })
            }
            "undone" -> {
                row.panel.add(JBLabel(t("✗ reverted", "✗")).apply {
                    foreground = UIUtil.getContextHelpForeground()
                    toolTipText = "reverted"
                })
                row.panel.add(JButton(t("↻ Redo", "↻")).apply {
                    toolTipText = "Re-apply reverted #${rec.id}"
                    addActionListener { ReviewOps.undoOrRedo(project, file.session, rec, redo = true, advance = false) }
                })
            }
            else -> {
                row.panel.add(JButton(t("✓ Keep", "✓")).apply {
                    toolTipText = "Keep #${rec.id}"
                    addActionListener { ReviewOps.keep(project, file.session, rec.id, advance = false) }
                })
                row.panel.add(JButton(t("✗ Undo", "✗")).apply {
                    toolTipText = "Surgically revert #${rec.id}"
                    addActionListener { ReviewOps.undoOrRedo(project, file.session, rec, redo = false, advance = false) }
                })
            }
        }
        // No per-row Chat button (it sized differently and crowded the row);
        // Chat stays on the embedded viewer's own toolbar and the Review tab's selection toolbar.
        row.shown = status
        row.panel.revalidate()
        row.panel.repaint()
    }

    /** Bring every built row to the store's CURRENT statuses. Called on the EDT (the service
     *  coalesces its listener fan-out there); keyed on the log's (mtime,size) so an idle tick costs
     *  one stat and a real change costs one read. Internal so the platform test can drive the sync
     *  deterministically instead of racing the service's coalesced fan-out. */
    internal fun syncActs() {
        if (disposed) return
        val key = StoreReader.logKey(file.session)
        if (key == actsLogKey) return
        actsLogKey = key
        val byId = StoreReader.readLog(file.session).associateBy { it.id }
        for (row in actsRows) {
            val status = byId[row.rec.id]?.status ?: row.shown
            if (status != row.shown) fillActs(row, status)
        }
    }

    private val viewBtn = JButton().apply {
        addActionListener {
            sideBySide = !sideBySide
            syncBar()
            rebuild()
        }
    }
    private val spotBtn = JButton("Spotlight").apply {
        toolTipText = "Dim the unmodified lines inside every diff, so the changes stand out"
        addActionListener {
            spotlightOn = !spotlightOn
            syncBar()
            applySpotlight()
        }
    }
    private val bar = JPanel(FlowLayout(FlowLayout.LEFT, 6, 4)).apply {
        add(viewBtn)
        add(spotBtn)
    }
    private val root = JPanel(BorderLayout()).apply {
        add(bar, BorderLayout.NORTH)
        add(scroll, BorderLayout.CENTER)
    }

    private fun syncBar() {
        // Plain words, no glyph prefixes: the emoji/shape glyphs rendered at
        // their own sizes and the two buttons visibly disagreed.
        viewBtn.text = if (sideBySide) "Stacked" else "Side by side"
        viewBtn.toolTipText =
            if (sideBySide) "Back to the stacked view — removed/added lines inline, one reading column"
            else "Side by side — before and after in two panes, the platform's two-pane viewer"
        spotBtn.text = if (spotlightOn) "Spotlight on" else "Spotlight"
    }

    /** Rebuild every block in the CURRENT view — the paged flow from the top, old viewers disposed. */
    private fun rebuild() {
        diffPanels.forEach { Disposer.dispose(it) }
        diffPanels.clear()
        actsRows.clear()
        actsLogKey = "" // the rebuilt rows start from snapshot statuses — re-derive them
        stack.removeAll()
        built = 0
        stack.revalidate()
        stack.repaint()
        addPage()
    }

    /** Re-skin the action rows when the store moves — a decision made here, in the Review tab, or
     *  from the CLI shows on the block either way. */
    private val storeListener = Runnable { syncActs() }

    init {
        syncBar()
        addPage()
        com.cellobservatory.observatory.services.ObservatoryService.getInstance(project).addListener(storeListener)
        // The width-tracking stack is what actually narrows — re-derive the label mode as it moves.
        stack.addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) = syncCompact()
        })
    }

    /** Read the NEXT page's blobs off the EDT, then append its panels — the whole point of paging. */
    private fun addPage() {
        val pageSpecs = file.specs.drop(built).take(PAGE)
        built += pageSpecs.size
        stack.remove(more)
        stack.revalidate()
        stack.repaint() // the button leaves the screen NOW, not when the read returns — a painted-but-dead button reads as broken
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val sides = pageSpecs.map {
                StoreReader.readBlobOrNull(file.session, it.rec.beforeBlob) to
                    StoreReader.readBlobOrNull(file.session, it.rec.afterBlob)
            }
            app.invokeLater {
                if (disposed || project.isDisposed) return@invokeLater
                val missing = mutableListOf<Int>()
                pageSpecs.forEachIndexed { i, spec ->
                    val (before, after) = sides[i]
                    if (before == null || after == null) {
                        missing.add(spec.rec.id)
                        return@forEachIndexed
                    }
                    stack.add(block(spec, before, after))
                }
                if (missing.isNotEmpty()) {
                    ReviewOps.notify(
                        project,
                        "Skipped ${missing.joinToString(", ") { "#$it" }} — blob(s) missing from the store",
                        NotificationType.WARNING,
                    )
                }
                val left = file.specs.size - built
                if (left > 0) {
                    more.removeAll()
                    more.add(InplaceButton("Build the next ${minOf(PAGE, left)} diffs", NavTint.tint(AllIcons.Actions.MoveDown, NavTint.BLUE)) { addPage() })
                    more.add(JBLabel("$left more not built yet — ten at a time keeps this tab instant"))
                    stack.add(more)
                }
                stack.revalidate()
                stack.repaint()
                // Fresh rows were filled from SNAPSHOT statuses — re-derive against the store, so a
                // block decided elsewhere (or before a view toggle's rebuild) opens with the truth.
                actsLogKey = ""
                syncActs()
                // Spotlight rides new pages too — DOUBLY deferred: the viewers schedule their own
                // rediff on the EDT queue, and dimming before their change highlighters exist would
                // hit the empty-guard and no-op. A block that still slips through re-dims on the
                // next toggle; the guard means it is never dimmed WRONGLY.
                if (spotlightOn) app.invokeLater { app.invokeLater { applySpotlight() } }
            }
        }
    }

    /** Our dim highlighters, per editor — so a re-apply can drop exactly ours and nothing else. */
    private val dimKey = Key.create<MutableList<RangeHighlighter>>("claudeObservatory.reviewAll.dim")

    /**
     * THE SPOTLIGHT: dim every line the diff did not mark as changed, inside
     * every built block, both views. The changed set is read from the viewers' OWN line highlighters
     * — whatever the platform marked inserted/changed/deleted stays bright — and the dim is the
     * InlineOverlay recipe verbatim: muted-grey foreground at SELECTION−1 (above syntax, below the
     * selection; a lower layer loses the merge and the dim never shows). An editor with NO diff
     * marks is left whole — dimming everything would claim "nothing here changed" about a block
     * that is entirely a change (the InlineOverlay empty-guard, same reasoning).
     */
    private fun applySpotlight() {
        if (disposed) return
        val dimAttrs = TextAttributes(JBColor.GRAY, null, null, null, Font.PLAIN)
        for (panel in diffPanels) {
            for (comp in UIUtil.findComponentsOfType(panel.component, EditorComponentImpl::class.java)) {
                val editor = comp.editor
                val markup = editor.markupModel
                // Drop OUR previous dims (tracked per editor), never the viewer's own highlighters.
                editor.getUserData(dimKey)?.forEach { runCatching { it.dispose() } }
                editor.putUserData(dimKey, null)
                if (!spotlightOn) continue
                // The viewer paints changed lines as LINES_IN_RANGE background highlighters; ours are
                // EXACT_RANGE, so this read can never mistake a dim for a change.
                val changed = HashSet<Int>()
                for (h in markup.allHighlighters) {
                    if (h.targetArea != HighlighterTargetArea.LINES_IN_RANGE) continue
                    val doc = editor.document
                    val a = doc.getLineNumber(h.startOffset.coerceIn(0, doc.textLength))
                    val b = doc.getLineNumber(h.endOffset.coerceIn(0, doc.textLength))
                    for (line in a..b) changed.add(line)
                }
                if (changed.isEmpty()) continue // not rendered yet, or genuinely unmarked — never dim blind
                val ours = mutableListOf<RangeHighlighter>()
                var runStart = -1
                fun flushDim(end: Int) {
                    if (runStart in 0..end) {
                        ours.add(
                            markup.addRangeHighlighter(
                                editor.document.getLineStartOffset(runStart),
                                editor.document.getLineEndOffset(end),
                                HighlighterLayer.SELECTION - 1, dimAttrs,
                                HighlighterTargetArea.EXACT_RANGE,
                            )
                        )
                    }
                    runStart = -1
                }
                for (line in 0 until editor.document.lineCount) {
                    if (line in changed) flushDim(line - 1)
                    else if (runStart < 0) runStart = line
                }
                flushDim(editor.document.lineCount - 1)
                editor.putUserData(dimKey, ours)
            }
        }
    }

    // DumbAware: reviewing does not touch indexes, and an action greyed out during indexing beside a
    // button that still works is the kind of inconsistency that reads as a bug.
    private fun act(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private fun block(spec: ReviewAllSpec, before: String, after: String): JPanel {
        val rec = spec.rec
        val factory = DiffContentFactory.getInstance()
        val type = FileTypeManager.getInstance().getFileTypeByFileName(File(rec.file).name)
        val request = SimpleDiffRequest(
            "#${rec.id} · ${spec.rel}",
            factory.create(project, before, type),
            factory.create(project, after, type),
            if (rec.beforeBlob == null) "(new file)" else "before",
            if (rec.afterBlob == null) "(deleted)" else "after",
        ).apply {
            // The same verbs on the embedded viewer's OWN toolbar, where a reader coming from the
            // single-diff window looks for them. (The FORCED VIEW rides the processor CONTEXT, not
            // this request — see [BlockDiffProcessor].)
            putUserData(
                DiffUserDataKeys.CONTEXT_ACTIONS,
                listOf(
                    act("Keep #${rec.id}", NavTint.KEEP) { ReviewOps.keep(project, file.session, rec.id, advance = false) },
                    act("Undo #${rec.id}", NavTint.UNDO) { ReviewOps.undoOrRedo(project, file.session, rec, redo = false, advance = false) },
                    act("Chat About #${rec.id}", NavTint.CHAT) { ReviewOps.chatAbout(project, file.session, rec.id) },
                ),
            )
        }
        val header = SimpleColoredComponent().apply {
            append("#${rec.id}  ", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            append(spec.rel, SimpleTextAttributes.REGULAR_ATTRIBUTES)
            // The stack width-tracks the window, so a long path CLIPS at the pane edge — the full
            // text rides the tooltip instead of a horizontal scroll nothing else here needs.
            toolTipText = "#${rec.id} · ${spec.rel}"
        }
        // Buttons LEFT of the path, LABELLED: bare icons here were reported as "no options for each
        // diff" — a verb nobody recognizes is a verb nobody has. They stay in reach however narrow
        // the pane, and a clipped path costs readability, never an action. The row is STATUS-AWARE
        // (parity with the VS Code stacked page): a decided block shows its
        // verdict and keeps its remaining verb — kept → ↺ Revert, reverted → ↻ Redo — re-skinned
        // in place by [syncActs] whenever the store moves, whichever surface moved it.
        val btns = JPanel(FlowLayout(FlowLayout.LEFT, 3, 0))
        val row = ActsRow(rec, btns, "")
        actsRows.add(row)
        fillActs(row, rec.status)
        val top = JPanel(BorderLayout()).apply {
            add(btns, BorderLayout.WEST)
            add(header, BorderLayout.CENTER)
            border = JBUI.Borders.empty(6, 0, 2, 0)
        }
        // The CONTEXT, preloaded BEFORE the processor exists — the only channel the forced view
        // actually travels (see [BlockDiffProcessor]). TextDiffSettings rides the same holder:
        // hunks-only collapse, and soft wrap so long lines fold to the block's
        // width instead of growing a horizontal scrollbar inside each embedded viewer.
        val holder = com.intellij.openapi.util.UserDataHolderBase().apply {
            putUserData(
                DiffUserDataKeysEx.FORCE_DIFF_TOOL,
                if (sideBySide) SimpleDiffTool.INSTANCE else UnifiedDiffTool.INSTANCE,
            )
            putUserData(
                TextDiffSettingsHolder.TextDiffSettings.KEY,
                TextDiffSettingsHolder.TextDiffSettings().apply {
                    isExpandByDefault = false
                    isUseSoftWraps = true
                },
            )
        }
        val diffPanel = BlockDiffProcessor(project, holder)
        Disposer.register(this, diffPanel) // parented to the editor, as createRequestPanel was
        diffPanels.add(diffPanel)
        diffPanel.setRequest(request)
        // Sized from the unit's ±count: changed lines + fold/context rows, capped so one huge block
        // cannot swallow the column (it scrolls internally past the cap). HEIGHT ONLY — the width
        // follows the viewport (the stack width-tracks, so blocks scale with the window).
        // Tight: changed lines + a little fold chrome. The looser +6/base-36 sizing left a band of
        // dead whitespace under every small diff.
        val h = JBUI.scale(30) + JBUI.scale(19) * minOf(spec.delta + 3, 30)
        return object : JPanel(BorderLayout()) {
            override fun getPreferredSize(): Dimension = Dimension(super.getPreferredSize().width, h)
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, h)
        }.apply {
            add(top, BorderLayout.NORTH)
            add(diffPanel.component, BorderLayout.CENTER)
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(10)
        }
    }

    override fun getComponent(): JComponent = root
    override fun getPreferredFocusedComponent(): JComponent = scroll
    override fun getName(): String = "OAK Review"
    override fun setState(state: FileEditorState) {}
    override fun isModified(): Boolean = false
    override fun isValid(): Boolean = true
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
    override fun dispose() {
        disposed = true
        com.cellobservatory.observatory.services.ObservatoryService.getInstance(project).removeListener(storeListener)
    }
    override fun getFile(): VirtualFile = file
}

/**
 * The per-block diff host, replacing DiffManager.createRequestPanel: the platform reads
 * FORCE_DIFF_TOOL (and PLACE) from the processor CONTEXT inside its CONSTRUCTOR — 2025.2 bytecode:
 * `myForcedDiffTool = tryCast(myContext.getUserData(FORCE_DIFF_TOOL))` — so the public panel's
 * `putContextHints` hands the hint over one constructor too late, and every "stacked" block
 * rendered side-by-side whatever the toggle said (field failure, 2026-08-20; pinned by
 * ReviewAllActsTest's editor-count assertion). The protected (Project, UserDataHolder) constructor
 * exists for exactly this: the holder arrives PRELOADED. The setRequest/updateRequest shape mirrors
 * the platform's own DiffRequestPanelImpl.MyDiffRequestProcessor.
 */
private class BlockDiffProcessor(
    project: com.intellij.openapi.project.Project,
    context: com.intellij.openapi.util.UserDataHolder,
) : com.intellij.diff.impl.DiffRequestProcessor(project, context) {
    private var request: com.intellij.diff.requests.DiffRequest = com.intellij.diff.requests.NoDiffRequest.INSTANCE

    fun setRequest(r: com.intellij.diff.requests.DiffRequest) {
        request = r
        updateRequest()
    }

    override fun updateRequest(force: Boolean, scrollToChangePolicy: DiffUserDataKeysEx.ScrollToPolicy?) {
        applyRequest(request, force, scrollToChangePolicy)
    }
}

class ReviewAllEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = file is ReviewAllVirtualFile
    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        ReviewAllEditor(project, file as ReviewAllVirtualFile)
    override fun getEditorTypeId(): String = "claude-observatory-review-all"
    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}
