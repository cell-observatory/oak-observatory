package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.compactBytes
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.model.BackgroundProcess
import com.cellobservatory.observatory.model.Feed
import com.cellobservatory.observatory.model.FeedEntry
import com.cellobservatory.observatory.model.ProcessSummary
import com.cellobservatory.observatory.model.TaskRoll
import com.cellobservatory.observatory.model.ProcessesResult
import com.cellobservatory.observatory.model.ChangeMap
import com.cellobservatory.observatory.model.ChangeMapAgent
import com.cellobservatory.observatory.model.ChangeMapFile
import com.cellobservatory.observatory.model.ChangeMapModule
import com.cellobservatory.observatory.model.ChangeMapSummary
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.ChangeMapWorkflow
import com.cellobservatory.observatory.model.Collision
import com.cellobservatory.observatory.model.MtSubagent
import com.cellobservatory.observatory.model.MultitaskResult
import com.cellobservatory.observatory.model.ChangeMapPrompt
import com.cellobservatory.observatory.model.PromptsResult
import com.cellobservatory.observatory.model.SessionPrompt
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionTask
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.model.MultitaskFilter
import com.cellobservatory.observatory.model.RunningAgent
import com.cellobservatory.observatory.model.WorkflowAgent
import com.cellobservatory.observatory.model.WorkflowRun
import com.cellobservatory.observatory.model.folderLabelOf
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatoryConfigurable
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Presentation
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.actionSystem.ex.CustomComponentAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.notification.NotificationType
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.OnePixelSplitter
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBList
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.util.ui.tree.TreeUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Container
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.LayoutManager2
import java.awt.Rectangle
import java.awt.RenderingHints
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JSeparator
import javax.swing.JTree
import javax.swing.ListCellRenderer
import javax.swing.Scrollable
import javax.swing.ScrollPaneConstants
import javax.swing.SwingConstants
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeCellRenderer
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel

// The product's review palette — same hexes the VS Code webview reads from --vscode-charts-*, so the
// two editors colour a status identically. (StatsPanel keeps its own file-private copies.)
internal val CM_PENDING = JBColor(Color(0xD9A441), Color(0xD9A441))
internal val CM_KEPT = JBColor(Color(0x3FB950), Color(0x3FB950))
private val CM_REVERTED = JBColor.GRAY

    /**
     * Where each right-hand column of a ledger row ends, for one row width.
     *
     * ONE function, read by the painter and by the mouse. A `ListCellRenderer` paints into a
     * component that is never added to the hierarchy, so its glyphs have no listeners and a click
     * can only be resolved by arithmetic — which means the two halves have to be the same
     * arithmetic. Recomputing it at the click site is how ✓ ends up drawn over one file and
     * reverting another, and this pair rewrites files on disk.
     */
    private data class LedgerCols(
        val nameEnd: Int, val addEnd: Int, val delEnd: Int,
        val pendEnd: Int, val keptEnd: Int, val stackX: Int, val keepX: Int, val undoX: Int,
    )

    private fun ledgerColumns(width: Int): LedgerCols {
        val pad = JBUI.scale(4)
        val actW = JBUI.scale(14)
        val undoX = width - actW
        val keepX = undoX - actW
        val stackX = keepX - actW
        val keptEnd = stackX - pad
        val pendEnd = keptEnd - JBUI.scale(26)
        val delEnd = pendEnd - JBUI.scale(30)
        val addEnd = delEnd - JBUI.scale(38)
        // No churn bar any more — the name runs to this boundary instead of a
        // proportional track (the terminal map's call: ranking already answers "which is biggest").
        val nameEnd = addEnd - JBUI.scale(40)
        return LedgerCols(nameEnd, addEnd, delEnd, pendEnd, keptEnd, stackX, keepX, undoX)
    }

    /** Which action a click at `x` landed on within a row of `width`, or null for neither. */
    private fun ledgerActionAt(width: Int, x: Int): String? {
        val c = ledgerColumns(width)
        val actW = JBUI.scale(14)
        return when {
            x >= c.stackX && x < c.stackX + actW -> "stack"
            x >= c.keepX && x < c.keepX + actW -> "keep"
            x >= c.undoX && x < c.undoX + actW -> "undo"
            else -> null
        }
    }

// The multitask palette — the same hexes the VS Code webview reads from --vscode-charts-* (extension.ts
// --mt-*): working/running BLUE, done GREEN, awaiting ORANGE, error RED, subagents PURPLE.
internal val MT_ATTENTION = JBColor(Color(0xD9822B), Color(0xD9822B))
internal val MT_WORKING = JBColor(Color(0x4C8BF5), Color(0x4C8BF5))
internal val MT_DONE = JBColor(Color(0x3FB950), Color(0x3FB950))
internal val MT_ERROR = JBColor(Color(0xE5534B), Color(0xE5534B))
internal val MT_AGENT = JBColor(Color(0x9A6AC2), Color(0x9A6AC2)) // internal: FeedPanel's reasoning rows use it too
internal val MT_ADD = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_DONE)
internal val MT_REM = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ERROR)
/** The module strip shows at most this many segments; the churn-ranked tail merges into "+K more". */
private const val MAX_SEGMENTS = 11

// The SESSION-SCOPED left-nav panes. Their text is re-worded live (refreshScopeNotes) when a fleet row
// from another session drives the detail, because none of them follows that selection.
private const val TASKS_DESC =
    "This session’s numbered task list (the agent’s TaskCreate/TaskUpdate plan) — with live statuses; each row shows the edits made while it was in progress."
private const val PROCESSES_DESC =
    "Background shells the agent launched with run_in_background and left running — state, runtime, and how much output each has produced."
private const val PROCESSES_TIP =
    "The session's background shells — always THIS project's active session, never a selected sibling agent's. Identity is the harness's own shell id: the transcript records no OS pid, and inferring one from local processes would be wrong whenever the agent runs over SSH or in a container. Select one to follow its output."
/** …and what that tooltip becomes while a SIBLING agent is selected: no count, and why. */
private const val PROCESSES_UNSCOPED_TIP =
    "Background shells are read for the session under review, never for a selected sibling agent, so no count is shown while one is selected. Open that session from the Sessions tab to see its shells."
private const val SESSIONS_DESC =
    "Sessions on this machine, grouped by workspace. This workspace is first; select a session to review its conversation and edits."
private const val SESSIONS_TIP =
    "Sessions on this machine, grouped by workspace and ordered by conversation recency. Selecting a row PINS the review to that session (the same choice Switch Session makes) — unlike the other tabs, which only re-point the map and the Timeline's Feed tab."
/** Why a pinned session can be missing from the listing, which spans every workspace on this machine. */
internal const val UNLISTED_PIN = "not in this machine’s session list (deleted, empty, or a copy mirrored from another machine)"
private const val FLEET_TIP =
    "Running agents across every worktree — siblings + their subagents — with the live file-conflict strip below. Select one to map its changes."
private const val WORKFLOWS_TIP =
    "Claude Code Workflow runs — agents grouped by phase, with tokens/time/edits per run. Select one to map its changes."
private const val TASKS_TIP =
    "The session's task list (the agent's numbered TaskCreate/TaskUpdate tasks) — live statuses; completed tasks leave the list when the runtime archives them. Always THIS project's active session, never a selected sibling agent's."

// The left nav has NO tab-index constants, deliberately. Prompts is not among its members since 0.8.7 —
// it is the WINDOW to the left, so the list of asks and the view one of them scopes stay visible together.
// Two things then move every index: Processes is mounted only once the CLI answers for it, and grouped
// mode (0.10) renders two tabs instead of five. Every title, tooltip and selection therefore addresses a
// MEMBER NAME through setTabBadge / setTabTip / showNavMember, which resolve to a tab index or a column
// header for the mode in force. A single `setTitleAt(3, …)` left behind would relabel the group tab.
private const val MEMBER_SESSIONS = com.cellobservatory.observatory.model.NavGrouping.SESSIONS
private const val MEMBER_FLEET = com.cellobservatory.observatory.model.NavGrouping.FLEET
private const val MEMBER_WORKFLOWS = com.cellobservatory.observatory.model.NavGrouping.WORKFLOWS
private const val MEMBER_TASKS = com.cellobservatory.observatory.model.NavGrouping.TASKS
private const val MEMBER_PROCESSES = com.cellobservatory.observatory.model.NavGrouping.PROCESSES

/** A member's bare name — the tab title (ungrouped) or column header (grouped) before any badge. */
private val MEMBER_TITLES = mapOf(
    MEMBER_SESSIONS to "Sessions", MEMBER_FLEET to "Workers", MEMBER_WORKFLOWS to "Workflows",
    MEMBER_TASKS to "Tasks", MEMBER_PROCESSES to "Processes",
)

private val MEMBER_TIPS = mapOf(
    MEMBER_SESSIONS to SESSIONS_TIP, MEMBER_FLEET to FLEET_TIP, MEMBER_WORKFLOWS to WORKFLOWS_TIP,
    MEMBER_TASKS to TASKS_TIP, MEMBER_PROCESSES to PROCESSES_TIP,
)
/**
 * The SHIPPED width of each grouped divider, by group, left to right — what a reader gets before they
 * drag anything and what a double-click on that divider goes back to. Sessions · Fleet split evenly;
 * Workflows keeps about a third and Tasks · Processes share the rest, because a workflow row is one line
 * and a task list is many.
 */
private val GROUP_SPLIT_DEFAULTS = mapOf(
    // Five columns, roughly even: each divider is the LEFT pane’s share of what remains.
    com.cellobservatory.observatory.model.NavGrouping.NAV_ALL to listOf(0.2f, 0.25f, 0.34f, 0.5f),
)

/** Below this width the Overview stacks its master and detail instead of splitting them side by side. */
private const val NARROW_PANEL_PX = 620

/** Sentinel module ids for the strip's two tail chips — never real modules, never ledger filters:
 *  one opens the folded folders, the other folds them back. */
private const val OVERFLOW_MODULE = "+more"
private const val COLLAPSE_MODULE = "-less"

/** A strip segment narrower than this cannot hold a readable folder label, so the strip wraps instead. */
private const val MIN_SEGMENT_PX = 88

/** status → colour. "undone" surfaces as "reverted" grey, matching the VS Code renderer. */
private fun statusColor(status: String): JBColor = when (status) {
    "pending" -> CM_PENDING
    "undone" -> CM_REVERTED
    else -> CM_KEPT
}

/**
 * Overview (0.8.0 r3): a MASTER–DETAIL panel that folds the former standalone Multitasking window in.
 *
 * LEFT NAV — Fleet · Workflows · Tasks · Processes · Sessions (Processes appears once the CLI answers
 * for it). What the USER asked for lives one window over, in Prompts, whose selection scopes this panel.
 *   · Sessions  = every workspace's recorded sessions, newest conversation first — the one tab whose
 *                 selection PINS what the whole observatory reviews rather than re-pointing this panel.
 *   · Fleet     = running agents across every worktree-sibling (+ nested subagents), each with its live
 *                 phase, sparkline, ±lines, tokens, time, and risk; a live file-conflict strip below.
 *   · Workflows = the Claude Code Workflow runs — informative name, per-phase progress, ±lines/tokens/time.
 *   An Active-only toggle + Clear-completed (a dismiss, never a delete) filter these, display-only.
 *
 * RIGHT DETAIL — the change-map (folder strip · churn-ranked file ledger · scope summary) for the
 * SELECTED nav item, from `changemap --json`'s `agents[]` / `workflows[]`, joined by session / workflowId.
 * The default is the main/orchestrator session (the top-level map).
 *
 * Both payloads are aggregated in core (the single backend) — this panel only paints. Realtime rides on
 * the transcript watcher / store watcher via ObservatoryService.refresh. Parity with the VS Code Overview.
 */
/** Tag for the sessions-row "resolve" fragment — file-scoped so the (non-inner) renderer class and the
 *  panel's click handler share one identity to hit-test against. */
private val SESSIONS_RESOLVE_TAG = Any()

/** Tag for the sessions-row STORE-SIZE fragment (the size was missing from this
 *  panel, and clicking it opens the folder — the same gesture the terminal and VS Code carry). */
private val SESSIONS_STORE_TAG = Any()

/** Tag for the sessions-row "conversation" fragment (0.10.0): reopen this conversation in the Timeline's
 *  Feed tab — local rows only, since an agent must run where the worktree is. */
private val SESSIONS_CONVERSATION_TAG = Any()

/** Tag for the sessions-row "delete" fragment: remove this conversation from every Observatory
 *  picker and purge its captured edits for good (`oak sessions --delete <id>`). Local rows only, beside
 *  the continue fragment; the agent's own transcript is untouched, and `--undelete` lists it again,
 *  without its edits. */
private val SESSIONS_DELETE_TAG = Any()

/** Client-property key carrying a fragment's click tag on its label, so the WRAPPING session renderer
 *  (which flows badges onto new lines when the pane is narrow) can be hit-tested in 2-D — the single
 *  line ColoredListCellRenderer's x-only `getFragmentTagAt` cannot survive a wrap. */
private const val SESSIONS_FRAGMENT_TAG = "oak.sessions.fragmentTag"

class ChangeMapPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    /** Live panels by project, so the guided tour can bring a named tab forward and point at it. A
     *  registry rather than a service lookup because the panel is created by the tool-window factory
     *  and has no other identity; entries are dropped in [dispose] so a closed project leaks nothing. */
    companion object Registry {
        /** The nav-tab names the guided tour may address, in shipped order — the exact set
         *  [selectNavTab] maps. Held here so a tab core's tour learns to name and this panel cannot bring
         *  forward is a test failure rather than a step that silently does nothing. */
        val TOUR_TABS = listOf("sessions", "fleet", "workflows", "tasks", "processes")

        private val live = java.util.concurrent.ConcurrentHashMap<Project, ChangeMapPanel>()
        fun of(project: Project): ChangeMapPanel? = live[project]

        /** Re-apply the nav grouping in every live panel. The Settings page can flip it from outside any one
         *  window, and the tab STRUCTURE is not something a data refresh rebuilds — without this the change
         *  would only appear on the next IDE start. Mirrors ObservatoryDashboardsFactory.applyPanes. */
        fun applyNavGrouping() {
            ApplicationManager.getApplication().invokeLater {
                live.values.toList().forEach { if (!it.project.isDisposed) it.rebuildNavTabs() }
            }
        }
        internal fun remember(project: Project, panel: ChangeMapPanel) {
            live[project] = panel
            // Tied to the project, so a closed project drops its entry without the panel needing a
            // dispose hook of its own. remove(k,v) so a re-created panel's entry is never clobbered.
            com.intellij.openapi.util.Disposer.register(project) { live.remove(project, panel) }
        }
    }

    /**
     * Bring one of the left-nav tabs forward by its core name, and return the tab strip so a caller can
     * anchor a tooltip on it. Null when that tab is not present (Processes is appended only once the CLI
     * has answered for it) — the tour then does not switch, rather than guessing an index.
     *
     * Addressed by COMPONENT, not by title and not by the index constants. Three of the five titles are
     * rewritten with live counts as soon as data arrives ("Sessions 2", "Tasks 3/5", "Processes 1/3"),
     * which a demo guarantees, so a title match would silently miss exactly the tabs the tour talks
     * about; and Processes is inserted at runtime, so a constant index is right only until it appears.
     */
    fun selectNavTab(tab: String): javax.swing.JComponent? {
        if (!::navTabs.isInitialized) return null
        if (memberPane(tab) == null) return null
        // Remember where the reader was before the tour's first step moved them (setShowAll puts it back).
        // By MEMBER NAME, never by index: grouped mode has two tabs instead of five, so an index remembered
        // in one mode names different content in the other.
        val here = selectedNavMember()
        if (tourFilter != null && tourNavTab == null && here != null && here != tab) tourNavTab = here
        if (!showNavMember(tab)) return null
        return navTabs
    }

    /** Each nav member's pane — the ONE place the five member names bind to components. */
    private fun memberPane(member: String): JComponent? = when (member) {
        MEMBER_SESSIONS -> sessionsPane
        MEMBER_FLEET -> fleetPane
        MEMBER_WORKFLOWS -> workflowsPane
        MEMBER_TASKS -> tasksPane
        MEMBER_PROCESSES -> processesPane
        else -> null
    }

    /** The component that IS a tab for [member]: its own pane when ungrouped, its group's pane when grouped. */
    private fun navHostFor(member: String): JComponent? =
        if (!groupedNav) memberPane(member)
        else groupPanes[com.cellobservatory.observatory.model.NavGrouping.groupOf(member, true)]

    /** Bring the tab hosting [member] forward. False when that member is not mounted (Processes before the
     *  CLI has answered), and the caller then leaves the nav where it is rather than guessing. */
    private fun showNavMember(member: String): Boolean {
        if (!::navTabs.isInitialized) return false
        val host = navHostFor(member) ?: return false
        val i = navTabs.indexOfComponent(host)
        if (i < 0) return false
        navTabs.selectedIndex = i
        // Grouped, the tab is only half the answer: a member folded to a rail inside it is not "forward".
        if (groupedNav) groupPaneOf(member)?.ensureShown(member)
        return true
    }

    /** Which member the nav is showing: the selected tab's member ungrouped, the selected group's FIRST
     *  member grouped. Named, not indexed, so a mode flip restores the same content. */
    private fun selectedNavMember(): String? {
        if (!::navTabs.isInitialized) return null
        val i = navTabs.selectedIndex
        if (i < 0 || i >= navTabs.tabCount) return null
        val c = navTabs.getComponentAt(i)
        if (!groupedNav) return TOUR_TABS.firstOrNull { memberPane(it) === c }
        val group = groupPanes.entries.firstOrNull { it.value === c }?.key ?: return null
        return com.cellobservatory.observatory.model.NavGrouping.GROUPS[group]?.firstOrNull()
    }

    /**
     * Write a member's tab title (its name plus whatever badge the payload earns it) wherever that title
     * currently lives: the tab strip when ungrouped, its column header when grouped.
     *
     * EVERY title write in this file goes through here. Grouped mode has two tabs, so one leftover
     * `setTitleAt(TASKS_TAB, "Tasks 3/5")` would silently rename "Workflows · Tasks · Processes" on
     * whichever repaint happened to run next.
     */
    private fun setTabBadge(member: String, text: String) {
        if (!::navTabs.isInitialized) return
        if (groupedNav) {
            groupPaneOf(member)?.let {
                it.header(member).text = text
                it.syncRailText(member) // a folded column's rail carries the same badge, or it goes stale
            }
            return
        }
        val i = navTabs.indexOfComponent(memberPane(member) ?: return)
        if (i >= 0) navTabs.setTitleAt(i, text)
    }

    /** The tooltip twin of [setTabBadge]. */
    private fun setTabTip(member: String, tip: String) {
        if (!::navTabs.isInitialized) return
        if (groupedNav) {
            groupPaneOf(member)?.header(member)?.toolTipText = tip
            return
        }
        val i = navTabs.indexOfComponent(memberPane(member) ?: return)
        if (i >= 0) navTabs.setToolTipTextAt(i, tip)
    }

    /** The grouped pane that owns [member]'s column, or null while ungrouped. */
    private fun groupPaneOf(member: String): ColumnGroupPane? =
        groupPanes[com.cellobservatory.observatory.model.NavGrouping.groupOf(member, true)]

    /**
     * The component a tour step's `anchor` names, so its tip can point at the control it is about rather
     * than at the panel in general. Unknown or currently-absent anchors return null and the caller falls
     * back to the panel — a tip that lands somewhere plausible beats one that does not appear.
     */
    fun tourAnchor(anchor: String?): javax.swing.JComponent? = when (anchor) {
        "nav-tabs" -> if (::navTabs.isInitialized) navTabs else null
        // The Overview's own toolbar carries the four review axes and the session/bulk controls. These
        // four anchors each name ONE button on it, and this rings the whole row — coarser than VS Code,
        // which outlines the button itself. Stated in docs/DEMO.md rather than left to be discovered.
        "nav-axes", "accept-prompt", "session-label", "spotlight" -> toolbar
        // ("feed" left in 0.10.0 — the Timeline's Feed tab owns that anchor now.)
        // The detail pane is rebuilt per selection, so these resolve against whichever one is mounted now.
        "folders-strip", "files-ledger", "summary-bar" ->
            (detailHost.components.firstOrNull() as? AgentDetail)?.tourAnchor(anchor)
        else -> null
    }

    /** What the right detail is showing. Preserved across refreshes; falls back to [Main] if it vanishes. */
    private sealed class NavSel {
        object Main : NavSel()
        data class Agent(val session: String) : NavSel()
        /** A subagent inside [session]: the change map stays its parent agent's slice (that is where core
         *  attributes a subagent's edits), while the feed follows the subagent's own journal. */
        data class Subagent(val session: String, val agentId: String) : NavSel()
        data class Workflow(val id: String) : NavSel()
        /** A row of the session's task list — no change-map slice of its own, but a feed of the work done
         *  inside its in-progress window. [id] is the STRICT 12-hex taskId core resolves `--kind task`
         *  against (see [taskFeedId]), never the task list's display number. */
        data class Task(val id: String) : NavSel()
        /** A background shell — no change map at all (it edits nothing); its feed IS its detail. */
        data class Process(val id: String) : NavSel()
    }

    @Volatile private var map: ChangeMap? = null
    private var selected: NavSel = NavSel.Main

    /** Whether the reader has opened the folded "older sessions" group. Not persisted: opening it is a
     *  look-at-this-now intent, and restoring it across sessions re-enters the state the fold avoids. */
    private var foldOpen = false

    /** The Overview title-bar toolbars (one ActionToolbar per group), kept so a nav step or a change of
     *  prompt scope can refresh their scoped labels + counters. */
    private var overviewToolbars: List<ActionToolbar> = emptyList()
    /** The shared step-through review nav bar (parity with the status-bar widget), hosted in this toolbar. */
    // The bar always acts on the REVIEWED session (its verbs pair per-session edit ids with the ids it
    // read from that session's log); the panel's own toolbar carries the fleet-row scoping instead.
    private val reviewNavBar = ReviewNavBar(project, { onNavChanged() })
    /** The live detail panel — kept so a nav step can refresh its bottom summary without a full rebuild. */
    private var currentDetail: AgentDetail? = null
    /** Is the Folders strip showing every folder? Panel-level, because [renderDetail] rebuilds the detail
     *  (and its strip) on every refresh — state held by the strip itself would fold back within one
     *  refresh cycle. Keyed by scope, so another agent, workflow, or prompt starts folded again. */
    private var stripExpanded = false
    private var stripScope: String? = null

    /** A Diff/File/Folder/Prompt nav step landed — refresh the scoped toolbar labels + counters AND the
     *  change-map bottom summary (which names the current prompt / folder scope). */
    private fun onNavChanged() {
        refreshOverviewToolbar()
        currentDetail?.refreshSummary()
    }

    // --- LEFT NAV: Fleet (agents + subagents) + Workflows (runs), over multitask --json ---
    private val fleetRoot = DefaultMutableTreeNode()
    private val fleetModel = DefaultTreeModel(fleetRoot)
    private val fleetTree = Tree(fleetModel).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No agents yet — this fills in as Claude Code sessions run in this repo's worktrees"
        cellRenderer = SparklineTreeRenderer(FleetRenderer())
    }
    private val workflowsRoot = DefaultMutableTreeNode()
    private val workflowsModel = DefaultTreeModel(workflowsRoot)
    private val workflowsTree = Tree(workflowsModel).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No workflow runs — Claude Code Workflow orchestrations appear here"
        cellRenderer = SparklineTreeRenderer(WorkflowRenderer())
    }
    // --- LEFT NAV, third tab: the session's numbered task list (TaskCreate/TaskUpdate) ---
    /** One Tasks-tab row: the task + its STRICT per-task rollup (±/edit counts), when core has one for it. */
    private data class TaskRow(val task: SessionTask, val roll: TaskRoll?)
    /** The "N done · show all" collapse row — completed tasks fold behind it (fleet dismiss pattern). */
    private data class DoneTasksToggle(val count: Int, val open: Boolean)
    /** The "N older with pending edits · show all" collapse row in the Sessions tab (0.9.0). */
    private data class OlderSessionsToggle(val count: Int, val open: Boolean)
    /** The "needs you" header over the raised hands (2026-09-15) — inert on click, like FilterInfo. */
    private var oldSessionsOpen = false
    @Volatile private var lastSessions: SessionsResult? = null // BGT-read by sessionLabelAction.update()
    private var tasksOpen = false
    private var lastTasks: List<SessionTask> = emptyList()
    /** The reader's own Active-only value, parked while the guided tour runs. null = no tour is holding it. */
    private var tourFilter: Boolean? = null
    /** The nav MEMBER the reader was on before the tour moved them. null = no tour is holding it. A name
     *  rather than an index, so the grouping toggle changing the tab count cannot strand the restore. */
    private var tourNavTab: String? = null
    private val tasksModel = javax.swing.DefaultListModel<Any>()
    private val tasksList = JBList(tasksModel).apply {
        emptyText.text = "No tasks — this session plans with a task list only when the agent creates one"
        cellRenderer = TaskRowRenderer()
    }
    // --- LEFT NAV, fourth tab: the background shells this session launched and left running. The tab is
    //     added only once the CLI has ANSWERED `processes --json` (see repaintProcesses) ---
    private val processesModel = DefaultListModel<BackgroundProcess>()
    private val processesList = JBList(processesModel).apply {
        cellRenderer = ProcessRowRenderer()
    }
    // --- LEFT NAV, last tab: every session in this workspace (0.8.8). The only tab whose selection is a
    //     CHOICE OF SUBJECT — clicking a row pins what the whole observatory reviews ---
    /** The leading row of the Sessions tab: stop following one session and take whichever is newest.
     *  Without it, pinning would be a one-way door once the Switch Session dropdown was removed. */
    private object AutoSessionRow
    private data class WorkspaceHeaderRow(val workspace: String, val count: Int)

    private val sessionsModel = DefaultListModel<Any>()
    private val sessionsList = JBList(sessionsModel).apply {
        emptyText.text = "Reading this workspace’s sessions…"
        selectionModel = object : javax.swing.DefaultListSelectionModel() {
            init { selectionMode = javax.swing.ListSelectionModel.SINGLE_SELECTION }
            private fun selectable(index: Int): Boolean = index in 0 until sessionsModel.size() &&
                sessionsModel.getElementAt(index).let { it !is WorkspaceHeaderRow }
            override fun setSelectionInterval(index0: Int, index1: Int) {
                if (index1 < 0) { clearSelection(); return }
                val step = if (index1 < leadSelectionIndex) -1 else 1
                var next = index1
                while (next in 0 until sessionsModel.size() && !selectable(next)) next += step
                if (selectable(next)) super.setSelectionInterval(next, next)
            }
            override fun addSelectionInterval(index0: Int, index1: Int) = setSelectionInterval(index0, index1)
        }
        cellRenderer = SessionRowRenderer { com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.session?.takeIf { s -> s.isNotBlank() } }
        // The rows are VARIABLE height (they wrap), so a width change must re-measure them or the old
        // wrap heights stick. Toggling fixedCellHeight invalidates the list UI's cached row sizes; the
        // next paint re-queries the renderer at the new width and reflows.
        addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) {
                fixedCellHeight = 1
                fixedCellHeight = -1
                revalidate()
                repaint()
            }
        })
    }
    /** Held so [repaintSessions] can disclose that the pinned session is not in the listing. */
    private val sessionsDesc = descLabel(SESSIONS_DESC)
    private val sessionsPane: JComponent by lazy { descPane(sessionsDesc, JBScrollPane(sessionsList)) }
    // Each nav tab's pane is held as a field so the guided tour can address a tab by COMPONENT. The tab
    // titles carry live counts, so they are not stable identifiers, and Processes is appended at runtime,
    // so neither are the index constants.
    private val fleetPane: JComponent by lazy {
        descPane("Every Claude agent working in this repo’s worktrees — live phase, tokens, and risk. Select one to map just its edits.", JBScrollPane(fleetTree))
    }
    private val workflowsPane: JComponent by lazy {
        descPane("Multi-agent runs (an orchestrator and its subagents) — each run’s phases and the edits attributed to it.", JBScrollPane(workflowsTree))
    }
    private val tasksPane: JComponent by lazy { descPane(tasksDesc, JBScrollPane(tasksList)) }

    /** The session-scoped panes' description labels — held so [refreshScopeNotes] can disclose that they
     *  do NOT follow a fleet row from another session. */
    private val tasksDesc = descLabel(TASKS_DESC)
    private val processesDesc = descLabel(PROCESSES_DESC)
    /** The Processes pane, built up front but only added as a tab once the CLI answered for it. */
    private val processesPane: JComponent = descPane(processesDesc, JBScrollPane(processesList))

    // --- RIGHT DETAIL: the change-map for the selected nav item. (Its feed lived under it until
    //     0.10.0 — it renders in the Timeline's Feed tab now, so the map keeps the whole height.) ---
    private val detailHost = JPanel(BorderLayout())

    // --- Active-only + Clear-completed (display-only; a thin filter over the same payload). Persist across
    //     repaints; Active only defaults ON and is remembered in settings (0.8.8) — this panel is about work
    //     still awaiting review. The dismissed sets HIDE completed items (never delete); reset on a session
    //     change. A dismissed item reappears if it goes active again. ---
    // No @Volatile: this has no backing field — it reads and writes the persisted setting directly, so
    // the storage is the settings component's, and both threads see the same object.
    private var activeOnly: Boolean
        get() = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.overviewActiveOnly
        set(value) { com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.overviewActiveOnly = value }
    private val dismissedAgents = HashSet<String>()
    private val dismissedWorkflows = HashSet<String>()
    /** Background shells folded by Clear completed. A shell that has EXITED is finished work exactly like
     *  a done agent or a finished run, so it folds with them; a RUNNING shell never does — it is the
     *  reason to look at the tab. (VS Code parity: DISMISS_PR.) */
    private val dismissedProcesses = HashSet<String>()
    private var lastResult: MultitaskResult? = null
    private var lastProcesses: ProcessesResult? = null
    private var lastPrompts: PromptsResult? = null
    private var lastSelfSession: String? = null
    /** Suppress the tree selection listeners while we programmatically reload / restore selection. */
    private var suppressSel = false

    /** Workflow ids already seen in a payload — null until the FIRST payload seeds it, so opening the
     *  panel never steals focus; afterwards a newly-appeared RUNNING run auto-focuses (user prompt). */
    private var seenWorkflows: HashSet<String>? = null

    /** The left nav's tab strip — a field so a new workflow run can switch to Workflows. Its CONTENTS are
     *  rebuilt by [rebuildNavTabs]: five member tabs, or two group tabs of side-by-side columns. */
    private lateinit var navTabs: JBTabbedPane

    /** The master/detail splitter — a field so the grouping toggle can widen the nav when it flips. */
    private lateinit var masterSplit: OnePixelSplitter

    /** Grouped mode's group panes, by group key — what [navHostFor] resolves a member's tab to, and where
     *  a member's header, badge, width and fold state live while the tab strip names the GROUP. */
    private val groupPanes = HashMap<String, ColumnGroupPane>()

    /** Whether the Processes member is mounted. It appears only once `processes --json` has ANSWERED — an
     *  older CLI shows no tab at all rather than one that can never fill (VS Code parity) — and this is a
     *  flag rather than a component lookup because grouped mode mounts it inside a splitter, where
     *  `indexOfComponent` on the tab strip cannot see it. */
    private var processesShown = false

    private val cfg get() = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state

    /** Group the five nav tabs into two panes of side-by-side columns. Persisted, like every other layout
     *  choice on this panel; no backing field, so the setting IS the storage. */
    private var groupedNav: Boolean
        get() = cfg.overviewGroupedNav
        set(value) { cfg.overviewGroupedNav = value }

    /**
     * Where the master/detail divider sits for the CURRENT layout and nav mode.
     *
     * Four remembered values, not one: grouped columns need a far wider nav than five stacked tabs, and a
     * divider that resets on every toggle is one the reader re-drags every time. This EXTENDS the existing
     * per-orientation memory rather than competing with it.
     */
    private fun splitProp(): Float = with(cfg) {
        val stacked = ::masterSplit.isInitialized && masterSplit.orientation
        when {
            stacked && overviewGroupedNav -> overviewSplitNarrowGrouped
            stacked -> overviewSplitNarrow
            overviewGroupedNav -> overviewSplitWideGrouped
            else -> overviewSplitWide
        }
    }

    private fun storeSplitProp() {
        if (!::masterSplit.isInitialized) return
        val p = masterSplit.proportion
        with(cfg) {
            val stacked = masterSplit.orientation
            when {
                stacked && overviewGroupedNav -> overviewSplitNarrowGrouped = p
                stacked -> overviewSplitNarrow = p
                overviewGroupedNav -> overviewSplitWideGrouped = p
                else -> overviewSplitWide = p
            }
        }
    }

    /**
     * Build the left nav for the current mode.
     *
     * UNGROUPED: five tabs, Sessions first — which session you are reviewing is the question that precedes
     * every other tab, and answering it re-points the whole observatory rather than just this panel.
     *
     * GROUPED: one tab rendering all five members as columns, Sessions in the same lead position. The
     * splitters nest so the Processes column can be appended later, exactly as its tab used to be.
     *
     * [restore] names the member to bring forward afterwards; when null the currently selected member is
     * kept. A caller flipping the MODE must pass it, read before the flip — [selectedNavMember] answers for
     * whichever mode is in force.
     */
    private fun rebuildNavTabs(restore: String? = null) {
        if (!::navTabs.isInitialized) return
        val keep = restore ?: selectedNavMember()
        navTabs.removeAll()
        groupPanes.values.forEach { it.detach() } // give the member panes back before anything adopts them
        groupPanes.clear()
        if (!groupedNav) {
            for (m in TOUR_TABS) {
                if (m == MEMBER_PROCESSES && !processesShown) continue // mounted by repaintProcesses
                val pane = memberPane(m) ?: continue
                navTabs.addTab(MEMBER_TITLES[m] ?: m, pane)
                navTabs.setToolTipTextAt(navTabs.tabCount - 1, MEMBER_TIPS[m] ?: "")
            }
        } else {
            for ((group, members) in com.cellobservatory.observatory.model.NavGrouping.GROUPS) {
                val pane = ColumnGroupPane(
                    group = group,
                    members = members,
                    title = { MEMBER_TITLES[it] ?: it },
                    tip = { MEMBER_TIPS[it] },
                    defaultProportion = { i -> GROUP_SPLIT_DEFAULTS[group]?.getOrNull(i) ?: 0.5f },
                    // A fold changes which headers exist, and the badges live on them.
                    onFoldChange = { rebadgeNav() },
                )
                for (m in members) {
                    if (m == MEMBER_PROCESSES && !processesShown) continue // mounted by repaintProcesses
                    memberPane(m)?.let { pane.mount(m, it) }
                }
                // The Processes tab header brings back shells Clear completed folded away; grouped mode has
                // no such tab, so its COLUMN header inherits the gesture rather than losing it.
                if (MEMBER_PROCESSES in members) pane.onHeaderClick(MEMBER_PROCESSES) { unhideProcesses() }
                groupPanes[group] = pane
                navTabs.addTab(com.cellobservatory.observatory.model.NavGrouping.GROUP_TITLES[group] ?: group, pane)
                navTabs.setToolTipTextAt(
                    navTabs.tabCount - 1,
                    members.mapNotNull { MEMBER_TITLES[it] }.joinToString(" · ") +
                        " side by side — drag a divider to trade width, double-click one to even them up, " +
                        "and fold a column to a rail with the button beside its name.",
                )
            }
        }
        keep?.let { showNavMember(it) }
        navTabs.revalidate()
        navTabs.repaint()
        rebadgeNav()
    }

    /** Re-write every badge from the payloads already in hand. A rebuild (or a fold) moves the titles to
     *  new components, and without this the nav shows bare names until the next transcript tick. */
    private fun rebadgeNav() {
        repaintSessions(lastSessions)
        repaintTasks(lastTasks)
        repaintProcesses(lastProcesses)
        repaintNavCounts()
    }

    /** Bring the Processes member on screen once the CLI has answered for it: a tab of its own when
     *  ungrouped, the third column of the runs group when grouped.
     *
     *  Grouped, this is a MOUNT into the existing group pane rather than a rebuild of it: the divider
     *  between Workflows and the rest keeps the width the reader dragged, and every column keeps whether
     *  it was folded, because neither is re-derived here. */
    private fun mountProcesses() {
        if (!::navTabs.isInitialized) return
        if (groupedNav) {
            groupPanes[com.cellobservatory.observatory.model.NavGrouping.NAV_ALL]?.mount(MEMBER_PROCESSES, processesPane)
        } else if (navTabs.indexOfComponent(processesPane) < 0) {
            navTabs.addTab(MEMBER_TITLES[MEMBER_PROCESSES] ?: MEMBER_PROCESSES, processesPane)
            navTabs.setToolTipTextAt(navTabs.tabCount - 1, PROCESSES_TIP)
        }
    }

    /** Bring back the shells Clear completed folded away — dismissed, never deleted. */
    private fun unhideProcesses() {
        if (dismissedProcesses.isEmpty()) return
        dismissedProcesses.clear()
        suppressSel = true
        repaintProcesses(lastProcesses)
        restoreSelection() // the refill wiped the highlight — put it back on the same shell
        suppressSel = false
    }

    /** Flip the nav grouping: rebuild the tabs and give the nav the width that mode remembers. */
    private fun applyGroupedNav(on: Boolean) {
        if (groupedNav == on) return
        val keep = selectedNavMember() // read in the OLD mode, before the flip changes what tabs mean
        storeSplitProp() // park this mode's divider so flipping back finds it where the reader left it
        groupedNav = on
        rebuildNavTabs(keep)
        if (::masterSplit.isInitialized) masterSplit.proportion = splitProp()
        refreshOverviewToolbar()
    }

    init {
        Registry.remember(project, this) // so the guided tour can bring a named tab forward
        // (Live conflicts moved to the Actions panel in 0.8.3 — the fleet tab is just the tree now.)
        // Each pane leads with a one-line description (VS Code .ov-desc parity) above its tree/list.
        navTabs = JBTabbedPane()
        rebuildNavTabs(MEMBER_SESSIONS)
        // Left nav = 25% of the panel (45% grouped, whose columns need the width); the change-map
        // detail and the selection's feed share the rest.
        // Master–detail SIDE BY SIDE while there is width for both, STACKED when there is not. This tool
        // window is usually wide (bottom dock) but can be dragged to a side stripe, where a 25% nav
        // column leaves neither half readable — the nav tabs wrap to three rows and the ledger's file
        // names are squeezed to a few characters. Below the threshold the same two components split
        // vertically instead, which costs height (a narrow window has it) and gives back width.
        // The grouping toggle sits BESIDE the tab titles, pinned to the top of the strip's trailing edge
        // (user rule 2026-07-30) — it is about the tabs, and it read as unrelated among the display
        // controls on the toolbar two rows up. JBTabbedPane has no trailing-component slot of its own, so
        // the toolbar is a sibling laid out level with the strip.
        val navTabsToolbar = ActionManager.getInstance()
            .createActionToolbar("ClaudeObservatoryOverviewTabs", DefaultActionGroup(groupedNavToggle()), true)
            .apply {
                targetComponent = this@ChangeMapPanel
                component.isOpaque = false
            }
        val navHost = JPanel(BorderLayout()).apply {
            add(navTabs, BorderLayout.CENTER)
            add(
                JPanel(BorderLayout()).apply {
                    isOpaque = false
                    add(navTabsToolbar.component, BorderLayout.NORTH)
                },
                BorderLayout.EAST,
            )
        }
        masterSplit = OnePixelSplitter(false, splitProp()).apply {
            firstComponent = navHost
            secondComponent = detailHost
        }
        val split = masterSplit
        split.addComponentListener(object : ComponentAdapter() {
            private var stacked: Boolean? = null
            override fun componentResized(e: ComponentEvent) {
                val narrow = e.component.width in 1 until NARROW_PANEL_PX
                if (stacked == narrow) return // orientation changes reset the divider — only on a real flip
                // Remember where the reader left THIS layout's divider before flipping to the other one,
                // which then comes back where they left it rather than at a constant.
                if (stacked != null) storeSplitProp()
                stacked = narrow
                split.orientation = narrow
                split.proportion = splitProp()
            }
        })
        // A drag is only recorded when the divider settles — Splitter fires this on every pixel of one.
        split.addPropertyChangeListener("proportion") { storeSplitProp() }
        // No prompt-scope banner here: the Prompts WINDOW beside this panel already shows the picked
        // ask (selected, with its full text and a clear action), so naming it again in the Overview was
        // duplication. The scope is still evident — the panes note what they hid, the bulk buttons read
        // "…in #N", and the bottom summary names the ask.
        setContent(split)

        // Feed the shared nav bar the session's prompts, whose editIds drive the Prompt axis (the
        // status-bar host leaves this empty — it carries no Prompt axis).
        reviewNavBar.promptsProvider = { lastPrompts?.prompts ?: emptyList() }
        // The Overview shows the RICH Diff/File counters (edit time · filename · edit count); the status bar
        // stays terse (VS Code parity — that detail rides only the Overview's counters).
        reviewNavBar.richCounters = true

        // TWO rows (user swap 2026-07-17, VS Code parity — its .ov-toolbar is a flex column-reverse):
        //   BOTTOM row = the review AXES: Diff · File · Folder · Prompt (centered, dividers between).
        //   TOP row (split) = controls: LEFT cluster = session selector + Accept All + Reject All +
        //     Clear Resolved + Export ; RIGHT cluster = Search · Active only | Spotlight · Refresh.
        // The nav-bar actions come from the shared ReviewNavBar (labels shown, like VS Code). Each cluster is
        // its own ActionToolbar so a nav step or a change of prompt scope can refresh its labels + counters.

        // --- BOTTOM row: the four review axes ---
        //     ICONS ONLY on these rows. Each axis already names itself in its own counter — "File 3/126",
        //     "Folder 1/23" — so repeating "Accept File" and "Reject File" beside it spent most of the bar
        //     restating the axis the reader is already looking at. The counter is the annotation; the
        //     buttons are icons with tooltips. The top row keeps its labels: those are session-wide and
        //     destructive, and there is no axis label above them to say what they act on.
        val diffGroup = DefaultActionGroup().apply {
            reviewNavBar.diffAxis().forEach(::add)
            add(reviewNavBar.keepAction(showText = false)); add(reviewNavBar.undoAction(showText = false))
            add(reviewNavBar.chatEditAction(showText = false)); add(reviewNavBar.viewDiffAction(showText = false))
        }
        val fileGroup = DefaultActionGroup().apply {
            reviewNavBar.fileAxis().forEach(::add)
            add(reviewNavBar.acceptFileAction(showText = false)); add(reviewNavBar.rejectFileAction(showText = false))
        }
        val folderGroup = DefaultActionGroup().apply {
            reviewNavBar.folderAxis().forEach(::add)
            add(reviewNavBar.acceptFolderAction(showText = false)); add(reviewNavBar.rejectFolderAction(showText = false))
        }
        // Prompt is the LAST axis: the coarsest scope on the bar, and the one a person names out loud
        // ("accept everything from that ask"). No Chat button — `chat-context` has no prompt ref, and a
        // button that silently framed the prompt as something else would be worse than its absence.
        val promptGroup = DefaultActionGroup().apply {
            reviewNavBar.promptAxis().forEach(::add)
            add(reviewNavBar.reviewPromptAction(showText = false)); add(reviewNavBar.acceptPromptAction(showText = false))
            add(reviewNavBar.revertPromptAction(showText = false))
            // Rewind widens Reject Prompt from "this ask" to "this ask and everything after it", so it sits
            // beside it — the Prompts window deliberately carries no per-ask review verbs (see its comment).
            add(reviewNavBar.rewindPromptAction(showText = false))
        }

        // --- TOP row LEFT cluster: session selector + session-wide bulk + Export. Bulk actions RETARGET to
        //     the picked ASK when the Prompts window has one selected — that is the explicit scope the
        //     reader named, and every pane on this panel is already filtered to it. ---
        val leftGroup = DefaultActionGroup().apply {
            add(sessionLabelAction())
            add(bulkAction("Accept All", NavTint.ACCEPT_ALL, { "Accept All in $it" },
                { withSession { s -> ReviewOps.keepAll(project, s) } },
                // The REVIEWED session, never withSession: the prompt's edit ids come from the
                // reviewed session's log, and ids are small per-session integers — pairing them with a
                // selected SIBLING's session id would accept unrelated edits in that worktree while the
                // confirm dialog listed this one's files. Prompts belong to the reviewed conversation
                // by definition (VS Code's prompt verbs carry no session for the same reason).
                { r -> withReviewedSession { s -> ReviewOps.keepAll(project, s, editsOfPrompt(r), "prompt #${r.index}") } }))
            add(bulkAction("Reject All", NavTint.REVERT_ALL, { "Reject All in $it" },
                // Session-only: `undo --all --session s`, so no records cross a session boundary.
                { withSession { s -> ReviewOps.undoAllInSession(project, s) } },
                { r -> withReviewedSession { s -> ReviewOps.undoIds(project, s, editsOfPrompt(r), "prompt #${r.index}", "prompt #${r.index}") } }))
            add(bulkAction("Clear Resolved", NavTint.CLEAR, { "Clear in $it" },
                {
                    withSession { s ->
                        // Count only what we can actually see: the reviewed session's log. For a sibling
                        // the count is UNKNOWN here (null) — ReviewOps phrases the dialog count-free and
                        // reports the CLI's own cleared figure, instead of interpolating a -1 sentinel
                        // into a destructive confirmation (which is what shipped: "Clear -1 resolved
                        // edit(s)?").
                        val resolved = if (s == service().currentSession()) service().log().count { !it.pending } else null
                        if (resolved != 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
                    }
                },
                { r -> withSession { s -> ReviewOps.clearResolvedIds(project, s, r.editIds, "prompt #${r.index}") } }))
            add(exportGroup())
        }
        // --- TOP row RIGHT cluster: Search · Active only · Clear completed | Spotlight · Refresh | demo ---
        //     Demo mode LAST among the controls, and on this panel as well as the Edits tree (VS Code
        //     puts it on both title bars). It is the one cluster here that is not about the session
        //     under review, so it sits at the end behind its own separator rather than among the review
        //     controls. The VERSION chip and the SETTINGS gear close the row, in that order — pinned to
        //     the right edge (VS Code parity: same pair, same order, same far-right position).
        val rightGroup = DefaultActionGroup().apply {
            add(FilterSortActions.searchField(project)) // the inline search FIELD (not the pop-up dialog)
            // Reset scope, RIGHT BESIDE Search: one button that widens the panel
            // back to every tracked edit — Search text, the folder-tile filter, and the prompt scope
            // all cleared at once. Until now each had its own exit (empty Search / re-click the tile /
            // the Prompts window's Clear Scope) and none was discoverable from here. The service
            // refresh it triggers re-syncs the Prompts window's own selection (repaint reads
            // selectedPromptId fresh and clears the list when it is null).
            add(
                iconAction(
                    "Reset Scope",
                    AllIcons.General.Reset,
                    "Reset scope — show every tracked edit (clears Search, the folder filter, and the prompt scope)",
                ) {
                    service().selectedPromptId = null
                    service().setFilterSpec(emptyList(), emptyList()) // clear ext/type…
                    service().setFilter("") // …and the query; refreshes every surface, detail starts unfiltered
                },
            )
            add(FilterSortActions.filterGroup(project))
            add(FilterSortActions.sortGroup(project))
            add(activeOnlyToggle())
            // Group Tabs is NOT here: it is about the tab strip, so it sits beside it (user rule
            // 2026-07-30). See navHost below.
            add(clearCompletedAction())
            addSeparator()
            add(reviewNavBar.spotlightAction())
            add(action("Refresh", AllIcons.Actions.Refresh) { service().sweepIgnoredThen { rebuild(force = true) } })
            addSeparator()
            DemoVerbs.ALL.forEach { v -> add(demoAction(v.text, v.icon, v.wantDemo) { v.run(project) }) }
            addSeparator()
            add(versionGroup())
            // The settings gear, LAST. Until now this plugin had NO entry point to its own settings at
            // all — the screen existed (ObservatoryConfigurable, registered under Settings ▸ Tools) but
            // nothing in the tool window opened it, so the only way in was to know it was there. VS Code
            // has had this button since the previous round; this is the parity half.
            add(
                iconAction(
                    "Settings",
                    AllIcons.General.Settings,
                    "OAK settings — CLI paths, pinned session, and the editor review surface",
                ) {
                    com.intellij.openapi.options.ShowSettingsUtil.getInstance()
                        .showSettingsDialog(project, ObservatoryConfigurable::class.java)
                },
            )
        }

        fun mkTb(name: String, g: DefaultActionGroup): ActionToolbar =
            ActionManager.getInstance().createActionToolbar("ClaudeObservatoryOverview$name", g, true).apply {
                // The PANEL, never a tab's tree. The platform refuses to run an action whose toolbar's
                // target component is not showing — and `fleetTree` lives inside the Fleet tab, so with
                // any other tab selected (Sessions is the default) EVERY button on these six toolbars
                // silently did nothing: Accept All, Reject All, Clear Resolved, Export, Search, Active
                // only, Clear completed, Spotlight, Refresh and all four review axes. The IDE log said so
                // 28 times — "Action is not performed because target component is not showing" — while
                // the UI gave the reader no clue at all.
                targetComponent = this@ChangeMapPanel
                component.isOpaque = false
            }
        val diffTb = mkTb("Diff", diffGroup)
        val fileTb = mkTb("File", fileGroup)
        val folderTb = mkTb("Folder", folderGroup)
        val promptTb = mkTb("Prompt", promptGroup)
        val leftTb = mkTb("Left", leftGroup)
        val rightTb = mkTb("Right", rightGroup)
        overviewToolbars = listOf(diffTb, fileTb, folderTb, promptTb, leftTb, rightTb)

        // TOP row: left cluster pinned LEFT, right cluster pinned RIGHT while both fit; when the tool
        // window is too narrow for both, the right cluster WRAPS onto a second line (VS Code's
        // .ov-tbrow.split is flex-wrap: wrap + space-between). SplitWrapLayout does the fit-or-stack; the
        // width-change revalidate lets the host toolbar grow the extra row instead of clipping.
        val topRow = JPanel(SplitWrapLayout(JBUI.scale(3))).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftTb.component)  // child 0 = LEFT cluster
            add(rightTb.component) // child 1 = RIGHT cluster
            addComponentListener(object : ComponentAdapter() {
                private var lastWidth = -1
                override fun componentResized(e: ComponentEvent) {
                    val c = e.component
                    if (c.width != lastWidth) { lastWidth = c.width; c.revalidate() }
                }
            })
        }
        // BOTTOM row: the four review axes, centered, with a divider between each. WrapLayout (a wrapping
        // FlowLayout) flows them onto ADDITIONAL centered lines when the pane is too narrow for one row —
        // instead of the axis toolbars shrinking below preferred and collapsing into an IntelliJ "…" overflow.
        val bottomRow = JPanel(WrapLayout(FlowLayout.CENTER, JBUI.scale(2), JBUI.scale(3))).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            listOf(diffTb, fileTb, folderTb, promptTb).forEachIndexed { i, tb ->
                if (i > 0) add(navDivider())
                add(tb.component)
            }
            // Height tracks the current width — revalidate on a width change so the host toolbar grows
            // rows (mirrors the top row); without it the first (pre-width) pass would leave a single row.
            addComponentListener(object : ComponentAdapter() {
                private var lastWidth = -1
                override fun componentResized(e: ComponentEvent) {
                    val c = e.component
                    if (c.width != lastWidth) { lastWidth = c.width; c.revalidate() }
                }
            })
        }
        toolbar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            border = JBUI.Borders.empty(2, 2)
            add(topRow)
            add(Box.createVerticalStrut(JBUI.scale(3)))
            add(bottomRow)
        }

        // Single-click a Fleet row → map that agent (a subagent maps its parent agent); a Workflows run →
        // map that workflow. Ignore programmatic reloads (suppressSel) and non-item rows (the filter banner).
        fleetTree.addTreeSelectionListener {
            if (suppressSel) return@addTreeSelectionListener
            when (val obj = (fleetTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject) {
                is AgentRow -> selectDetail(NavSel.Agent(obj.agent.session))
                is SubRow -> selectDetail(NavSel.Subagent(obj.session, obj.sub.agentId))
                else -> {}
            }
        }
        workflowsTree.addTreeSelectionListener {
            if (suppressSel) return@addTreeSelectionListener
            (workflowsTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject
                ?.let { if (it is WfRunRow) selectDetail(NavSel.Workflow(it.id)) }
        }

        // Right-click a Fleet row → zero-token chat about that agent / subagent (clipboard-only on JetBrains).
        fleetTree.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) = maybePopup(e)
            override fun mouseReleased(e: MouseEvent) = maybePopup(e)
            private fun maybePopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val path = fleetTree.getPathForLocation(e.x, e.y) ?: return
                fleetTree.selectionPath = path
                popupFor((path.lastPathComponent as? DefaultMutableTreeNode)?.userObject)?.show(fleetTree, e.x, e.y)
            }
        })

        // Clicking the Tasks tab's "N done · show all" row folds/unfolds the completed tasks.
        tasksList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val i = tasksList.locationToIndex(e.point)
                if (i >= 0 && tasksModel.get(i) is DoneTasksToggle) {
                    tasksOpen = !tasksOpen
                    suppressSel = true
                    repaintTasks(lastTasks)
                    restoreSelection() // the refill wiped the highlight — put it back on the same row
                    suppressSel = false
                }
            }
        })

        // A task or a background shell has no change-map slice to select, but it does have a feed: these
        // drive the bottom pane the same way a fleet / workflow row drives the map above it.
        tasksList.addListSelectionListener {
            if (suppressSel || it.valueIsAdjusting) return@addListSelectionListener
            (tasksList.selectedValue as? TaskRow)?.let { row -> selectDetail(NavSel.Task(taskFeedId(row))) }
        }
        // Right-click a task row → the strict per-task review ops. They live in a menu rather than as
        // row buttons because they are destructive-adjacent and the list is dense; the menu names the
        // scope in words ("its strict in-progress span") so nothing is accepted by accident.
        tasksList.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) = maybePopup(e)
            override fun mouseReleased(e: MouseEvent) = maybePopup(e)
            private fun maybePopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val i = tasksList.locationToIndex(e.point)
                if (i < 0) return
                val row = tasksModel.get(i) as? TaskRow ?: return
                tasksList.selectedIndex = i
                taskMenu(row)?.show(tasksList, e.x, e.y)
            }
        })
        // Choosing a session is a change of SUBJECT — it pins what the whole observatory reviews — so it
        // happens on ACTIVATION (a click, or Enter on the keyboard), never on mere selection: arrowing
        // through the list to read it would otherwise re-point every window once per row.
        sessionsList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.isPopupTrigger || e.button != MouseEvent.BUTTON1) return
                val i = sessionsList.locationToIndex(e.point)
                if (i < 0 || !sessionsList.getCellBounds(i, i).contains(e.point)) return
                when (val row = sessionsModel.get(i)) {
                    // A click in the trailing "resolve" zone resolves that row instead of switching to
                    // it: accept what is pending, then drop its records (Swing lists have no per-row
                    // buttons, so the hit region is the label's own tail).
                    is SessionRow ->
                        if (row.pending > 0 && resolveFragmentHit(i, row, e)) resolveSessionRow(row)
                        // The store-size fragment opens the folder instead of switching sessions —
                        // the same click the terminal and VS Code answer.
                        else if (row.storePath.isNotBlank() && storeFragmentHit(i, row, e))
                            ReviewOps.revealStoreFolder(project, row.storePath)
                        // The drive fragment: pin, reveal the Feed tab, reopen the conversation
                        // there — refused while a turn RUNS (stop the current agent first).
                        else if (conversationFragmentHit(i, row, e)) openConversationRow(row)
                        // The delete fragment: remove this conversation from every picker (confirmed
                        // first), instead of switching to it.
                        else if (deleteFragmentHit(i, row, e)) deleteSessionRow(row)
                        else pinSession(row)
                    AutoSessionRow -> pinSession(null)
                    // Repaint from the REMEMBERED payload: a toggle is a display state, and refetching
                    // here would make expanding the list spawn a CLI call.
                    is OlderSessionsToggle -> {
                        oldSessionsOpen = !oldSessionsOpen
                        suppressSel = true
                        repaintSessions(lastSessions)
                        restoreSelection()
                        suppressSel = false
                    }
                    else -> {}
                }
            }
        })
        sessionsList.registerKeyboardAction(
            {
                when (val row = sessionsList.selectedValue) {
                    is SessionRow -> pinSession(row)
                    AutoSessionRow -> pinSession(null)
                    else -> {}
                }
            },
            javax.swing.KeyStroke.getKeyStroke(java.awt.event.KeyEvent.VK_ENTER, 0),
            JComponent.WHEN_FOCUSED,
        )
        processesList.addListSelectionListener {
            if (suppressSel || it.valueIsAdjusting) return@addListSelectionListener
            processesList.selectedValue?.let { p -> selectDetail(NavSel.Process(p.id)) }
        }
        // Clicking the Processes tab HEADER brings back the shells Clear completed folded away — they were
        // dismissed, never deleted, and the header badge says how many are hidden. Grouped mode has no
        // Processes tab, so there the gesture lives on its column header instead (see columnPane).
        navTabs.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (groupedNav) return
                val i = navTabs.indexOfComponent(processesPane)
                if (i < 0 || navTabs.indexAtLocation(e.x, e.y) != i) return
                unhideProcesses()
            }
        })
        // Clicking a nav tree's "N hidden · show all" row does the same for its agents / workflow runs.
        fleetTree.addMouseListener(unhideListener(fleetTree, dismissedAgents))
        // Remember whether the folded group is open, so the repaint on the next transcript tick does not
        // slam it shut under the reader (see the re-collapse in repaintNav).
        fleetTree.addTreeExpansionListener(object : javax.swing.event.TreeExpansionListener {
            private fun isFold(e: javax.swing.event.TreeExpansionEvent) =
                (e.path?.lastPathComponent as? DefaultMutableTreeNode)?.userObject is FoldedGroup
            // `repainting` gates these: the repaint below expands and collapses nodes itself, and a
            // programmatic move is not the reader saying anything about what they want open.
            override fun treeExpanded(e: javax.swing.event.TreeExpansionEvent) { if (!repainting && isFold(e)) foldOpen = true }
            override fun treeCollapsed(e: javax.swing.event.TreeExpansionEvent) { if (!repainting && isFold(e)) foldOpen = false }
        })
        workflowsTree.addMouseListener(unhideListener(workflowsTree, dismissedWorkflows))

        ObservatoryService.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    /** True while a repaint is driving the tree, so its own expand/collapse is not read as a reader gesture. */
    private var repainting = false

    private fun selectDetail(sel: NavSel) {
        selected = sel
        val ref = feedRef()
        service().selectedFeed = ref?.let { ObservatoryService.FeedSel(it, service().currentSession()) }
        if (ref != null && !suppressSel) {
            com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                .getToolWindow("Observatory Timeline")?.show(null)
            TimelinePanel.of(project)?.selectMember(com.cellobservatory.observatory.model.NavGrouping.FEED)
        }
        renderDetail()
        refreshScopeNotes()
        refreshOverviewToolbar()
        repaintNavCounts() // the badges describe the SELECTED session (0.9.0) — see below
    }

    /**
     * Resolve one session from its own row: accept its pending edits, then clear its records.
     *
     * Confirmed, because clearing the records cannot be undone. The accept itself writes no file — it
     * records a verdict — and the session is kept; `Clean Store → Drop` deletes one outright.
     */
    private fun resolveSessionRow(row: SessionRow) {
        val ok = Messages.showYesNoDialog(
            project,
            "Resolve “${row.displayName}”?\n\n" +
                "Accepts its ${row.pending} pending edit(s), then clears this session's review records.\n\n" +
                "Accepting changes NO file on disk — it records a verdict. Clearing the records cannot be undone, " +
                "and the session itself is kept.",
            "OAK",
            "Resolve Session",
            "Cancel",
            Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        com.intellij.openapi.progress.ProgressManager.getInstance().run(
            object : com.intellij.openapi.progress.Task.Backgroundable(project, "Resolving ${row.displayName}…") {
                override fun run(indicator: com.intellij.openapi.progress.ProgressIndicator) {
            val r = ObservatoryCli.resolveSession(row.id, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                if (r.ok) {
                    service().refresh(force = true)
                    ReviewOps.notify(project, "Resolved ${row.displayName}.")
                } else {
                    ReviewOps.notify(project, "Could not resolve ${row.displayName} — ${r.stderr.take(160)}", NotificationType.ERROR)
                }
            }
                }
            }
        )
    }

    /** The delete fragment's action — the shared confirm-and-delete every session picker uses. */
    private fun deleteSessionRow(row: SessionRow) = ReviewOps.confirmAndDeleteSession(project, row)

    /** The session the nav badges describe: a selected agent (or its parent, for a subagent row). */
    private fun scopedSession(): String? = when (val s = selected) {
        is NavSel.Agent -> s.session
        is NavSel.Subagent -> s.session
        else -> null
    }

    /** True when a fleet row for a session OTHER than the one under review is selected. */
    private fun otherAgentSelected(): Boolean {
        val s = scopedSession() ?: return false
        return s != (lastResult?.agents?.firstOrNull { it.self }?.session ?: service().currentSession())
    }

    /**
     * Badge the Fleet · Workflows · Tasks · Processes tabs (0.9.0).
     *
     * A badge must count THE LIST ITS PANE RENDERS. Scoping Tasks to the change map's per-agent `tasks`
     * was wrong twice over: that is the STRICT edit-producing subset (it read "Tasks 0" over a pane
     * listing 13), and for a sibling it described a session the pane was not showing. A sibling's tasks,
     * workflows and shells are not in this payload — fetching them per sibling measured 1.2 s a refresh
     * — so while one is selected those badges say NOTHING rather than another session's numbers.
     *
     * Fleet is the exception and keeps a count: it is repo-wide, its pane really does list every agent,
     * so selected/total is honest where a bare "1" would not be.
     */
    private fun repaintNavCounts() {
        if (!::navTabs.isInitialized) return
        // The rows the pane will actually DRAW — Active-only and the week-old fold applied — not every
        // session ever recorded for this repo. "Fleet 33" over a tree showing 2 rows reads as 33 live
        // agents, which is what the badge is asked and what it must answer.
        val agents = lastResult?.agents.orEmpty()
            .filter { MultitaskFilter.showAgent(it, activeOnly, dismissedAgents) }
            // `folded` is decided in core and shipped on the row — the fold rule lives in ONE place.
            .filter { !it.folded || it.self || it.session == scopedSession() }
        val other = otherAgentSelected()
        setTabBadge(
            MEMBER_FLEET,
            when {
                agents.isEmpty() -> "Workers"
                scopedSession() != null && agents.size > 1 -> "Workers 1/${agents.size}"
                else -> "Workers ${agents.size}"
            },
        )
        val runs = lastResult?.workflows?.size ?: 0
        setTabBadge(MEMBER_WORKFLOWS, if (other || runs == 0) "Workflows" else "Workflows $runs")
        val tasks = lastTasks
        val done = tasks.count { it.status == "completed" }
        setTabBadge(MEMBER_TASKS, if (other || tasks.isEmpty()) "Tasks" else "Tasks $done/${tasks.size}")
        // Shells cannot be scoped either; repaintProcesses owns the unscoped label, so only blank it here.
        if (other) {
            setTabBadge(MEMBER_PROCESSES, "Processes")
            setTabTip(MEMBER_PROCESSES, PROCESSES_UNSCOPED_TIP)
        }
    }

    /** What `feed --kind task` resolves against: the row's STRICT 12-hex task id (core.taskIdForSubject).
     *  NEVER the task list's display number — core keys tasks by that strict id, so a display id resolves
     *  to nothing and the pane would report "no such task in this session" about a task this very panel is
     *  listing. Blank on an older CLI that predates the field: there is then nothing to follow, and no
     *  feed subject is published rather than asking about an id core cannot answer for. */
    private fun taskFeedId(row: TaskRow): String = row.task.taskId

    /**
     * The first task that still has pending edits, as (taskId, label) — what the guided tour's `auto`
     * accept-a-task step acts on. Resolved from the rows this panel has already built, so the tour
     * neither refetches nor hard-codes a task id that the scenario could invalidate. Null when nothing
     * is pending, and the tour then says so instead of running a no-op.
     */
    fun firstPendingTaskInData(): Pair<String, String>? {
        // From the FETCHED tasks, not the rendered rows: Active only is on by default and hides every
        // completed task, and five of the demo's six are completed — so the rendered model can be empty
        // of exactly the row the tour is about to accept, and the step would silently do nothing.
        val rollBy = map?.rollupByTask?.filter { it.taskId != null }?.associateBy { it.taskId } ?: emptyMap()
        for (t in lastTasks) {
            val id = t.taskId.takeIf { it.isNotBlank() } ?: continue
            if ((rollBy[id]?.pending ?: 0) <= 0) continue
            return id to t.subject.ifBlank { "task #${t.id}" }
        }
        return null
    }

    /** Guided tour: suspend the Active-only display filter for its duration and restore the reader's own
     *  value after. The tour narrates rows that filter hides, so leaving it on describes a screen that is
     *  not on the reader's monitor. */
    fun setShowAll(on: Boolean) {
        if (on) {
            if (tourFilter != null) return
            tourFilter = activeOnly
            if (activeOnly) { activeOnly = false; repaintFiltered() }
        } else {
            // Hand the panel back the way the tour found it: the reader's own tab and their own filter.
            // Both are cleared BEFORE the restore, so selectNavTab does not re-record the position it is
            // putting back.
            val back = tourNavTab
            val prev = tourFilter
            tourNavTab = null
            tourFilter = null
            back?.let { showNavMember(it) }
            if (prev != null && prev != activeOnly) { activeOnly = prev; repaintFiltered() }
        }
    }

    /** Repaint everything the Active-only filter scopes — the same pair its own toggle drives. */
    private fun repaintFiltered() {
        repaintNav(lastResult)
        renderDetail()
    }

    fun firstPendingTask(): Pair<String, String>? {
        for (i in 0 until tasksModel.size()) {
            val row = tasksModel.getElementAt(i) as? TaskRow ?: continue
            val id = row.task.taskId.takeIf { it.isNotBlank() } ?: continue
            if ((row.roll?.pending ?: 0) <= 0) continue
            return id to row.task.subject.ifBlank { "task #${row.task.id}" }
        }
        return null
    }

    /** The per-task review menu: Accept / Reject / Clear over the task's STRICT in-progress span, plus
     *  the session-wide clear of every settled task. Null for a row core has no strict id for (an older
     *  CLI): a menu that cannot name its scope must not offer to act on one. */
    private fun taskMenu(row: TaskRow): JPopupMenu? {
        val taskId = row.task.taskId.takeIf { it.isNotBlank() } ?: return null
        val session = service().currentSession() ?: return null
        val label = row.task.subject.ifBlank { "task #${row.task.id}" }
        val pending = row.roll?.pending ?: 0
        val resolved = (row.roll?.kept ?: 0) + (row.roll?.undone ?: 0)
        return JPopupMenu().apply {
            add(menuItem("Accept — keep this task’s ${pending} pending edit(s)") { ReviewOps.keepTask(project, session, taskId, label) }
                .apply { isEnabled = pending > 0 })
            add(menuItem("Reject — revert this task’s ${pending} pending edit(s)") { ReviewOps.undoTask(project, session, taskId, label) }
                .apply { isEnabled = pending > 0 })
            add(menuItem("Clear — drop this task’s ${resolved} resolved edit(s)") { ReviewOps.clearTask(project, session, taskId, label) }
                .apply { isEnabled = resolved > 0 })
            addSeparator()
            add(menuItem("Clear resolved edits of every completed task") { ReviewOps.clearCompletedTasks(project, session) })
            addSeparator()
            add(menuItem("Chat About This Task") {
                ReviewOps.chatContext(project, session, ChatRef.Task(taskId), "task “$label”")
            })
        }
    }

    /** The session the RIGHT detail is showing — a fleet row can name a sibling worktree's session, and
     *  the session-scoped tabs (Tasks, Processes) do NOT follow it. */
    private fun selectedSession(): String? = when (val sel = selected) {
        is NavSel.Agent -> sel.session
        is NavSel.Subagent -> sel.session
        else -> service().currentSession()
    }

    /** Tasks and Processes are always THIS PROJECT's active session: core answers `multitask`'s tasks and
     *  `processes --json` per session, and the panel only ever asks for the active one. When a fleet row
     *  from another session drives the detail, the panes say so — silently showing one session's shells
     *  under another session's heading is the kind of thing that reads as fact. */
    private fun refreshScopeNotes() {
        val active = service().currentSession()
        val sel = selectedSession()
        val note = if (active != null && sel != null && sel != active) {
            " <b>Showing the active session (${active.take(8)}), not the selected agent (${sel.take(8)}).</b>"
        } else {
            ""
        }
        // A picked ask filters the fleet, the runs and the shells — but NOT the task list, because a
        // prompt slice carries no task-id set. Saying so is the difference between a scope and a lie.
        val promptNote = if (scopedPrompt() != null) " <b>Not filtered by the picked prompt — an ask names no tasks.</b>" else ""
        tasksDesc.text = "<html>$TASKS_DESC$note$promptNote</html>"
        processesDesc.text = "<html>$PROCESSES_DESC$note</html>"
    }

    /** What the bottom pane follows for the current selection, or null when there is nothing single to
     *  follow (the default session view is a change map, not one thing doing something). A fleet row IS a
     *  session — including a sibling worktree's — so its feed is keyed by that session, not by ours. */
    private fun feedRef(): ObservatoryService.FeedRef? {
        val active = service().currentSession()
        return when (val sel = selected) {
            NavSel.Main -> null
            is NavSel.Agent -> ObservatoryService.FeedRef(sel.session, "session", "")
            is NavSel.Subagent -> ObservatoryService.FeedRef(sel.session, "agent", sel.agentId)
            is NavSel.Workflow -> active?.let { ObservatoryService.FeedRef(it, "workflow", sel.id) }
            // A blank id means the row carries no strict task core can resolve — follow nothing rather
            // than asking about an id that will come back "no such task".
            is NavSel.Task -> sel.id.takeIf { it.isNotBlank() }?.let { id -> active?.let { ObservatoryService.FeedRef(it, "task", id) } }
            is NavSel.Process -> active?.let { ObservatoryService.FeedRef(it, "process", sel.id) }
            // No feed for a prompt: core's `feed --kind` answers for agents, workflows, tasks, shells and
            // the session — not for a turn. Rather than tail one of those and label it this ask's window,
            // the pane detaches: an absent feed renders absent.
        }
    }

    /** Force the Overview toolbar to recompute its labels (prompt scope) + nav counters immediately. */
    @Suppress("DEPRECATION") // updateActionsImmediately: still the way to force a toolbar refresh
    private fun refreshOverviewToolbar() {
        overviewToolbars.forEach { it.updateActionsImmediately() }
    }

    /** A thin, fixed-height divider between the Overview toolbar groups — the Swing echo of .ov-nbsep. */
    private fun navDivider(): JComponent = JSeparator(SwingConstants.VERTICAL).apply {
        val d = Dimension(JBUI.scale(1), JBUI.scale(18))
        preferredSize = d
        minimumSize = d
        maximumSize = d
    }

    private fun popupFor(node: Any?): JPopupMenu? = when (node) {
        is AgentRow -> JPopupMenu().apply {
            add(menuItem("Chat About This Agent") {
                ReviewOps.chatContext(project, node.agent.session, ChatRef.Session, "agent ${node.agent.session.take(8)}")
            })
        }
        is SubRow -> JPopupMenu().apply {
            val label = node.sub.agentType ?: node.sub.description ?: node.sub.agentId.take(12)
            add(menuItem("Chat About This Subagent") {
                ReviewOps.chatContext(project, node.session, ChatRef.Agent(node.sub.agentId), "subagent $label")
            })
        }
        else -> null
    }

    private fun menuItem(text: String, run: () -> Unit) = javax.swing.JMenuItem(text).apply { addActionListener { run() } }

    /** Click-to-restore for a nav tree's filter banner: hitting the "N hidden · show all" row un-dismisses
     *  everything Clear completed folded away in that tab. A dismiss is display-only, so the way back has
     *  to be one click from the row that admits things are hidden. */
    private fun unhideListener(tree: Tree, dismissed: HashSet<String>) = object : MouseAdapter() {
        override fun mouseClicked(e: MouseEvent) {
            val node = (tree.getPathForLocation(e.x, e.y)?.lastPathComponent as? DefaultMutableTreeNode)?.userObject
            if (node !is FilterInfo || dismissed.isEmpty()) return
            dismissed.clear()
            repaintNav(lastResult)
        }
    }

    // --- data: the SHARED throttled multitask/changemap views from ObservatoryService (0.8.0
    // stabilization: one CLI spawn per view per ~3s across ALL panels, instead of a fresh pair here on
    // every ~2s watcher tick). get() returns the latest cached view immediately and notifies the
    // service listeners when a fresh one lands — which re-enters rebuild() with the new data. ---

    /** Problems already reported, so a per-tick fetch does not repeat the same warning forever.
     *  Cleared when a fetch comes back clean, so a recurrence is reported again. */
    private val reportedProblems = mutableSetOf<String>()

    private fun rebuild(force: Boolean = false) {
        val service = ObservatoryService.getInstance(project)
        val mt = service.multitask(force)
        val cm = service.changemap(force)
        val ps = service.processes(force)
        val rq = service.prompts(force)
        val ss = service.sessions(force)
        // (The feed no longer rides this tick: the Timeline's FeedPanel is the ONE consumer of the
        // service's feed slot — a second asker here would key-thrash it into a spawn per tick.)
        // Anything the batch could not build. Reported ONCE per distinct problem, because this runs on
        // every ~3-second tick and a warning that repeats forever is one the reader learns to dismiss
        // without reading. A view that fails renders as an empty panel otherwise — indistinguishable
        // from a session that did nothing.
        val problems = ObservatoryCli.lastProblems
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            for (why in problems) {
                if (reportedProblems.add(why)) ReviewOps.notify(project, why, NotificationType.WARNING)
            }
            if (problems.isEmpty()) reportedProblems.clear()
            map = cm
            lastProcesses = ps
            lastPrompts = rq
            repaintNav(mt)
            repaintSessions(ss)
            renderDetail()
            refreshOverviewToolbar() // keep the nav counters + scoped labels live on store changes
        }
    }

    private fun repaintNav(res: MultitaskResult?) {
        // Reset the dismissed sets when the active session changes — a stale dismiss must never carry over.
        // `self` is the payload's own session (multitask is now pinned with --session, so it tracks a
        // Switch Session); with no fleet row for it — a pinned session outside this repo's siblings — fall
        // back to the resolved session, or the switch would go unnoticed here.
        val self = res?.agents?.firstOrNull { it.self }?.session ?: service().currentSession()
        if (self != null && lastSelfSession != null && self != lastSelfSession) {
            dismissedAgents.clear(); dismissedWorkflows.clear(); dismissedProcesses.clear(); seenWorkflows = null
            // …and the detail selection with them. The fleet lists EVERY sibling session in this repo, so a
            // row picked against the old session still resolves after the switch and would keep the detail
            // pinned to the session you just left — silently the wrong change-map.
            selected = NavSel.Main
        }
        if (self != null) lastSelfSession = self
        lastResult = res

        // Auto-focus a NEW workflow run: the first payload only seeds the seen-set (opening the panel
        // never steals focus); afterwards a newly-appeared RUNNING run switches the nav to Workflows and
        // selects it (restoreSelection highlights the row) — the detail then tracks the run's agents,
        // phases, and edits live via the shared throttled fetches.
        val wfs = res?.workflows ?: emptyList()
        val seen = seenWorkflows
        if (seen == null) {
            seenWorkflows = wfs.map { it.id }.toHashSet()
        } else {
            var fresh: String? = null
            for (w in wfs) if (seen.add(w.id) && w.running) fresh = w.id
            fresh?.let {
                selected = NavSel.Workflow(it)
                showNavMember(MEMBER_WORKFLOWS) // grouped mode brings the runs group forward instead
            }
        }

        suppressSel = true
        fleetRoot.removeAllChildren()
        val collisionFiles = res?.collisions?.map { it.file }?.toHashSet() ?: emptySet()
        val allAgents = res?.agents ?: emptyList()
        // Under an ask scope: only THIS window's session can own the prompt (a sibling worktree's
        // session is its own conversation, answering to nobody who typed here), and its subagent rows
        // narrow to the ones that ask spawned.
        val rq = scopedPrompt()
        val scopedAgents =
            if (rq == null) allAgents
            else allAgents.filter { self == null || it.session == self }
        val shown = scopedAgents.filter { MultitaskFilter.showAgent(it, activeOnly, dismissedAgents) }
        if (rq == null) fleetInfoNode(allAgents, shown)?.let { fleetRoot.add(it) }
        val agentNodeFor: (RunningAgent) -> DefaultMutableTreeNode = { agent ->
            val collides = agent.files.any { it in collisionFiles }
            val agentNode = DefaultMutableTreeNode(AgentRow(agent, collides))
            val subs = if (rq == null) agent.subagents else agent.subagents.filter { it.agentId in rq.agentIds }
            subs.forEach { agentNode.add(DefaultMutableTreeNode(SubRow(agent.session, it))) }
            agentNode
        }
        // FOLDED (0.9.0): conversations quiet for over a week sink under one collapsed parent, and the
        // Overview no longer rebuilds their change maps every refresh — 24 of 33 siblings in a mature
        // repo. A tree node is the fold: it starts collapsed, and opening it is the ask.
        val (liveAgents, oldAgents) = shown.partition { !it.folded }
        liveAgents.forEach { fleetRoot.add(agentNodeFor(it)) }
        if (oldAgents.isNotEmpty()) {
            val group = DefaultMutableTreeNode(FoldedGroup(oldAgents.size))
            oldAgents.forEach { group.add(agentNodeFor(it)) }
            fleetRoot.add(group)
        }
        if (rq != null) {
            val hiddenAgents = allAgents.size - scopedAgents.size
            val hiddenSubs = scopedAgents.sumOf { a -> a.subagents.count { it.agentId !in rq.agentIds } }
            if (hiddenAgents > 0 || hiddenSubs > 0) {
                val bits = mutableListOf<String>()
                if (hiddenAgents > 0) bits.add("$hiddenAgents sibling session${if (hiddenAgents == 1) "" else "s"}")
                if (hiddenSubs > 0) bits.add("$hiddenSubs subagent${if (hiddenSubs == 1) "" else "s"}")
                fleetRoot.insert(
                    DefaultMutableTreeNode(ScopeInfo("${bits.joinToString(" · ")} hidden — not started by prompt #${rq.index}")),
                    0,
                )
            }
        }
        fleetModel.reload()
        // Expand every agent's subagents, and set the folded group to whatever the reader last chose.
        //
        // This was `TreeUtil.expandAll(fleetTree)` followed by a guarded re-collapse, which could never
        // work: expandAll expands the folded group too, that fires treeExpanded, the listener sets
        // foldOpen = true, and the very next line skips the collapse because foldOpen is now true. A
        // week of old sessions sprang open on every transcript tick. expandAll also delegates to
        // promiseExpandAll and drops the promise, so on the async path the deferred expansion lands
        // AFTER the collapse and re-opens it — both timings end expanded.
        //
        // Walking the nodes ourselves is synchronous, decides the fold once, and never expands it as a
        // side effect of expanding something else.
        repainting = true
        try {
            com.cellobservatory.observatory.model.FleetTreeFold.apply(fleetTree, fleetRoot, foldOpen) { it is FoldedGroup }
        } finally {
            repainting = false
        }
        repaintWorkflows(res?.workflows)
        repaintTasks(res?.tasks ?: emptyList())
        repaintProcesses(lastProcesses)
        // LAST, deliberately: repaintTasks and repaintProcesses set their own tab titles, so a scoped
        // badge written before them survived only until the next tick.
        repaintNavCounts()
        restoreSelection()
        suppressSel = false
        refreshScopeNotes()
    }

    /** Paint the Processes tab — background shells in core's order (oldest first) — and badge the tab
     *  running/total (+ how many FAILED, the one state worth finding the tab for, + how many Clear
     *  completed folded away), so a shell still going is visible without opening it.
     *
     *  The tab itself only exists once the CLI ANSWERED `processes --json`: an older CLI on PATH cannot
     *  fill it, and a permanently empty tab reading "no background shells" would assert as observed fact
     *  something nothing ever looked at (VS Code hides it the same way). */
    private fun repaintProcesses(res: ProcessesResult?) {
        // Folded by Clear completed — dismissed, never deleted, and the tab header says how many are
        // hidden so a shrunken list never reads as "these never happened". A shell that goes back to
        // running would reappear, the same rule the fleet's dismiss uses.
        val rqP = scopedPrompt()
        // Under an ask scope: the shells that ask launched. Attribution is by START, so a long-lived
        // shell never migrates to a later ask just because it was still running when that one arrived.
        val scoped = (res?.processes ?: emptyList()).let { list -> if (rqP == null) list else list.filter { it.id in rqP.processIds } }
        // Active only (the shared toggle) hides shells that have EXITED — the same rule that hides
        // finished agents and runs — so the pane shows only what is still going. The count it drops is
        // remembered so an emptied list reads as the filter's doing, not "this session ran none".
        val exitedHidden = if (activeOnly) scoped.count { !it.running } else 0
        val all = if (activeOnly) scoped.filter { it.running } else scoped
        val shown = all.filter { it.running || it.id !in dismissedProcesses }
        val folded = all.size - shown.size
        processesModel.clear()
        shown.forEach { processesModel.addElement(it) }
        processesList.emptyText.text = when {
            rqP != null && scoped.isEmpty() -> "Prompt #${rqP.index} launched no background shell"
            activeOnly && all.isEmpty() ->
                "No running shells" + (if (exitedHidden > 0) " — clear Active only to see the $exitedHidden that ${if (exitedHidden == 1) "has" else "have"} exited" else "")
            folded > 0 && shown.isEmpty() -> "Every shell has been cleared from this list — click the Processes tab header to bring them back"
            else -> processesEmptyText(res)
        }
        if (!::navTabs.isInitialized) return
        if (res == null && !processesShown) return // never answered — nothing to mount or badge
        if (!processesShown) {
            processesShown = true
            mountProcesses()
        }
        // The badge counts what the tab WILL SHOW: under an ask scope that is the shells this ask
        // launched, not the session's — a badge that contradicts the pane it labels is worse than none.
        val sum = res?.summary?.let {
            if (rqP == null) it else ProcessSummary(total = all.size, running = all.count { p -> p.running }, failed = 0)
        }
        // Shells are read for the session under review only, and the payload carries none per sibling.
        // With another agent selected the honest badge is NO badge (0.9.0): the reviewed session's count
        // beside a pane the reader believes is scoped to their selection is worse than showing nothing.
        val otherAgent = scopedSession()?.let { it != service().currentSession() } ?: false
        setTabTip(MEMBER_PROCESSES, if (otherAgent) PROCESSES_UNSCOPED_TIP else PROCESSES_TIP)
        setTabBadge(
            MEMBER_PROCESSES,
            if (otherAgent || sum == null || sum.total == 0) "Processes"
            else "Processes ${sum.running}/${sum.total}" +
                (if (sum.failed > 0) " · ${sum.failed} failed" else "") +
                (if (folded > 0) " · $folded cleared" else ""),
        )
    }

    /** The three states an empty Processes list can be in, kept distinct: nothing was launched (observed),
     *  the fetch has not landed yet (unknown), and the CLI could not answer at all (unknowable here — that
     *  case normally has no tab, but a CLI that stops answering mid-session must not silently become
     *  "no background shells"). */
    private fun processesEmptyText(res: ProcessesResult?): String = when {
        res != null -> "No background shells — this session never ran a command with run_in_background"
        !service().processesAttempted -> "Reading this session’s background shells…"
        else -> "The oak CLI on PATH did not answer `processes --json` — update it to list background shells"
    }

    /** Paint the Tasks tab (the session's numbered task list) and badge the tab with done/total. Each row
     *  joins core's STRICT per-task rollup by taskId, so its ±/edit counts cover exactly the edits captured
     *  while that to-do was in progress — nothing is swept in from around it. Completed tasks fold behind a
     *  "N done · show all" row; Active-only hides them outright (the fleet's filter semantics).
     *
     *  A picked ask does NOT filter this list: a prompt slice carries no task-id set, and quietly showing a
     *  subset would state an attribution core never made. The scope note above the list says so. */
    private fun repaintTasks(tasks: List<SessionTask>) {
        lastTasks = tasks
        val rollBy = map?.rollupByTask?.filter { it.taskId != null }?.associateBy { it.taskId } ?: emptyMap()
        val (done, active) = tasks.partition { it.status == "completed" }
        tasksModel.clear()
        // An empty list means three different things and must not read as one: the session planned
        // nothing, Active only is hiding a finished plan, or the payload has not landed yet.
        tasksList.emptyText.text = when {
            tasks.isNotEmpty() && activeOnly ->
                "Every task is finished — Active only is hiding ${done.size} completed task(s); untoggle it to see them"
            else -> "No tasks — this session plans with a task list only when the agent creates one"
        }
        active.forEach { tasksModel.addElement(TaskRow(it, rollBy[it.taskId])) }
        if (!activeOnly && done.isNotEmpty()) {
            tasksModel.addElement(DoneTasksToggle(done.size, tasksOpen))
            if (tasksOpen) done.forEach { tasksModel.addElement(TaskRow(it, rollBy[it.taskId])) }
        }
        setTabBadge(MEMBER_TASKS, if (tasks.isEmpty()) "Tasks" else "Tasks ${done.size}/${tasks.size}")
    }

    /** Paint the Sessions tab: this workspace's sessions, newest conversation first, with the live one
     *  marked. The rows come from the stat-only `sessions --json` listing — no session's edit log is read
     *  to build them, which is what makes opening this tab (and the Switch Session popup) instant. */
    private fun repaintSessions(res: SessionsResult?) {
        lastSessions = res
        val rows = res?.sessions ?: emptyList()
        sessionsList.emptyText.text = when {
            res != null -> "No sessions on this machine yet"
            !service().sessionsAttempted -> "Reading sessions…"
            else -> "The oak CLI on PATH did not answer `sessions --json` — update it to list sessions"
        }
        sessionsModel.clear()
        if (res != null) sessionsModel.addElement(AutoSessionRow)
        val pinned = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.session?.takeIf { it.isNotBlank() }
        val now = System.currentTimeMillis()
        var shown = 0
        for (group in overviewSessionGroups(rows, pinned, now, activeOnly)) {
            sessionsModel.addElement(WorkspaceHeaderRow(group.workspace, group.count))
            group.recent.forEach { sessionsModel.addElement(it); shown++ }
            if (group.older.isNotEmpty()) {
                sessionsModel.addElement(OlderSessionsToggle(group.older.size, oldSessionsOpen))
                if (oldSessionsOpen) group.older.forEach { sessionsModel.addElement(it); shown++ }
            }
            if (group.hidden > 0) sessionsModel.addElement(FilterInfo("${group.hidden} hidden by Active only"))
        }
        setTabBadge(MEMBER_SESSIONS, if (rows.isEmpty()) "Sessions" else "Sessions $shown/${rows.size}")
        // Mark which row the observatory is on now (the pinned one, else the live one) without firing the
        // selection listener — restoring a highlight must never re-pin anything.
        val pinnedId = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.session
            ?.takeIf { it.isNotBlank() }
            ?: rows.firstOrNull { it.current }?.id
        suppressSel = true
        val idx = (0 until sessionsModel.size()).firstOrNull {
            val row = sessionsModel.getElementAt(it)
            row is SessionRow && row.id == pinnedId
        } ?: -1
        sessionsList.selectedIndex = idx
        suppressSel = false
        // Pinned to a session the listing has no row for: the panels are showing it, so say which, instead
        // of leaving every row unhighlighted with no reason. Only once a listing has ANSWERED: before that,
        // "not listed" is a claim about a payload we do not have. (Same three-state discipline as the
        // empty text above.)
        sessionsDesc.text = if (res != null && pinnedId != null && idx < 0) {
            "<html>$SESSIONS_DESC <b>Reviewing ${pinnedId.take(8)} — $UNLISTED_PIN.</b></html>"
        } else {
            "<html>$SESSIONS_DESC</html>"
        }
    }

    /** Pin the review to [row]'s session, or to NOTHING ([row] null) to follow whichever session is
     *  newest. Writing the setting is the whole action: every surface re-reads it on the refresh that
     *  follows, so the edits, the change map, the feed and the audits all move together. */
    private fun pinSession(row: SessionRow?) {
        // Every listed row is a session on this machine (the parser keeps only local rows).
        // Routed through the shared handler so that during a demo this moves the in-memory override
        // instead of writing a persisted pin that would outlive the demo it points at.
        if (ObservatoryService.getInstance(project).currentSession() == row?.id) return
        ReviewOps.applySessionChoice(project, row?.id)
        ReviewOps.notify(project, row?.let { "Reviewing “${it.displayName}”" } ?: "Following this workspace’s newest session")
    }

    /** Paint the Workflows tab: one node per run — its INFORMATIVE name (description/summary) · agents ·
     *  tokens · time · ±lines · running/done — with its agents GROUPED BY PHASE, each agent showing its
     *  label + tokens/time/edits. Thin — builds userObject nodes; [WorkflowRenderer] paints them. */
    private fun repaintWorkflows(workflows: List<WorkflowRun>?) {
        workflowsRoot.removeAllChildren()
        val rqW = scopedPrompt()
        // Under an ask scope: the runs THAT ask started (core attributes by start, so a run still going
        // stays with the ask that launched it).
        val allWf = (workflows ?: emptyList()).let { list -> if (rqW == null) list else list.filter { it.id in rqW.workflowIds } }
        val shownWf = allWf.filter { MultitaskFilter.showWorkflow(it, activeOnly, dismissedWorkflows) }
        if (rqW == null) workflowsInfoNode(allWf, shownWf)?.let { workflowsRoot.add(it) }
        else if (allWf.isEmpty()) workflowsRoot.add(DefaultMutableTreeNode(ScopeInfo("Prompt #${rqW.index} started no workflow run")))
        shownWf.forEach { w ->
            val node = DefaultMutableTreeNode(WfRunRow(w))
            val grouped = HashSet<String>()
            w.phaseGroups.forEach { pg ->
                val phaseNode = DefaultMutableTreeNode(WfPhaseRow(pg.title, pg.done, pg.total))
                w.agents.filter { it.phase == pg.title }.forEach { a ->
                    phaseNode.add(DefaultMutableTreeNode(WfAgentRow(a)))
                    grouped.add(a.agentId)
                }
                node.add(phaseNode)
            }
            w.agents.filter { it.agentId !in grouped }.forEach { a -> node.add(DefaultMutableTreeNode(WfAgentRow(a))) }
            workflowsRoot.add(node)
        }
        workflowsModel.reload()
        TreeUtil.expandAll(workflowsTree)
    }

    /**
     * The ask the Prompts window has picked, resolved against THIS payload's per-prompt slices.
     *
     * Null when nothing is picked — and also when the payload cannot describe the pick (an older CLI
     * with no `prompts` in `changemap --json`). Both mean the same thing here: nothing is filtered. A
     * panel that showed a scope banner over unfiltered rows would be asserting something untrue.
     */
    private fun scopedPrompt(): ChangeMapPrompt? {
        val id = service().selectedPromptId ?: return null
        return map?.prompts?.firstOrNull { it.id == id }
    }

    /** Re-select the nav row for the current [selected] after a reload wiped the selection (best-effort). */
    private fun restoreSelection() {
        when (val sel = selected) {
            is NavSel.Agent -> childOf(fleetRoot) { it is AgentRow && it.agent.session == sel.session }
                ?.let { fleetTree.selectionPath = TreePath(it.path) }
            is NavSel.Subagent -> descendantOf(fleetRoot) { it is SubRow && it.sub.agentId == sel.agentId }
                ?.let { fleetTree.selectionPath = TreePath(it.path) }
            is NavSel.Workflow -> childOf(workflowsRoot) { it is WfRunRow && it.id == sel.id }
                ?.let { workflowsTree.selectionPath = TreePath(it.path) }
            // Match on the same strict id the selection was made with — the display number would pick a
            // different row whenever the two disagree.
            is NavSel.Task -> if (sel.id.isNotBlank()) selectRow(tasksList, tasksModel) { it is TaskRow && taskFeedId(it) == sel.id }
            is NavSel.Process -> selectRow(processesList, processesModel) { it.id == sel.id }
            NavSel.Main -> {}
        }
    }

    /** First list row matching [pred] becomes the selection (a no-op when the row is gone — the item was
     *  filtered away or finished being reported). */
    private fun <T> selectRow(list: JBList<T>, model: DefaultListModel<T>, pred: (T) -> Boolean) {
        for (i in 0 until model.size()) {
            if (pred(model.get(i))) { list.selectedIndex = i; return }
        }
    }

    private fun childOf(root: DefaultMutableTreeNode, pred: (Any?) -> Boolean): DefaultMutableTreeNode? {
        for (i in 0 until root.childCount) {
            val n = root.getChildAt(i) as DefaultMutableTreeNode
            if (pred(n.userObject)) return n
        }
        return null
    }

    /** Like [childOf] but one level deeper — subagents hang under their agent's node. */
    private fun descendantOf(root: DefaultMutableTreeNode, pred: (Any?) -> Boolean): DefaultMutableTreeNode? {
        for (i in 0 until root.childCount) {
            val n = root.getChildAt(i) as DefaultMutableTreeNode
            if (pred(n.userObject)) return n
            childOf(n, pred)?.let { return it }
        }
        return null
    }



    // --- the right detail: change-map for the selected nav item ---

    private fun renderDetail() {
        // A background shell edits nothing, so it has no change map. Its feed used to BE the detail
        // here; the feed lives in the Timeline's Feed tab now, so this half says where it went (the
        // selection auto-revealed that tab — the label is confirmation, not a dead end).
        val feedOnly = selected is NavSel.Process
        detailHost.removeAll()
        currentDetail = null
        try {
            val m = map
            // A picked ask outranks the nav selection: it is the coarser scope and the more explicit
            // choice. Selecting a row inside the filtered nav still re-points the FEED, which doesn't
            // conflict with it.
            val td = if (m == null || feedOnly) null
                else scopedPrompt()?.let { promptTabData(it, m) } ?: (tabDataFor(selected, m) ?: tabDataFor(NavSel.Main, m))
            // A CHANGE of scope folds the strip; a refresh of the same scope leaves it as the reader left it.
            val scope = "${service().selectedPromptId ?: ""}|$selected"
            if (scope != stripScope) { stripScope = scope; stripExpanded = false }
            if (td == null) {
                detailHost.add(
                    emptyLabel(
                        if (feedOnly) "A background shell edits nothing, so it has no change map — its activity is in the Timeline window’s Feed tab, which just opened."
                        else "No edits in this session yet — this fills in as agent edits files"
                    ),
                    BorderLayout.CENTER,
                )
            } else {
                val detail = AgentDetail(td)
                currentDetail = detail
                detailHost.add(detail, BorderLayout.CENTER)
            }
        } catch (t: Throwable) {
            // Never leave the detail blank — a paint failure must be visible here, not only in idea.log.
            Logger.getInstance(ChangeMapPanel::class.java).warn("Overview detail failed to render", t)
            detailHost.add(emptyLabel("Overview detail failed to render: ${t.message ?: t.javaClass.simpleName} — see idea.log"), BorderLayout.CENTER)
        }
        detailHost.revalidate()
        detailHost.repaint()
    }

    /** Join the nav selection to a change-map slice: Main → the top-level map; Agent → its `agents[]` entry;
     *  Workflow → its `workflows[]` entry. Returns null when the selected item has no slice (caller falls
     *  back to Main). */
    private fun tabDataFor(sel: NavSel, m: ChangeMap): TabData? = when (sel) {
        NavSel.Main ->
            if (m.summary == null && m.files.isEmpty()) null
            else TabData(
                session = m.summary?.session ?: "", summary = m.summary, files = m.files, modules = m.modules,
            )
        is NavSel.Agent -> m.agents.firstOrNull { it.session == sel.session }?.let { agentTabData(it) }
        is NavSel.Subagent -> m.agents.firstOrNull { it.session == sel.session }?.let { agentTabData(it) }
        is NavSel.Workflow -> m.workflows.firstOrNull { it.id == sel.id }?.let { workflowTabData(it, m) }
        // Neither a task nor a background shell owns a change-map slice: core slices by agent and by
        // workflow, and a shell edits nothing at all. The caller falls back to the session map.
        is NavSel.Task, is NavSel.Process -> null
    }

    /** One ASK's detail: its own rollup and its churn-ranked files and folders — all aggregated in core
     *  (ChangeMapPrompt), so this only re-labels them. */
    private fun promptTabData(r: ChangeMapPrompt, m: ChangeMap): TabData {
        val summary = ChangeMapSummary(
            session = m.summary?.session ?: "", title = "#${r.index} ${r.title}", units = r.rollup.edits,
            pending = r.rollup.pending, kept = r.rollup.kept, undone = r.rollup.undone,
            added = r.rollup.added, removed = r.rollup.removed, errors = r.errors, subagents = r.agentIds.size,
            fleet = 0, egress = 0,
        )
        return TabData(
            session = m.summary?.session ?: "", summary = summary, files = r.files, modules = r.modules,
        )
    }

    private fun agentTabData(a: ChangeMapAgent) = TabData(
        session = a.session, summary = a.summary, files = a.files, modules = a.modules,
    )

    /** One workflow's detail: a synthetic summary from its rollup and its churn-ranked touched files. */
    private fun workflowTabData(w: ChangeMapWorkflow, m: ChangeMap): TabData {
        val r = w.rollup
        val summary = ChangeMapSummary(
            session = m.summary?.session ?: "", title = m.summary?.title, units = r.edits, pending = r.pending, kept = r.kept, undone = r.undone,
            added = r.added, removed = r.removed, errors = 0, subagents = 0, fleet = 0, egress = 0,
        )
        return TabData(
            session = m.summary?.session ?: "", summary = summary, files = w.files, modules = emptyList(),
            running = w.running,
        )
    }

    private fun emptyLabel(text: String): JComponent = JBLabel(text).apply {
        border = JBUI.Borders.empty(12)
        foreground = UIUtil.getContextHelpForeground()
    }

    /** A left-nav pane with a one-line muted description above its content (the VS Code .ov-desc). */
    private fun descPane(desc: String, content: JComponent): JComponent = descPane(descLabel(desc), content)

    /** …the same pane over a description label the caller keeps (so it can be re-worded live). */
    private fun descPane(label: JBLabel, content: JComponent): JComponent = JPanel(BorderLayout()).apply {
        add(label, BorderLayout.NORTH)
        add(content, BorderLayout.CENTER)
    }

    private fun descLabel(desc: String): JBLabel = JBLabel("<html>$desc</html>").apply {
        font = JBUI.Fonts.smallFont()
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(4, 6, 5, 6)
    }

    /** The session-name label leading the top row — VS Code's `ov-sess-label`: the human-readable
     *  session title (the Sessions rows' title — a rename, else the claude.ai title, else the agent's ai-title, else the first prompt) on ONE
     *  line, never wrapped and NEVER clipped (user call 2026-07-28): the whole name shows, and a tight
     *  row is the toolbar's problem (its overflow), not the title's. The tooltip carries the raw
     *  session id. A label, not a control: switching sessions is a Sessions-tab click. */
    private fun sessionLabelAction(): AnAction =
        object : AnAction(), CustomComponentAction, DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun actionPerformed(e: AnActionEvent) {} // a label, not a control
            override fun update(e: AnActionEvent) {
                val s = map?.summary
                val sess = s?.session.orEmpty()
                // The SAME source VS Code's label reads: the Sessions rows carry the agent's title for
                // every session (a rename, else the claude.ai title, else ai-title, else first prompt — core). The change-map
                // summary's title alone is blank for sessions whose transcript insights carry neither,
                // which is how the demo session rendered as its raw id.
                val rowTitle = lastSessions?.sessions?.firstOrNull { it.id == sess }?.title?.trim().orEmpty()
                val title = rowTitle.ifEmpty { s?.title?.trim().orEmpty() }
                // setText(text, FALSE): titles are prose — with mnemonic parsing on, "save_load"
                // renders as "saveload" and "&" vanishes (underscore/ampersand become mnemonics).
                e.presentation.setText(
                    "🔬 " + title.ifEmpty { if (sess.isEmpty()) "session —" else "session ${sess.take(8)}" },
                    false,
                )
                e.presentation.description =
                    (if (title.isEmpty()) "" else "$title — ") +
                        (if (sess.isEmpty()) "no active Claude Code session" else "session $sess") +
                        " · switch in the Sessions tab"
            }
            override fun createCustomComponent(presentation: Presentation, place: String): JComponent =
                JBLabel().apply {
                    // Uncapped: the FULL title renders (JLabel is single-line by nature, so it can
                    // never wrap); a row too tight for label + buttons overflows into the toolbar's
                    // own "…" chevron rather than costing the title characters.
                    font = JBUI.Fonts.smallFont()
                    border = JBUI.Borders.empty(0, 4, 0, 6)
                }
            override fun updateCustomComponent(component: JComponent, presentation: Presentation) {
                (component as JBLabel).text = presentation.text
                component.toolTipText = presentation.description
            }
        }

    /** Release-channel info for the version chip — fetched off the EDT via the CLI (`version --check
     *  --json`, the shared backend), cached an hour. @Volatile: the popup builds its rows on whatever
     *  thread expands it. */
    @Volatile private var versionInfo: ObservatoryCli.VersionCheck? = null
    @Volatile private var versionFetchedAtMs = 0L

    private fun refreshVersionInfo(force: Boolean = false) {
        val now = System.currentTimeMillis()
        // The throttle holds on FAILURE too (a shorter negative TTL): the platform expands a popup
        // group's children on every toolbar update pass, so a missing/old/offline CLI must not spawn
        // a `version --check` process per tick — 30s-capped spawns with no in-flight guard pile up.
        val ttlMs = if (versionInfo == null) 5 * 60 * 1000L else 60 * 60 * 1000L
        if (!force && versionFetchedAtMs != 0L && now - versionFetchedAtMs < ttlMs) return
        versionFetchedAtMs = now
        ApplicationManager.getApplication().executeOnPooledThread {
            ObservatoryCli.versionCheck(project.basePath)?.let { versionInfo = it }
        }
    }

    /** This plugin's OWN installed version — what the chip label shows (each surface shows what is
     *  actually running there; the CLI reports its own in the dropdown's rows). */
    private fun pluginVersion(): String =
        com.intellij.ide.plugins.PluginManagerCore.getPlugin(
            com.intellij.openapi.extensions.PluginId.getId("com.cell-observatory.oak-observatory")
        )?.version ?: ""

    /** The version chip closing the top row (VS Code's `ov-version`, pinned right): the running
     *  version, opening Update Now + the Stable ⇄ Pre-release channel switch. Every action runs the
     *  CLI's `update` — the one updater for all surfaces — then asks for an IDE restart. */
    private fun versionGroup(): AnAction =
        object : DefaultActionGroup("v" + pluginVersion().ifEmpty { "—" }, true), DumbAware {
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the label
            override fun displayTextInToolbar() = true
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun update(e: AnActionEvent) {
                // The chip itself signals an available update — a dot beside the version, the same
                // signal VS Code's chip shows — and each tick (throttled) keeps the info current.
                refreshVersionInfo()
                val v = versionInfo
                val chLatest = if (v?.channel == "dev") v.devLatest ?: v.stableLatest else v?.stableLatest
                e.presentation.setText(
                    "v" + pluginVersion().ifEmpty { "—" } + (if (v?.updateAvailable == true) " ●" else ""),
                    false,
                )
                e.presentation.description =
                    (if (v?.updateAvailable == true && chLatest != null) "Update available — v$chLatest. " else "") +
                        "OAK version — update, or switch between the stable and pre-release channels"
            }
            override fun getChildren(e: AnActionEvent?): Array<AnAction> {
                val v = versionInfo
                    ?: return arrayOf(
                        // The Update row stays reachable even before (or without) release info —
                        // the CLI does its own check, so clicking is always safe (VS Code parity).
                        action("Update Now", AllIcons.Actions.Download, "Update the CLI + both editor plugins; reports up to date when nothing is newer") { runUpdateCli(null) },
                        com.intellij.openapi.actionSystem.Separator.getInstance(),
                        action("Checking for releases…", AllIcons.Actions.Refresh, "Fetch release info again (needs the oak CLI + network)") { refreshVersionInfo(force = true) },
                    )
                val rows = mutableListOf<AnAction>()
                val chLatest = if (v.channel == "dev") v.devLatest ?: v.stableLatest else v.stableLatest
                // WHAT IS INSTALLED, per surface (VS Code parity). "Update Now" moves the plugin AND
                // the CLI, which carry independent versions — showing one number for both is how the
                // dropdown came to disagree with what was actually on the machine. These rows are a
                // report: disabled, nothing to click.
                rows += infoRow("Plugin", pluginVersion(), if (v.stranded) "not on this channel" else null)
                rows += infoRow("CLI", v.current, if (v.stranded) "not on this channel" else null)
                rows += com.intellij.openapi.actionSystem.Separator.getInstance()
                // ALWAYS present (user call 2026-07-28, VS Code parity): clicking while current is a
                // safe no-op — runUpdateCli reads the plan and shows a balloon instead of the restart
                // dialog — and doubles as a manual re-check. "up to date" is only claimed when the
                // release feed actually answered.
                val updateText =
                    if (v.stranded && chLatest != null) "Move onto the channel — v$chLatest"
                    else if (v.updateAvailable && chLatest != null) "Update Now — v$chLatest"
                    else if (chLatest != null) "Update Now — up to date (v${v.current.ifEmpty { "—" }})"
                    else "Update Now"
                rows += action(updateText, AllIcons.Actions.Download, "Update the CLI + both editor plugins; reports up to date when nothing is newer") { runUpdateCli(null) }
                rows += com.intellij.openapi.actionSystem.Separator.getInstance()
                val stableText = (if (v.channel != "dev") "✓ " else "") + "Stable" + (v.stableLatest?.let { " — v$it" } ?: "")
                val devText = (if (v.channel == "dev") "✓ " else "") + "Pre-release" + (v.devLatest?.let { " — v$it" } ?: " — none yet")
                rows += action(stableText, AllIcons.Actions.Commit, "Tagged releases") {
                    if (v.channel != "stable") runUpdateCli("stable")
                }
                rows += action(devText, AllIcons.Actions.Lightning, "Rolling build of the dev branch — newest features, less soak") {
                    if (v.channel != "dev") runUpdateCli("dev")
                }
                return rows.toTypedArray()
            }
        }.apply {
            templatePresentation.description =
                "OAK version — update, or switch between the stable and pre-release channels"
        }

    /** Run the CLI's `update` (optionally switching `--channel`) in the background and report. The
     *  CLI pass rewrites the installed plugin on disk; the restart POP-UP appears only when something
     *  was actually installed (the CLI prints its exact up-to-date summary line otherwise), and
     *  "Restart IDE" performs the restart — parity with VS Code's Reload-Window offer. */
    private fun runUpdateCli(channel: String?) {
        val what = when (channel) { null -> "Updating OAK"; "dev" -> "Switching to the Pre-release channel"; else -> "Switching to the Stable channel" }
        ReviewOps.notify(project, "$what — this refreshes the CLI and both editor plugins…")
        ApplicationManager.getApplication().executeOnPooledThread {
            // ASK FIRST, as data. Whether this plugin is about to be rewritten decides whether a
            // restart is worth demanding, and the old way of finding out — searching the CLI's prose
            // for "everything is up to date" — is a contract nobody was enforcing. It also matched
            // the substring inside "CLI is up to date (…); no editor extensions detected locally.",
            // so a run that installed nothing at all could still claim otherwise, and vice versa.
            val before = ObservatoryCli.updatePlan(channel, project.basePath)
            val pluginWillMove = before == null || before.any { it.surface == "jetbrains" && it.reason != "current" }
            val (ok, out) = ObservatoryCli.update(channel, project.basePath)
            versionFetchedAtMs = 0L
            refreshVersionInfo(force = true)
            ApplicationManager.getApplication().invokeLater {
                when {
                    !ok -> ReviewOps.notify(project, "$what failed: ${out.take(300).ifBlank { "is the oak CLI installed?" }}", NotificationType.ERROR)
                    !pluginWillMove ->
                        ReviewOps.notify(project, "$what done — already on the newest build, no restart needed.")
                    else -> {
                        val restart = Messages.showYesNoDialog(
                            project,
                            "$what done — the plugin on disk was replaced.\n\nRestart the IDE now to load the new build?",
                            "OAK",
                            "Restart IDE",
                            "Later",
                            Messages.getQuestionIcon(),
                        )
                        if (restart == Messages.YES) ApplicationManager.getApplication().restart()
                        else ReviewOps.notify(project, "New build loads on the next IDE restart.")
                    }
                }
            }
        }
    }

    /** Export — ONE dropdown, both exports (parity with VS Code's Export button + picker): the
     *  shareable review summary (kept / reverted per file, markdown), or the FULL session trace of
     *  everything the observatory recorded (JSON; core.buildSessionTrace via the `export` verb). */
    private fun exportGroup(): AnAction =
        object : DefaultActionGroup("Export", true), DumbAware {
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the label
            override fun displayTextInToolbar() = true
        }.apply {
            templatePresentation.icon = NavTint.tint(AllIcons.ToolbarDecorator.Export, NavTint.BLUE)
            templatePresentation.description =
                "Export — a shareable review summary (markdown), or the full session trace of everything recorded (JSON)"
            add(action("Review Summary (markdown)", AllIcons.FileTypes.Text) {
                withSession { s ->
                    ReviewOps.openMarkdown(
                        project, "claude-observatory-review-summary",
                        "Could not export the review summary (is the oak CLI installed?)",
                    ) { ObservatoryCli.summaryMarkdown(s, project.basePath) }
                }
            })
            add(action("Full Session Trace (JSON)", AllIcons.FileTypes.Json) {
                withSession { s ->
                    ReviewOps.openJson(
                        project, "claude-observatory-trace",
                        "Could not export the session trace — is the oak CLI installed? " +
                            "For very large sessions, run `oak export --out trace.json` in a terminal.",
                    ) { ObservatoryCli.traceJson(s, project.basePath) }
                }
            })
        }

    /** An Overview-toolbar button: [text] renders beside the icon (VS Code shows these labels), with an
     *  optional longer [description] as the tooltip. */
    /** A demo-mode button, shown only in the state its verb belongs to: Start before a demo exists,
     *  Restart / Guided Tour / Exit once one does. Same helper shape as the Edits tree's, so the two
     *  toolbars cannot disagree about when a verb applies. `update` runs on a background thread because
     *  [ReviewOps.demoPresent] touches the filesystem (behind its own short cache). */
    private fun demoAction(text: String, icon: Icon, wantDemo: Boolean, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            // ICON ONLY, matching VS Code's compact demo buttons. Labelled, these four were the widest
            // thing on a bar that is already fighting for room; the tooltip carries the verb.
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun update(e: AnActionEvent) {
                e.presentation.isEnabledAndVisible = ReviewOps.demoPresent(project) == wantDemo
            }
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private fun action(text: String, icon: Icon, description: String? = null, run: () -> Unit): AnAction =
        object : AnAction(text, description, icon), DumbAware {
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the label
            override fun displayTextInToolbar() = true
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** A non-clickable REPORT row for the version dropdown: "<what> — v<version> · <note>". Disabled
     *  on purpose — it states what is installed on this machine, and there is nothing to press. An
     *  absent version renders "—" rather than borrowing a number from another surface. */
    private fun infoRow(what: String, version: String, note: String?): AnAction =
        object : AnAction("$what — v${version.ifEmpty { "—" }}" + (note?.let { " · $it" } ?: "")), DumbAware {
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the label
            override fun displayTextInToolbar() = true
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun update(e: AnActionEvent) {
                e.presentation.isEnabled = false
            }
            override fun actionPerformed(e: AnActionEvent) = Unit
        }

    /** The same button WITHOUT its label — glyph only, the verb carried by the tooltip. [action]'s
     *  labels are what VS Code shows for the review verbs; the row's trailing "about this extension"
     *  controls are icons there too, and this row is already fighting for width. */
    private fun iconAction(text: String, icon: Icon, description: String? = null, run: () -> Unit): AnAction =
        object : AnAction(text, description, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** A top-toolbar bulk action that RETARGETS to the ask the Prompts window has picked: it runs
     *  [promptRun] against that ask's own edits and presents [scopedText]; with nothing picked it runs
     *  [sessionRun] session-wide and presents [baseText]. */
    private fun bulkAction(
        baseText: String,
        icon: Icon,
        scopedText: (String) -> String,
        sessionRun: () -> Unit,
        promptRun: (ChangeMapPrompt) -> Unit,
    ): AnAction = object : AnAction(baseText, null, icon), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT // reads the picked ask, not the UI
        @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the scoped label
        override fun displayTextInToolbar() = true
        override fun update(e: AnActionEvent) {
            val pick = scopedPrompt()
            e.presentation.text = if (pick != null) scopedText("#${pick.index}") else baseText
        }

        override fun actionPerformed(e: AnActionEvent) {
            val pick = scopedPrompt()
            if (pick != null) promptRun(pick) else sessionRun()
        }
    }

    /** The store records one PICKED ask attributed to — resolved against the live log so a bulk op acts on
     *  what is there now, not on what the payload said when it was fetched. */
    private fun editsOfPrompt(r: ChangeMapPrompt): List<EditRecord> {
        val ids = r.editIds.toHashSet()
        return service().log().filter { it.id in ids }.sortedBy { it.id }
    }

    private fun service() = ObservatoryService.getInstance(project)

    /** Run [block] with the active session, or warn if there is none — mirrors ObservationsPanel.withSession. */
    /**
     * The session the Overview's own actions act on: the SELECTED fleet row, else the reviewed one.
     *
     * Every caller below reaches the store through a session-only CLI verb (`keep --all`, `undo --all`,
     * `clean --resolved`), never by handing it records read from another session's log — edit ids are
     * per-session integers, so pairing a sibling's id with this session's records would apply them to
     * unrelated edits and revert files in the wrong worktree.
     */
    /** The REVIEWED session only — for verbs whose payload (edit ids, prompt scopes) was derived from
     *  the reviewed session's log and must never travel to a selected sibling. */
    private fun withReviewedSession(block: (String) -> Unit) {
        val s = service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", com.intellij.notification.NotificationType.WARNING)
            return
        }
        block(s)
    }

    private fun withSession(block: (String) -> Unit) {
        val s = scopedSession() ?: service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", com.intellij.notification.NotificationType.WARNING)
            return
        }
        block(s)
    }

    // --- Active-only + Clear-completed toolbar actions (apply to the Fleet + Workflows nav). Display-only. ---

    // The Active-only / Clear-completed classification lives in model.MultitaskFilter — the shared
    // Kotlin port of VS Code's canonical multitaskFilter (pinned by MultitaskFilterTest, no drift).
    private fun agentActive(a: RunningAgent) = MultitaskFilter.agentActive(a)

    private fun activeOnlyToggle(): ToggleAction = object : ToggleAction(
        "Active Only",
        "Show only active agents (working / awaiting input / awaiting permission, or with an active subagent) and running workflows — and scope the change map on the right to work still awaiting review",
        AllIcons.General.Filter,
    ), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT // reads one flag
        @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the label
        override fun displayTextInToolbar() = true
        override fun isSelected(e: AnActionEvent) = activeOnly
        override fun setSelected(e: AnActionEvent, state: Boolean) {
            activeOnly = state
            repaintNav(lastResult)
            // The toggle scopes the DETAIL too (VS Code parity): one control, one meaning across the panel.
            renderDetail()
        }
    }

    /** Show every nav tab side by side as columns of one group, and back. Layout ONLY — nothing is
     *  filtered and the change-map detail is untouched. It lives beside the tab strip it rearranges (see
     *  navHost); icon-only there, because a label in that slot would push into the tabs themselves. */
    private fun groupedNavToggle(): ToggleAction = object : ToggleAction(
        "Group Tabs",
        "Group all tabs side by side (Sessions · Workers · Workflows · Tasks · Processes)",
        AllIcons.Actions.SplitVertically,
    ), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT // reads one flag
        override fun isSelected(e: AnActionEvent) = groupedNav
        override fun setSelected(e: AnActionEvent, state: Boolean) = applyGroupedNav(state)
    }

    /** Fold every SETTLED item out of the nav: done agents, finished workflow runs, and exited background
     *  shells. Display-only — nothing is deleted, each tab admits how many it is hiding, and anything that
     *  goes active again comes straight back. (VS Code's `clearCompleted`; 0.8.7 added the shells, which
     *  are finished work exactly like a done agent or run.) */
    private fun clearCompletedAction(): AnAction = action(
        "Clear Completed",
        NavTint.CLEAR,
        "Hide completed agents, finished workflow runs, and exited background shells (display-only — never deletes anything; click a tab's “show all” / the Processes tab header to bring them back)",
    ) {
        lastResult?.agents?.filter { !agentActive(it) }?.forEach { dismissedAgents.add(it.session) }
        lastResult?.workflows?.filter { !it.running }?.forEach { dismissedWorkflows.add(it.id) }
        // A RUNNING shell is never folded — it is the reason to look at the tab at all.
        lastProcesses?.processes?.filter { !it.running }?.forEach { dismissedProcesses.add(it.id) }
        repaintNav(lastResult)
    }

    private fun fleetInfoNode(all: List<RunningAgent>, shown: List<RunningAgent>): DefaultMutableTreeNode? {
        val hidden = all.count { it.session in dismissedAgents && !agentActive(it) }
        val parts = mutableListOf<String>()
        if (activeOnly) parts += "Active only — showing ${shown.size} of ${all.size} agent${if (all.size == 1) "" else "s"}"
        // Wording + click-to-restore mirror the VS Code filter bar's "N hidden · show all".
        if (hidden > 0) parts += "$hidden hidden · show all"
        return if (parts.isEmpty()) null else DefaultMutableTreeNode(FilterInfo(parts.joinToString("  ·  ")))
    }

    private fun workflowsInfoNode(all: List<WorkflowRun>, shown: List<WorkflowRun>): DefaultMutableTreeNode? {
        val hidden = all.count { it.id in dismissedWorkflows && !it.running }
        val parts = mutableListOf<String>()
        if (activeOnly) parts += "Active only — showing ${shown.size} of ${all.size} workflow${if (all.size == 1) "" else "s"}"
        if (hidden > 0) parts += "$hidden hidden · show all"
        return if (parts.isEmpty()) null else DefaultMutableTreeNode(FilterInfo(parts.joinToString("  ·  ")))
    }

    // --- nav node userObjects ---

    private class AgentRow(val agent: RunningAgent, val collides: Boolean)
    /** Parent of the week-old sessions (0.9.0) — collapsed by default; see the fleet build above. */
    private class FoldedGroup(val count: Int)
    private class SubRow(val session: String, val sub: MtSubagent)
    private class WfRunRow(val run: WorkflowRun) {
        val id: String get() = run.id
    }
    private class WfPhaseRow(val title: String, val done: Int, val total: Int)
    private class WfAgentRow(val agent: WorkflowAgent)
    private class FilterInfo(val text: String) {
        override fun toString(): String = text
    }

    /** The ask-scope note ("N hidden — not started by prompt #7"). Deliberately NOT a [FilterInfo]:
     *  clicking that one restores what "Clear completed" folded away, which has nothing to do with a
     *  prompt scope, and a row whose click does something unrelated to what it says is worse than none. */
    private class ScopeInfo(val text: String) {
        override fun toString(): String = text
    }

    private class FleetRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is AgentRow -> renderAgent(node)
                is FoldedGroup -> {
                    icon = AllIcons.Vcs.History
                    append("${node.count} older session${if (node.count == 1) "" else "s"}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "Conversations quiet for over a week. They are not rebuilt on refresh — expanding one is what asks for it."
                }
                is SubRow -> renderSubagent(node.sub)
                is FilterInfo -> {
                    icon = AllIcons.General.Filter
                    append(node.text, SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is ScopeInfo -> {
                    icon = AllIcons.General.Filter
                    append(node.text, SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES)
                }
            }
        }

        private fun renderAgent(node: AgentRow) {
            val a = node.agent
            val (glyph, attrs) = phaseBadge(a.phase)
            icon = phaseIcon(a.phase)
            // A '~' marks a staleness-INFERRED phase (awaiting-permission/idle/done have no structural
            // marker) — parity with the VS Code badge; the tooltip carries the explanation.
            val heuristic = a.phaseConfidence == "heuristic"
            val head = (if (a.self) "(you) " else "") + a.gitBranch.ifBlank { a.session.take(8) }
            append("$glyph${if (heuristic) "~" else ""} ", attrs)
            append("$head  ", SimpleTextAttributes.REGULAR_ATTRIBUTES)
            append(baseName(a.worktree), SimpleTextAttributes.GRAYED_ATTRIBUTES)
            // A folded session whose map was never built has no numbers — and +0 −0 / 0 tok would read
            // as "this session did nothing", which is a different claim entirely. Say which one it is.
            if (!a.loaded) {
                append("  not loaded", SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES)
                toolTipText = "Folded — the change map for this session was not rebuilt, so there are no numbers to show. Open it from the Sessions tab to build one."
                return
            }
            if (a.added > 0 || a.removed > 0) {
                append("  +${a.added}", MT_ADD)
                append(" −${a.removed}", MT_REM)
            }
            // 0.8.0: tokens + wall-clock, the same metric style Workflows already show.
            if (a.tokens > 0 || a.durationMs > 0) append("  ${fmtTok(a.tokens)} tok · ${fmtDur(a.durationMs)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            if (a.riskTotal > 0) append("  ⚠ ${if (a.riskHigh > 0) "${a.riskHigh} high" else "${a.riskTotal}"}",
                if (a.riskHigh > 0) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
            if (node.collides) append("  ⛒ collision", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
            // How far past its own worktree this agent reached — the one footprint fact that survived the
            // 0.8.7 fold into the risk/egress audits, and the only one worth a glance on a fleet row. Read
            // and written stay SEPARATE clauses, never summed: "it read somewhere else" and "it wrote
            // somewhere else" are different findings, and the second is the one that changes files.
            val outside = a.outside
            if (outside != null && outside.any) {
                val parts = listOfNotNull(
                    outside.reads.takeIf { it > 0 }?.let { "$it read" },
                    outside.writes.takeIf { it > 0 }?.let { "$it written" },
                )
                append("  ↗ ${parts.joinToString(" · ")} outside", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
            }
            if (a.compactions > 0) append("  ⌁ ${a.compactions}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            toolTipText = buildString {
                append(if (a.self) "This session: " else "Agent: ").append(a.session).append("\n")
                append("phase ${a.phase}").append(if (heuristic) " (~ inferred from inactivity)" else "").append("\n")
                append("worktree ${a.worktree}").append("  ·  branch ${a.gitBranch}").append("\n")
                append("${fmtTok(a.tokens)} tok · ${fmtDur(a.durationMs)}")
                if (a.todos.isNotEmpty()) {
                    val cur = a.todos.firstOrNull { it.status == "in_progress" } ?: a.todos.lastOrNull()
                    cur?.let { append("\ntask: ${it.content}") }
                }
                outside?.let { o ->
                    if (o.reads > 0) append("\n${o.reads} file(s) read outside its workspace")
                    if (o.writes > 0) append("\n${o.writes} file(s) written outside its workspace")
                }
                if (a.compactions > 0) append("\n${a.compactions} context compaction(s)")
                append("\nSelect to map this agent's changes on the right")
            }
        }

        private fun renderSubagent(s: MtSubagent) {
            val (glyph, _) = phaseBadge(s.phase)
            icon = phaseIcon(s.phase)
            val heuristic = s.phaseConfidence == "heuristic"
            val title = s.agentType ?: s.description ?: s.agentId.take(12)
            // Subagent identity in PURPLE — the VS Code webview's --mt-agent accent.
            append(title, SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_AGENT))
            append("  $glyph ${s.phase}${if (heuristic) "~" else ""}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            s.currentTask?.takeIf { it.isNotBlank() }?.let { append("  · ${clip(it, 48)}", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
            if (s.edits > 0 || s.added > 0 || s.removed > 0) {
                append("  +${s.added}", MT_ADD)
                append(" −${s.removed}", MT_REM)
            }
            // The spawn's OWN model · effort · ↑in·↓out·↺cache · runtime — parity with the terminal's spawn
            // rows; the same statusline-style token split, greyed like the rest.
            val me = listOfNotNull(s.model?.takeIf { it.isNotBlank() }, s.effort?.takeIf { it.isNotBlank() }).joinToString(" · ")
            val meta = buildList {
                if (me.isNotEmpty()) add(me)
                if (s.tokensIn > 0 || s.tokensOut > 0 || s.tokensCacheRead > 0) add("↑${fmtTok(s.tokensIn)} ↓${fmtTok(s.tokensOut)} ↺${fmtTok(s.tokensCacheRead)}")
                if (s.durationMs > 0) add(fmtDur(s.durationMs))
            }
            if (meta.isNotEmpty()) append("  ${meta.joinToString(" · ")}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            toolTipText = buildString {
                append(title)
                if (s.description != null && s.agentType != null) append("\n${s.description}")
                append("\nphase ${s.phase}${if (heuristic) " (~ inferred: no completion notice or structural marker yet)" else ""} · agent ${s.agentId}")
                if (s.todos.isNotEmpty()) {
                    append("\n")
                    s.todos.take(8).forEach { append("\n• [${it.status}] ${it.content}") }
                }
            }
        }

        private fun phaseIcon(phase: String): Icon = when (phase) {
            "working" -> AllIcons.Actions.Execute
            "awaiting-input", "awaiting-permission" -> AllIcons.General.BalloonWarning
            "errored" -> AllIcons.General.Error
            "done" -> AllIcons.Actions.Commit
            else -> AllIcons.Actions.Pause
        }
    }

    /** Paints the Workflows tab (mirrors [FleetRenderer]): a run row = status badge + INFORMATIVE name +
     *  GRAYED metrics; a phase row = "Title done/total"; an agent row = done-dot · label (a trailing '~'
     *  marks a prompt-derived label, same convention as phases) · GRAYED metrics. The activity sparkline
     *  is painted beside the row by [SparklineTreeRenderer]. */
    private class WorkflowRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is WfRunRow -> renderRun(node.run)
                is WfPhaseRow -> {
                    append(node.title, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                    append("  ${node.done}/${node.total}",
                        if (node.done >= node.total) SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_DONE) else SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is WfAgentRow -> renderAgent(node.agent)
                is FilterInfo -> {
                    icon = AllIcons.General.Filter
                    append(node.text, SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is ScopeInfo -> {
                    icon = AllIcons.General.Filter
                    append(node.text, SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES)
                }
            }
        }

        private fun renderRun(w: WorkflowRun) {
            if (w.running) append("▶ running  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_WORKING))
            else append("✓ done  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_DONE))
            val name = w.description?.takeIf { it.isNotBlank() } ?: w.name
            append(clip(name, 64), SimpleTextAttributes.REGULAR_ATTRIBUTES)
            append("  ${w.agentCount} ag · ${fmtTok(w.tokens)} tok · ${fmtDur(w.durationMs)}", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            append("  +${w.added}", MT_ADD)
            append(" −${w.removed}", MT_REM)
            toolTipText = buildString {
                append(name)
                if (w.phaseGroups.isNotEmpty()) append("\n" + w.phaseGroups.joinToString(" · ") { "${it.title} ${it.done}/${it.total}" })
                append("\nSelect to map this run's changes on the right")
            }
        }

        private fun renderAgent(a: WorkflowAgent) {
            // Done dot GREEN, running dot BLUE — the same state colors the VS Code agent rows use.
            append(if (a.done) "● " else "○ ",
                SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, if (a.done) MT_DONE else MT_WORKING))
            // A '~' marks a prompt-derived (heuristic) label on a live run — same convention as phases.
            val who = a.label?.let { it + if (a.labelDerived) "~" else "" } ?: "${a.agentType ?: "agent"} ${a.agentId.take(8)}"
            append(clip(who, 48), SimpleTextAttributes.REGULAR_ATTRIBUTES)
            if (a.added > 0 || a.removed > 0) {
                append("  +${a.added}", MT_ADD)
                append(" −${a.removed}", MT_REM)
            }
            // Model AND effort, the pair the Sessions row already shows. An unknown effort is left
            // OUT rather than guessed — the default differs by build and by model.
            val mdl = when {
                a.model.isNotBlank() && a.effort.isNotBlank() -> "${a.model} · ${a.effort} · "
                a.model.isNotBlank() -> "${a.model} · "
                a.effort.isNotBlank() -> "${a.effort} · "
                else -> ""
            }
            append("  $mdl${fmtTok(a.tokens)} tok · ${fmtDur(a.durationMs)} · ${a.edits} edit${if (a.edits == 1) "" else "s"}",
                SimpleTextAttributes.GRAYED_ATTRIBUTES)
            toolTipText = who
        }
    }

    /** Paints one Tasks-tab row: status glyph (the fleet's state colors) · #id · subject (struck through
     *  when completed) · per-task ±/edits from its strict rollup · the in-progress activeForm · a blocked-by
     *  note. Tooltip = the description. */
    private class TaskRowRenderer : com.intellij.ui.ColoredListCellRenderer<Any>() {
        override fun customizeCellRenderer(
            list: javax.swing.JList<out Any>, value: Any?, index: Int, selected: Boolean, hasFocus: Boolean,
        ) {
            if (value is DoneTasksToggle) {
                append("${value.count} done · ${if (value.open) "hide" else "show all"}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                toolTipText = "Completed tasks fold here — click to ${if (value.open) "hide" else "show"} them"
                return
            }
            val row = value as? TaskRow ?: return
            val t = row.task
            val done = t.status == "completed"
            val wip = t.status == "in_progress"
            append(
                if (done) "● " else if (wip) "◐ " else "○ ",
                SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, if (done) MT_DONE else if (wip) MT_WORKING else JBColor.GRAY),
            )
            append("#${t.id}  ", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            append(
                clip(t.subject, 64),
                if (done) SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, JBColor.GRAY) else SimpleTextAttributes.REGULAR_ATTRIBUTES,
            )
            row.roll?.takeIf { it.edits > 0 }?.let { r ->
                append("  +${r.added}", MT_ADD)
                append(" −${r.removed}", MT_REM)
                append(" · ${r.edits} edit${if (r.edits == 1) "" else "s"}" + if (r.pending > 0) " · ${r.pending} pending" else "", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            }
            if (wip && t.activeForm != null) append("  ${t.activeForm}…", SimpleTextAttributes(SimpleTextAttributes.STYLE_ITALIC, MT_WORKING))
            if (t.blockedBy.isNotEmpty()) append("  blocked ×${t.blockedBy.size}", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
            toolTipText = t.description.ifBlank { t.subject }
        }
    }

    /** Paints one Sessions-tab row: ● live / ○ past · the agent's own title for the session · when its
     *  conversation was last active. No pending count: the listing is deliberately stat-only (that count
     *  is what used to make opening this list slow), and the row you pick shows its own counts at once. */
    /** A session row that WRAPS when the Sessions pane is narrow: every badge flows
     *  onto the next line instead of being clipped. Built as one label per fragment in a [WrapLayout],
     *  so each stays whole; the clickable fragments carry [SESSIONS_FRAGMENT_TAG] for the 2-D hit-test
     *  in [sessionRowFragmentTag] — a single-line x-only hit-test cannot survive a wrap. */
    private class SessionRowRenderer(private val pinned: () -> String?) : javax.swing.ListCellRenderer<Any> {
        private val panel = JPanel(WrapLayout(java.awt.FlowLayout.LEFT, JBUI.scale(3), JBUI.scale(1))).apply {
            isOpaque = true
            border = JBUI.Borders.empty(2, 4)
        }

        private fun frag(text: String, color: java.awt.Color?, tag: Any? = null, small: Boolean = false): JBLabel {
            val l = JBLabel(text)
            color?.let { l.foreground = it }
            if (small) l.font = com.intellij.util.ui.JBUI.Fonts.smallFont()
            tag?.let { l.putClientProperty(SESSIONS_FRAGMENT_TAG, it) }
            return l
        }

        override fun getListCellRendererComponent(
            list: javax.swing.JList<out Any>, value: Any?, index: Int, selected: Boolean, cellHasFocus: Boolean,
        ): java.awt.Component {
            panel.removeAll()
            panel.background = if (selected) list.selectionBackground else list.background
            val fg: java.awt.Color = if (selected) list.selectionForeground else list.foreground
            val gray: java.awt.Color = if (selected) list.selectionForeground else JBColor.GRAY
            panel.toolTipText = null
            when (value) {
                is WorkspaceHeaderRow -> {
                    panel.add(frag("${value.workspace} · ${value.count} " + if (value.count == 1) "session" else "sessions", gray, small = true))
                }
                is OlderSessionsToggle -> {
                    panel.add(frag("${value.count} older sessions · ${if (value.open) "hide" else "show all"}", gray, small = true))
                    panel.toolTipText = "Sessions last active more than a week ago."
                }
                is FilterInfo -> {
                    val l = frag(value.text, gray, small = true)
                    l.icon = AllIcons.General.Filter
                    panel.add(l)
                }
                AutoSessionRow -> {
                    val following = pinned() == null
                    panel.add(frag(if (following) "●" else "○", if (following) MT_WORKING else JBColor.GRAY))
                    panel.add(frag("Auto — newest session in this workspace", fg))
                    if (following) panel.add(frag("following", gray, small = true))
                    panel.toolTipText = "Follow whichever session is newest, instead of staying on one you picked."
                }
                is SessionRow -> buildSessionRow(value, fg, gray)
                else -> {}
            }
            // WrapLayout wraps to the container's width, so hand it the list's width up front — the
            // preferred HEIGHT it then reports is what the (variable-height) list uses for this row.
            panel.size = java.awt.Dimension(list.width.coerceAtLeast(JBUI.scale(48)), 1)
            return panel
        }

        private fun buildSessionRow(row: SessionRow, fg: java.awt.Color, gray: java.awt.Color) {
            // A raised hand wears ⚠ and says what it waits on, on what, for how long (2026-09-15).
            val hand = row.attention?.takeIf { it.kind != "idle-done" }
            panel.add(
                if (hand != null) frag("⚠", MT_ATTENTION)
                else frag(if (row.current) "●" else "○", if (row.current) MT_WORKING else JBColor.GRAY),
            )
            panel.add(frag(row.displayName, fg))
            if (hand != null) {
                val what = hand.kind + (hand.message.takeIf { it.isNotBlank() }?.let { " · $it" } ?: "") +
                    (if (hand.ts > 0) " · ${fmtDur(System.currentTimeMillis() - hand.ts)}" else "")
                panel.add(frag(what, MT_ATTENTION, small = true))
            }
            if (row.agent.isNotBlank() && row.agent != "claude") panel.add(frag("[${row.agent}]", MT_ATTENTION, small = true))
            panel.add(frag(row.model.ifBlank { "model unknown" }, gray, small = true))
            if (row.added > 0 || row.removed > 0) {
                panel.add(frag("+${row.added}", MT_ADD.fgColor))
                panel.add(frag("−${row.removed}", MT_REM.fgColor))
            }
            panel.add(frag("${row.edits} edit${if (row.edits == 1) "" else "s"}", gray, small = true))
            if (row.pending > 0) panel.add(frag("${row.pending} pending", CM_PENDING))
            else if (row.edits > 0) panel.add(frag("reviewed", CM_KEPT))
            panel.add(frag("${fmtTok(row.tokens)} tok · ${fmtDur(row.durationMs)}", gray, small = true))
            if (row.effort.isNotBlank()) panel.add(frag("${row.effort} effort", gray, small = true))
            panel.add(frag(relTime(row.lastActiveMs) + if (row.current) " · active" else "", gray, small = true))
            if (row.storeBytes > 0) panel.add(frag(compactBytes(row.storeBytes), gray, tag = SESSIONS_STORE_TAG, small = true))
            // Drive: reopen this conversation in the Feed tab. Every listed row is local (the parser
            // keeps only local rows), so it can be driven from here.
            panel.add(frag("conversation", JBColor.namedColor("Link.activeForeground", MT_WORKING), tag = SESSIONS_CONVERSATION_TAG, small = true))
            // Delete: remove this conversation from every picker and purge its captured edits. Red,
            // beside continue, because it is destructive — its confirm says the transcript survives,
            // names the edits still pending review, and says `--undelete` lists the session again
            // without its edits. Hiding and the store purge act on this machine.
            panel.add(frag("delete", MT_ERROR, tag = SESSIONS_DELETE_TAG, small = true))
            if (row.pending > 0) panel.add(frag("resolve", JBColor.namedColor("Link.activeForeground", MT_WORKING), tag = SESSIONS_RESOLVE_TAG, small = true))
            panel.toolTipText = "${row.displayName}\nsession ${row.id}" +
                (if (row.current) "\nthe live session for this workspace" else "") +
                (if (row.storeBytes > 0) "\nstore on disk: ${compactBytes(row.storeBytes)} — click the size to open its folder" else "") +
                "\nClick to review this session — it becomes the subject of every observatory window."
        }
    }

    /** True when the click landed on the row's "resolve" fragment itself. The renderer is configured for
     *  the row with its REAL selection state (selection can change fonts, which moves fragment bounds),
     *  then asked which fragment owns the x — the same layout the paint used, so zone and label cannot
     *  disagree, at any UI scale. */
    private fun resolveFragmentHit(index: Int, row: SessionRow, e: MouseEvent): Boolean =
        sessionRowFragmentTag(index, row, e) === SESSIONS_RESOLVE_TAG

    private fun storeFragmentHit(index: Int, row: SessionRow, e: MouseEvent): Boolean =
        sessionRowFragmentTag(index, row, e) === SESSIONS_STORE_TAG

    private fun conversationFragmentHit(index: Int, row: SessionRow, e: MouseEvent): Boolean =
        sessionRowFragmentTag(index, row, e) === SESSIONS_CONVERSATION_TAG

    private fun deleteFragmentHit(index: Int, row: SessionRow, e: MouseEvent): Boolean =
        sessionRowFragmentTag(index, row, e) === SESSIONS_DELETE_TAG

    /** Open the selected session's conversation. */
    private fun openConversationRow(row: SessionRow) {
        pinSession(row)
        service().selectedFeed = null
        com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Observatory Timeline")?.show(null)
        TimelinePanel.of(project)?.selectMember(com.cellobservatory.observatory.model.NavGrouping.FEED)
    }

    /** Which tagged fragment of a sessions row sits under the pointer — the ONE hit-test both the
     *  resolve link and the store-size click share, so a fragment can never be drawn in one place
     *  and pressed in another. */
    private fun sessionRowFragmentTag(index: Int, row: SessionRow, e: MouseEvent): Any? {
        val bounds = sessionsList.getCellBounds(index, index) ?: return null
        // Configure the renderer for the row at its REAL selection state and lay it out at the cell's
        // size — the SAME wrap the paint used — then find which fragment label owns the (x, y). 2-D,
        // because the row wraps: a fragment that was on line one for a wide pane is on line three now.
        val comp = sessionsList.cellRenderer.getListCellRendererComponent(
            sessionsList, row, index, sessionsList.isSelectedIndex(index), false
        ) as? java.awt.Container ?: return null
        comp.setBounds(0, 0, bounds.width, bounds.height)
        comp.doLayout()
        // By the fragments' OWN laid-out bounds, not findComponentAt: that answers null for anything under
        // an invisible parent, and the list UI parks its renderer inside an invisible CellRendererPane on
        // every layout pass — each refresh re-fills this list — until the next paint takes it out. A click
        // in between hit nothing, and the row switched sessions instead of opening its store folder.
        val x = e.point.x - bounds.x
        val y = e.point.y - bounds.y
        return comp.components.firstOrNull { it.bounds.contains(x, y) }
            ?.let { (it as? javax.swing.JComponent)?.getClientProperty(SESSIONS_FRAGMENT_TAG) }
    }

    /** Wraps a tree cell renderer so rows that carry activity bins — fleet agents, workflow runs + their
     *  agents — get a painted [SparklineIcon] on the row's right edge. The panel stays non-opaque so the
     *  tree's wide-selection background shows through; the inner renderer's tooltip is forwarded. */
    private class SparklineTreeRenderer(private val inner: ColoredTreeCellRenderer) : TreeCellRenderer {
        private val spark = JLabel()
        private val panel = JPanel(BorderLayout(JBUI.scale(6), 0)).apply {
            isOpaque = false
            add(inner, BorderLayout.CENTER)
            add(spark, BorderLayout.EAST)
        }

        override fun getTreeCellRendererComponent(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ): Component {
            val c = inner.getTreeCellRendererComponent(tree, value, selected, expanded, leaf, row, hasFocus)
            val bins = when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is AgentRow -> node.agent.sparkline
                is WfRunRow -> node.run.sparkline
                is WfAgentRow -> node.agent.sparkline
                else -> null
            }
            spark.icon = bins?.takeIf { b -> b.any { it > 0 } }?.let { SparklineIcon(it) }
            spark.isVisible = spark.icon != null
            panel.toolTipText = (c as? JComponent)?.toolTipText
            return panel
        }
    }

    /** The per-detail render inputs — one change-map slice (main session, a sibling agent, or a workflow). */
    private class TabData(
        val session: String,
        val summary: ChangeMapSummary?,
        val files: List<ChangeMapFile>,
        val modules: List<ChangeMapModule>,
        /** Non-null on a workflow slice — its run state, shown as a badge in the chips row. */
        val running: Boolean? = null,
    )

    /** One slice's Overview detail: chips headline · folder strip · churn-ranked file ledger · summary. */
    private inner class AgentDetail(private val data: TabData) : JPanel(BorderLayout()) {
        private var modFilter: String? = null

        private val strip = StripBar()
        private val listModel = DefaultListModel<ChangeMapFile>()
        // Held directly — JBList wraps the assigned renderer (ExpandedItemListCellRendererWrapper), so
        // reading list.cellRenderer back would not return this instance.
        private val ledgerRenderer = LedgerRenderer()
        private val list = JBList(listModel).apply {
            cellRenderer = ledgerRenderer
            emptyText.text = "No edits attributed to this agent yet"
        }
        private val readout = JBLabel().apply { font = JBUI.Fonts.label(); foreground = UIUtil.getContextHelpForeground() }

        // Section captions (VS Code .cm-caption) + the bottom summary bar. The caption tooltips describe
        // each section; the summary names the current scope's pending/accepted/file/folder totals.
        private val capFolders = caption("Folders", "Folders — the directories the agent changed. Color = review status (amber pending · green kept · red reverted); click a tile to filter the files below and open that folder in the nav bar.")
        private val capFiles = caption("Files", "Files — every changed file, ranked by churn. Dot = review status, +N/−N = lines, ⧗/✓ = pending/reviewed; click a row to open the edit, ⧉ opens the file's changes stacked.")
        private val summaryLabel = JBLabel().apply { font = JBUI.Fonts.miniFont(); border = JBUI.Borders.empty(2, 4, 2, 4) }
        private var lastShown: List<ChangeMapFile> = emptyList()

        /** The section a tour step's anchor names, for its tip to point at. */
        fun tourAnchor(anchor: String): JComponent? = when (anchor) {
            "folders-strip" -> strip
            "files-ledger" -> list
            "summary-bar" -> summaryLabel
            else -> null
        }

        private fun caption(text: String, tip: String): JBLabel = JBLabel(text).apply {
            font = JBUI.Fonts.miniFont()
            foreground = UIUtil.getContextHelpForeground()
            border = JBUI.Borders.empty(3, 1, 2, 0)
            toolTipText = tip
            alignmentX = Component.LEFT_ALIGNMENT
        }

        /** The strip's viewport: expanded, a repo-wide session runs to dozens of rows, so the strip is
         *  capped at five and scrolls — opening the folders never pushes the file ledger out of view. */
        private val stripScroll = object : JBScrollPane(strip) {
            override fun getPreferredSize(): Dimension =
                Dimension(JBUI.scale(200), minOf(strip.preferredSize.height, JBUI.scale(18 * 5)))
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
        }.apply {
            border = JBUI.Borders.empty()
            isOpaque = false
            viewport.isOpaque = false
            horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
            verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
        }

        init {
            strip.alignmentX = Component.LEFT_ALIGNMENT
            stripScroll.alignmentX = Component.LEFT_ALIGNMENT
            val north = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                border = JBUI.Borders.empty(2, 4)
                add(capFolders)    // above the Folders strip
                add(stripScroll)
                add(capFiles)      // above the Files ledger (which is the CENTER list below)
            }
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(list), BorderLayout.CENTER)
            val south = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                readout.alignmentX = Component.LEFT_ALIGNMENT
                summaryLabel.alignmentX = Component.LEFT_ALIGNMENT
                add(readout)
                add(summaryLabel)
            }
            add(south, BorderLayout.SOUTH)

            // Click a folder tile → filter the ledger to it AND jump the nav-bar Folder axis there (open its
            // first pending edit) — VS Code parity (revealFolder).
            strip.onClick = { mod ->
                val selecting = modFilter != mod
                modFilter = if (selecting) mod else null
                paintTab()
                if (selecting) reviewNavBar.revealFolder(mod)
            }
            list.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    // Keep / Undo first, and on a SINGLE click: they are the row's own buttons, and
                    // making them wait for a second click would put them behind the open-the-diff
                    // gesture that the same second click already means.
                    val i = list.locationToIndex(e.point)
                    val bounds = if (i >= 0) list.getCellBounds(i, i) else null
                    if (i >= 0 && bounds != null && e.point.y >= bounds.y && e.point.y < bounds.y + bounds.height) {
                        val f = list.model.getElementAt(i)
                        val act = ledgerActionAt(bounds.width, e.point.x - bounds.x)
                        if (act != null) {
                            if (data.session.isBlank()) return
                            // ⧉ works on DECIDED files too — the stacked blocks carry verdicts.
                            if (act == "stack") {
                                if (f.maxId >= 0) StoreReader.findRecord(data.session, f.maxId)?.let {
                                    Diffs.showFileStacked(project, data.session, it.file)
                                }
                                return
                            }
                            if (f.pending <= 0) return
                            if (act == "keep") ReviewOps.keepUnder(project, data.session, f.rel, f.file, f.pending)
                            else ReviewOps.undoUnder(project, data.session, f.rel, f.file, f.pending)
                            return
                        }
                    }
                    if (e.clickCount != 2) return
                    val f = list.selectedValue ?: return
                    if (f.maxId < 0 || data.session.isBlank()) return
                    val rec = StoreReader.findRecord(data.session, f.maxId) ?: return
                    Navigate.openFileAtEdit(project, data.session, rec)
                }
            })
            paintTab()
        }

        private fun paintTab() {
            stripScroll.isVisible = data.modules.isNotEmpty()
            capFolders.isVisible = stripScroll.isVisible
            strip.update(data.modules, modFilter)

            // The filter (Search query + regex/extension/type) narrows this ledger too (parity with the
            // sidebar tree + VS Code), and so does Active only — a file with nothing pending is not work
            // still awaiting review. Then the sort control orders it: by time (default) or by name.
            val svc = ObservatoryService.getInstance(project)
            val kept = data.files.filter {
                (modFilter == null || it.moduleLabel == modFilter) &&
                    (!activeOnly || it.pending > 0) &&
                    svc.matchesFile(it.rel, it.ext, it.category)
            }
            val shown = when (svc.sortKey()) {
                "name" -> kept.sortedBy { it.rel }
                "name-desc" -> kept.sortedByDescending { it.rel }
                "time-asc" -> kept.sortedWith(compareBy<ChangeMapFile> { it.maxTs }.thenBy { it.rel })
                else -> kept.sortedWith(compareByDescending<ChangeMapFile> { it.maxTs }.thenBy { it.rel }) // time
            }
            lastShown = shown
            capFiles.isVisible = shown.isNotEmpty()
            // An empty ledger under Active only means "all reviewed", not "nothing was edited" — say which.
            list.emptyText.text = if (activeOnly && data.files.isNotEmpty()) {
                "Nothing left to review here — Active only is hiding ${data.files.size} fully-reviewed file(s)"
            } else {
                "No edits attributed to this agent yet"
            }
            listModel.clear()
            shown.forEach { listModel.addElement(it) }

            // Say WHY the ledger is narrowed — a silently filtered-empty list reads as a bug. Active only
            // leads: it is a toolbar toggle away from this pane, so it is the narrowing least likely to be
            // remembered, and it hides fully-reviewed work rather than merely re-ranking it.
            val notes = mutableListOf<String>()
            if (activeOnly) notes.add("Active only · ${shown.size} of ${data.files.size} file(s) still pending — untoggle to see them all")
            modFilter?.let { mf -> data.modules.find { it.module == mf }?.let { notes.add("module ${it.label} — click again to clear") } }
            if (svc.filterQuery.isNotBlank()) notes.add("search “${svc.filterQuery}” · ${shown.size} file(s) — Search again (empty) to clear")
            if (svc.filterExts.isNotEmpty() || svc.filterCats.isNotEmpty()) notes.add("filtered · ${shown.size} file(s) — Filter ▾ to change, Reset scope to clear")
            readout.text = notes.joinToString("  ·  ")

            refreshSummary()
            strip.repaint()
            revalidate(); repaint()
        }

        /** The bottom summary bar: for the CURRENT scope, `[name ·] N pending · N accepted · [N reverted ·]
         *  N files · N folders`. Scope precedence (VS Code renderSummary): a SELECTED prompt (the most
         *  explicit pick there is — the user named the ask) → else an active folder filter → else the whole
         *  visible view. A prompt or folder scope is NAMED; the whole view is unnamed. */
        fun refreshSummary() {
            // A picked ask outranks the folder filter — it is the more explicit thing the reader did — but
            // a folder tile still narrows within it, so the ask only wins while no tile is active.
            if (modFilter == null) scopedPrompt()?.let { req -> paintPromptSummary(req); return }
            paintSummary(
                modFilter,
                lastShown.sumOf { it.pending }, lastShown.sumOf { it.kept }, lastShown.sumOf { it.undone },
                lastShown.size, lastShown.map { it.moduleLabel }.toHashSet().size,
            )
        }

        /** The picked ask's scope — every number here is core's own (the per-prompt slice in
         *  `changemap --json`), including the files and folders it touched. Nothing is recomputed. */
        private fun paintPromptSummary(req: ChangeMapPrompt) {
            // Named by NUMBER only: the ask itself is on the scope banner above, whole and wrapped. A
            // one-line bar could only carry it by clipping it, which is the thing we stopped doing.
            paintSummary(
                "#${req.index}", req.rollup.pending, req.rollup.kept, req.rollup.undone,
                req.files.size, req.modules.size,
            )
        }

        /** The one summary-bar formatter — a named scope leads in blue, then pending / accepted /
         *  [reverted] / files / folders. Shared so every scope kind reads identically. */
        private fun paintSummary(name: String?, pending: Int, kept: Int, undone: Int, nfiles: Int, nfolders: Int) {
            if (name == null && nfiles == 0) { summaryLabel.text = ""; return }
            val parts = mutableListOf<String>()
            name?.let { parts.add("<b style='color:#4C8BF5'>${escHtml(clip(it, 56))}</b>") }
            parts.add("<b style='color:#D9A441'>$pending</b> pending")
            parts.add("<b style='color:#3FB950'>$kept</b> accepted")
            if (undone > 0) parts.add("<b style='color:#8C8C8C'>$undone</b> reverted")
            parts.add("<b>$nfiles</b> file${if (nfiles == 1) "" else "s"}")
            parts.add("<b>$nfolders</b> folder${if (nfolders == 1) "" else "s"}")
            // Nothing here about .observatoryignore (VS Code parity): under one mode a matching path is
            // never recorded, so there is no count to report — this bar describes what the session HAS,
            // and an ignored file was never part of it.
            summaryLabel.text = "<html>${parts.joinToString(" · ")}</html>"
            summaryLabel.toolTipText = null
        }

        /**
         * The module proportion strip: equal-width clickable chips, colour = worst-unreviewed-wins.
         *
         * It WRAPS. A segment narrower than [MIN_SEGMENT_PX] cannot hold a folder label, so rather than
         * shrink into unreadable slivers the strip spills onto further rows — which is what keeps it
         * legible in a narrow panel and what makes the expanded (every-folder) form usable at all. The
         * churn-ranked tail folds into a "+K more" chip that OPENS the rest; a "show fewer" chip folds
         * it back. Both chips are controls, never ledger filters.
         */
        private inner class StripBar : JComponent(), Scrollable {
            private var all: List<ChangeMapModule> = emptyList()
            private var mods: List<ChangeMapModule> = emptyList()
            private var sel: String? = null
            private var hit: List<Pair<Rectangle, ChangeMapModule>> = emptyList()
            var onClick: ((String) -> Unit)? = null

            init {
                toolTipText = ""
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        when (val m = hit.firstOrNull { it.first.contains(e.point) }?.second?.module) {
                            null -> {}
                            OVERFLOW_MODULE -> { stripExpanded = true; rebuild() }
                            COLLAPSE_MODULE -> { stripExpanded = false; rebuild() }
                            else -> onClick?.invoke(m)
                        }
                    }
                })
                // Wrapping changes the row count with the width, and the row count is the height — so a
                // resize has to re-ask the layout for space, not just repaint.
                addComponentListener(object : ComponentAdapter() {
                    private var rows = -1
                    override fun componentResized(e: ComponentEvent) {
                        val now = rowsFor(width)
                        if (now == rows) return
                        rows = now
                        relayout()
                    }
                })
            }

            private val rowH: Int get() = JBUI.scale(18)
            private fun perRow(w: Int): Int = maxOf(1, w / JBUI.scale(MIN_SEGMENT_PX))
            private fun rowsFor(w: Int): Int =
                if (mods.isEmpty()) 1 else (mods.size + perRow(w) - 1) / perRow(w)
            /** Before the first layout the strip has no width of its own; the row count then comes from
             *  the container that is about to size it, so the first paint is not a tall mis-guess. */
            private fun usableWidth(): Int =
                if (width > 0) width else (parent?.width ?: 0).takeIf { it > 0 } ?: JBUI.scale(600)

            // Explicit sizes rather than setPreferredSize: the height is a function of the current width.
            override fun getPreferredSize(): Dimension =
                Dimension(JBUI.scale(200), rowsFor(usableWidth()) * rowH)
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
            override fun getMinimumSize(): Dimension = Dimension(JBUI.scale(60), rowH)

            // Scrollable: fill the viewport's width (segments are laid out against it), scroll by rows.
            override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
            override fun getScrollableTracksViewportWidth(): Boolean = true
            override fun getScrollableTracksViewportHeight(): Boolean = false
            override fun getScrollableUnitIncrement(r: Rectangle, orientation: Int, direction: Int): Int = rowH
            override fun getScrollableBlockIncrement(r: Rectangle, orientation: Int, direction: Int): Int = rowH * 2

            fun update(modules: List<ChangeMapModule>, selected: String?) {
                all = modules
                sel = selected
                rebuild()
            }

            /** Recompute the displayed segments (head + tail chip, or everything + a fold-back chip). */
            private fun rebuild() {
                mods = when {
                    all.size <= MAX_SEGMENTS -> all
                    stripExpanded -> all + chip(COLLAPSE_MODULE, "show fewer", all.drop(MAX_SEGMENTS))
                    else -> all.take(MAX_SEGMENTS) + chip(
                        OVERFLOW_MODULE, "+${all.size - MAX_SEGMENTS} more", all.drop(MAX_SEGMENTS),
                    )
                }
                relayout()
            }

            /**
             * Re-lay-out the strip AND the panel that sizes it.
             *
             * A JScrollPane is a Swing validate root: revalidate() inside it stops there, so the strip's
             * new row count changed its preferred height and nothing above ever asked for the new size —
             * "+K more" expanded the model and the viewport kept its old two rows behind a scrollbar.
             * Invalidating the scroll pane's PARENT is what carries the change into the BoxLayout.
             */
            private fun relayout() {
                revalidate()
                stripScroll.invalidate()
                (stripScroll.parent as? JComponent)?.revalidate()
                repaint()
            }

            /** A tail chip carries the folded folders' totals so its tooltip can report what it hides. */
            private fun chip(id: String, label: String, tail: List<ChangeMapModule>) = ChangeMapModule(
                module = id, label = label,
                churn = tail.sumOf { it.churn }, cnt = tail.sumOf { it.cnt },
                kept = tail.sumOf { it.kept }, pending = tail.sumOf { it.pending },
                undone = tail.sumOf { it.undone }, status = "undone", // → the gray status color
                files = tail.sumOf { it.files },
            )

            override fun getToolTipText(e: MouseEvent): String? =
                hit.firstOrNull { it.first.contains(e.point) }?.second?.let { m ->
                    when (m.module) {
                        OVERFLOW_MODULE -> "${m.label.removePrefix("+")} folder(s) · ${m.churn} lines · ${m.files} file(s) — click to show them all"
                        COLLAPSE_MODULE -> "Show only the top $MAX_SEGMENTS folders by lines changed"
                        else -> "${m.label} · ${m.churn} lines · ${m.files} file(s)"
                    }
                }

            override fun paintComponent(g: Graphics) {
                val g2 = g as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                if (mods.isEmpty()) return
                g2.font = JBUI.Fonts.miniFont()
                val per = perRow(width)
                val n = mods.size
                val acc = mutableListOf<Pair<Rectangle, ChangeMapModule>>()
                for ((i, m) in mods.withIndex()) {
                    val row = i / per
                    val col = i % per
                    val inRow = minOf(per, n - row * per) // a short last row divides the width among its own
                    val x0 = col * width / inRow
                    val x1 = (col + 1) * width / inRow
                    val y0 = row * rowH
                    val w = x1 - x0
                    val h = rowH - if (row < rowsFor(width) - 1) JBUI.scale(1) else 0 // 1px gutter between rows
                    val isSel = sel == m.module
                    val base = statusColor(m.status)
                    g2.color = if (sel != null && !isSel) UIUtil.toAlpha(base, 90) else base
                    g2.fillRect(x0, y0, w, h)
                    if (col > 0) {
                        g2.color = UIUtil.getPanelBackground()
                        g2.fillRect(x0, y0, JBUI.scale(1), h)
                    }
                    val lbl = clipStr(g2, m.label, w - JBUI.scale(4))
                    if (lbl.isNotEmpty()) {
                        g2.color = JBColor(Color(0x22, 0x22, 0x22), Color(0x1a, 0x1a, 0x1a))
                        val tw = g2.fontMetrics.stringWidth(lbl)
                        g2.drawString(lbl, x0 + (w - tw) / 2, y0 + h / 2 + g2.fontMetrics.ascent / 2 - JBUI.scale(1))
                    }
                    if (isSel) {
                        g2.color = UIUtil.getLabelForeground()
                        g2.drawRect(x0, y0, w - 1, h - 1)
                    }
                    acc.add(Rectangle(x0, y0, w, h) to m)
                }
                hit = acc
            }

            private fun clipStr(g2: Graphics2D, s: String, w: Int): String {
                if (w <= 0) return ""
                if (g2.fontMetrics.stringWidth(s) <= w) return s
                var t = s
                while (t.length > 1 && g2.fontMetrics.stringWidth("$t…") > w) t = t.dropLast(1)
                return if (g2.fontMetrics.stringWidth("$t…") > w) "" else "$t…"
            }
        }

        /** One ledger row: status dot · file · module · +added −removed · pending/accepted · ⧉ ✓ ✗ */
        private inner class LedgerRenderer : JComponent(), ListCellRenderer<ChangeMapFile> {
            private var value: ChangeMapFile? = null
            private var selected = false

            init {
                preferredSize = Dimension(JBUI.scale(200), JBUI.scale(18))
            }

            override fun getListCellRendererComponent(
                list: JList<out ChangeMapFile>, v: ChangeMapFile, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
            ): Component {
                value = v
                selected = isSelected
                toolTipText = buildString {
                    append(v.rel)
                    append("\n+${v.added} −${v.removed} · ${v.cnt} unit(s) · ${v.pending}⧗ pending · ${v.kept}✓ accepted · ${v.undone}✗ reverted")
                    if (v.classes.isNotEmpty()) append("\n" + v.classes.take(4).joinToString(", "))
                    v.reason?.let { append("\n“$it”") }
                    v.risk?.let { append("\n⚠ $it") }
                    append("\nDouble-click → open the diff · ✓ keep this file · ✗ undo this file")
                }
                return this
            }

            override fun paintComponent(g: Graphics) {
                val v = value ?: return
                val g2 = g as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                if (selected) {
                    g2.color = UIUtil.getListSelectionBackground(true)
                    g2.fillRect(0, 0, width, height)
                }
                val fg = if (selected) UIUtil.getListSelectionForeground(true) else UIUtil.getLabelForeground()
                val grey = if (selected) UIUtil.getListSelectionForeground(true) else UIUtil.getContextHelpForeground()
                val col = statusColor(v.status)
                val mid = height / 2

                var x = JBUI.scale(3)
                g2.color = col
                g2.fillRoundRect(x, mid - JBUI.scale(3), JBUI.scale(6), JBUI.scale(6), 2, 2)
                x += JBUI.scale(11)

                // "N min ago" to the LEFT of the file — the most-recent edit time, grey, mini.
                g2.font = JBUI.Fonts.miniFont()
                g2.color = grey
                val ageW = JBUI.scale(52)
                g2.drawString(clip(g2, if (v.maxTs > 0) relTime(v.maxTs) else "—", ageW), x, mid + JBUI.scale(3))
                x += ageW + JBUI.scale(6)

                // Right-hand columns are laid out by ONE function, shared with the mouse — a cell
                // renderer paints into a component that is never added to the hierarchy, so a click is
                // resolved by arithmetic and nothing catches it when the two drift apart. These
                // buttons revert files, so drift here means reverting a row nobody pointed at.
                val cols = ledgerColumns(width)

                // The name takes the width the churn bar used to hold (the
                // bar's track read as a block of empty space).
                g2.font = JBUI.Fonts.smallFont() // the file name reads at small; the metric columns stay mini
                g2.color = fg
                val modW = JBUI.scale(60)
                val nameW = (cols.nameEnd - x - modW - JBUI.scale(10)).coerceAtLeast(JBUI.scale(120))
                g2.drawString(clip(g2, v.file + (if (v.agent) " ●" else "") + (if (v.risk != null) " ⌐" else ""), nameW), x, mid + JBUI.scale(3))
                x += nameW + JBUI.scale(4)

                g2.font = JBUI.Fonts.miniFont()
                g2.color = grey
                g2.drawString(clip(g2, v.moduleLabel, modW), x, mid + JBUI.scale(3))

                // Added and removed, APART. Same change the terminal's map made: +900/−4 and +4/−900 are
                // the same churn and are not remotely the same change to review.
                val baseline = mid + JBUI.scale(3)
                g2.color = if (selected) fg else CM_KEPT
                val add = "+${v.added}"
                g2.drawString(add, cols.addEnd - g2.fontMetrics.stringWidth(add), baseline)
                g2.color = if (selected) fg else CM_REVERTED
                val del = "−${v.removed}"
                g2.drawString(del, cols.delEnd - g2.fontMetrics.stringWidth(del), baseline)

                // Pending and accepted as NUMBERS — "how much is left here" is what this ledger answers,
                // and a proportional bar cannot.
                g2.color = if (selected) fg else CM_PENDING
                val pend = "${v.pending}⧗"
                g2.drawString(pend, cols.pendEnd - g2.fontMetrics.stringWidth(pend), baseline)
                g2.color = if (selected) fg else CM_KEPT
                val kept = "${v.kept}✓"
                g2.drawString(kept, cols.keptEnd - g2.fontMetrics.stringWidth(kept), baseline)

                // The stacked opener: the file's changes as the STACKED layout —
                // always live: the blocks carry verdicts, so a fully decided file still opens.
                g2.color = if (selected) fg else MT_WORKING
                g2.drawString("⧉", cols.stackX, baseline)

                // The two actions. Greyed — not hidden — when there is nothing pending, so the row keeps
                // its shape as counts change and the tooltip carries the reason.
                val live = v.pending > 0
                g2.color = if (!live) JBColor.border() else if (selected) fg else CM_KEPT
                g2.drawString("✓", cols.keepX, baseline)
                g2.color = if (!live) JBColor.border() else if (selected) fg else CM_REVERTED
                g2.drawString("✗", cols.undoX, baseline)
            }

            private fun clip(g2: Graphics2D, s: String, w: Int): String {
                if (g2.fontMetrics.stringWidth(s) <= w) return s
                var t = s
                while (t.isNotEmpty() && g2.fontMetrics.stringWidth("$t…") > w) t = t.dropLast(1)
                return "$t…"
            }
        }
    }
}

