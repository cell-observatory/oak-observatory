package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.event.MouseEvent

private const val WIDGET_ID = "claudeObservatoryStatus"

/** The microscope scoreboard: pending count at a glance, full review stats in the tooltip,
 *  click = review the next pending edit — parity with the VS Code status-bar item. */
class ObservatoryStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = WIDGET_ID
    override fun getDisplayName() = "OAK"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = ObservatoryWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

private class ObservatoryWidget(private val project: Project) :
    StatusBarWidget, StatusBarWidget.TextPresentation {

    private var statusBar: StatusBar? = null
    private val listener = Runnable { statusBar?.updateWidget(WIDGET_ID) }

    override fun ID() = WIDGET_ID
    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        ObservatoryService.getInstance(project).addListener(listener)
    }

    override fun dispose() {
        ObservatoryService.getInstance(project).removeListener(listener)
        statusBar = null
    }

    override fun getText(): String {
        val pending = ObservatoryService.getInstance(project).counts().pending
        return if (pending > 0) "🔬 $pending" else "🔬"
    }

    override fun getTooltipText(): String {
        val c = ObservatoryService.getInstance(project).counts()
        if (c.pending + c.kept + c.undone == 0) return "OAK — no tracked edits yet"
        val rate = if (c.kept + c.undone > 0) " · ${(c.kept * 100) / (c.kept + c.undone)}% accepted" else ""
        val oldest = c.oldestPendingTs?.let { " · oldest ${relTime(it)}" } ?: ""
        val action = if (c.pending > 0) "Click to review the next pending edit" else "All caught up"
        return "OAK: ${c.pending} pending · ${c.kept} accepted · ${c.undone} reverted$rate$oldest — $action"
    }

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return@Consumer
        val next = service.nextPendingEdit() ?: return@Consumer
        Navigate.openFileAtEdit(project, session, next)
    }

    override fun getAlignment(): Float = Component.LEFT_ALIGNMENT
}
