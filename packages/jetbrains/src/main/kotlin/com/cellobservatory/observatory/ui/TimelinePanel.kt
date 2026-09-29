package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.NavGrouping
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTabbedPane
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Font
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * The Observatory Timeline window's content: the session selector, then the four members
 * — as four tabs (Feed · Prompts · Observations · Actions), or as four columns side by side.
 *
 * ONE tool-window content rather than three, and that is the point of the class.
 *
 * The session selector used to be a `setTitleActions` chip on the platform's own tool-window header.
 * Nothing there is ours: the header is a BorderLayout whose EAST holds one no-wrap toolbar carrying the
 * title actions FIRST and the gear/hide buttons last, with no overflow popup — so when that toolbar wants
 * more width than the header has, the platform lays it out at a negative x and the leftmost buttons (ours)
 * are the ones clipped away, silently. It also left the guided tour's `session-picker` anchor with nothing
 * to ring, because no component inside any panel was the selector. Both problems are the same problem: the
 * control did not live in the content. Now it does — a slim row of our own, always visible, above whatever
 * the tabs are showing, and it is the component the tour points at.
 *
 * The grouped layout is the Overview's, from the same [ColumnGroupPane]: draggable dividers, remembered
 * widths, and columns that fold to a rail. Its toggle sits beside the tab strip rather than on a toolbar
 * of its own, because it is about the tabs.
 */
class TimelinePanel(private val project: Project) : JPanel(BorderLayout()) {

    /** Live panels by project, so the tour and the nav bar can reach this window's tabs. */
    companion object Registry {
        private val live = java.util.concurrent.ConcurrentHashMap<Project, TimelinePanel>()
        fun of(project: Project): TimelinePanel? = live[project]
        internal fun remember(project: Project, panel: TimelinePanel) {
            live[project] = panel
            com.intellij.openapi.util.Disposer.register(project) { live.remove(project, panel) }
        }
    }

    private val cfg get() = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state

    /**
     * The four surfaces, each behind a [LazyPane].
     *
     * They are built when this window is first REALIZED rather than when the panel is constructed —
     * which is where the platform used to build them anyway (`createToolWindowContent` runs on the first
     * show), so nothing about the product's timing changes. What it buys is a panel that can be
     * constructed without three panels' worth of store reads and CLI spawns starting behind it, which is
     * what a headless test does and what made this window untestable before.
     */
    private val panes: Map<String, JComponent> = linkedMapOf(
        NavGrouping.FEED to LazyPane { FeedPanel(project) },
        NavGrouping.PROMPTS to LazyPane { PromptsPanel(project) },
        NavGrouping.OBSERVATIONS to LazyPane { ObservationsPanel(project) },
        NavGrouping.ACTIONS to LazyPane { ActionsPanel(project) },
    )

    private val icons = mapOf(
        NavGrouping.PROMPTS to AllIcons.Actions.ListFiles,
        NavGrouping.OBSERVATIONS to AllIcons.Actions.IntentionBulb,
        NavGrouping.ACTIONS to AllIcons.Debugger.Console,
        NavGrouping.FEED to AllIcons.Actions.Execute,
    )

    private val tips = mapOf(
        NavGrouping.PROMPTS to "What you asked for, in order — selecting one scopes the Overview",
        NavGrouping.OBSERVATIONS to "What the agent noticed and reported while it worked",
        NavGrouping.ACTIONS to "Every tool call, newest first",
        NavGrouping.FEED to "The conversation as it happened — prompts, replies, thinking, tool calls and diffs — or the activity of what the Overview selects",
    )

    private val tabs = JBTabbedPane()

    private val columns = ColumnGroupPane(
        group = NavGrouping.TIMELINE,
        members = NavGrouping.TIMELINE_MEMBERS,
        title = { NavGrouping.TIMELINE_TITLES[it] ?: it },
        tip = { tips[it] },
        // The Feed leads and takes the biggest share: it carries the whole conversation. Prompts
        // takes most of the remainder (its rows carry the whole ask); Observations · Actions split
        // what is left.
        defaultProportion = { i -> when (i) { 0 -> 0.4f; 1 -> 0.45f; else -> 0.5f } },
    )

    /** Where the tabs or the columns are mounted — swapped by [rebuild]. */
    private val host = JPanel(BorderLayout())

    /** The session selector, in a toolbar of its own so the tour can ring exactly that chip. */
    private val sessionToolbar = ActionManager.getInstance()
        .createActionToolbar(
            "ClaudeObservatoryTimelineSession",
            DefaultActionGroup(TimelineSessionAction(project), TimelineNewSessionAction(project)),
            true,
        ).apply {
            targetComponent = this@TimelinePanel
            component.isOpaque = false
        }

