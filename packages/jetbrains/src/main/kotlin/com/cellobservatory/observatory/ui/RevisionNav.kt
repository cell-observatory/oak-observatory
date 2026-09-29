package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.notification.NotificationType
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project

/** Steps a file's edit history in a current-vs-revision diff (JetBrains twin of VS Code's diffRevisionStep).
 *  The cursor is keyed by absolute path and clamps at both ends — history is finite (no wrap). */
object RevisionNav {
    private val cursor = HashMap<String, Int>() // file path -> edit id the diff is parked on

    fun step(project: Project, editor: Editor, dir: Int) {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val vf = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        val edits = service.log().filter { it.file == ClaudePaths.storeKey(vf.path) }.sortedBy { it.id } // this file's history, oldest->newest
        if (edits.isEmpty()) return ReviewOps.notify(project, "No agent edits recorded for this file")
        val cur = cursor[vf.path]
        val base = if (cur == null) edits.size else edits.indexOfFirst { it.id == cur } // null = parked "at current"
        val idx = (base + dir).coerceIn(0, edits.size - 1)
        val target = edits[idx]
        if (cur != null && target.id == cur) {
            ReviewOps.notify(project, if (dir > 0) "Already at the latest revision" else "Already at the first revision")
        }
        cursor[vf.path] = target.id
        Diffs.showRevision(project, session, target, vf)
    }
}
