package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.openapi.project.Project

/**
 * Which pending edit a PER-FILE review surface acts on.
 *
 * Two surfaces sit over the same file at the same time — the editor-top banner and the floating review
 * bar — and both carry a per-edit Keep/Undo. Two copies of this rule means their two Keep buttons can
 * resolve different edits while pointing at the same line, so the rule lives here once.
 */
internal object ReviewSelection {

    /**
     * The pending edit [path]'s review buttons act on: the one the service review cursor is parked on
     * when it sits in THIS file (what Prev/Next Edit, the bar's ‹/›, or an auto-advance just landed on),
     * else the file's first pending edit. Null when the file has nothing pending.
     */
    fun currentEditIn(project: Project, path: String): EditRecord? {
        val service = ObservatoryService.getInstance(project)
        val key = com.cellobservatory.observatory.ui.RemoteEditorReview.fileKey(project, path) // hoisted: this runs per toolbar tick over every record
        return service.currentPendingEdit()?.takeIf { it.file == key }
            ?: service.reviewRecords().filter { it.pending && it.file == key }.minByOrNull { it.id }
    }
}
