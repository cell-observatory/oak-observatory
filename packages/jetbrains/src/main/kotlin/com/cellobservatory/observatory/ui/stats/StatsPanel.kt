package com.cellobservatory.observatory.ui.stats

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.GridLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.ButtonGroup
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JToggleButton
import javax.swing.Timer
import kotlin.math.ln
import kotlin.math.max

// Chart palette (mirrors the VS Code webview's theme-variable choices).
private val C_PENDING = JBColor(Color(0xD9A441), Color(0xD9A441))
private val C_KEPT = JBColor(Color(0x3FB950), Color(0x3FB950))
private val C_REVERTED = JBColor.GRAY
private val C_TOTAL = JBColor(Color(0x4C8BF5), Color(0x4C8BF5))
private val C_INPUT = JBColor(Color(0x9A6AC2), Color(0x9A6AC2))
private val C_OUTPUT = JBColor(Color(0xC9713F), Color(0xC9713F))
private val C_RED = JBColor(Color(0xE5534B), Color(0xE5534B))

private data class Bucket(
    val label: String,
    val editsPending: Double, val editsKept: Double, val editsUndone: Double,
    val tokensInput: Double, val tokensOutput: Double,
) { val tokensTotal get() = tokensInput + tokensOutput }

/** One USAGE row: the numbers live in shared spent/total/cached columns. A
 *  measurement without a quota share (Enterprise) keeps pct null — the value still shows in the
 *  spent column, so the row is never empty. */
private data class UsageRow(
    val label: String,
    val pct: Double?,
    val spent: String = "",
    val total: String = "",
    val cached: String = "",
    /** The reset countdown, drawn in the full foreground directly above the bar. */
    val time: String? = null,
)

private data class Usage(
    val ctxPct: Double?, val ctxTokens: Double?, val ctxSize: Double?,
    val fivePct: Double?, val fiveReset: Long?, val fiveTok: Double?,
    val weekPct: Double?, val weekReset: Long?, val weekTok: Double?,
    /** Tokens MEASURED across every configured machine, and the plan totals the statusline read —
     *  both null until the bundled statusline has run somewhere. They outrank the projection. */
    val fiveAll: Double?, val weekAll: Double?, val fiveTotal: Double?, val weekTotal: Double?,
    /** Spend, as the client that computes it reported it — shown where a quota bar can never fill. */
    val costFive: Double?, val costWeek: Double?,
    /** The bill cycle: tokens, budget, reads, spend and its projected budget. */
    val monthTok: Double?, val monthTokTotal: Double?, val monthReset: Long?, val monthReads: Double?,
    val monthCost: Double?, val monthCostTotal: Double?,
    /** The per-model weekly cap the account reports (the desktop app's "Fable" row). */
    val fablePct: Double?, val fableReset: Long?, val fableLabel: String?,
    val fableTok: Double?, val fableTokTotal: Double?, val fableReads: Double?,
    /** codex's own rollout windows — the gpt tab (null when codex has no recent activity here). */
    val gptFivePct: Double?, val gptFiveReset: Long?, val gptWeekPct: Double?, val gptWeekReset: Long?,
    val gptCtxPct: Double?, val gptCtxTokens: Double?, val gptCtxSize: Double?,
    val gptWeekTok: Double?, val gptWeekTotal: Double?,
    val gptMonthReset: Long?,
    val gptMonthTok: Double?, val gptMonthTokTotal: Double?, val gptMonthReads: Double?,
    val gptMonthCost: Double?, val gptMonthCostTotal: Double?,
    val fiveReads: Double?, val weekReads: Double?, val tokCacheRead: Double?,
    val promoLabel: String?, val promoDates: String?,
    /** Credit left, where the account reports a balance (codex does), and whether it is uncapped. */
    val creditBalance: Double?, val creditsUnlimited: Boolean,
    /** Whose tokens the measured figures are: "here", "2 machines", "2 machines (1 unreachable)". */
    val usageScope: String?,
    val statuslineCache: Boolean, val cachedAtMs: Long?, val staleMs: Long,
    /** null = nothing has reported yet; false = this plan has no rolling windows (Enterprise / API). */
    val rollingLimits: Boolean?, val localWindows: List<Pair<String, Double>>,
    val sessionTokens: SessionTokens?,
    val vitals: SessionVitals?,
)

/** The session's cumulative token split from `usage --json`'s `sessionTokens` (core.sessionUsage). */
private data class SessionTokens(
    val input: Double, val output: Double, val cacheRead: Double, val cacheCreation: Double,
    val hitPct: Double?,
)

/** What the session is running on and what has happened to its context, from `usage --json`'s `vitals`
 *  (core.sessionVitals). [model] is null until the session has an assistant turn and [effort] is null when
 *  it never declared one — both render as nothing, never as a guessed default (the default differs by
 *  build and model, so inventing one would be a lie). */
private data class SessionVitals(
    val model: String?,
    val modelTurns: Int,
    /** Every model the session ran on as label→turns; more than one means it switched mid-flight. */
    val models: List<Pair<String, Int>>,
    val effort: String?,
    /** True when the level came from an older transcript's `/effort` echo rather than an assistant record. */
    val effortStub: Boolean,
    /** Context compactions the harness recorded, oldest first — structural (`compact_boundary` records),
     *  never estimated. Empty for a session that was never compacted. */
    val compactions: List<VitalCompaction>,
)

/** One compaction from `vitals.compactions`. [droppedTokens] is THIS event's own drop (pre − post) —
 *  core deliberately does not hand over the harness's running cumulative total here, which would
 *  overstate every compaction after the first. */
private data class VitalCompaction(val ts: Long, val trigger: String, val droppedTokens: Double)

private fun human(n: Double): String {
    if (!n.isFinite()) return "0"
    if (n < 1000) return n.toInt().toString()
    val (v, suf) = when {
        n < 1e6 -> n / 1e3 to "k"
        n < 1e9 -> n / 1e6 to "M"
        else -> n / 1e9 to "B"
    }
    val s = if (v < 10) String.format("%.1f", v) else v.toInt().toString()
    return (if (s.endsWith(".0")) s.dropLast(2) else s) + suf
}

private fun until(ms: Long?): String {
    if (ms == null) return ""
    val d = ms - System.currentTimeMillis()
    if (d <= 0) return ""
    val mins = (d / 60000).toInt()
    val h = mins / 60
    if (h >= 24) return "${h / 24}d${h % 24}h"
    return if (h > 0) "${h}h${mins % 60}m" else "${mins % 60}m"
}

/** The exact refresh time (2026-08-31: durations became wall-clock everywhere) — relTime, minus the
 *  seconds: a cache stamp does not need them. */
private fun atTime(ts: Long): String {
    val full = com.cellobservatory.observatory.model.relTime(ts)
    // Same-day form carries seconds ("14:32:05") — trim to the minute for this stamp.
    return if (Regex("^\\d\\d:\\d\\d:\\d\\d$").matches(full)) full.substring(0, 5) else full
}


/**
 * What a plan window actually shows.
 *
 * The MEASURED aggregate outranks the projection — it is added up from what each configured machine
 * recorded, while the projection divides THIS machine's tokens by an account-wide percentage, which
 * is only meaningful when one machine does all the work. Same precedence and same wording as the
 * terminal's statusline, so two surfaces cannot report different numbers for one session. The scope
 * travels with the figure: a total nobody can attribute is a total nobody trusts.
 */
/** Money, exactly as the terminal renders it. */
private fun usdStr(n: Double): String = when {
    n >= 1000 -> "$%.1fk".format(n / 1000)
    n >= 100 -> "$%.0f".format(n)
    n > 0 && n < 0.01 -> "<\$0.01"
    else -> "$%.2f".format(n)
}

/** Credit left, where the account reports a balance (codex does). "unlimited" is a different fact
 *  from a zero balance and is never drawn as $0. */
private fun creditNote(u: Usage): String = when {
    u.creditsUnlimited -> " · credits unlimited"
    u.creditBalance != null -> " · credits " + usdStr(u.creditBalance)
    else -> ""
}

