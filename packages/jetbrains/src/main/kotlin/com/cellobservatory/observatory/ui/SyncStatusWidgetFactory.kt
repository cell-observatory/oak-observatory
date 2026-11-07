package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.SyncView
import com.cellobservatory.observatory.model.syncItemText
import com.cellobservatory.observatory.model.syncTooltipLines
import com.intellij.icons.AllIcons
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.ui.AnimatedIcon
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JLabel

private const val SYNC_WIDGET_ID = "claudeObservatorySync"

/** oak sync on the IDE status bar: the last run, or the one going on now, and what needs the reader (a conflict, a
 *  failure); hidden while sync is not in use here, so a machine that never chose to sync is shown nothing. Its tooltip
 *  is the last run a machine a line, in the CLI's words; a click opens sync's menu (SyncOps.menu). VS Code parity: its
 *  status bar item. */
class SyncStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = SYNC_WIDGET_ID
    override fun getDisplayName() = "OAK Sync"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = SyncWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

internal class SyncWidget(private val project: Project) : CustomStatusBarWidget {
    private var statusBar: StatusBar? = null

    internal val label = JLabel().apply {
        font = JBUI.Fonts.smallFont()
        border = JBUI.Borders.empty(0, 4)
        isVisible = false
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
    }

    init {
        label.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) = SyncOps.showMenu(project, label)
        })
    }

    override fun ID() = SYNC_WIDGET_ID
    override fun getComponent() = label
    override fun getPresentation(): StatusBarWidget.WidgetPresentation? = null

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        SyncOps.addListener(this) { show(SyncOps.view) }
        show(SyncOps.view)
        SyncOps.refresh()
    }

    override fun dispose() {
        statusBar = null
    }

    internal fun show(v: SyncView?) {
        if (project.isDisposed) return
        val on = v?.inUse == true
        label.isVisible = on
        if (v != null && on) {
            label.text = syncItemText(v)
            label.icon = if (v.running) AnimatedIcon.Default() else AllIcons.Actions.Refresh
            label.foreground = if (!v.running && (v.conflicts.isNotEmpty() || v.failed)) MT_ATTENTION else UIUtil.getLabelForeground()
            // Every line whole: the tooltip wraps at its width rather than cutting a machine's reason short.
            label.toolTipText = "<html><body style='width: 480px'>" + syncTooltipLines(v).joinToString("<br>") { escHtml(it) } + "</body></html>"
        }
        statusBar?.updateWidget(SYNC_WIDGET_ID)
    }
}
