package com.cellobservatory.observatory.ui.inline

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.Placement
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.services.PlacementsCache
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.Diffs
import com.cellobservatory.observatory.ui.NavTint
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.util.Alarm
import java.awt.Color
import java.awt.Font
import javax.swing.Icon

private const val MAX_INLINE_LINES = 20_000 // same guard as the VS Code overlay

// the agent's signature error-stripe color — a distinct coral so the agent's edits stand out on the overview
// ruler instead of blending into VCS markers. Parity with the VS Code CLAUDE_MARK_COLOR.
private val CLAUDE_MARK = JBColor(Color(0xCC785C), Color(0xE0906F))

// Whole-line fill on the agent's added/changed lines — a clearly visible green (light/dark) so the edited
// region reads at a glance. JBColor can't alpha-blend like VS Code, so these are solid tints picked to
// match the strengthened VS Code ADDED_LINE_BG (rgba green @ 0.30, blended over the editor bg).
private val ADDED_LINE_BG = JBColor(Color(0xCD, 0xE4, 0xD0), Color(0x2F, 0x47, 0x33))

// The red twin of ADDED_LINE_BG, on the surviving line a removed hunk now follows. Derived the same way:
// the VS Code REMOVED_LINE_BG is rgba(229, 83, 75, 0.30), blended here over the light (#FFFFFF) and dark
// (#1E1E1E) editor backgrounds, because JBColor cannot alpha-blend.
private val REMOVED_LINE_BG = JBColor(Color(0xF7, 0xCB, 0xC9), Color(0x5A, 0x2E, 0x2C))

// The ghost text itself. Darker on light, where the pure #E5534B washes out against REMOVED_LINE_BG.
private val GHOST_FG = JBColor(Color(0xB3, 0x26, 0x1E), Color(0xE5, 0x53, 0x4B))

/**
 * A one-line preview of a hunk an edit REMOVED: its first non-blank line, trimmed, with a "…(+N)" tail
 * when the hunk removed more than one line.
 *
 * Byte-parity with the VS Code `ghostText` — the same hunk must read identically in both editors — so note
 * the truncation rule exactly as written there: it fires only when the head EXCEEDS 60 characters, and
 * then yields 60 of them (59 plus the ellipsis). GhostLabelTest pins both sides of that boundary.
 *
 * This is the ONE carve-out from the standing "never ellipsize content text" rule. An after-line-end inlay
 * has no width to wrap into and no tooltip to hang the rest on, and the label is a POINTER to the diff
 * rather than the content: the full removed text is one click away on the ✦ lens or the gutter star.
 */
internal fun ghostLabel(lines: List<String>): String {
    val head = (lines.firstOrNull { it.isNotBlank() } ?: "").trim()
    val shown = if (head.length > 60) head.take(59) + "…" else head
    val more = lines.size - 1
    return if (more > 0) "− $shown …(+$more)" else "− $shown"
}

/**
 * The buffer lines an edit is REACHABLE at — what the gutter star and the lens anchor on.
 *
 * Normally the lines it added. A PURE deletion has none: its text no longer exists in the buffer, so it
 * anchors on the surviving lines its removed hunks now follow. Mirrors VS Code's `anchorLines`, which its
 * star, its CodeLens and its cursor lookup all use, so a deletion-only edit keeps an at-the-code
 * Keep/Undo in both editors instead of only ghost text in one of them.
 */
internal fun anchorLines(p: Placement, lineCount: Int): List<Int> {
    val added = p.lines.filter { it < lineCount }
    if (added.isNotEmpty() || lineCount <= 0) return added
    return p.removed.map { it.anchor.coerceIn(0, lineCount - 1) }.distinct()
}

/**
 * The inline review overlay: per pending edit, a clickable "✓ Keep #N · ✗ Undo · 💬 Chat · ⧉ View diff" lens
 * above its first line (block inlay — the stable API, chosen over experimental Code Vision),
 * a changed-line background + gutter action icon, and a dim " ✨ #N" end-of-line marker.
 * Placement geometry comes from PlacementsCache (CLI locate); re-renders on store changes,
 * document edits (debounced 250ms), and cache updates.
 */
@Service(Service.Level.PROJECT)
class InlineOverlay(private val project: Project) : Disposable {