// (FeedPane + FeedRenderer moved to ui/FeedPanel.kt in 0.10.0 — the feed renders in the Timeline now.)
/** Paints one Processes-tab row: run state (green running · dim exit 0 · RED non-zero exit) · what the
 *  shell is for · runtime · output volume.
 *
 *  There is no pid column, deliberately: the transcript records no OS pid, and inferring one by scanning
 *  local processes would be wrong the moment the agent runs over SSH or in a container. The harness's
 *  shell id IS the identity — it is what the agent itself uses to read or kill the shell — so it is
 *  printed on the row (VS Code parity), not buried in the tooltip. */
private class ProcessRowRenderer : com.intellij.ui.ColoredListCellRenderer<BackgroundProcess>() {
    override fun customizeCellRenderer(
        list: JList<out BackgroundProcess>, value: BackgroundProcess?, index: Int, selected: Boolean, hasFocus: Boolean,
    ) {
        val p = value ?: return
        val code = p.exitCode
        when {
            // Green reads as "still going" here — a running shell is the row worth finding.
            p.running -> {
                icon = AllIcons.Actions.Execute
                append("▶ running  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_DONE))
            }
            code == null -> {
                icon = AllIcons.Actions.Pause
                // No exit code was ever reported — that is NOT the same as exit 0, so it doesn't say so.
                append("○ ${p.status.ifBlank { "ended" }}  ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            code == 0 -> {
                icon = AllIcons.Actions.Commit
                append("○ exit 0  ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            else -> {
                icon = AllIcons.General.Error
                append("✖ exit $code  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ERROR))
            }
        }
        // The shell id, on the row: it is the only identity this shell has, and it is what you type to
        // read or kill it. (No OS pid exists to print — see the class note.)
        if (p.id.isNotBlank()) append("${p.id}  ", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        append(clip((p.description ?: p.command).replace(Regex("\\s+"), " "), 56), SimpleTextAttributes.REGULAR_ATTRIBUTES)
        append("  ${fmtDur(p.runtimeMs)}", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        if (p.outputBytes > 0) append(" · ${fmtBytes(p.outputBytes)} out", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        toolTipText = buildString {
            p.description?.takeIf { it.isNotBlank() }?.let { append(it).append("\n\n") }
            append(clip(p.command.replace(Regex("\\s+"), " "), 200))
            append("\n\nshell ${p.id} · ${if (p.running) "running" else p.status.ifBlank { "ended" }}")
            if (code != null) append(" · exit $code")
            append(" · ${fmtDur(p.runtimeMs)}")
            if (p.outputBytes > 0) append("\noutput ${fmtBytes(p.outputBytes)}")
            p.outputPath?.let { append("\n$it") }
            append("\nno OS pid exists to show — the transcript never records one")
            append("\nSelect to follow this shell's output below")
        }
    }
}

/** Bytes a background shell has written so far. */
private fun fmtBytes(n: Long): String = when {
    n >= 1024L * 1024L -> "%.1f MB".format(n / (1024.0 * 1024.0))
    n >= 1024L -> "${n / 1024} kB"
    else -> "$n B"
}

/** phase → (glyph, text attributes). `awaiting-permission` is the needs-attention state (§2.8). */
private fun phaseBadge(phase: String): Pair<String, SimpleTextAttributes> = when (phase) {
    "working" -> "▶ working" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_WORKING)
    "awaiting-input" -> "❓ awaiting input" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ATTENTION)
    "awaiting-permission" -> "⏸ awaiting permission" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ATTENTION)
    "errored" -> "✖ errored" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ERROR)
    "done" -> "● done" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_DONE)
    else -> "○ idle" to SimpleTextAttributes.GRAYED_BOLD_ATTRIBUTES
}

/** ~20 activity bins → a PAINTED mini bar chart (one bar per bin, height v/max, bar ≈72% of its slot) —
 *  the same geometry VS Code's spark() SVG draws, replacing the old unicode block-glyph sparkline. */
private class SparklineIcon(private val bins: List<Int>) : Icon {
    private val w = JBUI.scale(58)
    private val h = JBUI.scale(11)
    override fun getIconWidth(): Int = w
    override fun getIconHeight(): Int = h

    override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
        val max = bins.maxOrNull() ?: 0
        if (max <= 0) return // empty / all-zero bins → nothing to paint
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = UIUtil.toAlpha(MT_WORKING, 170) // chart-blue bars — the VS Code --mt-spark color
            val slot = w.toDouble() / bins.size
            val bar = (slot * 0.72).toInt().coerceAtLeast(1)
            for ((i, v) in bins.withIndex()) {
                if (v <= 0) continue
                val bh = ((v.toDouble() / max) * h).toInt().coerceAtLeast(1)
                g2.fillRect(x + (i * slot).toInt(), y + h - bh, bar, bh)
            }
        } finally {
            g2.dispose()
        }
    }
}

