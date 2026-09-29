package com.cellobservatory.observatory.actions

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.NavGrouping
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.Navigate
import com.cellobservatory.observatory.ui.ReviewOps
import com.cellobservatory.observatory.ui.RevisionNav
import com.cellobservatory.observatory.ui.TimelinePanel
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import java.awt.datatransfer.StringSelection

/** ⌥⌘N — step to the next pending edit, cycling through all of them (the keyboard review loop). */
class ReviewNextAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val next = service.nextPendingEdit()
            ?: return ReviewOps.notify(project, "No pending agent edits — all caught up")
        Navigate.openFileAtEdit(project, session, next)
    }
}

/** ⌥⌘P — step to the previous pending edit, cycling through all of them (the keyboard review loop). */
class ReviewPrevAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val prev = service.prevPendingEdit()
            ?: return ReviewOps.notify(project, "No pending agent edits — all caught up")
        Navigate.openFileAtEdit(project, session, prev)
    }
}

/** ⌥⌘Y — keep the pending edit under the cursor. */
class KeepAtCursorAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        Navigate.pendingAtCursor(project, editor) { rec ->
            if (rec == null) {
                ReviewOps.notify(project, "No pending agent edit at the cursor")
            } else {
                val session = ObservatoryService.getInstance(project).currentSession() ?: return@pendingAtCursor
                ReviewOps.keep(project, session, rec.id)
            }
        }
    }
}

/** ⌥⌘U — surgically undo the pending edit under the cursor. */
class UndoAtCursorAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        Navigate.pendingAtCursor(project, editor) { rec ->
            if (rec == null) {
                ReviewOps.notify(project, "No pending agent edit at the cursor")
            } else {
                val session = ObservatoryService.getInstance(project).currentSession() ?: return@pendingAtCursor
                ReviewOps.undoOrRedo(project, session, rec, redo = false)
            }
        }
    }
}

/** ⌥⌘[ — diff the current file against the state the previous agent edit produced. */
class DiffPrevRevisionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        RevisionNav.step(project, editor, -1)
    }
}

/** ⌥⌘] — diff the current file against the state the next agent edit produced. */
class DiffNextRevisionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        RevisionNav.step(project, editor, 1)
    }
}

/** ⌃⌥K / ⌘⌥K — accept every pending edit in the active file (parity: VS Code keepOpenFile). */
class KeepOpenFileAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.VIRTUAL_FILE) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return
        val targets = service.log().filter { it.file == ClaudePaths.storeKey(vf.path) }
        ReviewOps.keepAll(project, session, targets, vf.name)
    }
}

/** ⌃⌥R / ⌘⌥R — revert every pending edit in the active file (parity: VS Code undoOpenFile). */
class UndoOpenFileAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.VIRTUAL_FILE) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return
        val targets = service.log().filter { it.file == ClaudePaths.storeKey(vf.path) }
        // `under = vf.path` scopes the revert to this file; omitting it makes undoScope run
        // `undo --all` across the whole session (matches EditsTreePanel/FileHistory/ReviewNavBar).
        ReviewOps.undoAll(project, session, targets, vf.name, vf.path)
    }
}

/**
 * Comment for the agent on the caret line. Resolves the pending edit the cursor
 * sits in, asks for a note, and stores it through `oak comment add` — anchored on the edit id + the
 * caret's 1-based line. Batched later by "Send Review Comments to Agent".
 */
class AddReviewCommentAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val session = ObservatoryService.getInstance(project).currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val line = editor.caretModel.logicalPosition.line + 1 // core lines are 1-based; the file IS the after-state
        Navigate.pendingAtCursor(project, editor) { rec ->
            if (rec == null) {
                ReviewOps.notify(project, "No pending agent edit at the cursor to comment on", NotificationType.WARNING)
                return@pendingAtCursor
            }
            // On the EDT (pendingAtCursor's callback) — a brief modal input the user asked for is fine.
            val text = Messages.showInputDialog(
                project,
                "Your note for the agent on line $line of ${rec.file.substringAfterLast('/')}:",
                "Add Review Comment",
                null,
            )
            if (text.isNullOrBlank()) return@pendingAtCursor
            ApplicationManager.getApplication().executeOnPooledThread {
                val failure = ObservatoryCli.commentAdd(session, project.basePath, rec.id, line, text)
                ApplicationManager.getApplication().invokeLater {
                    if (failure == null) ReviewOps.notify(project, "Comment added on edit #${rec.id} — “Send Review Comments to Agent” drafts them all")
                    else ReviewOps.notify(project, "OAK: could not add the review comment — $failure", NotificationType.ERROR)
                }
            }
        }
    }
}

/**
 * Batch every unsent review comment into one editable dialog draft. Send submits it through herdr
 * and marks the comments sent; opening the draft alone never sends them.
 */
class SendReviewCommentsAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val session = ObservatoryService.getInstance(project).currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        ApplicationManager.getApplication().executeOnPooledThread {
            val draft = ObservatoryCli.commentCompose(session, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                if (draft == null) {
                    ReviewOps.notify(project, "No review comments to send — add some with “Add Review Comment” on a changed line")
                    return@invokeLater
                }
                ReviewOps.deliverPrompt(project, session, draft.text, "Review comments", draft.ids)
            }
        }
    }
}

/**
 * Quote the agent's last reply into an editable dialog draft as a `> ` block — reference it,
 * or annotate it by typing after the quote. Only Send submits the draft through herdr.
 */
class QuoteLastReplyAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val session = ObservatoryService.getInstance(project).currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        ApplicationManager.getApplication().executeOnPooledThread {
            val quote = ObservatoryCli.quoteLastReply(session, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                if (quote.isNullOrBlank()) {
                    ReviewOps.notify(project, "The agent has not replied yet in this session — nothing to quote")
                    return@invokeLater
                }
                ReviewOps.deliverPrompt(project, session, quote, "Quote last reply")
            }
        }
    }
}
