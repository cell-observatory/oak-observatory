package com.cellobservatory.observatory.ui.inline

import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.ui.Diffs
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Rectangle
import java.awt.RenderingHints

/**
 * The CodeLens analog: "✓ Keep #N · ✗ Undo · ❝ Chat · ⧉ View diff" above an edit's first line,
 * indent-aligned with the code, with real affordances — the hovered action renders in the theme
 * link color with an underline (InlineOverlay drives hover + the hand cursor). Reasoning stays in
 * the Observations tab, not the editor.
 */
class LensRenderer(
    private val project: Project,
    private val session: String,
    private val rec: EditRecord,
    /** This edit's line churn from `locate --json`. Absent from a pre-0.10 CLI, and from any placement
     *  that renders nothing, so the lens simply omits the churn rather than printing a fabricated 0/0. */
    private val delta: com.cellobservatory.observatory.model.Delta? = null,
) : EditorCustomElementRenderer {

    private class Seg(val text: String, val run: (() -> Unit)?) {
        var x0 = 0
        var x1 = 0
    }

    // Position counters, mirroring the status-bar nav bar (computed once): "edit n/m in file" is the
    // Diff axis, "file i/k" the File axis (shown only when more than one file has pending edits).
    private val posLabel: String = run {
        // Cancelled-out chains are not stops on either axis (the nav bar and the overlay both skip
        // them), so counting them here would print "edit 3/5" on a bar that steps two.
        val svc = com.cellobservatory.observatory.services.ObservatoryService.getInstance(project)
        val log = StoreReader.readLog(session).filter { !svc.isHidden(it) }
        val filePending = log.filter { it.file == rec.file && it.status == "pending" }.sortedBy { it.id }
        val editIdx = filePending.indexOfFirst { it.id == rec.id }
        val files = log.filter { it.status == "pending" }.map { it.file }.distinct().sorted()
        val fileIdx = files.indexOf(rec.file)
        val edit = if (editIdx >= 0) "  ·  edit ${editIdx + 1}/${filePending.size} in file" else ""
        val file = if (fileIdx >= 0 && files.size > 1) "  ·  file ${fileIdx + 1}/${files.size}" else ""
        edit + file
    }

    /** "+A −R" for this edit, in the VS Code lens's exact spacing (two spaces after the id). Empty when
     *  the CLI did not report a delta. */
    private val churn: String = delta?.let { "  +${it.added} −${it.removed}" } ?: ""

    private val segments: List<Seg> = buildList {
        // "✨ #N" opens the inline diff (mirrors the gutter star); then the spaced-out quick actions.
        // Reasoning is NOT shown here — it lives in the diff's title. Icons/spacing match VS Code.
        add(Seg("✦ #${rec.id}$churn$posLabel  view changes") { Diffs.show(project, session, rec) })
        add(Seg("      ", null))
        add(Seg("✓ Keep") { ReviewOps.keep(project, session, rec.id) })
        add(Seg("      ", null))
        add(Seg("✗ Undo") { ReviewOps.undoOrRedo(project, session, rec, redo = false) })
        add(Seg("      ", null))
        // ❝ = a monochrome quotation/speech dingbat (matches the row's symbol style; NOT the 💬 emoji).
        add(Seg("❝ Chat") { ReviewOps.chatAbout(project, session, rec.id) })
        add(Seg("      ", null))
        add(Seg("⧉ View diff") { Diffs.show(project, session, rec) })
    }

    private var hoverIdx = -1

    private fun font(inlay: Inlay<*>) =
        UIUtil.getFontWithFallback(inlay.editor.colorsScheme.getFont(EditorFontType.PLAIN))
            .deriveFont(inlay.editor.colorsScheme.editorFontSize.toFloat()) // full editor size — readable

    /** Pixel width of the anchor line's leading whitespace, so the lens aligns with the code. */
    private fun indentPx(inlay: Inlay<*>): Int {
        return try {
            val editor = inlay.editor
            val doc = editor.document
            val line = doc.getLineNumber(inlay.offset)
            val text = doc.charsSequence.subSequence(doc.getLineStartOffset(line), doc.getLineEndOffset(line))
            val ws = text.takeWhile { it == ' ' || it == '\t' }
                .toString().replace("\t", " ".repeat(4))
            editor.contentComponent.getFontMetrics(editor.colorsScheme.getFont(EditorFontType.PLAIN))
                .stringWidth(ws)
        } catch (_: Exception) {
            JBUI.scale(8)
        }
    }

    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        val fm = inlay.editor.component.getFontMetrics(font(inlay))
        return indentPx(inlay) + segments.sumOf { seg: Seg -> fm.stringWidth(seg.text) } + JBUI.scale(8)
    }

    override fun calcHeightInPixels(inlay: Inlay<*>): Int = inlay.editor.lineHeight

    override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
        val f = font(inlay)
        g2.font = f
        val fm = g2.getFontMetrics(f)
        val grey = editor.colorsScheme.getAttributes(DefaultLanguageHighlighterColors.LINE_COMMENT)?.foregroundColor
            ?: JBColor.GRAY
        val link = JBUI.CurrentTheme.Link.Foreground.ENABLED
        var x = targetRegion.x + indentPx(inlay)
        val y = targetRegion.y + fm.ascent + (targetRegion.height - fm.height) / 2
        for ((i, seg) in segments.withIndex()) {
            seg.x0 = x - targetRegion.x
            val hovered = i == hoverIdx && seg.run != null
            g2.color = if (hovered) link else grey
            g2.drawString(seg.text, x, y)
            val w = fm.stringWidth(seg.text)
            if (hovered) g2.drawLine(x, y + JBUI.scale(2), x + w, y + JBUI.scale(2))
            x += w
            seg.x1 = x - targetRegion.x
        }
    }

    /** Index of the clickable segment at [xInInlay], or -1. */
    fun segmentAt(xInInlay: Int): Int =
        segments.indexOfFirst { it.run != null && xInInlay in it.x0 until it.x1 }

    /** Update hover state; returns true when a repaint is needed. */
    fun setHover(idx: Int): Boolean {
        if (idx == hoverIdx) return false
        hoverIdx = idx
        return true
    }

    fun actionAt(xInInlay: Int): (() -> Unit)? = segments.getOrNull(segmentAt(xInInlay))?.run
}