internal fun fmtTok(n: Long): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "${n / 1000}k"
    else -> "$n"
}

internal fun fmtDur(ms: Long): String {
    val s = ms / 1000
    if (s < 60) return "${s}s"
    val m = s / 60
    if (m < 60) return "${m}m"
    return "%.1fh".format(m / 60.0)
}

private fun baseName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifBlank { path }

private fun clip(s: String, n: Int): String = if (s.length <= n) s else s.take(n - 1) + "…"

/** Minimal HTML escape for text interpolated into a JBLabel's <html> body (the bottom summary name). */
internal fun escHtml(s: String): String =
    s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/**
 * A two-cluster toolbar row that mirrors CSS `flex-wrap: wrap; justify-content: space-between`
 * (VS Code's `.ov-tbrow.split`): the LEFT cluster (child 0) pins to the left edge and the RIGHT cluster
 * (child 1) pins to the right edge while both fit on one line; when the row is too narrow for both, the
 * right cluster wraps onto a second line (left-aligned) so nothing is clipped. The preferred height
 * tracks the current width — the host row's width-change listener revalidates so the toolbar grows the
 * extra row rather than cutting the right cluster off (as the old fixed GridBagLayout did).
 */
internal class SplitWrapLayout(private val vgap: Int) : LayoutManager2 {
    override fun addLayoutComponent(name: String?, comp: Component?) {}
    override fun addLayoutComponent(comp: Component?, constraints: Any?) {}
    override fun removeLayoutComponent(comp: Component?) {}
    override fun getLayoutAlignmentX(target: Container?): Float = 0f
    override fun getLayoutAlignmentY(target: Container?): Float = 0.5f
    override fun invalidateLayout(target: Container?) {}
    // Width MAX so a BoxLayout Y_AXIS host stretches this row to the full toolbar width (the right
    // cluster must be able to reach the true right edge); the host caps height to preferred.
    override fun maximumLayoutSize(target: Container): Dimension = Dimension(Int.MAX_VALUE, Int.MAX_VALUE)

