package com.cellobservatory.observatory.ui.editor

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.Icons
import com.cellobservatory.observatory.ui.NavTint
import com.cellobservatory.observatory.ui.Navigate
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.EditorNotificationPanel
import com.intellij.ui.EditorNotificationProvider
import java.util.function.Function
import javax.swing.JComponent

/**
 * Persistent review bar atop any editor whose file has pending agent edits — parity with the VS Code
 * editor-title buttons. Every action renders a tinted nav-bar icon + a word label, icon AND text both
 * clickable (Search · Prev/Next Edit · Prev/Next File · Keep · Undo · Accept File · Reject File ·
 * Clear Resolved · Spotlight). Per-file gated; kept live by
 * ObservatoryStartup, which fires EditorNotifications.updateAllNotifications() on every store change.
 */
class ObservatoryEditorBanner : EditorNotificationProvider, DumbAware {

    override fun collectNotificationData(
        project: Project,
        file: VirtualFile,
    ): Function<in FileEditor, out JComponent?>? {
        // Which in-editor review chrome the reader asked for. Since 0.10 the default is the floating bar
        // over the code (ObservatoryFloatingToolbarProvider) — this banner AND that bar over one file is
        // two rows of the same verbs. `banner` or `both` brings it back.
        if (!ObservatorySettings.instance.state.bannerSurface) return null
        val service = ObservatoryService.getInstance(project)
        service.currentSession() ?: return null
        // Cheap: cached folded log + path filter, no `locate` subprocess — safe on the provider's BGT.
        val key = ClaudePaths.storeKey(file.path) // hoisted: the provider runs per open file per refresh
        // Not the cancelled-out chains: a banner reading "2 pending" over a file the Review tree
        // shows nothing for, whose Prev/Next then have nowhere to go.
        val pendingInFile = service.log().count { it.pending && !service.isHidden(it) && it.file == key }
        if (pendingInFile == 0) return null // null ⇒ no banner on files Claude hasn't touched
        return Function { fileEditor -> banner(project, service, file, pendingInFile, fileEditor) }
    }