/** The shell statusline's own humaniser: TRUNCATING, at every magnitude. The panel's rounding
 *  version disagreed with the terminal and the status line about the same number. */
private fun humanTok(n: Double): String {
    val v = n.toLong()
    if (v >= 1_000_000_000) {
        val b = (v % 1_000_000_000) / 100_000_000
        return if (b == 0L) "${v / 1_000_000_000}B" else "${v / 1_000_000_000}.${b}B"
    }
    if (v >= 1_000_000) {
        val d = (v % 1_000_000) / 100_000
        return if (d == 0L) "${v / 1_000_000}M" else "${v / 1_000_000}.${d}M"
    }
    if (v >= 1000) return "${v / 1000}k"
    return "$v"
}

private fun estPair(measured: Double?, total: Double?, tok: Double?, pct: Double?): Pair<String, String> {
    // ONE set of numbers on every surface: the statusline's calibrated account
    // est/total is CANONICAL — a second denominator derived from the measured sum disagreed with
    // the terminal for the same window. The derived form is only the fallback when the cache has
    // no estimate yet. No scope text on the rows, ever. Split spent/total, for the columns.
    val used = if (tok != null && tok > 0 && total != null && total > 0) tok else (measured?.takeIf { it > 0 } ?: tok?.takeIf { it > 0 })
    if (used == null) return "" to ""
    val p = pct ?: 0.0
    val budget = if (tok != null && tok > 0 && total != null && total > 0) total
        else if (p >= 1.0) used / p * 100 else null
    return "~${humanTok(used)}" to (budget?.let { humanTok(it) } ?: "")
}

/** Stale stamp + credit note, drawn as one footnote line under the rows — they used to ride the
 *  row detail text, where they broke the column alignment. */
private fun footNote(u: Usage?): String {
    if (u == null) return ""
    val age = if (u.statuslineCache && u.cachedAtMs != null) System.currentTimeMillis() - u.cachedAtMs else null
    val stale = if (age != null && age > u.staleMs) "as of ${atTime(u.cachedAtMs ?: 0L)}" else ""
    return listOf(stale, creditNote(u).removePrefix(" · ")).filter { it.isNotBlank() }.joinToString(" · ")
}


/**
 * Stats + Usage, painted natively in Swing (deliberately no JCEF — fragile under Gateway/remote
 * dev, and the plots are simple step-lines). Edits (linear) + Tokens (log) with a Today/7d/30d
 * toggle and crosshair tooltips; below, the ctx/5h/wk usage bars with reset countdowns, ~token
 * estimates, and the v0.1.2 staleness stamps ("Xm ago" + terminal hint when the statusline cache
 * is older than USAGE_STALE_MS, since IDE panels never run the agent's statusLine).
 */
class StatsPanel(private val project: Project) : JPanel(BorderLayout()), com.intellij.openapi.Disposable {

    /** Live panels by project, so the guided tour can ring a control this panel owns. Same shape as
     *  ChangeMapPanel's registry — the panel is created by a tool-window factory and has no other
     *  identity. Entries drop when the project closes. */
    companion object Registry {
        private val live = java.util.concurrent.ConcurrentHashMap<Project, StatsPanel>()
        fun of(project: Project): StatsPanel? = live[project]
        internal fun remember(project: Project, panel: StatsPanel) {
            live[project] = panel
            com.intellij.openapi.util.Disposer.register(project) { live.remove(project, panel) }
        }
    }

    /** The component a tour step's anchor names, or null when this panel does not own that name — the
     *  tour asks every panel and rings whichever one answers. */
    fun tourAnchor(anchor: String?): javax.swing.JComponent? {
        val c = when (anchor) {
            "stats-model" -> vitalsChip
            "stats-compaction" -> compactionLine
            "stats-tokens", "stats-cache" -> tokenStrip
            "stats-usage" -> usageBars
            "stats-review" -> scoreboard
            else -> null
        }
        // A folded section unfolds before it is ringed — pointing at a fold is not showing the thing.
        when (c) {
            tokenStrip, compactionLine -> secTokens.unfold()
            scoreboard -> secEdits.unfold()
            usageBars -> secUsage.unfold()
        }
        return c
    }

    private var series: Map<String, List<Bucket>> = emptyMap()
    private var usage: Usage? = null
    private var range = "week"
    private var statsEverLoaded = false
    private var lastStatsRun = 0L
    private var statsRunning = false
    // Held so dispose() can stop them — otherwise the Swing TimerQueue + the service listener keep the
    // panel (and the captured, now-disposed Project) reachable after the tool window/project closes.
    private val serviceListener = Runnable { refresh() }
    private var refreshTimer: Timer? = null
    private var spinTimer: Timer? = null

    private val gathering = JBLabel("Gathering stats…").apply {
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(8)
        toolTipText = "First scan of your transcripts; cached after"
    }
    private val tokenStrip = TokenStrip()
    private val scoreboard = ReviewScoreboard()
    private val tokensChart = ChartComponent(
        true,
        listOf(Triple("total", C_TOTAL) { b: Bucket -> b.tokensTotal },
            Triple("input", C_INPUT) { b: Bucket -> b.tokensInput },
            Triple("output", C_OUTPUT) { b: Bucket -> b.tokensOutput }),
    )
    private val usageBars = UsageBars()
    private val hint = JBLabel().apply {
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(4, 8)
        isVisible = false
    }
    // Stats top navbar (parity with the VS Code Stats navbar): the active session only — Search-edits
    // lives on the review nav bar (Overview toolbar + status bar), as in VS Code.
    private val sessionLabel = JBLabel().apply {
        foreground = UIUtil.getContextHelpForeground()
        toolTipText = "Active Claude Code session"
        // A prompt can be the title. Let Swing ellipsize it instead of making its full text the
        // splitter's minimum width; the tooltip below retains the complete title and session ID.
        minimumSize = Dimension(0, preferredSize.height)
    }
    // Which model is serving this session, and at what effort (0.8.6). Hidden outright until the
    // transcript records an assistant turn — a placeholder chip beside the title would read as a fact.
    private val vitalsChip = JBLabel().apply {
        font = JBUI.Fonts.miniFont()
        foreground = UIUtil.getContextHelpForeground()
        isVisible = false
    }
    // Context compactions, as one line. The saw-tooth context chart this used to sit under is gone, but
    // losing context is the most consequential thing that happens to a long session, so the FACT stays:
    // how many times, and how much the last one dropped. Hidden outright when there were none.
    private val compactionLine = JBLabel().apply {
        font = JBUI.Fonts.miniFont()
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(2, 2, 0, 2)
        alignmentX = java.awt.Component.LEFT_ALIGNMENT
        isVisible = false
    }

