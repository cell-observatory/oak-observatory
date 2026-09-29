package com.cellobservatory.observatory.ui.editor

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.Diffs
import com.cellobservatory.observatory.ui.NavTint
import com.cellobservatory.observatory.ui.Navigate
import com.cellobservatory.observatory.ui.ReviewOps
import com.cellobservatory.observatory.ui.ReviewSelection
import com.cellobservatory.observatory.ui.inline.InlineOverlay
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import java.io.File
import javax.swing.Icon

/**
 * The buttons on the floating review bar (see [ObservatoryFloatingToolbarProvider]):
 * Keep · Undo · Chat · View diff · ‹ Diff n/m › · Accept File · Reject File · Spotlight · Clear Resolved —
 * Copilot's editor overlay controls, widened to the review verbs this product actually has.
 *
 * Read left to right, the bar widens in SCOPE: the four per-edit verbs and the counter that says which
 * edit they mean, then the two file-wide ones, then the two that are about the whole session. Every one of
 * them is the same operation the nav bar performs, with the same [NavTint] glyph, calling the same
 * [ReviewOps] / [Diffs] / [InlineOverlay] entry point — a second implementation of "keep" or "spotlight"
 * that drifted from the first is the failure this avoids. What it cannot share is the ReviewNavBar
 * INSTANCE: that one belongs to a project, and this group belongs to the application (see below).
 *
 * Two constraints shape every action here.
 *
 * The group is built ONCE per application and handed to every editor of every open project, so nothing
 * may be captured in a field: the project, the editor, the file and the session are all resolved from the
 * event's own data context on each `update()`/`actionPerformed`. A captured project would answer for
 * whichever window happened to open first.
 *
 * And `update()` runs on a background thread ([ActionUpdateThread.BGT]) — mandatory here, not a
 * preference: a toolbar that hops to the EDT once per button per repaint is what the 0.8.9 toolbar audit
 * measured at seconds per expansion. So nothing below touches FileEditorManager or the Swing hierarchy;
 * the file comes from the pre-collected data context and the records from the service's cached log.
 */
internal object FloatingReviewActions {

    /** The bar's action group. One instance, app-shared — see the class comment. */
    fun group(): ActionGroup = DefaultActionGroup(
        FloatingKeep(),
        FloatingUndo(),
        FloatingChat(),
        FloatingViewDiff(),
        FloatingDiffPrev(),
        FloatingDiffCounter(),
        FloatingDiffNext(),
        // The FILE axis. The bar had the Diff axis only, so it could step through one file's edits and
        // never leave it — while VS Code's bar has carried ‹› since it shipped. Same four axes, both
        // editors; they hide when there is nowhere to go, so a floating bar never covers code with a
        // dead button.
        FloatingFilePrev(),
        FloatingFileCounter(),
        FloatingFileNext(),
        FloatingAcceptFile(),
        FloatingRejectFile(),
        FloatingSpotlight(),
        FloatingClearResolved(),
    )
}

/** Everything an action on this bar needs, resolved from ONE event. Null whenever the bar has nothing to
 *  act on, so each `update()` is a single null check rather than five. */
private class BarContext(
    val project: Project,
    val session: String,
    val path: String,
    /** The file's pending edits, oldest first — the Diff axis this bar steps. Never empty. */
    val pending: List<EditRecord>,
) {
    /** The edit the per-edit buttons act on — the review cursor when it is parked in this file, else the
     *  file's first pending edit. Shared with the editor banner, which can be on screen at the same time. */
    val current: EditRecord? = ReviewSelection.currentEditIn(project, path)

    val fileName: String get() = File(path).name

    /** Every record for this file, pending or not — the file-scoped verbs take the whole file. */
    fun allInFile(): List<EditRecord> {
        val key = ClaudePaths.storeKey(path)
        return ObservatoryService.getInstance(project).log().filter { it.file == key }
    }
}

/** The file under the bar, from the EVENT — never from FileEditorManager, which `update()` may not touch. */
private fun pathOf(e: AnActionEvent): String? =
    e.getData(CommonDataKeys.VIRTUAL_FILE)?.path
        ?: e.getData(CommonDataKeys.EDITOR)?.let { FileDocumentManager.getInstance().getFile(it.document)?.path }