    // The returned Function is invoked per FileEditor on the EDT — build Swing here, not above.
    private fun banner(
        project: Project,
        service: ObservatoryService,
        file: VirtualFile,
        count: Int,
        fileEditor: FileEditor,
    ): JComponent {
        val panel = EditorNotificationPanel(fileEditor, EditorNotificationPanel.Status.Info)
        panel.icon(Icons.Microscope)
        panel.text("$count pending")
        // Every action carries TEXT: an icon-only createActionLabel("") renders its icon but has no
        // clickable hyperlink region in Swing — the 0.8.x "banner button does nothing" bug.
        // Search leads every nav bar (user rule).
        panel.createActionLabel("Search") {
            val q = Messages.showInputDialog(
                project, "Filter edits by file path (empty to clear):",
                "Search Edits", null, service.filterQuery, null,
            )
            if (q != null) service.setFilter(q)
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.SEARCH)
            toolTipText = "Search edits"
        }
        // Every button: tinted nav-bar icon + a WORD label (user rule 2026-07-16 — "text on all the
        // icons"; a bare glyph like "↑" names nothing, and the same action must look the same as it
        // does on the status-bar nav bar).
        panel.createActionLabel("Prev Edit") {
            val s = service.currentSession() ?: return@createActionLabel
            val prev = service.prevPendingEdit()
            if (prev == null) ReviewOps.notify(project, "No pending agent edits — all caught up")
            else Navigate.openFileAtEdit(project, s, prev)
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.tint(com.intellij.icons.AllIcons.Actions.PreviousOccurence, NavTint.BLUE))
            toolTipText = "Previous pending edit"
        }
        panel.createActionLabel("Next Edit") {
            val s = service.currentSession() ?: return@createActionLabel
            val next = service.nextPendingEdit()
            if (next == null) ReviewOps.notify(project, "No pending agent edits — all caught up")
            else Navigate.openFileAtEdit(project, s, next)
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.tint(com.intellij.icons.AllIcons.Actions.NextOccurence, NavTint.BLUE))
            toolTipText = "Next pending edit"
        }
        // File axis — jump across every file with pending edits (parity with the nav bar's file axis).
        panel.createActionLabel("Prev File") { stepFile(project, service, file.path, -1) }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.tint(com.intellij.icons.AllIcons.Actions.Back, NavTint.BLUE))
            toolTipText = "Previous changed file"
        }
        panel.createActionLabel("Next File") { stepFile(project, service, file.path, 1) }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.tint(com.intellij.icons.AllIcons.Actions.Forward, NavTint.BLUE))
            toolTipText = "Next changed file"
        }
        // Per-edit pair — acts on the edit the review cursor is parked on when it sits in THIS file
        // (the one Prev/Next Edit just landed on), else the file's first pending edit. The rule is shared
        // with the floating review bar, which sits over the same file: see ReviewSelection.
        val bannerEdit = { com.cellobservatory.observatory.ui.ReviewSelection.currentEditIn(project, file.path) }
        panel.createActionLabel("Keep") {
            service.currentSession()?.let { s -> bannerEdit()?.let { ReviewOps.keep(project, s, it.id) } }
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.KEEP)
            toolTipText = "Keep this edit — the one Prev/Next Edit is parked on"
        }
        panel.createActionLabel("Undo") {
            service.currentSession()?.let { s -> bannerEdit()?.let { ReviewOps.undoOrRedo(project, s, it, redo = false) } }
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.UNDO)
            toolTipText = "Undo this edit — the one Prev/Next Edit is parked on"
        }
        // These act on THIS file only — the banner is per-file, so session-wide would be misleading.
        panel.createActionLabel("Accept File") {
            service.currentSession()?.let { s ->
                ReviewOps.keepAll(project, s, service.log().filter { it.file == ClaudePaths.storeKey(file.path) }, file.name)
            }
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.ACCEPT_FILE)
            toolTipText = "Accept all edits in this file"
        }
        panel.createActionLabel("Reject File") {
            service.currentSession()?.let { s ->
                ReviewOps.undoAll(project, s, service.log().filter { it.file == ClaudePaths.storeKey(file.path) }, file.name, file.path)
            }
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.REJECT)
            toolTipText = "Reject (revert) all edits in this file"
        }
        // Clear resolved (kept/reverted) edits — parity with the nav bar's clear button. The label
        // spells out "Clear Resolved" (user rule: a bare "Clear" is ambiguous about what it drops).
        panel.createActionLabel("Clear Resolved") {
            service.currentSession()?.let { s ->
                val resolved = service.log().count { !it.pending }
                if (resolved > 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
            }
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.CLEAR)
            toolTipText = "Clear resolved (kept/reverted) edits"
        }
        // Spotlight/heatmap toggle — the same lightbulb icon the nav bar uses, so it reads identically
        // across every surface (status-bar nav bar + this editor banner).
        panel.createActionLabel("Spotlight") {
            com.cellobservatory.observatory.ui.inline.InlineOverlay.getInstance(project).toggleHeatmap()
        }.apply {
            setUseIconAsLink(true)
            setIcon(NavTint.SPOTLIGHT)
            toolTipText = "Toggle file heatmap (spotlight the agent's edits)"
        }
        return panel
    }

    /** Open the first pending edit of the prev (-1) / next (+1) file with pending edits, wrapping. */
    private fun stepFile(project: Project, service: ObservatoryService, current: String, dir: Int) {
        val s = service.currentSession() ?: return
        val files = service.pendingFiles()
        if (files.isEmpty()) return
        val idx = files.indexOf(ClaudePaths.storeKey(current))
        val target = files[((if (idx < 0) 0 else idx) + dir + files.size) % files.size]
        val first = service.log().filter { it.pending && !service.isHidden(it) && it.file == target }.minByOrNull { it.id } ?: return
        Navigate.openFileAtEdit(project, s, first)
    }
}