    // Foldable sections: each header row toggles its body,
    // the painted titles moved up into the headers, state persists app-wide. The chart section is
    // built in init because the range toggle is a local there.
    private val secTokens = FoldSection("tokens", "SESSION TOKENS", listOf(tokenStrip, compactionLine))
    private val secEdits = FoldSection("edits", "EDITS", listOf(scoreboard))
    // Manual refresh, pinned right of the Usage title: pull the account usage
    // now — the same refresh the status-bar ↻ fires. The pull is
    // a detached process into the cache, so the click nudges two quick re-polls (without them the
    // panel sits on its normal cadence and the click looks dead) and spins to say it heard.
    private val usageRefreshLink = com.intellij.ui.components.ActionLink("↻") {}.apply {
        font = JBUI.Fonts.label(14f)
        toolTipText = "Refresh now — pull your account usage"
    }
    // One tab per subscription — shown only when codex reports windows here.
    private val usageTabClaude = com.intellij.ui.components.ActionLink("claude") { setUsageTab("claude") }.apply { font = JBUI.Fonts.miniFont() }
    private val usageTabGpt = com.intellij.ui.components.ActionLink("gpt") { setUsageTab("gpt") }.apply { font = JBUI.Fonts.miniFont(); isVisible = false }
    private val secUsage = FoldSection(
        "usage", "USAGE", listOf(usageBars, hint),
        JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            add(usageTabClaude)
            add(Box.createHorizontalStrut(JBUI.scale(6)))
            add(usageTabGpt)
            add(Box.createHorizontalStrut(JBUI.scale(10)))
            add(usageRefreshLink)
        },
    )

    private fun setUsageTab(t: String) {
        PropertiesComponent.getInstance().setValue("oak.stats.usage.tab", t, "claude")
        usageBars.tab = t
        syncUsageTabLinks()
        usage?.let { usageBars.update(it) } ?: usageBars.repaint()
    }

    private fun syncUsageTabLinks() {
        val bold = JBUI.Fonts.miniFont().asBold()
        usageTabClaude.font = if (usageBars.tab == "gpt") JBUI.Fonts.miniFont() else bold
        usageTabGpt.font = if (usageBars.tab == "gpt") bold else JBUI.Fonts.miniFont()
    }

    init {
        Registry.remember(project, this) // so the guided tour can ring a control this panel owns
        // Keep every range reachable in the default narrow dock: FlowLayout can wrap the last
        // button below this fixed-height row, where it is clipped by the chart section.
        val ranges = JPanel(GridLayout(1, 3, JBUI.scale(4), 0)).apply {
            border = JBUI.Borders.empty(4)
        }
        val group = ButtonGroup()
        for ((key, label) in listOf("today" to "Today", "week" to "7 days", "month" to "30 days")) {
            val b = JToggleButton(label, key == range)
            b.addActionListener { range = key; repaintCharts() }
            group.add(b)
            ranges.add(b)
        }
        // Top navbar: the active session. The range toggle lives in the stack right above the chart it
        // scopes (VS Code parity: title → session tokens → edits → ranges → chart → usage). Clicking
        // the scoreboard's PENDING column jumps to the first edit to review.
        val navbar = JPanel(BorderLayout(JBUI.scale(8), 0)).apply {
            border = JBUI.Borders.empty(4, 8, 3, 8)
            add(sessionLabel, BorderLayout.CENTER)
            add(vitalsChip, BorderLayout.EAST)
        }
        add(navbar, BorderLayout.NORTH)
        // In the BoxLayout stack an unbounded JPanel would soak up glue space — pin its height.
        ranges.maximumSize = Dimension(Int.MAX_VALUE, ranges.preferredSize.height)
        scoreboard.toolTipText = "Click the PENDING count to jump to the first edit to review"
        scoreboard.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) { if (e.x < scoreboard.width / 3) reviewFirst() }
        })
        scoreboard.addMouseMotionListener(object : java.awt.event.MouseMotionAdapter() {
            override fun mouseMoved(e: java.awt.event.MouseEvent) {
                scoreboard.cursor = if (e.x < scoreboard.width / 3) java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR) else java.awt.Cursor.getDefaultCursor()
            }
        })

        val secChart = FoldSection("chart", "TOKENS", listOf(ranges, gathering, tokensChart))
        val stack = ScrollableStack().apply {
            border = JBUI.Borders.empty(4, 8)
            add(secTokens)
            add(Box.createVerticalStrut(JBUI.scale(12)))
            add(secEdits)
            add(Box.createVerticalStrut(JBUI.scale(12)))
            add(secChart)
            add(Box.createVerticalStrut(JBUI.scale(12)))
            add(secUsage)
            add(Box.createVerticalGlue())
        }
        // Track the viewport width so charts/labels re-layout to the ACTUAL pane width — a plain
        // panel in a scroll pane lays out at preferred width and paints off-canvas when squeezed.
        add(JBScrollPane(stack, JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED, JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER), BorderLayout.CENTER)

        usageRefreshLink.addActionListener {
            // Spin + dim while the detached pull lands; the next update()
            // restores both. The re-poll timers are what make the click visibly finish.
            usageBars.busy = true
            usageBars.repaint()
            spinTimer?.stop()
            val frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
            var fi = 0
            spinTimer = Timer(90) {
                usageRefreshLink.text = frames[fi % frames.length].toString()
                fi++
            }.apply { start() }
            ObservatoryCli.pullAccountUsage(project.basePath)
            for (delay in intArrayOf(2500, 6000)) {
                Timer(delay) { refresh(forceUsage = true) }.apply { isRepeats = false; start() }
            }
        }
        secUsage.setNote("hover for what refreshes this")
        scoreboard.update(ObservatoryService.getInstance(project).counts()) // populate before first show
        ObservatoryService.getInstance(project).addListener(serviceListener)
        // 30s tick: refresh usage + stale stamps; stats self-throttles to one subprocess per 20s.
        refreshTimer = Timer(30_000) { if (isShowing) refresh() }.apply { isRepeats = true; start() }
        addHierarchyListener { if (isShowing) refresh() }
    }

    override fun dispose() {
        spinTimer?.stop()
        refreshTimer?.stop()
        refreshTimer = null
        ObservatoryService.getInstance(project).removeListener(serviceListener)
    }

    private fun repaintCharts() {
        val buckets = series[range] ?: emptyList()
        tokensChart.update(buckets)
    }

    /** Jump to the first (oldest) pending edit — the scoreboard PENDING-count click target. */
    private fun reviewFirst() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return
        // Same set the review walk uses: off the raw log this jumped to a chain the walk skips, so the
        // scoreboard and "review next" disagreed about where reviewing starts.
        val first = service.log().filter { it.pending && !service.isHidden(it) }.minByOrNull { it.id } ?: return
        com.cellobservatory.observatory.ui.Navigate.openFileAtEdit(project, session, first)
    }

    fun refresh(forceUsage: Boolean = false) {
        val session = ObservatoryService.getInstance(project).currentSession()
        // Show the human-readable session NAME (title / first prompt) — reuses the change-map summary the
        // service already caches (no extra CLI spawn); the raw id stays in the tooltip. VS Code parity.
        val title = ObservatoryService.getInstance(project).changemap()?.summary?.title?.takeIf { it.isNotBlank() }
        sessionLabel.text = "🔬 " + (title ?: session?.take(8) ?: "—")
        sessionLabel.toolTipText = session?.let { (title?.let { t -> "$t — " } ?: "") + "Active session: $it" } ?: "No active Claude Code session"
        // Live review scoreboard from the in-memory folded log (cheap; cached on the log's mtime/size).
        scoreboard.update(ObservatoryService.getInstance(project).counts())
        fetchUsage(forceUsage)
        fetchStats()
    }

    private var usageRunning = false
    private var lastUsageRun = 0L

    private fun fetchStats() {
        val now = System.currentTimeMillis()
        if (statsRunning || now - lastStatsRun < 20_000) return
        statsRunning = true
        lastStatsRun = now
        val session = ObservatoryService.getInstance(project).currentSession()
        AppExecutorUtil.getAppExecutorService().submit {
            val json = ObservatoryCli.statsJson(session, project.basePath)
            val parsed = json?.let { parseStats(it) }
            ApplicationManager.getApplication().invokeLater {
                statsRunning = false
                if (project.isDisposed) return@invokeLater
                if (parsed == null) {
                    if (!statsEverLoaded) {
                        gathering.text = "⚠ Needs the oak CLI"
                        gathering.toolTipText = "Stats run `oak stats --json` — install the CLI on this machine, then reopen this tab."
                    }
                } else {
                    statsEverLoaded = true
                    gathering.isVisible = false
                    series = parsed
                    repaintCharts()
                }
            }
        }
    }

    private fun fetchUsage(force: Boolean = false) {
        // Throttled like fetchStats: the service listener fires this on every coalesced tick (~2-3s
        // during active work), which spawned a ~60ms CLI process each time, visible or not. The 30s
        // Timer already re-fires while the panel is showing, so a 20s floor loses nothing but churn.
        // The ↻ button passes force=true: its re-polls (at 2.5s/6s) land inside the floor on most
        // clicks, which dropped them and left the spinner running until the next 30s tick.
        val now = System.currentTimeMillis()
        if (usageRunning || (!force && now - lastUsageRun < 20_000)) return
        usageRunning = true
        lastUsageRun = now
        val session = ObservatoryService.getInstance(project).currentSession()
        AppExecutorUtil.getAppExecutorService().submit {
            val u = ObservatoryCli.usageJson(session, project.basePath)?.let { parseUsage(it) }
            ApplicationManager.getApplication().invokeLater {
                usageRunning = false
                if (project.isDisposed) return@invokeLater
                usage = u ?: usage
                usageBars.tab = PropertiesComponent.getInstance().getValue("oak.stats.usage.tab", "claude")
                usageTabGpt.isVisible = usage?.gptFivePct != null || usage?.gptWeekPct != null || usage?.gptCtxPct != null || usage?.gptMonthTok != null
                if (!usageTabGpt.isVisible && usageBars.tab == "gpt") usageBars.tab = "claude"
                syncUsageTabLinks()
                usageBars.update(usage)
                secUsage.setNote(usage?.cachedAtMs?.let { "updated " + atTime(it) } ?: "")
                spinTimer?.stop()
                spinTimer = null
                usageBars.busy = false
                usageRefreshLink.text = "↻"
                tokenStrip.update(usage?.sessionTokens)
                updateVitals(usage?.vitals)
                updateHint()
            }
        }
    }

    /** The navbar's model/effort chip. Nothing is invented: no model → no chip at all, no declared effort
     *  → no effort clause. "+N" means the session switched models mid-flight; the tooltip names them with
     *  their turn counts, and says when the effort came from an `/effort` echo instead of a record. */
    private fun updateVitals(v: SessionVitals?) {
        updateCompactions(v?.compactions ?: emptyList())
        val model = v?.model
        if (v == null || model == null) {
            vitalsChip.isVisible = false
            return
        }
        val others = v.models.filter { it.first != model }
        vitalsChip.text = model + (v.effort?.let { " · $it effort" } ?: "") + (if (others.isNotEmpty()) "  +${others.size}" else "")
        vitalsChip.toolTipText = buildString {
            append("Model: $model")
            if (v.modelTurns > 0) append(" · ${v.modelTurns} turn(s)")
            if (others.isNotEmpty()) {
                append("\nAlso ran on: ")
                append(others.joinToString(", ") { "${it.first} (${it.second} turn(s))" })
            }
            v.effort?.let {
                append("\nEffort: $it")
                if (v.effortStub) append(" — read from the session's /effort command, not from an assistant record")
            }
        }
        vitalsChip.isVisible = true
    }

    /** The one-line compaction readout: how many times this session's context was summarized away, and
     *  what the most recent one dropped. A session that was never compacted shows nothing at all — an
     *  explicit "0 compactions" line would be noise on the majority of sessions. */
    private fun updateCompactions(comps: List<VitalCompaction>) {
        val last = comps.lastOrNull()
        if (last == null) {
            compactionLine.isVisible = false
            return
        }
        val drop = if (last.droppedTokens > 0) " · last dropped ${human(last.droppedTokens)} tokens" else ""
        compactionLine.text = "⌁ ${comps.size} context compaction${if (comps.size == 1) "" else "s"}$drop"
        compactionLine.toolTipText = buildString {
            append("Claude Code summarized the conversation so far and continued from that summary.")
            comps.takeLast(6).forEach {
                append("\n${it.trigger.ifBlank { "compact" }}")
                if (it.droppedTokens > 0) append(" · ${human(it.droppedTokens)} dropped")
                if (it.ts > 0) append(" · ${java.text.SimpleDateFormat("HH:mm").format(java.util.Date(it.ts))}")
            }
            if (comps.size > 6) append("\n(${comps.size - 6} earlier one(s) not listed)")
        }
        compactionLine.isVisible = true
    }

    private fun updateHint() {
        val u = usage ?: return
        hint.isVisible = true
        when {
            !u.statuslineCache -> {
                hint.text = "<html>Run <b>oak statusline</b> for 5h/wk usage</html>"
                hint.toolTipText = "5h/week plan usage needs claude-statusline writing on this host — it's bundled with the CLI; start an agent session after installing."
            }
            // The freshness story lives on the usage TOOLTIP now, not a banner.
            else -> hint.isVisible = false
        }
    }

    // --- parsing ---

    private fun parseStats(json: String): Map<String, List<Bucket>>? = try {
        val o = JsonParser.parseString(json).asJsonObject
        if (!o.has("daily") || !o.has("hourly")) null else { // guard against a foreign binary's JSON
            val daily = o.getAsJsonArray("daily").map { bucketOf(it.asJsonObject, dayLabel(it.asJsonObject)) }
            val hourly = o.getAsJsonArray("hourly").map { bucketOf(it.asJsonObject, "${it.asJsonObject.get("hour").asInt}:00") }
            mapOf("today" to hourly, "week" to daily.takeLast(7), "month" to daily)
        }
    } catch (_: Exception) {
        null
    }

    private fun dayLabel(o: JsonObject): String {
        val p = o.get("day").asString.split("-")
        return if (p.size == 3) "${p[1].toInt()}/${p[2].toInt()}" else o.get("day").asString
    }

    private fun bucketOf(o: JsonObject, label: String) = Bucket(
        label = label,
        editsPending = o.get("editsPending")?.asDouble ?: 0.0,
        editsKept = o.get("editsKept")?.asDouble ?: 0.0,
        editsUndone = o.get("editsUndone")?.asDouble ?: 0.0,
        tokensInput = o.get("tokensInput")?.asDouble ?: 0.0,
        tokensOutput = o.get("tokensOutput")?.asDouble ?: 0.0,
    )

    private fun parseUsage(json: String): Usage? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val account = o.get("claudeAccount")?.takeIf { it.isJsonObject }?.asJsonObject ?: o
        val ctx = account.get("ctx")?.takeIf { it.isJsonObject }?.asJsonObject
        fun num(el: com.google.gson.JsonElement?): Double? =
            el?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble
        fun lng(el: com.google.gson.JsonElement?): Long? =
            el?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asLong
        Usage(
            ctxPct = num(ctx?.get("pct")), ctxTokens = num(ctx?.get("tokens")), ctxSize = num(ctx?.get("size")),
            // ACCOUNT keys first (claude*): the unprefixed twins are session-scoped and, for a codex
            // session, carry GPT's windows under Claude's label.
            fivePct = num(o.get(if (o.has("claudeFivePct")) "claudeFivePct" else "fiveHourPct")), fiveReset = lng(o.get(if (o.has("claudeFiveReset")) "claudeFiveReset" else "fiveReset")), fiveTok = num(o.get(if (o.has("claudeFiveTokens")) "claudeFiveTokens" else "fiveTokens")),
            weekPct = num(o.get(if (o.has("claudeWeekPct")) "claudeWeekPct" else "weekPct")), weekReset = lng(o.get(if (o.has("claudeWeekReset")) "claudeWeekReset" else "weekReset")), weekTok = num(o.get(if (o.has("claudeWeekTokens")) "claudeWeekTokens" else "weekTokens")),
            fiveAll = num(account.get("fiveMeasuredAll")), weekAll = num(account.get("weekMeasuredAll")),
            fiveTotal = num(account.get("fiveTotal")), weekTotal = num(account.get("weekTotal")),
            costFive = num(account.get("cost")?.takeIf { it.isJsonObject }?.asJsonObject?.get("five")),
            costWeek = num(account.get("cost")?.takeIf { it.isJsonObject }?.asJsonObject?.get("week")),
            monthTok = num(account.get("monthTokens")), monthTokTotal = num(account.get("monthTokensTotal")),
            monthReset = lng(account.get("monthReset")), monthReads = num(account.get("monthReads")),
            monthCost = num(account.get("monthCost")), monthCostTotal = num(account.get("monthCostTotal")),
            fablePct = num(account.get("fablePct")), fableReset = lng(account.get("fableReset")),
            fableLabel = account.get("fableLabel")?.takeIf { it.isJsonPrimitive }?.asString,
            fableTok = num(account.get("fableTokens")), fableTokTotal = num(account.get("fableTotal")),
            fableReads = num(account.get("fableReads")),
            gptFivePct = num(o.get("gptFivePct")), gptFiveReset = lng(o.get("gptFiveReset")),
            gptWeekPct = num(o.get("gptWeekPct")), gptWeekReset = lng(o.get("gptWeekReset")),
            gptCtxPct = num(o.get("gptCtxPct")), gptCtxTokens = num(o.get("gptCtxTokens")), gptCtxSize = num(o.get("gptCtxSize")),
            gptWeekTok = num(o.get("gptWeekTok")), gptWeekTotal = num(o.get("gptWeekTotal")),
            gptMonthReset = lng(o.get("gptMonthReset")),
            gptMonthTok = num(o.get("gptMonthTok")), gptMonthTokTotal = num(o.get("gptMonthTokTotal")), gptMonthReads = num(o.get("gptMonthReads")),
            gptMonthCost = num(o.get("gptMonthCost")), gptMonthCostTotal = num(o.get("gptMonthCostTotal")),
            fiveReads = num(account.get("fiveReads")), weekReads = num(account.get("weekReads")),
            tokCacheRead = num(account.get("tokensCacheRead")),
            promoLabel = account.get("promo")?.takeIf { it.isJsonObject }?.asJsonObject?.get("label")?.takeIf { it.isJsonPrimitive }?.asString,
            promoDates = account.get("promo")?.takeIf { it.isJsonObject }?.asJsonObject?.get("dates")?.takeIf { it.isJsonPrimitive }?.asString,
            creditBalance = num(account.get("creditBalance")),
            creditsUnlimited = account.get("creditsUnlimited")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
            usageScope = account.get("usageScope")?.takeIf { it.isJsonPrimitive }?.asString,
            rollingLimits = account.get("rollingLimits")?.takeIf { !it.isJsonNull }?.asBoolean,
            localWindows = o.get("localWindows")?.takeIf { !it.isJsonNull }?.asJsonArray
                ?.map { it.asJsonObject }
                ?.mapNotNull { w -> (num(w.get("tokens")))?.let { t -> w.get("label").asString to t } }
                ?: emptyList(),
            statuslineCache = account.get("statuslineCache")?.asBoolean ?: false,
            cachedAtMs = lng(account.get("cachedAtMs")),
            staleMs = lng(o.get("staleMs")) ?: 300_000L,
            sessionTokens = o.get("sessionTokens")?.takeIf { it.isJsonObject && it.asJsonObject.get("available")?.takeIf { v -> v.isJsonPrimitive }?.asBoolean != false }?.asJsonObject?.let { st ->
                SessionTokens(
                    input = num(st.get("input")) ?: 0.0,
                    output = num(st.get("output")) ?: 0.0,
                    cacheRead = num(st.get("cacheRead")) ?: 0.0,
                    cacheCreation = num(st.get("cacheCreation")) ?: 0.0,
                    hitPct = num(st.get("hitPct")),
                )
            },
            vitals = o.get("vitals")?.takeIf { it.isJsonObject }?.asJsonObject?.let { v ->
                val m = v.get("model")?.takeIf { it.isJsonObject }?.asJsonObject
                val eff = v.get("effort")?.takeIf { it.isJsonObject }?.asJsonObject
                fun list(k: String) =
                    v.get(k)?.takeIf { it.isJsonArray }?.asJsonArray ?: com.google.gson.JsonArray()
                SessionVitals(
                    model = m?.get("label")?.takeIf { !it.isJsonNull }?.asString,
                    modelTurns = num(m?.get("turns"))?.toInt() ?: 0,
                    models = list("models").mapNotNull { e ->
                        val mo = e.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                        val label = mo.get("label")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null
                        label to (num(mo.get("turns"))?.toInt() ?: 0)
                    },
                    effort = eff?.get("level")?.takeIf { !it.isJsonNull }?.asString,
                    effortStub = eff?.get("source")?.takeIf { !it.isJsonNull }?.asString == "stub",
                    compactions = list("compactions").mapNotNull { e ->
                        val co = e.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                        VitalCompaction(
                            ts = lng(co.get("ts")) ?: 0L,
                            trigger = co.get("trigger")?.takeIf { !it.isJsonNull }?.asString ?: "compact",
                            droppedTokens = num(co.get("droppedTokens")) ?: 0.0,
                        )
                    },
                )
            },
        )
    } catch (_: Exception) {
        null
    }
}