    private fun kids(parent: Container): List<Component> =
        (0 until parent.componentCount).map { parent.getComponent(it) }.filter { it.isVisible }

    /** True when the two clusters can't sit side by side within [avail] px. */
    private fun wraps(left: Component?, right: Component?, avail: Int): Boolean =
        left != null && right != null && avail > 0 &&
            left.preferredSize.width + right.preferredSize.width > avail

    override fun preferredLayoutSize(parent: Container): Dimension {
        val ins = parent.insets
        val k = kids(parent)
        val left = k.getOrNull(0); val right = k.getOrNull(1)
        val lp = left?.preferredSize ?: Dimension()
        val rp = right?.preferredSize ?: Dimension()
        val avail = parent.width - ins.left - ins.right
        return if (wraps(left, right, avail))
            Dimension(maxOf(lp.width, rp.width) + ins.left + ins.right, lp.height + vgap + rp.height + ins.top + ins.bottom)
        else
            Dimension(lp.width + rp.width + ins.left + ins.right, maxOf(lp.height, rp.height) + ins.top + ins.bottom)
    }

    override fun minimumLayoutSize(parent: Container): Dimension = preferredLayoutSize(parent)

    override fun layoutContainer(parent: Container) {
        val ins = parent.insets
        val k = kids(parent)
        val left = k.getOrNull(0); val right = k.getOrNull(1)
        val lp = left?.preferredSize ?: Dimension()
        val rp = right?.preferredSize ?: Dimension()
        val avail = parent.width - ins.left - ins.right
        if (wraps(left, right, avail)) {
            left?.setBounds(ins.left, ins.top, minOf(lp.width, avail), lp.height)
            right?.setBounds(ins.left, ins.top + lp.height + vgap, minOf(rp.width, avail), rp.height)
        } else {
            left?.setBounds(ins.left, ins.top, lp.width, lp.height)
            right?.setBounds(parent.width - ins.right - rp.width, ins.top, rp.width, rp.height)
        }
    }
}