private fun barContext(e: AnActionEvent): BarContext? {
    val project = e.project ?: return null
    val path = pathOf(e) ?: return null
    val service = ObservatoryService.getInstance(project)
    val session = service.currentSession() ?: return null
    val key = ClaudePaths.storeKey(path) // hoisted: this runs per button per toolbar tick
    val pending = service.log().filter { it.pending && it.file == key }.sortedBy { it.id }
    if (pending.isEmpty()) return null
    return BarContext(project, session, path, pending)
}

/**
 * Base for the bar's buttons: BGT, DumbAware, and hidden — not merely disabled — whenever the file has
 * nothing pending. The bar is a floating overlay sitting on top of code; a row of dead buttons there
 * covers the text for no reason.
 */
private abstract class FloatingBarAction(text: String, description: String, icon: Icon?) :
    AnAction(text, description, icon), DumbAware {

    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = barContext(e)?.let { applies(it) } ?: false
    }

    override fun actionPerformed(e: AnActionEvent) {
        barContext(e)?.let { run(it) }
    }

    /** Whether this button applies to the bar's current state (default: the file has pending edits). */
    open fun applies(c: BarContext): Boolean = true

    abstract fun run(c: BarContext)
}

private class FloatingKeep : FloatingBarAction("Keep", "Keep this edit — the one the counter names", NavTint.KEEP) {
    override fun applies(c: BarContext) = c.current != null
    override fun run(c: BarContext) {
        c.current?.let { ReviewOps.keep(c.project, c.session, it.id) }
    }
}

private class FloatingUndo : FloatingBarAction("Undo", "Undo this edit — the one the counter names", NavTint.UNDO) {
    override fun applies(c: BarContext) = c.current != null
    override fun run(c: BarContext) {
        c.current?.let { ReviewOps.undoOrRedo(c.project, c.session, it, redo = false) }
    }
}

/** Step the file's pending edits. Parks the SERVICE review cursor rather than keeping one of its own:
 *  the banner, ⌥⌘N/P, the status bar and the auto-advance all read that cursor, and a fourth position
 *  would drift from it the moment the reader used two of the surfaces. */
private abstract class FloatingDiffStep(text: String, description: String, icon: Icon, private val dir: Int) :
    FloatingBarAction(text, description, icon) {

    override fun applies(c: BarContext) = c.pending.size > 1
    override fun run(c: BarContext) {
        val cur = c.current ?: return
        val idx = c.pending.indexOfFirst { it.id == cur.id }.let { if (it < 0) 0 else it }
        val target = c.pending[(idx + dir + c.pending.size) % c.pending.size]
        ObservatoryService.getInstance(c.project).parkReviewCursor(target.id)
        Navigate.openFileAtEdit(c.project, c.session, target)
    }
}

private class FloatingDiffPrev : FloatingDiffStep(
    "Previous Edit", "Previous pending edit in this file",
    NavTint.tint(AllIcons.Actions.PreviousOccurence, NavTint.BLUE), -1,
)

private class FloatingDiffNext : FloatingDiffStep(
    "Next Edit", "Next pending edit in this file",
    NavTint.tint(AllIcons.Actions.NextOccurence, NavTint.BLUE), 1,
)

/**
 * The File axis: every file with pending edits, distinct and sorted.
 *
 * ONE definition, called by the two steppers and the counter between them. It is also, deliberately,
 * the same expression as `ReviewNavBar.pendingFiles()` — the two bars can be on screen together, and a
 * counter that indexed a differently-ordered list than the buttons beside it would step from "File 2/7"
 * to a file the reader had already seen. Three copies of one rule is two too many; if this ever needs
 * to change, it changes here and in `ReviewNavBar`, and `FloatingFileCounterTest` fails if they drift.
 */
private fun pendingFiles(project: Project): List<String> =
    ObservatoryService.getInstance(project).pendingFiles()