/** A vertical stack whose width always tracks the scroll viewport, so children lay out and paint
 *  at the REAL pane width instead of their preferred width (which long labels would inflate). */
private class ScrollableStack : JPanel(), javax.swing.Scrollable {
    init {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }

    override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
    override fun getScrollableUnitIncrement(r: java.awt.Rectangle, o: Int, d: Int) = JBUI.scale(16)
    override fun getScrollableBlockIncrement(r: java.awt.Rectangle, o: Int, d: Int) = JBUI.scale(64)
    override fun getScrollableTracksViewportWidth() = true
    override fun getScrollableTracksViewportHeight() = false
}

/** A foldable stats section — the Overview columns' fold gesture applied to this stack:
 *  a mini-font header ("▾ TITLE") toggles the body wrapper. Only the WRAPPER hides,
 *  so children keep their own isVisible logic (gathering/hint follow data, not the fold). Fold
 *  state persists app-wide, mirroring the VS Code webview's saved state. */
private class FoldSection(key: String, private val title: String, body: List<JComponent>, headerExtra: JComponent? = null) : JPanel() {
    private val propKey = "oak.stats.fold." + key
    private val header = JBLabel().apply {
        font = JBUI.Fonts.miniFont()
        foreground = UIUtil.getContextHelpForeground()
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        toolTipText = "Click to fold or unfold this section"
        border = JBUI.Borders.emptyBottom(2)
        alignmentX = LEFT_ALIGNMENT
    }
    private val bodyPane = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = false
        alignmentX = LEFT_ALIGNMENT
    }
    /** A dim note beside the title (the usage section shows its last-updated time here). */
    private val noteLabel = JBLabel().apply {
        font = JBUI.Fonts.miniFont()
        foreground = UIUtil.getContextHelpForeground()
    }
    private var folded = PropertiesComponent.getInstance().getBoolean(propKey, false)

    fun setNote(text: String) {
        noteLabel.text = text
    }

    init {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = false
        alignmentX = LEFT_ALIGNMENT
        for (c in body) {
            c.alignmentX = LEFT_ALIGNMENT
            bodyPane.add(c)
        }
        // Header row: title · note … [extra pinned RIGHT].
        add(JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            alignmentX = LEFT_ALIGNMENT
            add(header)
            add(Box.createHorizontalStrut(JBUI.scale(6)))
            add(noteLabel)
            add(Box.createHorizontalGlue())
            if (headerExtra != null) add(headerExtra)
            maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(20))
        })
        add(bodyPane)
        header.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                folded = !folded
                PropertiesComponent.getInstance().setValue(propKey, folded)
                sync()
            }
        })
        sync()
    }

    fun unfold() {
        if (!folded) return
        folded = false
        PropertiesComponent.getInstance().setValue(propKey, false)
        sync()
    }

    private fun sync() {
        header.text = (if (folded) "▸ " else "▾ ") + title
        bodyPane.isVisible = !folded
        revalidate()
        repaint()
    }

    /** BoxLayout stack: never soak glue space past the content (the stack's standing rule). */
    override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
}

