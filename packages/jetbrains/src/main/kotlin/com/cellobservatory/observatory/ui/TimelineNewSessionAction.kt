package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory

/** New sessions run in herdr-owned terminals through the shared CLI adapter. */
class TimelineNewSessionAction(private val project: Project) : AnAction("＋", "Start a new agent session in herdr", null) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val anchor = e.inputEvent?.component as? javax.swing.JComponent
        val popup = JBPopupFactory.getInstance().createPopupChooserBuilder(listOf("claude", "codex"))
            .setTitle("New session in herdr")
            .setItemChosenCallback { kind ->
                ApplicationManager.getApplication().executeOnPooledThread {
                    val result = ObservatoryCli.startAgent(kind, project.basePath)
                    ApplicationManager.getApplication().invokeLater {
                        if (!project.isDisposed) ReviewOps.notify(project, result.error ?: "Started $kind in herdr. Open herdr to interact with it.")
                    }
                }
            }.createPopup()
        if (anchor != null && anchor.isShowing) popup.showUnderneathOf(anchor) else popup.showCenteredInCurrentWindow(project)
    }
}
