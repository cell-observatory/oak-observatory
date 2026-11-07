package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem

/**
 * Editor navigation anchored by the CLI's `locate` (positional diff mapping into the LIVE buffer —
 * the one read-only algorithm the plan says never to re-port). Locate runs on a background thread;
 * caret moves land back on the EDT.
 *
 * These two spawn `locate` DIRECTLY rather than going through PlacementsCache, and that is deliberate: the
 * cache answers null while its 350 ms quiet window is open, and a jump has to land now or not at all —
 * returning "not yet" to a keypress reads as the key doing nothing. A jump is a discrete user action, so
 * one spawn per jump is bounded by how fast a person can press a key; the cache exists for the render path,
 * which runs per keystroke and cannot afford one.
 */
object Navigate {

    /** Open a file by its record path, no caret placement — the Review tree's FILE rows use this
     *  (parity with the VS Code Review list, where the filename itself opens the file). */
    fun openFile(project: Project, path: String) {
        val svc = ObservatoryService.getInstance(project)
        svc.currentMachine()?.let { machine ->
            svc.currentSession()?.let { RemoteEditorReview.open(project, machine, it, file = path) }
            return
        }
        openLocalFile(project, path)
    }
    fun openLocalFile(project: Project, path: String) {
        val vf = LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(com.intellij.openapi.util.io.FileUtil.toSystemIndependentName(path))
        if (vf == null) {
            ReviewOps.notify(project, "File not found: $path", NotificationType.WARNING)
            return
        }
        FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, vf), true)
    }

    fun openFileAtEdit(project: Project, session: String, rec: EditRecord) {
        ObservatoryService.getInstance(project).currentMachine()?.let { machine ->
            ObservatoryService.getInstance(project).selectRemoteReviewFile(rec.file)
            RemoteEditorReview.open(project, machine, session, edit = rec.id)
            return
        }
        openLocalFileAtEdit(project, session, rec.id, rec.file, rec.file)
    }

    fun openLocalFileAtEdit(project: Project, session: String, id: Int, remoteFile: String, localFile: String, machine: String? = null) {
        // Record paths are OS-native (backslashes on Windows); the VFS wants system-independent.
        val vf = LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(com.intellij.openapi.util.io.FileUtil.toSystemIndependentName(localFile))
        if (vf == null) {
            ReviewOps.notify(project, "File not found: $localFile", NotificationType.WARNING)
            return
        }
        val editor = FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, vf), true) ?: return
        val text = editor.document.text
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Locating edit #$id", false) {
            override fun run(indicator: ProgressIndicator) {
                val line = ObservatoryCli.onMachine(machine) { ObservatoryCli.locate(session, remoteFile, text, project.basePath, includeUndone = machine != null) }
                    .find { it.id == id }
                    // A PURE deletion added no lines, so there is nothing of it left to jump onto — land on
                    // the surviving line its first removed hunk now follows, or the edit is unreachable and
                    // the caret stays put (VS Code's anchorLines makes the same fallback).
                    ?.let { p -> p.lines.firstOrNull() ?: p.removed.firstOrNull()?.anchor }
                    ?: return
                ApplicationManager.getApplication().invokeLater {
                    if (!editor.isDisposed && line < editor.document.lineCount) {
                        editor.caretModel.moveToLogicalPosition(LogicalPosition(line, 0))
                        editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
                    }
                }
            }
        })
    }

    /** Find the pending edit whose current lines contain the caret; result delivered on the EDT. */
    fun pendingAtCursor(project: Project, editor: Editor, onFound: (EditRecord?) -> Unit) {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return onFound(null)
        val file = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(editor.document)?.path
            ?: return onFound(null)
        val caretLine = editor.caretModel.logicalPosition.line
        val text = editor.document.text
        val fileKey = RemoteEditorReview.fileKey(project, file) ?: return onFound(null)
        val machine = service.currentMachine()
        val pending = service.reviewRecords().filter { it.pending && it.file == fileKey }
        if (pending.isEmpty()) return onFound(null)
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Resolving edit at cursor", false) {
            override fun run(indicator: ProgressIndicator) {
                val hit = ObservatoryCli.onMachine(machine) { ObservatoryCli.locate(session, fileKey, text, project.basePath) }
                    // Same anchor rule as the overlay: the lines the edit added, or — for a pure deletion —
                    // the surviving line its removed hunk now follows.
                    .find { p ->
                        if (p.lines.isNotEmpty()) caretLine in p.lines
                        else p.removed.any { it.anchor == caretLine }
                    }
                val rec = pending.find { it.id == hit?.id }
                ApplicationManager.getApplication().invokeLater { onFound(rec) }
            }
        })
    }
}