/** This session's cumulative token split — INPUT (uncached) / OUTPUT / CACHED (reads, with the hit
 *  rate folded into its label) — under the session title. "SESSION TOKENS", not "TOKENS"/"USAGE":
 *  both already name other sections of this panel (the machine-wide time-series chart and the
 *  plan-limit bars). VS Code parity. */
private class TokenStrip : JComponent() {
    private var t: SessionTokens? = null

    init {
        preferredSize = Dimension(JBUI.scale(200), JBUI.scale(50))
        minimumSize = Dimension(JBUI.scale(110), JBUI.scale(50))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(54))
    }

    fun update(tokens: SessionTokens?) {
        t = tokens
        repaint()
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val grey = UIUtil.getContextHelpForeground()
        g2.color = grey
        g2.font = JBUI.Fonts.miniFont()
        val tok = t
        val cachedLabel = "CACHED" + (tok?.hitPct?.let { " · ${Math.round(it)}% HIT" } ?: "")
        val cells: List<Triple<String, String, Color>> = listOf(
            Triple("INPUT", tok?.input?.let(::human) ?: "—", C_INPUT),
            Triple("OUTPUT", tok?.output?.let(::human) ?: "—", C_TOTAL),
            Triple(cachedLabel, tok?.cacheRead?.let(::human) ?: "—", C_KEPT),
        )
        val gap = JBUI.scale(6)
        val top = JBUI.scale(2)
        val cellW = (width - 2 * gap) / 3
        val cellH = JBUI.scale(42)
        var x = 0
        for ((label, value, color) in cells) {
            g2.color = JBColor.border()
            g2.drawRoundRect(x, top, cellW - 1, cellH, JBUI.scale(6), JBUI.scale(6))
            g2.color = color
            g2.font = JBUI.Fonts.label(14f).asBold()
            g2.drawString(value, x + (cellW - g2.fontMetrics.stringWidth(value)) / 2, top + JBUI.scale(22))
            g2.color = grey
            g2.font = JBUI.Fonts.miniFont()
            g2.drawString(label, x + (cellW - g2.fontMetrics.stringWidth(label)) / 2, top + JBUI.scale(36))
            x += cellW + gap
        }
        toolTipText = tok?.let {
            "This session's cumulative tokens, as billed — input ${human(it.input)} (uncached) · output ${human(it.output)}" +
                " · cache reads ${human(it.cacheRead)} · cache writes ${human(it.cacheCreation)}" +
                (it.hitPct?.let { p -> " · hit rate ${Math.round(p)}% (reads ÷ all context sent)" } ?: "")
        } ?: "This session's cumulative token split — fills in once the session has assistant turns"
    }
}

