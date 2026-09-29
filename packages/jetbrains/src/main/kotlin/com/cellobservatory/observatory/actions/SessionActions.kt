package com.cellobservatory.observatory.actions

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.ReviewOps
import com.cellobservatory.observatory.ui.inline.InlineOverlay
import com.cellobservatory.observatory.ui.tour.TourController
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages

/**
 * Session-level utility actions, registered in plugin.xml so the panel-only commands (Setup Check,
 * Export, Switch Session, Clean Store, Accept/Reject All, Clear Resolved, Spotlight, Search, Install
 * Hooks) are reachable from Find Action and can be keybound — parity with VS Code, where the same
 * commands live in the palette. Each reuses the SAME shared handler the tree toolbars call (ReviewOps
 * / the service), so behavior never forks.
 */

private fun sessionOrNotify(project: Project): String? {
    val s = ObservatoryService.getInstance(project).currentSession()
    if (s == null) ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
    return s
}

/** A session-level action gated only on having a project (the handlers notify when no session/edits).
 *  Public (not file-private) so the public, reflectively-instantiated subclasses don't expose a less-
 *  visible supertype. */
abstract class SessionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }
}

/** Run `doctor` and open the setup diagnostics (hooks, PATH, config, session, status line) in a tab. */
class SetupCheckAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.openDoctor(e.project ?: return)
    }
}

/** Export a shareable markdown review summary (kept/reverted per file) and open it in an editor tab. */
class ExportReviewSummaryAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.openMarkdown(
            project, "claude-review-summary",
            "Could not generate a review summary (is the oak CLI installed?)",
        ) { ObservatoryCli.summaryMarkdown(s, project.basePath) }
    }
}

/** Pin which capture session the observatory shows (the Switch-Session chooser). */
class SwitchSessionAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.chooseSession(e.project ?: return)
    }
}

/** Store maintenance: GC orphaned blobs, or drop the whole session. */
class CleanStoreAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.cleanStore(e.project ?: return)
    }
}

/** Install the PreToolUse/PostToolUse capture hooks (`oak init`). */
class InstallHooksAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.installHooks(e.project ?: return)
    }
}

/** Accept every pending agent edit in the session. */
class AcceptAllEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.keepAll(project, s)
    }
}

/** Revert every pending agent edit in the session (with the dirty-buffer guard + confirm). */
class RevertAllEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.undoAll(project, s, ObservatoryService.getInstance(project).log(), "this session")
    }
}

/** Re-apply every undone agent edit in the session (the forward mirror of Reject All). */
class RedoAllEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.redoAll(project, s, ObservatoryService.getInstance(project).log(), "this session")
    }
}

/** Clear the resolved (kept/undone) edits from the session log; pending edits are kept. */
class ClearResolvedEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        val resolved = ObservatoryService.getInstance(project).log().count { !it.pending }
        if (resolved > 0) ReviewOps.clearResolved(project, s, resolved)
        else ReviewOps.notify(project, "No resolved edits to clear")
    }
}

/** Toggle Spotlight — dim the unedited lines to foreground the agent's changes. */
class SpotlightAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        InlineOverlay.getInstance(e.project ?: return).toggleHeatmap()
    }
}

// --- demo mode + the guided tour (0.8.9) -------------------------------------------------------------
// Cancel is the progress bar's own Cancel while the replay runs; reset and redo are the same thing as
// starting, because a run clears any previous demo for this folder before it replays. Two ids exist so
// Find Action can offer the right verb for the state you are in.

/** Replay the scripted demo session and open the guided tour. */
class StartDemoAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && !ReviewOps.demoPresent(e.project!!)
    }
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.startDemo(e.project ?: return)
    }
}

/** Replay it again from the beginning — the reset, for showing it a second time. */
class RestartDemoAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && ReviewOps.demoPresent(e.project!!)
    }
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.startDemo(e.project ?: return)
    }
}

/** Take the guided tour of the session on screen, from step one. */
class StartTourAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && ReviewOps.demoPresent(e.project!!)
    }
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        TourController.getInstance(project).start { msg -> ReviewOps.notify(project, msg, NotificationType.WARNING) }
    }
}

/** Step the tour without reaching for its panel (so it can be keybound). */
class TourNextAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && TourController.getInstance(e.project!!).running
    }
    override fun actionPerformed(e: AnActionEvent) {
        TourController.getInstance(e.project ?: return).next()
    }
}

class TourBackAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && TourController.getInstance(e.project!!).running
    }
    override fun actionPerformed(e: AnActionEvent) {
        TourController.getInstance(e.project ?: return).back()
    }
}

/** Pause or resume the tour's autoplay. Any other control pauses it too. */
class TourPlayPauseAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && TourController.getInstance(e.project!!).running
    }
    override fun actionPerformed(e: AnActionEvent) {
        TourController.getInstance(e.project ?: return).playPause()
    }
}

/** Leave demo mode and remove every trace of it. */
class ExitDemoAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && ReviewOps.demoPresent(e.project!!)
    }
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.exitDemo(e.project ?: return)
    }
}

/** Filter the Review list and the Overview ledger by file path (empty clears) — the shared Search filter. */
class SearchEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = ObservatoryService.getInstance(project)
        val q = Messages.showInputDialog(
            project, "Filter edits by file path (empty to clear):", "Search Edits",
            null, service.filterQuery, null,
        )
        if (q != null) service.setFilter(q)
    }
}
