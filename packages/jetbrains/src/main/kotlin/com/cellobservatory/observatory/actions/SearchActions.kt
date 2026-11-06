package com.cellobservatory.observatory.actions

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.SearchHit
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import java.text.SimpleDateFormat
import java.util.Date

/**
 * OAK: Search Conversations… — the asks you typed and the answers you got,
 * across this machine and saved machines, ranked by the CLI (`oak search --json`). Pick a hit to review
 * that session. The search runs off the EDT; the dialog and the chooser are the only EDT work.
 */
class SearchConversationsAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val q = Messages.showInputDialog(project, "Words to find — every one must appear (in the ask or the answer):", "OAK: Search Conversations", null)
            ?.trim()?.takeIf { it.isNotBlank() } ?: return
        val workDir = project.basePath
        ApplicationManager.getApplication().executeOnPooledThread {
            val r = ObservatoryCli.searchMachines(q, workDir)
            val hits = r.hits
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                // A search that failed or timed out found nothing out about any conversation, so it
                // must not say "nothing matches".
                if (r.errors.isNotEmpty()) {
                    ReviewOps.notify(project, "Could not search the conversations on some machines — ${r.errors.joinToString("; ")}", NotificationType.WARNING)
                    if (hits.isEmpty()) return@invokeLater
                }
                if (hits.isEmpty()) {
                    ReviewOps.notify(project, "Nothing matches “$q” in any conversation", NotificationType.INFORMATION)
                    return@invokeLater
                }
                showChooser(project, q, hits)
            }
        }
    }

    internal fun openHit(project: com.intellij.openapi.project.Project, hit: SearchHit) {
        if (hit.machine != null) ReviewOps.applyRemoteSessionChoice(project, hit.machine, hit.session)
        else ReviewOps.applySessionChoice(project, hit.session)
    }

    private fun showChooser(project: com.intellij.openapi.project.Project, q: String, hits: List<SearchHit>) {
        val fmt = SimpleDateFormat("MMM d HH:mm")
        val labelToHit = LinkedHashMap<String, SearchHit>()
        for (h in hits) {
            val name = h.title ?: ("session " + h.session.take(8))
            val agent = if (h.agent.isNotBlank() && h.agent != "claude") " · [${h.agent}]" else ""
            // The label carries the excerpt, so choosing is reading — and the id keeps two hits from one
            // session distinct (the map is keyed by label).
            val label = "$name$agent · ${h.machine ?: "This machine"} · ${fmt.format(Date(h.ts))} · ${if (h.where == "prompt") "ask" else "answer"}: ${h.snippet}  —  ${h.session.take(8)}"
            labelToHit[label] = h
        }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labelToHit.keys.toList())
            .setTitle("“$q” — ${hits.size} matching ask${if (hits.size == 1) "" else "s"}")
            .setItemChosenCallback { label ->
                val h = labelToHit[label] ?: return@setItemChosenCallback
                openHit(project, h)
                ReviewOps.notify(project, "${fmt.format(Date(h.ts))} — ${h.prompt}")
            }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }
}