/** Live review scoreboard: current pending / accepted / reverted counts + a progress bar that fills as
 *  edits get reviewed. Fed from ObservatoryService.counts() on every store change — parity with the VS
 *  Code Stats webview's review section (natively painted, consistent with the charts below). */
private class ReviewScoreboard : JComponent() {
    private var c: ObservatoryService.Counts? = null

    init {
        preferredSize = Dimension(JBUI.scale(200), JBUI.scale(82))
        minimumSize = Dimension(JBUI.scale(110), JBUI.scale(82))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(88))
    }

    fun update(counts: ObservatoryService.Counts?) {
        c = counts
        repaint()
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val grey = UIUtil.getContextHelpForeground()
        g2.color = grey
        g2.font = JBUI.Fonts.miniFont()
        val counts = c ?: ObservatoryService.Counts(0, 0, 0, null)
        val cells = listOf(
            Triple("PENDING", counts.pending, C_PENDING),
            Triple("ACCEPTED", counts.kept, C_KEPT),
            Triple("REVERTED", counts.undone, C_REVERTED),
        )
        val gap = JBUI.scale(6)
        val top = JBUI.scale(2)
        val cellW = (width - 2 * gap) / 3
        val cellH = JBUI.scale(44)
        var x = 0
        for ((label, value, color) in cells) {
            g2.color = JBColor.border()
            g2.drawRoundRect(x, top, cellW - 1, cellH, JBUI.scale(6), JBUI.scale(6))
            g2.color = color
            g2.font = JBUI.Fonts.label(16f).asBold()
            val num = value.toString()
            g2.drawString(num, x + (cellW - g2.fontMetrics.stringWidth(num)) / 2, top + JBUI.scale(25))
            g2.color = grey
            g2.font = JBUI.Fonts.miniFont()
            g2.drawString(label, x + (cellW - g2.fontMetrics.stringWidth(label)) / 2, top + JBUI.scale(39))
            x += cellW + gap
        }
        val reviewed = counts.kept + counts.undone
        val total = counts.pending + reviewed
        val pct = if (total > 0) reviewed.toDouble() / total else 0.0
        val barY = top + cellH + JBUI.scale(10)
        val barH = JBUI.scale(5)
        g2.color = JBColor.border()
        g2.fillRoundRect(0, barY, width, barH, 4, 4)
        if (total > 0) {
            g2.color = if (pct >= 1.0) C_KEPT else C_TOTAL
            g2.fillRoundRect(0, barY, (width * pct).toInt().coerceAtLeast(2), barH, 4, 4)
        }
        g2.color = grey
        g2.font = JBUI.Fonts.miniFont()
        val progress = if (total > 0) "$reviewed of $total reviewed (${(pct * 100).toInt()}%)" else "no edits yet"
        g2.drawString(progress, JBUI.scale(2), barY + JBUI.scale(18))
        if (reviewed > 0) {
            val rate = "${(counts.kept.toDouble() / reviewed * 100).toInt()}% accepted"
            g2.drawString(rate, width - g2.fontMetrics.stringWidth(rate) - JBUI.scale(2), barY + JBUI.scale(18))
        }
    }
}

/** Multi-series step-line chart with y ticks (linear or log) and a crosshair tooltip. */
private class ChartComponent(
    private val logScale: Boolean,
    private val seriesSpec: List<Triple<String, Color, (Bucket) -> Double>>,
) : JComponent() {

    private var buckets: List<Bucket> = emptyList()
    private var hover = -1

    init {
        // Narrow-pane friendly: the Dashboards window shows three panes side by side, so this
        // chart must render sensibly from ~a quarter of a tool window up to full width.
        preferredSize = Dimension(JBUI.scale(200), JBUI.scale(96))
        minimumSize = Dimension(JBUI.scale(110), JBUI.scale(90))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(110))
        val mouse = object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                if (buckets.isEmpty()) return
                val plotX = e.x - JBUI.scale(36)
                val w = width - JBUI.scale(44)
                hover = if (plotX in 0..w) (plotX * buckets.size / max(1, w)).coerceIn(0, buckets.size - 1) else -1
                toolTipText = if (hover >= 0) buckets[hover].let { b ->
                    "${b.label} · " + seriesSpec.joinToString(" · ") { (n, _, f) -> "$n ${human(f(b))}" }
                } else null
                repaint()
            }

            override fun mouseExited(e: MouseEvent) {
                hover = -1
                repaint()
            }
        }
        addMouseMotionListener(mouse)
        addMouseListener(mouse)
    }

    fun update(b: List<Bucket>) {
        buckets = b
        repaint()
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val left = JBUI.scale(36)
        val plotW = width - left - JBUI.scale(8)
        val plotH = height - JBUI.scale(30)
        val top = JBUI.scale(14)
        val grey = UIUtil.getContextHelpForeground()

        g2.color = grey
        g2.font = JBUI.Fonts.miniFont()
        var lx = left
        for ((name, color, _) in seriesSpec) {
            val entryW = JBUI.scale(12) + g2.fontMetrics.stringWidth(name) + JBUI.scale(10)
            if (lx + entryW > width) break // narrow pane: drop trailing legend entries, don't overlap
            g2.color = color
            g2.fillRect(lx, JBUI.scale(5), JBUI.scale(9), JBUI.scale(3))
            g2.color = grey
            g2.drawString(name, lx + JBUI.scale(12), JBUI.scale(10))
            lx += entryW
        }
        if (buckets.isEmpty()) return

        var maxV = 1.0
        for ((_, _, f) in seriesSpec) for (b in buckets) maxV = max(maxV, f(b))
        fun yOf(v: Double): Int {
            val h = plotH - top
            val frac = if (logScale) (if (v < 1) 0.0 else ln(v) / ln(max(2.0, maxV))) else v / maxV
            return top + h - (frac * (h - 3)).toInt()
        }

        // baseline + y ticks (drawn top-down, skipping any tick within 14px of the previous —
        // the same min-separation guard as the VS Code chart, so labels never crowd or overlap)
        g2.color = JBColor.border()
        g2.drawLine(left, plotH, left + plotW, plotH)
        g2.color = grey
        val ticks = if (logScale) {
            generateSequence(1.0) { it * 10 }.takeWhile { it <= maxV }.toList().takeLast(3)
        } else listOf(maxV, maxV / 2).filter { it >= 1 }
        var lastTickY = Int.MIN_VALUE
        for (t in ticks.sortedDescending()) {
            val yy = yOf(t)
            if (lastTickY != Int.MIN_VALUE && kotlin.math.abs(yy - lastTickY) < JBUI.scale(14)) continue
            g2.drawString(human(t), JBUI.scale(2), yy + JBUI.scale(4))
            lastTickY = yy
        }

        val n = buckets.size
        for ((_, color, f) in seriesSpec) {
            g2.color = color
            var prevY = -1
            for (i in 0 until n) {
                val x0 = left + i * plotW / n
                val x1 = left + (i + 1) * plotW / n
                val y = yOf(f(buckets[i]))
                if (prevY >= 0) g2.drawLine(x0, prevY, x0, y)
                g2.drawLine(x0, y, x1, y)
                prevY = y
            }
        }

        if (hover in 0 until n) {
            g2.color = UIUtil.getLabelForeground()
            val cx = left + hover * plotW / n + plotW / (2 * n)
            g2.drawLine(cx, top, cx, plotH)
        }

        // x labels — count adapts to the pane width so narrow panes don't overlap labels
        g2.color = grey
        val m = minOf(6, n, max(2, plotW / JBUI.scale(56)))
        for (k in 0 until m) {
            val idx = if (m == 1) 0 else k * (n - 1) / (m - 1)
            val label = buckets[idx].label
            val x = left + (idx * plotW / n).coerceAtMost(plotW - g2.fontMetrics.stringWidth(label))
            g2.drawString(label, x, height - JBUI.scale(4))
        }
    }
}