    private val sessionRow = JPanel(BorderLayout()).apply {
        isOpaque = false
        border = JBUI.Borders.empty(1, 2, 0, 2)
        add(sessionToolbar.component, BorderLayout.WEST)
        add(
            JBLabel("Every tab below reads this session.").apply {
                font = JBUI.Fonts.label().deriveFont(Font.PLAIN, JBUI.Fonts.label().size2D - 1f)
                foreground = UIUtil.getContextHelpForeground()
                border = JBUI.Borders.empty(0, 6)
            },
            BorderLayout.CENTER,
        )
    }

    private var grouped: Boolean
        get() = cfg.timelineGroupedNav
        set(value) { cfg.timelineGroupedNav = value }

    init {
        Registry.remember(project, this)
        val groupToolbar = ActionManager.getInstance()
            .createActionToolbar("ClaudeObservatoryTimelineTabs", DefaultActionGroup(groupToggle()), true)
            .apply {
                targetComponent = this@TimelinePanel
                component.isOpaque = false
            }
        add(sessionRow, BorderLayout.NORTH)
        add(
            JPanel(BorderLayout()).apply {
                add(host, BorderLayout.CENTER)
                // Beside the tab titles, not above them and not on a toolbar of its own: pinned to the TOP
                // of the trailing edge, which is the tab strip's own row (user rule 2026-07-30).
                add(
                    JPanel(BorderLayout()).apply {
                        isOpaque = false
                        add(groupToolbar.component, BorderLayout.NORTH)
                    },
                    BorderLayout.EAST,
                )
            },
            BorderLayout.CENTER,
        )
        rebuild()
    }

    /** Build the tabs, or the columns — whichever mode is in force. */
    private fun rebuild() {
        host.removeAll()
        if (grouped) {
            tabs.removeAll() // give the panes back before the column pane adopts them
            for (m in NavGrouping.TIMELINE_MEMBERS) panes[m]?.let { columns.mount(m, it) }
            host.add(columns, BorderLayout.CENTER)
        } else {
            columns.detach() // …and back again, or the tab strip would adopt components it still holds
            tabs.removeAll()
            for (m in NavGrouping.TIMELINE_MEMBERS) {
                val pane = panes[m] ?: continue
                tabs.addTab(NavGrouping.TIMELINE_TITLES[m] ?: m, icons[m], pane, tips[m])
            }
            host.add(tabs, BorderLayout.CENTER)
        }
        host.revalidate()
        host.repaint()
    }

    /**
     * Bring one member forward by its core name — what the guided tour calls to raise Prompts, Actions or
     * Observations now that they are in-content tabs rather than tool-window contents.
     *
     * True when the member is on screen afterwards. In GROUPED mode there is no tab to select — every
     * member is a column already — but one folded to a rail is unfolded first: bringing a surface forward
     * has to actually show it.
     */
    fun selectMember(member: String): Boolean {
        val pane = panes[member] ?: return false
        if (grouped) {
            columns.ensureShown(member)
            return true
        }
        val i = tabs.indexOfComponent(pane)
        if (i < 0) return false
        tabs.selectedIndex = i
        return true
    }

    /** The component a tour step's `session-picker` anchor names — the selector itself, not the row it
     *  sits in, so the ring lands on the control the step is about. */
    fun sessionAnchor(): JComponent = sessionToolbar.component

    /**
     * A tab's content, built the first time this component becomes displayable.
     *
     * `addNotify` is the platform's own "you are on screen now" signal, and it fires for every tab of a
     * realized JTabbedPane — so this defers construction to the window opening, not to a tab being
     * clicked. That is exactly the point where the tool-window factory used to build them.
     */
    private class LazyPane(private val make: () -> JComponent) : JPanel(BorderLayout()) {
        private var built = false
        override fun addNotify() {
            super.addNotify()
            if (built) return
            built = true
            add(make(), BorderLayout.CENTER)
            revalidate()
        }
    }

    private fun groupToggle(): ToggleAction = object : ToggleAction(
        "Group Tabs",
        "Show Feed, Prompts, Observations and Actions side by side instead of as tabs",
        AllIcons.Actions.SplitVertically,
    ), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT // reads one flag
        override fun isSelected(e: AnActionEvent) = grouped
        override fun setSelected(e: AnActionEvent, state: Boolean) {
            if (grouped == state) return
            grouped = state
            rebuild()
        }
    }
}