/**
 * Step to the previous / next FILE with pending edits, opening its oldest one.
 *
 * The file list and the wrap are the same rule `ReviewNavBar.navFile` uses — sorted, distinct, and
 * wrapping at the ends — so the floating bar and the status-bar nav bar cannot disagree about what
 * "next file" means while both are on screen.
 */
private abstract class FloatingFileStep(text: String, description: String, icon: Icon, private val dir: Int) :
    FloatingBarAction(text, description, icon) {

    /** Hidden when there is only one file to review: a floating bar sits on top of code, so a button
     *  that cannot act is covering text for nothing (the same rule FloatingDiffStep follows). */
    override fun applies(c: BarContext) = pendingFiles(c.project).size > 1

    override fun run(c: BarContext) {
        val files = pendingFiles(c.project)
        if (files.isEmpty()) return
        val here = ClaudePaths.storeKey(c.path)
        val idx = files.indexOf(here)
        val target = files[((if (idx < 0) 0 else idx) + dir + files.size) % files.size]
        val first = ObservatoryService.getInstance(c.project).log()
            .filter { it.pending && it.file == target }.minByOrNull { it.id } ?: return
        ObservatoryService.getInstance(c.project).parkReviewCursor(first.id)
        Navigate.openFileAtEdit(c.project, c.session, first)
    }
}

private class FloatingFilePrev : FloatingFileStep(
    "Previous Changed File", "Previous file with pending edits",
    NavTint.tint(AllIcons.Actions.Back, NavTint.BLUE), -1,
)

private class FloatingFileNext : FloatingFileStep(
    "Next Changed File", "Next file with pending edits",
    NavTint.tint(AllIcons.Actions.Forward, NavTint.BLUE), 1,
)

/**
 * "File n/m" — the File axis's twin of [FloatingDiffCounter], between the two file steppers.
 *
 * The steppers shipped without it, so the bar had two arrows with nothing between them saying what they
 * were stepping THROUGH: the reader could see that another file existed but not how many, or where in
 * them they were. The status-bar nav bar has carried this counter since it shipped; this is the same
 * number on the surface that floats over the code.
 *
 * Terse on purpose. `ReviewNavBar.fileCounterText` appends the filename and edit count when it is hosted
 * in the Overview, where there is room; this bar sits ON the code it is about, so it stays at the
 * counter. Hidden — not disabled — below two files, matching [FloatingFileStep.applies], so the bar
 * does not cover a line to say "File 1/1".
 */
private class FloatingFileCounter : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the counter text
    override fun displayTextInToolbar() = true

    override fun update(e: AnActionEvent) {
        val c = barContext(e)
        val files = c?.let { pendingFiles(it.project) } ?: emptyList()
        val idx = if (c == null) -1 else files.indexOf(ClaudePaths.storeKey(c.path))
        // idx < 0 hides rather than rendering "File 0/m": barContext already refused a file with nothing
        // pending, so a miss here means the store moved under us mid-tick, and a wrong number on a bar
        // the reader steps with is worse than no number at all.
        if (files.size <= 1 || idx < 0) {
            e.presentation.isEnabledAndVisible = false
            return
        }
        e.presentation.isEnabledAndVisible = true
        e.presentation.text = "File ${idx + 1}/${files.size}"
        e.presentation.description = "${File(c!!.path).name} — ${c.pending.size} pending edit(s) in this file"
    }

    override fun actionPerformed(e: AnActionEvent) {
        val c = barContext(e) ?: return
        c.current?.let { Diffs.show(c.project, c.session, it) }
    }
}

/** "Diff n/m" — Copilot's "1 of 5". Text rather than an icon, so it says what the bar is parked on; a
 *  click opens that edit's diff, the same as the nav bar's counter. */
private class FloatingDiffCounter : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the counter text
    override fun displayTextInToolbar() = true

    override fun update(e: AnActionEvent) {
        val c = barContext(e)
        val cur = c?.current
        if (c == null || cur == null) {
            e.presentation.isEnabledAndVisible = false
            return
        }
        val idx = c.pending.indexOfFirst { it.id == cur.id }
        e.presentation.isEnabledAndVisible = true
        e.presentation.text = "Diff ${idx + 1}/${c.pending.size}"
        e.presentation.description = "Edit #${cur.id} · ${cur.tool} — open its diff"
    }

    override fun actionPerformed(e: AnActionEvent) {
        val c = barContext(e) ?: return
        c.current?.let { Diffs.show(c.project, c.session, it) }
    }
}

