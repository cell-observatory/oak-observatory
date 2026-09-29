package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.messages.MessageBusConnection
import javax.swing.JComponent

private const val CLUSTER_ID = "claudeObservatoryActions"

/** The nav bar: a review toolbar beside the 🔬 scoreboard, visible ONLY while edits await review
 *  (parity with the VS Code status-bar nav bar). The step-through controls themselves live in the shared
 *  [ReviewNavBar] (also hosted in the Overview title bar); this widget only adds the status-bar plumbing —
 *  a CustomStatusBarWidget hosting the ReviewNavBar's ActionToolbar, hidden whenever nothing is pending. */
class ObservatoryActionsWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = CLUSTER_ID
    override fun getDisplayName() = "OAK: Review Actions"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = ObservatoryActionsWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

private class ObservatoryActionsWidget(private val project: Project) : CustomStatusBarWidget {

    private val service get() = ObservatoryService.getInstance(project)
    private val listener = Runnable { refreshUi() }
    private var busConn: MessageBusConnection? = null

    // The status bar has no selection concept, so it always means the session under review.
    private val navBar = ReviewNavBar(project, { refreshUi() })

    private val toolbar = ActionManager.getInstance()
        // sessionClear: the status bar carries the session-wide Clear Resolved (VS Code status-bar parity).
        // showText: every action button carries its short label (user rule 2026-07-16 — the icon-only
        // status bar read as cryptic; VS Code's status-bar buttons carry the same labels).
        .createActionToolbar("ClaudeObservatoryNavBar", navBar.buildGroup(sessionClear = true, showText = true), true)
        .apply {
            isReservePlaceAutoPopupIcon = false
            targetComponent = component
            component.isOpaque = false
        }

    override fun ID() = CLUSTER_ID
    override fun getComponent(): JComponent = toolbar.component
    override fun getPresentation(): StatusBarWidget.WidgetPresentation? = null // custom-component widget

    override fun install(statusBar: StatusBar) {
        service.addListener(listener)
        // The Diff/File counters depend on the active editor, so refresh on tab switches too.
        busConn = project.messageBus.connect().also {
            it.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) = refreshUi()
            })
        }
        refreshUi() // correct from activation, not just after the first store event
    }

    override fun dispose() {
        service.removeListener(listener)
        busConn?.disconnect()
        busConn = null
    }

    /** Show the whole bar only while edits await review, and recompute every button's state; on the EDT. */
    @Suppress("DEPRECATION") // updateActionsImmediately: still the way to force a status-bar toolbar refresh
    private fun refreshUi() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            toolbar.component.isVisible = service.counts().pending > 0
            toolbar.updateActionsImmediately()
        }
    }
}
