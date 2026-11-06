package com.cellobservatory.observatory.actions

import com.cellobservatory.observatory.ui.SyncOps
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import java.util.concurrent.TimeUnit

/** oak sync from Find Action, each through the CLI (SyncOps), as VS Code's OAK: Sync commands are. */

/** Run `oak sync now`, with a cancellable progress bar, then say what the run did. */
class SyncNowAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) = SyncOps.syncNow(e.project)
}

/** oak sync's menu: run now, each open conflict, the backup, the machines and projects synced, the last run; built from
 *  a status read for it, not the one before. */
class SyncMenuAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val read = SyncOps.refresh(force = true)
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { read.get(30, TimeUnit.SECONDS) }
            ApplicationManager.getApplication().invokeLater { if (project?.isDisposed != true) SyncOps.showMenu(project, null) }
        }
    }
}

/** `oak sync setup`, asking what it asks on a terminal: also how the backup is changed later. */
class SyncSetupAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) = SyncOps.setup(e.project)
}