/**
 * A FlowLayout that actually WRAPS its rows. Stock FlowLayout reports a single-row preferred size, so a
 * BoxLayout/BorderLayout host never gives it height for extra rows and its children clip or (for an
 * IntelliJ ActionToolbar) collapse into a "…" overflow. This computes the true wrapped height for the
 * current width, so the Overview's centered review-axes row flows Diff/File/Folder/Prompt onto more
 * lines when the pane is narrow. (Rob Camick's well-known WrapLayout, ported to Kotlin.)
 */
internal class WrapLayout(align: Int, hgap: Int, vgap: Int) : FlowLayout(align, hgap, vgap) {
    override fun preferredLayoutSize(target: Container): Dimension = layoutSize(target, true)

    override fun minimumLayoutSize(target: Container): Dimension =
        layoutSize(target, false).also { it.width -= (hgap + 1) }

    private fun layoutSize(target: Container, preferred: Boolean): Dimension {
        synchronized(target.treeLock) {
            // The target may have width 0 during the first pass — walk up to the first sized ancestor.
            var container: Container = target
            while (container.size.width == 0 && container.parent != null) container = container.parent!!
            val targetWidth = container.size.width.let { if (it == 0) Int.MAX_VALUE else it }
            val insets = target.insets
            val horizontalInsetsAndGap = insets.left + insets.right + hgap * 2
            val maxWidth = targetWidth - horizontalInsetsAndGap
            val dim = Dimension(0, 0)
            var rowWidth = 0
            var rowHeight = 0
            for (i in 0 until target.componentCount) {
                val m = target.getComponent(i)
                if (!m.isVisible) continue
                val d = if (preferred) m.preferredSize else m.minimumSize
                if (rowWidth + d.width > maxWidth) {
                    addRow(dim, rowWidth, rowHeight); rowWidth = 0; rowHeight = 0
                }
                if (rowWidth != 0) rowWidth += hgap
                rowWidth += d.width
                rowHeight = maxOf(rowHeight, d.height)
            }
            addRow(dim, rowWidth, rowHeight)
            dim.width += horizontalInsetsAndGap
            dim.height += insets.top + insets.bottom + vgap * 2
            return dim
        }
    }

    private fun addRow(dim: Dimension, rowWidth: Int, rowHeight: Int) {
        dim.width = maxOf(dim.width, rowWidth)
        if (dim.height > 0) dim.height += vgap
        dim.height += rowHeight
    }
}