/** The ctx / 5h / wk usage bars with color thresholds, countdowns, and ~token estimates. */
private class UsageBars : JComponent() {
    private var u: Usage? = null
    /** True while a manual pull is in flight — the section paints dimmed until update() lands. */
    var busy = false
    /** Which subscription's rows paint — "claude" or "gpt" (one tab per sub). */
    var tab = "claude"

    init {
        preferredSize = Dimension(JBUI.scale(200), JBUI.scale(54))
        minimumSize = Dimension(JBUI.scale(110), JBUI.scale(54))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(54))
    }

    /** Height follows the rows exactly (2026-09-04): the fixed 70px predates the mo/$ rows,
     *  which were silently CLIPPED below it. Every row takes the same 22px pitch (the time slot
     *  is reserved even when empty); the column header, promo note and footnote add their own
     *  lines. */
    private fun fitHeight(usage: Usage?) {
        val gptTab = tab == "gpt" && usage != null && (usage.gptFivePct != null || usage.gptWeekPct != null || usage.gptCtxPct != null || usage.gptMonthTok != null)
        val n = when {
            usage == null -> 3
            gptTab -> 1 + (if (usage.gptCtxPct != null) 1 else 0) + (if (usage.gptFivePct != null) 1 else 0) +
                (if ((usage.gptMonthTok ?: 0.0) > 0) 1 else 0) + (if ((usage.gptMonthCost ?: 0.0) > 0) 1 else 0)
            usage.rollingLimits == false -> if (usage.monthCost != null) 3 else 2
            else -> if (usage.fablePct != null) 6 else 5
        }
        val rowsH = n * JBUI.scale(22)
        val h = JBUI.scale(2) + JBUI.scale(12) + rowsH +
            (if (!gptTab && usage?.promoLabel != null) JBUI.scale(12) else 0) +
            (if (!gptTab && footNote(usage).isNotEmpty()) JBUI.scale(12) else 0) + JBUI.scale(4)
        preferredSize = Dimension(JBUI.scale(200), h)
        minimumSize = Dimension(JBUI.scale(110), h)
        maximumSize = Dimension(Int.MAX_VALUE, h)
        revalidate()
    }

    fun update(usage: Usage?) {
        u = usage
        fitHeight(usage)
        repaint()
    }

    private fun colorFor(pct: Double) = when {
        pct >= 80 -> C_RED
        pct >= 50 -> C_PENDING
        else -> C_KEPT
    }

    /** The rows the section paints, spent/total already formatted — apart from the paint so the figures
     *  can be read without a screen. */
    private fun rows(usage: Usage?, gptTab: Boolean): List<UsageRow> = if (usage == null) {
        listOf(UsageRow("ctx", null), UsageRow("5h", null), UsageRow("wk", null))
    } else if (gptTab) {
        // Same grammar throughout: ctx = codex's last-turn context vs its model window; wk
        // reported quota + measured local tokens; mo/$ calendar-summed and list-priced. 5h only
        // when codex still reports one (current builds persist the weekly alone). A row codex
        // gives no data for stays absent rather than fabricated.
        val gmp = if (usage.gptMonthTok != null && usage.gptMonthTokTotal != null && usage.gptMonthTokTotal > 0)
            minOf(100.0, usage.gptMonthTok / usage.gptMonthTokTotal * 100) else null
        listOfNotNull(
            usage.gptCtxPct?.let { UsageRow("ctx", it, usage.gptCtxTokens?.let { v -> human(v) } ?: "", usage.gptCtxSize?.let { v -> human(v) } ?: "") },
            usage.gptFivePct?.let { UsageRow("5h", it, time = until(usage.gptFiveReset).ifBlank { null }) },
            UsageRow("wk", usage.gptWeekPct,
                usage.gptWeekTok?.takeIf { it > 0 }?.let { "~${humanTok(it)}" } ?: "",
                usage.gptWeekTotal?.takeIf { it > 0 }?.let { humanTok(it) } ?: "",
                "", until(usage.gptWeekReset).ifBlank { null }),
            usage.gptMonthTok?.takeIf { it > 0 }?.let {
                UsageRow("mo", gmp, "~${humanTok(it)}",
                    usage.gptMonthTokTotal?.takeIf { t -> t > 0 }?.let { t -> humanTok(t) } ?: "",
                    usage.gptMonthReads?.takeIf { r -> r > 0 }?.let { r -> "+${humanTok(r)}↺" } ?: "",
                    until(usage.gptMonthReset).ifBlank { null })
            },
            usage.gptMonthCost?.takeIf { it > 0 }?.let {
                UsageRow("$", gmp, "~${usdStr(it)}",
                    usage.gptMonthCostTotal?.takeIf { t -> t > 0 }?.let { t -> "~${usdStr(t)}" } ?: "")
            },
        )
    } else {
        val moPct = if (usage.monthTok != null && usage.monthTokTotal != null && usage.monthTokTotal > 0)
            minOf(100.0, usage.monthTok / usage.monthTokTotal * 100) else null
        // The $ bar SHARES the month bar's percentage — one account, one share (2026-09-04).
        val dPct = if (usage.monthCost != null && moPct != null) moPct else null
        // humanTok on the quota rows — the statusline's truncating humaniser, so the columns
        // read byte-for-byte like the terminal (the old subs mixed in the rounding human()).
        val moSpent = usage.monthTok?.takeIf { it > 0 }?.let { "~${humanTok(it)}" } ?: ""
        val moTotal = usage.monthTokTotal?.let { humanTok(it) } ?: ""
        val moCached = usage.monthReads?.takeIf { it > 0 }?.let { "+${humanTok(it)}↺" } ?: ""
        val dSpent = usage.monthCost?.let { "~${usdStr(it)}" } ?: ""
        // The month's $ total is projected, like its spent figure (list prices over an estimated month): both carry `~`.
        val dTotal = usage.monthCostTotal?.let { "~${usdStr(it)}" } ?: ""
        val ctxRow = UsageRow("ctx", usage.ctxPct,
            usage.ctxTokens?.let { human(it) } ?: "",
            usage.ctxSize?.let { human(it) } ?: "",
            usage.tokCacheRead?.takeIf { it > 0 }?.let { "+${human(it)}↺" } ?: "")
        // No rolling quota (Enterprise/API): ctx + the bill cycle + its spend are the whole
        // readout — the 5h/wk slots say nothing such a plan can use. (A
        // second rollingLimits==false branch above used to shadow this one, so Enterprise
        // rendered the OLD layout with ledger-summed 5h spend — dead code.)
        if (usage.rollingLimits == false) listOfNotNull(
            ctxRow,
            UsageRow("mo", moPct, moSpent, moTotal, moCached),
            if (usage.monthCost != null) UsageRow("$", dPct, dSpent, dTotal) else null,
        )
        else {
            val p5 = estPair(usage.fiveAll, usage.fiveTotal, usage.fiveTok, usage.fivePct)
            val p7 = estPair(usage.weekAll, usage.weekTotal, usage.weekTok, usage.weekPct)
            listOfNotNull(
                ctxRow,
                UsageRow("5h", usage.fivePct, p5.first, p5.second, usage.fiveReads?.takeIf { it > 0 }?.let { "+${humanTok(it)}↺" } ?: "", until(usage.fiveReset).ifBlank { null }),
                // The per-model weekly cap (the account API's "Fable" row), BEFORE the
                // whole-week row it narrows — union-measured ~est/total + reads, same canon.
                usage.fablePct?.let {
                    UsageRow((usage.fableLabel ?: "fable").lowercase(), it,
                        usage.fableTok?.takeIf { v -> v > 0 }?.let { v -> "~${humanTok(v)}" } ?: "",
                        usage.fableTokTotal?.takeIf { v -> v > 0 }?.let { v -> humanTok(v) } ?: "",
                        usage.fableReads?.takeIf { v -> v > 0 }?.let { v -> "+${humanTok(v)}↺" } ?: "",
                        until(usage.fableReset).ifBlank { null })
                },
                UsageRow("wk", usage.weekPct, p7.first, p7.second, usage.weekReads?.takeIf { it > 0 }?.let { "+${humanTok(it)}↺" } ?: "", until(usage.weekReset).ifBlank { null }),
                UsageRow("mo", moPct, moSpent, moTotal, moCached, until(usage.monthReset).ifBlank { null }),
                UsageRow("$", dPct, dSpent, dTotal),
            )
        }
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        if (busy) g2.composite = java.awt.AlphaComposite.getInstance(java.awt.AlphaComposite.SRC_OVER, 0.55f)
        g2.font = JBUI.Fonts.miniFont()
        val grey = UIUtil.getContextHelpForeground()
        g2.color = grey
        val usage = u
        val gptTab = tab == "gpt" && usage != null && (usage.gptFivePct != null || usage.gptWeekPct != null || usage.gptCtxPct != null || usage.gptMonthTok != null)
        val rows = rows(usage, gptTab)
        // Row layout: label · bar (countdown directly ABOVE it) · % · then the
        // numbers in shared right-aligned spent/total/cached columns under a mini header, so they
        // align down the section. The bar takes whatever the columns leave (uniform across rows,
        // scaling with the pane); when even that reserve cannot fit, the columns drop and the bar
        // keeps a floor width. Rows without a countdown use a shorter pitch — no dead air.
        var y = JBUI.scale(2)
        val fm = g2.fontMetrics
        val trackX = JBUI.scale(28)
        val pctW = JBUI.scale(30)
        val fgTime = UIUtil.getLabelForeground()
        val colGap = JBUI.scale(8)
        val w1 = maxOf(fm.stringWidth("used"), rows.maxOf { fm.stringWidth(it.spent) })
        val w2 = maxOf(fm.stringWidth("total"), rows.maxOf { fm.stringWidth(it.total) })
        val w3 = maxOf(fm.stringWidth("cached"), rows.maxOf { fm.stringWidth(it.cached) })
        val colsW = w1 + w2 + w3 + colGap * 3
        val fits = width - trackX - pctW - colsW - JBUI.scale(6) >= JBUI.scale(40)
        val track = if (fits) width - trackX - pctW - colsW - JBUI.scale(6)
            else (width - trackX - pctW - JBUI.scale(10)).coerceAtLeast(JBUI.scale(40))
        val e3 = width - JBUI.scale(2)
        val e2 = e3 - w3 - colGap
        val e1 = e2 - w2 - colGap
        fun right(txt: String, edge: Int, baseline: Int) {
            if (txt.isNotEmpty()) g2.drawString(txt, edge - fm.stringWidth(txt), baseline)
        }
        if (fits) {
            g2.color = grey
            right("used", e1, y + JBUI.scale(8))
            right("total", e2, y + JBUI.scale(8))
            right("cached", e3, y + JBUI.scale(8))
            y += JBUI.scale(12)
        }
        // ONE pitch for every row — the time slot is reserved even when empty, so the bars are
        // evenly spaced down the section; the % sits tight against its bar.
        for (row in rows) {
            val barY = y + JBUI.scale(12)
            val by = barY + JBUI.scale(4)
            g2.color = grey
            g2.drawString(row.label, JBUI.scale(2), by)
            if (row.time != null) {
                g2.color = fgTime
                right(row.time, trackX + track, y + JBUI.scale(8))
            }
            g2.color = JBColor.border()
            g2.fillRoundRect(trackX, barY, track, JBUI.scale(5), 4, 4)
            val pct = row.pct
            if (pct != null) {
                val c = colorFor(pct)
                g2.color = c
                g2.fillRoundRect(trackX, barY, (track * (pct.coerceIn(0.0, 100.0) / 100)).toInt().coerceAtLeast(2), JBUI.scale(5), 4, 4)
                g2.drawString("${pct.toInt()}%", trackX + track + JBUI.scale(2), by)
            } else {
                g2.color = grey
                g2.drawString("—", trackX + track + JBUI.scale(2), by)
            }
            if (fits) {
                g2.color = grey
                right(row.spent, e1, by)
                right(row.total, e2, by)
                right(row.cached, e3, by)
            }
            y += JBUI.scale(22)
        }
        // The live limits promotion is part of these budgets — say so where the bars are read;
        // the stale stamp + credit note follow as one footnote (they used to ride the row text).
        g2.color = grey
        g2.font = g2.font.deriveFont(g2.font.size2D - 1f)
        if (!gptTab && usage?.promoLabel != null) {
            g2.drawString("${usage.promoLabel} limit promotion ${usage.promoDates ?: ""}".trim(), JBUI.scale(2), y + JBUI.scale(8))
            y += JBUI.scale(12)
        }
        val foot = if (gptTab) "" else footNote(usage)
        if (foot.isNotEmpty()) g2.drawString(foot, JBUI.scale(2), y + JBUI.scale(8))
        // The freshness story rides the hover: when the cache was last
        // refreshed, what refreshes it, and the no-credentials fallback — no banner.
        val rowsTip = rows.joinToString("  ·  ") { r ->
            ("${r.label} ${r.pct?.toInt()?.toString()?.plus("%") ?: "—"} " +
                listOf(r.spent, r.total, r.cached).filter { it.isNotEmpty() }.joinToString("/")).trim()
        }
        val freshTip = usage?.cachedAtMs?.let {
            "5h / week last refreshed at ${atTime(it)}. The panel pulls your account usage about once a minute " +
                "when Claude Code credentials are readable; without them (or offline), keep a claude terminal " +
                "open — its status line refreshes the same cache. ctx stays live from the transcript."
        }
        toolTipText = if (freshTip != null) "<html>${rowsTip}<br><br>${freshTip}</html>" else rowsTip
    }
}