    private val highlighters = HashMap<Editor, MutableList<RangeHighlighter>>()
    private val inlays = HashMap<Editor, MutableList<Inlay<*>>>()
    private val renderSig = HashMap<Editor, String>() // skip identical re-renders (kills flicker)
    private val editRegions = HashMap<Editor, List<Pair<IntRange, EditRecord>>>() // hover-card hit zones
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var installed = false
    private var hoverLens: LensRenderer? = null
    private var hoverInlay: Inlay<*>? = null
    var heatmapOn = false // "file heatmap": dim unmodified lines so the agent's edits stand out

    fun install() {
        if (installed) return
        installed = true
        val factory = EditorFactory.getInstance()
        factory.addEditorFactoryListener(object : EditorFactoryListener {
            override fun editorCreated(event: EditorFactoryEvent) {
                if (event.editor.project === project) scheduleRefresh()
            }

            override fun editorReleased(event: EditorFactoryEvent) = clear(event.editor)
        }, this)
        factory.eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (editorsFor(event.document).isNotEmpty()) scheduleRefresh()
            }
        }, this)
        factory.eventMulticaster.addEditorMouseListener(object : EditorMouseListener {
            override fun mouseClicked(e: EditorMouseEvent) = handleLensClick(e)
        }, this)
        factory.eventMulticaster.addEditorMouseMotionListener(object : com.intellij.openapi.editor.event.EditorMouseMotionListener {
            override fun mouseMoved(e: EditorMouseEvent) = handleLensHover(e)
        }, this)
        ObservatoryService.getInstance(project).addListener { refreshAll() }
        PlacementsCache.getInstance(project).addUpdateListener { file ->
            projectEditors().filter { pathOf(it) == file }.forEach { render(it) }
        }
        refreshAll()
    }

    fun refreshAll() = projectEditors().forEach { render(it) }

    /** Toggle the file heatmap (dim unmodified lines). Parity with VS Code's tab-bar 🔥 toggle. */
    fun toggleHeatmap() {
        heatmapOn = !heatmapOn
        renderSig.clear() // force a rebuild so the dim appears/disappears
        refreshAll()
        // Confirm the toggle out loud — spotlight only dims files WITH pending edits, so on a clean
        // file a silent toggle reads as "the button does nothing".
        com.cellobservatory.observatory.ui.ReviewOps.notify(
            project,
            if (heatmapOn) "Spotlight on — unedited lines dim in files with pending agent edits"
            else "Spotlight off",
        )
    }

    private fun editorsFor(document: Document) =
        EditorFactory.getInstance().getEditors(document, project).toList()

    private fun projectEditors() =
        EditorFactory.getInstance().allEditors.filter { it.project === project && !it.isDisposed }

    private fun pathOf(editor: Editor): String? =
        FileDocumentManager.getInstance().getFile(editor.document)?.path

    private fun scheduleRefresh() {
        alarm.cancelAllRequests()
        alarm.addRequest({ refreshAll() }, 250)
    }

    private fun render(editor: Editor) {
        if (editor.isDisposed) return clear(editor)
        val file = pathOf(editor)
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        val pending = if (file == null || session == null) emptyList()
        // A cancelled-out chain owns no line to annotate and no decision to offer, so it gets no lens
        // — the same rule the gutter, the Review tree and VS Code's decorations follow.
        else ClaudePaths.storeKey(file).let { key -> service.log().filter { it.pending && !service.isHidden(it) && it.file == key } }
        if (!ObservatorySettings.instance.state.inlineReview ||
            editor.document.lineCount > MAX_INLINE_LINES ||
            file == null || session == null || pending.isEmpty()
        ) {
            clear(editor)
            return
        }
        val placements = PlacementsCache.getInstance(project)
            .placementsFor(file, editor.document.text, editor.document.modificationStamp.toString())
            ?: return // stale — KEEP the previous artifacts (RangeMarkers track edits) until locate lands
        // Identical geometry ⇒ nothing to do. Rebuilding anyway would flicker on every keystroke.
        // The deletion anchors and the churn are part of the geometry: without them a hunk that only
        // moved its anchor, or a delta the CLI has just computed, would never repaint its ghost or lens.
        val sig = "$session|$file|" +
            placements.joinToString(";") { p ->
                "${p.id}:${p.lines}:${p.removed.map { it.anchor }}:${p.delta?.let { "${it.added}/${it.removed}" } ?: ""}"
            } +
            "|" + pending.joinToString(",") { it.id.toString() } + "|hm=$heatmapOn"
        if (renderSig[editor] == sig) return
        clear(editor)
        renderSig[editor] = sig

        val markup = editor.markupModel
        val hs = highlighters.getOrPut(editor) { mutableListOf() }
        val ins = inlays.getOrPut(editor) { mutableListOf() }
        val regions = mutableListOf<Pair<IntRange, EditRecord>>()
        // Only the LATEST edit per anchor line gets a gutter star + inline lens: several edits often
        // land on one line, and one menu per edit is noisy/ambiguous. Older same-line edits stay in the
        // Timeline; undoing the latest surgically reveals the previous state (its lens then takes over).
        val lineCount = editor.document.lineCount
        val latestByAnchor = HashMap<Int, Int>()
        for (p in placements) {
            val anchor = anchorLines(p, lineCount).minOrNull() ?: continue
            latestByAnchor[anchor] = maxOf(latestByAnchor[anchor] ?: Int.MIN_VALUE, p.id)
        }
        for (p in placements) {
            val rec = pending.find { it.id == p.id } ?: continue
            val lines = p.lines.filter { it < lineCount }
            // A SUBTLE green line fill (toned down, not the default diff green) + a coral error-stripe mark
            // per changed line, so a file the agent edited heavily doesn't drown in color. Shown for ALL edits.
            for (line in lines) {
                val h = markup.addLineHighlighter(line, HighlighterLayer.CARET_ROW - 1, TextAttributes(null, ADDED_LINE_BG, null, null, Font.PLAIN))
                h.setErrorStripeMarkColor(CLAUDE_MARK)
                hs.add(h)
            }
            // A pure deletion has no added lines, so it anchors on its ghost line instead — see anchorLines.
            val first = anchorLines(p, lineCount).minOrNull() ?: continue
            regions.add((lines.minOrNull() ?: first)..(lines.maxOrNull() ?: first) to rec)
            // Gutter star + lens only for the latest edit anchored at this line (others -> Timeline).
            if (rec.id != latestByAnchor[first]) continue
            val gutter = markup.addLineHighlighter(first, HighlighterLayer.CARET_ROW - 1, null)
            gutter.gutterIconRenderer = EditGutterRenderer(project, session, rec)
            hs.add(gutter)
            editor.inlayModel.addBlockElement(
                editor.document.getLineStartOffset(first), false, true, 0,
                LensRenderer(project, session, rec, p.delta),
            )?.let { ins.add(it) }
        }
        // Lines an edit REMOVED are gone from the buffer, so they are SHOWN rather than highlighted: a red
        // fill + coral stripe on the surviving line the hunk now follows, plus the removed text itself as
        // italic ghost text after that line's end. Hunks that clamp onto the same line merge into ONE
        // label, three-space separated (VS Code parity) — two after-line-end inlays on one line would
        // paint over each other.
        val ghostByLine = LinkedHashMap<Int, MutableList<String>>()
        if (lineCount > 0) {
            val pendingIds = pending.mapTo(HashSet()) { it.id } // set, not a scan per placement
            for (p in placements) {
                if (p.id !in pendingIds) continue
                for (del in p.removed) {
                    ghostByLine.getOrPut(del.anchor.coerceIn(0, lineCount - 1)) { mutableListOf() }
                        .add(ghostLabel(del.lines))
                }
            }
        }
        for ((line, labels) in ghostByLine) {
            val h = markup.addLineHighlighter(line, HighlighterLayer.CARET_ROW - 1, TextAttributes(null, REMOVED_LINE_BG, null, null, Font.PLAIN))
            h.setErrorStripeMarkColor(CLAUDE_MARK)
            hs.add(h)
            editor.inlayModel.addAfterLineEndElement(
                editor.document.getLineEndOffset(line), false, GhostTextRenderer(labels.joinToString("   ")),
            )?.let { ins.add(it) }
        }
        // Heatmap: dim every UNMODIFIED line (flat grey, no syntax colors) so the agent's edits stand out.
        // JetBrains can't alpha-blend text, so "dim" is a muted foreground (parity with VS Code's opacity).
        // The layer must sit ABOVE HighlighterLayer.SYNTAX (2000) — a foreground at CARET_ROW-2 (998)
        // loses the merge to syntax colors and the dim never shows (the 0.8.x "Spotlight does nothing"
        // bug); SELECTION-1 wins over syntax + inspections while still yielding to the selection.
        // The "changed" set is the added lines PLUS the deletion-anchor lines (VS Code parity): a line whose
        // only claim is that Claude deleted something there must stay bright, or Spotlight dims the very
        // thing it was toggled to find. Empty ⇒ nothing to spotlight, so dimming the whole file would say
        // "none of this is the agent's" about a file that is entirely pending.
        // Computed inside the guard, not above it: this runs on every debounced render, spotlight or not.
        val changed = if (!heatmapOn) emptySet() else
            placements.flatMapTo(HashSet<Int>()) { p -> p.lines.filter { it < lineCount } }
                .also { it.addAll(ghostByLine.keys) }
        // Empty ⇒ nothing to spotlight, and dimming everything would say "none of this is the agent's" about
        // a file that is entirely pending.
        if (heatmapOn && changed.isNotEmpty()) {
            val dimAttrs = TextAttributes(com.intellij.ui.JBColor.GRAY, null, null, null, Font.PLAIN)
            var runStart = -1
            fun flushDim(end: Int) {
                if (runStart in 0..end) {
                    hs.add(
                        markup.addRangeHighlighter(
                            editor.document.getLineStartOffset(runStart),
                            editor.document.getLineEndOffset(end),
                            HighlighterLayer.SELECTION - 1, dimAttrs,
                            com.intellij.openapi.editor.markup.HighlighterTargetArea.EXACT_RANGE,
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
        }
        editRegions[editor] = regions
    }

    private fun clear(editor: Editor) {
        renderSig.remove(editor)
        editRegions.remove(editor)
        highlighters.remove(editor)?.forEach { h -> runCatching { editor.markupModel.removeHighlighter(h) } }
        inlays.remove(editor)?.forEach { runCatching { Disposer.dispose(it) } }
    }

    private fun handleLensClick(e: EditorMouseEvent) {
        val editor = e.editor
        if (editor.project !== project) return
        val inlay = editor.inlayModel.getElementAt(e.mouseEvent.point) ?: return
        val renderer = inlay.renderer
        if (renderer is LensRenderer) {
            val bounds = inlay.bounds ?: return
            renderer.actionAt(e.mouseEvent.x - bounds.x)?.invoke()
            e.consume()
        }
    }

    /** Hand cursor + link styling on the hovered lens action. */
    private fun handleLensHover(e: EditorMouseEvent) {
        val editor = e.editor
        if (editor.project !== project) return
        val inlay = editor.inlayModel.getElementAt(e.mouseEvent.point)
        val lens = inlay?.renderer as? LensRenderer
        val bounds = inlay?.bounds
        val idx = if (lens != null && bounds != null) lens.segmentAt(e.mouseEvent.x - bounds.x) else -1
        // leave the previous lens
        if (hoverLens != null && hoverLens !== lens) {
            if (hoverLens!!.setHover(-1)) hoverInlay?.bounds?.let { editor.contentComponent.repaint(it) }
            hoverLens = null
            hoverInlay = null
        }
        if (lens != null) {
            hoverLens = lens
            hoverInlay = inlay
            if (lens.setHover(idx)) bounds?.let { editor.contentComponent.repaint(it) }
        }
        setLensCursor(editor, idx >= 0)
    }

    /** Editors this overlay currently holds a custom cursor on, so it only ever releases its own. */
    private val cursorOwned = java.util.Collections.newSetFromMap(java.util.WeakHashMap<Editor, Boolean>())

    /**
     * Show the hand while the pointer is over a lens action, and give the cursor BACK otherwise.
     *
     * This used to assign `contentComponent.cursor` directly on every mouse move — including
     * `Cursor.getDefaultCursor()`, which is the ARROW. `handleLensHover` is registered on the global
     * event multicaster, so that ran for every motion event in every editor of the project and replaced
     * the I-BEAM everywhere, in every file, whether or not the file had a single agent edit in it. The
     * platform sets the pointer first and this handler ran last, so the editor could never win it back;
     * Cmd-click link cursors and fold-region cursors went the same way. It is the loudest thing a person
     * would feel and nothing in a build or a test can see it.
     *
     * `setCustomCursor` is the API that exists for this: the editor tracks who asked, and `null` hands
     * the pointer back to whatever the editor itself wants. We only ever release an editor we took.
     */
    private fun setLensCursor(editor: Editor, onLens: Boolean) {
        val impl = editor as? com.intellij.openapi.editor.impl.EditorImpl ?: return
        if (onLens) {
            impl.setCustomCursor(this, java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR))
            cursorOwned.add(editor)
        } else if (cursorOwned.remove(editor)) {
            impl.setCustomCursor(this, null)
        }
    }

    override fun dispose() {
        projectEditors().forEach { clear(it) }
    }

    companion object {
        fun getInstance(project: Project): InlineOverlay = project.getService(InlineOverlay::class.java)
    }
}

/**
 * The removed-lines ghost: [text] painted in italic red after a line's end, standing in for text that is
 * no longer in the buffer. Not clickable — the actions for that edit are on the lens and the gutter star
 * above it; this is the evidence, not a control.
 */
private class GhostTextRenderer(private val text: String) : com.intellij.openapi.editor.EditorCustomElementRenderer {

    private fun font(inlay: Inlay<*>) =
        com.intellij.util.ui.UIUtil.getFontWithFallback(
            inlay.editor.colorsScheme.getFont(com.intellij.openapi.editor.colors.EditorFontType.ITALIC),
        ).deriveFont(inlay.editor.colorsScheme.editorFontSize.toFloat())

    override fun calcWidthInPixels(inlay: Inlay<*>): Int =
        inlay.editor.component.getFontMetrics(font(inlay)).stringWidth(text) + com.intellij.util.ui.JBUI.scale(16)

    override fun paint(
        inlay: Inlay<*>,
        g: java.awt.Graphics,
        targetRegion: java.awt.Rectangle,
        textAttributes: TextAttributes,
    ) {
        val f = font(inlay)
        g.font = f
        g.color = GHOST_FG
        val fm = g.getFontMetrics(f)
        g.drawString(
            text,
            targetRegion.x + com.intellij.util.ui.JBUI.scale(8),
            targetRegion.y + fm.ascent + (targetRegion.height - fm.height) / 2,
        )
    }
}

/** ✨ gutter star at an edit's first line: click opens the inline diff; right-click a native menu. */
private class EditGutterRenderer(
    private val project: Project,
    private val session: String,
    private val rec: EditRecord,
) : GutterIconRenderer() {
    override fun getIcon(): Icon = com.cellobservatory.observatory.ui.Icons.Star
    override fun getTooltipText() = "Agent edit #${rec.id} · ${rec.tool} — click to see the changes"
    override fun equals(other: Any?) = (other as? EditGutterRenderer)?.rec?.id == rec.id
    override fun hashCode() = rec.id
    override fun isNavigateAction() = true

    // Right-click path: the platform renders this menu natively (reasoning lives on the card).
    override fun getPopupMenuActions(): DefaultActionGroup = DefaultActionGroup(
        simple("Keep #${rec.id}", NavTint.KEEP) { ReviewOps.keep(project, session, rec.id) },
        simple("Undo #${rec.id}", NavTint.UNDO) { ReviewOps.undoOrRedo(project, session, rec, redo = false) },
        simple("Diff #${rec.id}", AllIcons.Actions.Diff) { Diffs.show(project, session, rec) },
        simple("Chat About #${rec.id}", AllIcons.General.Balloon) { ReviewOps.chatAbout(project, session, rec.id) },
    )

    private fun simple(text: String, icon: Icon, run: () -> Unit) = object : AnAction(text, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }

    // Left-click path: show the edit's before ⟷ after diff (the reasoning + actions now live on the
    // inline lens above the edit; right-click still opens the full Keep/Undo/Diff/Chat menu).
    override fun getClickAction(): AnAction = object : AnAction("Agent Edit #${rec.id}") {
        override fun actionPerformed(e: AnActionEvent) = Diffs.show(project, session, rec)
    }
}