/** Hand the CURRENT edit's context to the reader's Claude — the nav bar's Chat, on the bar over the code
 *  it is about. The balloon glyph, never the bulb: the bulb is Spotlight's, two buttons along. */
private class FloatingChat : FloatingBarAction(
    "Chat", "Chat about this edit — copies its context, opens your agent", NavTint.CHAT,
) {
    override fun applies(c: BarContext) = c.current != null
    override fun run(c: BarContext) {
        c.current?.let { ReviewOps.chatAbout(c.project, c.session, it.id) }
    }
}

/** The same diff the counter opens, as a button of its own — the counter reads as a position, and a
 *  reader looking for "show me the change" should not have to discover that a number is a link. */
private class FloatingViewDiff : FloatingBarAction(
    "View diff", "View this edit's diff — before / after",
    NavTint.tint(AllIcons.Actions.Diff, NavTint.BLUE),
) {
    override fun applies(c: BarContext) = c.current != null
    override fun run(c: BarContext) {
        c.current?.let { Diffs.show(c.project, c.session, it) }
    }
}

/** These two act on THIS FILE only — the bar is per-file, so a session-wide verb here would be a trap. */
private class FloatingAcceptFile :
    FloatingBarAction("Accept File", "Accept every pending edit in this file", NavTint.ACCEPT_FILE) {
    override fun run(c: BarContext) = ReviewOps.keepAll(c.project, c.session, c.allInFile(), c.fileName)
}

private class FloatingRejectFile :
    FloatingBarAction("Reject File", "Reject (revert) every pending edit in this file", NavTint.REJECT) {
    override fun run(c: BarContext) = ReviewOps.undoAll(c.project, c.session, c.allInFile(), c.fileName, c.path)
}

/**
 * Spotlight — dim every line Claude did not touch, across every file with pending edits.
 *
 * A TOGGLE, unlike its neighbours: it has a state the reader can see on screen, and a button that looks
 * the same whether the dimming is on or off is one they have to click twice to find out. The state lives
 * on the project's [InlineOverlay], which is also what the nav bar's Spotlight flips — one switch, two
 * places to reach it.
 */
private class FloatingSpotlight : ToggleAction(
    "Spotlight", "Toggle Spotlight — dim unedited lines", NavTint.SPOTLIGHT,
), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        super.update(e) // writes the on/off state into the presentation
        e.presentation.isEnabledAndVisible = barContext(e) != null
    }

    override fun isSelected(e: AnActionEvent): Boolean =
        e.project?.let { InlineOverlay.getInstance(it).heatmapOn } ?: false

    override fun setSelected(e: AnActionEvent, state: Boolean) {
        // toggleHeatmap flips and re-renders; the platform only ever calls this with the opposite of
        // isSelected, so flipping is what "set to state" means here.
        e.project?.let { InlineOverlay.getInstance(it).toggleHeatmap() }
    }
}

/**
 * Drop the review records of everything already judged, for the whole session.
 *
 * Session-wide on a per-file bar, deliberately and by name: "Clear Resolved" says what it takes, it
 * destroys no file (a record of a verdict is all it removes), and the alternative — a file-scoped clear —
 * was removed from every surface in 0.8.9 for being a distinction without a difference. It stays on the
 * bar with nothing to clear and says so, rather than vanishing: a button that appears only sometimes is
 * one the reader stops looking for.
 */
private class FloatingClearResolved :
    FloatingBarAction("Clear Resolved", "Clear this session's resolved edits (keeps every file as it is)", NavTint.CLEAR) {
    override fun run(c: BarContext) {
        val resolved = ObservatoryService.getInstance(c.project).log().count { !it.pending }
        if (resolved > 0) ReviewOps.clearResolved(c.project, c.session, resolved)
        else ReviewOps.notify(c.project, "No resolved edits to clear")
    }
}
