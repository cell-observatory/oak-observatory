package com.cellobservatory.observatory.actions

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.InboxNextParser
import com.cellobservatory.observatory.model.NavGrouping
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.ReviewOps
import com.cellobservatory.observatory.ui.TimelinePanel
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.wm.ToolWindowManager

/**
 * ⌃⌥I — jump to the next session waiting on you: permission prompts first,
 * then questions, then input waits, oldest first. The ranking is core's, asked of the CLI
 * (`oak inbox --next --after <current>`) so this plugin carries no copy of the rule. Pins the session
 * and brings the Feed tab forward — the same landing the raised-hand balloon leads to.
 */
class NextAttentionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val current = ObservatoryService.getInstance(project).currentSession()
        val workDir = project.basePath
        ApplicationManager.getApplication().executeOnPooledThread {
            val r = ObservatoryCli.inboxNext(current, workDir)
            val hand = if (r.ok) InboxNextParser.parse(r.stdout) else null
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                // A read that failed or timed out learned nothing about who is waiting.
                if (!r.ok) {
                    val why = ObservatoryCli.failureMessage(r.stdout, r.stderr, "`oak inbox` did not answer").removePrefix("oak: ")
                    ReviewOps.notify(project, "Could not read which sessions are waiting — $why", NotificationType.WARNING)
                    return@invokeLater
                }
                if (hand == null) {
                    ReviewOps.notify(project, "Nobody is waiting on you")
                    return@invokeLater
                }
                ReviewOps.applySessionChoice(project, hand.id)
                ToolWindowManager.getInstance(project).getToolWindow("Observatory Timeline")?.show(null)
                TimelinePanel.of(project)?.selectMember(NavGrouping.FEED)
                val name = hand.title ?: ("session " + hand.id.take(8))
                ReviewOps.notify(project, "“$name” ${hand.label}" + (hand.message.takeIf { it.isNotBlank() }?.let { " — $it" } ?: ""))
            }
        }
    }
}
