package com.cellobservatory.observatory.ui.editor

import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorKind
import com.intellij.openapi.editor.toolbar.floating.FloatingToolbarComponent
import com.intellij.openapi.editor.toolbar.floating.FloatingToolbarProvider
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer

/**
 * The floating review bar: Keep · Undo · ‹ Diff n/m › · Accept File · Reject File, drawn in the corner of
 * any editor whose file still has agent edits awaiting review.
 *
 * This is the port of Copilot's editor overlay controls, and the platform's own floating-toolbar
 * extension point is a true overlay over the code — the thing VS Code has no extension API for at all
 * (its half of the port is a pinned comment-thread bubble instead). The buttons live in
 * [FloatingReviewActions]; the group instance is shared by every editor of every project, so nothing here
 * or there may capture a project.
 *
 * Two deliberate choices:
 *
 * `autoHideable = false` — the bar stays up while the file has pending edits. The platform's hover-reveal
 * default hides a toolbar the moment the pointer leaves the editor, which is exactly when someone is
 * reading the change they are about to judge, and Copilot's bar is persistent for the same reason.
 *
 * MAIN_EDITOR only — a diff pane is an editor too, and a review bar floating inside the diff *of* the
 * edit it acts on is one surface too many.
 */
class ObservatoryFloatingToolbarProvider : FloatingToolbarProvider {

    override val autoHideable: Boolean = false

    override val actionGroup: ActionGroup = FloatingReviewActions.group()

    override fun isApplicable(dataContext: DataContext): Boolean {
        if (CommonDataKeys.PROJECT.getData(dataContext) == null) return false
        val editor = CommonDataKeys.EDITOR.getData(dataContext) ?: return false
        return editor.editorKind == EditorKind.MAIN_EDITOR
    }

    /**
     * Show the bar while this editor's file has pending edits, and hide it otherwise — re-evaluated on
     * every store change through the service's existing listener ring. No timer of its own: the store
     * watcher already fires on each capture, and a keep/undo forces a refresh through it.
     */
    override fun register(dataContext: DataContext, component: FloatingToolbarComponent, parentDisposable: Disposable) {
        val project = CommonDataKeys.PROJECT.getData(dataContext) ?: return
        val editor = CommonDataKeys.EDITOR.getData(dataContext) ?: return
        val service = ObservatoryService.getInstance(project)
        val evaluate = Runnable { apply(project, editor, component) }
        service.addListener(evaluate)
        Disposer.register(parentDisposable) { service.removeListener(evaluate) }
        evaluate.run() // the file may already have pending edits when it opens
    }

    private fun apply(project: Project, editor: Editor, component: FloatingToolbarComponent) {
        if (project.isDisposed || editor.isDisposed) return
        val show = ObservatorySettings.instance.state.floatingSurface && hasPending(project, editor)
        // pendingCount() is O(1) in record count but stats log.jsonl once per call. Fine here — this runs
        // per store change, not per keystroke or per paint — and never on a hot path.
        if (show) component.scheduleShow() else component.scheduleHide()
    }

    private fun hasPending(project: Project, editor: Editor): Boolean {
        val path = FileDocumentManager.getInstance().getFile(editor.document)?.path ?: return false
        return ObservatoryService.getInstance(project).pendingCount(path) > 0
    }
}
