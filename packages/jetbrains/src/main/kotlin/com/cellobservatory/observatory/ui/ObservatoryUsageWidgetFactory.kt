package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JLabel
import javax.swing.JPanel
import java.lang.Math

private const val USAGE_WIDGET_ID = "claudeObservatoryUsage"

/** The usage readout on the IDE status bar (from the reference screenshot):
 *  per agent an ICON, then one chunk per window — bar + share colored by usage (the statusline's
 *  green/yellow/red), the window label grey, the time-left in the theme's plain foreground:
 *  `✳ ▰▱▱ 41% wk 4d · …  ⬡ …`. HTML labels carry the per-piece colors Swing
 *  cannot do in plain text. Both show wk and the bill-cycle month; no bar shows the 5-hour window, in its
 *  text or its tooltip (the Stats panel does). Refreshed once a minute off the EDT; click opens the Dashboards window.
 *  VS Code parity (its status items are single-color, so each window-chunk wears its hue there). */
class ObservatoryUsageWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = USAGE_WIDGET_ID
    override fun getDisplayName() = "OAK Usage"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = UsageWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

internal data class UsageSnap(
    /** Claude's 5-hour share: never drawn here, only read to tell a plan with rolling windows from a quota-less one. */
    val fivePct: Double?,
    val weekPct: Double?, val weekReset: Long?, val weekTok: Double?, val weekTotal: Double?,
    val fablePct: Double? = null, val fableReset: Long? = null, val fableLabel: String? = null,
    val gptWeekPct: Double? = null, val gptWeekReset: Long? = null,
    val gptMonthTok: Double? = null, val gptMonthTokTotal: Double? = null, val gptMonthReset: Long? = null,
    val monthCostTotal: Double? = null,
    val monthPct: Double? = null, val monthReset: Long? = null,
    /** The month's dollar figure as every status bar shows it after the month's reset (core's monthUsd): `~$13`
     *  estimated at list prices, `$13` where it is the charge Claude Code reported; null with no reading. */
    val monthUsd: String? = null, val gptMonthUsd: String? = null,
    /** The saved machine(s) the claude windows the bar shows came from, wk and mo (core's machineBarNote); null for
     *  this machine. The per-model cap is the tooltip's alone, so a cap from a saved machine names nothing on the bar. */
    val machineBarNote: String? = null,
    /** The same over the windows the tooltip shows, wk, the per-model cap and mo (core's machineTipNote). */
    val machineTipNote: String? = null,
    /** True when this machine has no Claude Code login to match that machine's account against. */
    val machineUnmatched: Boolean = false,
    /** When the oldest of the tooltip's windows was measured there (epoch ms; core's machineTipAt). */
    val machineTipAt: Long? = null,
    /** The saved machines whose own usage the estimates add to this machine's (core's machineMeasured), for the
     *  tooltip; null when the estimates are this machine's alone. */
    val measuredMachines: String? = null,
    val gptMeasuredMachines: String? = null,
    val usageFreshness: String? = null, val gptUsageFreshness: String? = null,
)

/** `oak usage --json` → the windows this widget draws. The keys are the CLI's own contract, which is
 *  why this is reachable from a test: a renamed or missing key is a silently blank chunk in the IDE. */
internal fun parseUsageSnap(json: String): UsageSnap? = try {
    val o = JsonParser.parseString(json).asJsonObject
    fun num(k: String): Double? = o.get(k)?.takeIf { it.isJsonPrimitive }?.asDouble
    fun lng(k: String): Long? = o.get(k)?.takeIf { it.isJsonPrimitive }?.asLong
    fun str(k: String): String? = o.get(k)?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() }
    // claude*/gpt* are the ACCOUNT-level keys: the un-prefixed fiveHourPct in the same payload
    // is session-scoped and, for a codex session, carries GPT's windows — the wrong label here.
    UsageSnap(
        fivePct = num("claudeFivePct"),
        weekPct = num("claudeWeekPct"), weekReset = lng("claudeWeekReset"), weekTok = num("claudeWeekTokens"), weekTotal = num("claudeWeekTotal"),
        // The per-model weekly cap, flattened alongside the other account windows. Nested under
        // claudeAccount.fablePct it reaches the Stats panel only, and this widget reads top-level keys.
        fablePct = num("claudeFablePct"), fableReset = lng("claudeFableReset"), fableLabel = str("claudeFableLabel"),
        gptWeekPct = num("gptWeekPct"), gptWeekReset = lng("gptWeekReset"),
        gptMonthTok = num("gptMonthTok"), gptMonthTokTotal = num("gptMonthTokTotal"), gptMonthReset = lng("gptMonthReset"),
        monthCostTotal = num("claudeMonthCostTotal"),
        monthPct = num("claudeMonthPct"), monthReset = lng("claudeMonthReset"),
        monthUsd = str("claudeMonthUsd"), gptMonthUsd = str("gptMonthUsd"),
        machineBarNote = str("claudeMachineBarNote"),
        machineTipNote = str("claudeMachineTipNote"),
        machineUnmatched = o.get("claudeMachineUnmatched")?.takeIf { it.isJsonPrimitive }?.asBoolean == true,
        machineTipAt = lng("claudeMachineTipAt"),
        measuredMachines = str("claudeMeasuredMachines"),
        gptMeasuredMachines = str("gptMeasuredMachines"),
        usageFreshness = str("claudeUsageFreshness"), gptUsageFreshness = str("gptUsageFreshness"),
    )
} catch (_: Exception) {
    null
}

private class UsageWidget(private val project: Project) : CustomStatusBarWidget {

    private var statusBar: StatusBar? = null
    private val timer = javax.swing.Timer(60_000) { refresh() }
    private var pendingRefresh: javax.swing.Timer? = null

    // Each agent's numbers sit inside their own rounded border so they read
    // as one belonging, not stray status text.
    private fun fenced(l: JLabel): JPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.X_AXIS)
        isOpaque = false
        border = javax.swing.BorderFactory.createCompoundBorder(
            com.intellij.ui.RoundedLineBorder(JBColor(java.awt.Color(0xC9C9C9), java.awt.Color(0x4A4A4A)), 8, 1),
            JBUI.Borders.empty(0, 6),
        )
        add(l)
    }
    private val claudeLabel = JLabel().apply { font = JBUI.Fonts.smallFont() }
    private val gptLabel = JLabel().apply { font = JBUI.Fonts.smallFont() }
    private val claudeBox = fenced(claudeLabel)
    private val gptBox = fenced(gptLabel)
    private val refreshLabel = JLabel("↻").apply {
        font = JBUI.Fonts.smallFont()
        toolTipText = "Refresh usage now"
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
    }
    private val gap = Box.createHorizontalStrut(JBUI.scale(10))
    private val panel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.X_AXIS)
        isOpaque = false
        add(claudeBox); add(gap); add(gptBox); add(Box.createHorizontalStrut(JBUI.scale(6))); add(refreshLabel)
        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                ToolWindowManager.getInstance(project).getToolWindow("Observatory Dashboards")?.show(null)
            }
        })
        refreshLabel.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                e.consume()
                ApplicationManager.getApplication().executeOnPooledThread {
                    com.cellobservatory.observatory.core.ObservatoryCli.pullAccountUsage(project.basePath)
                }
                refresh()
                pendingRefresh?.stop()
                pendingRefresh = javax.swing.Timer(20_000) { refresh() }.apply { isRepeats = false; start() }
            }
        })
    }

    override fun ID() = USAGE_WIDGET_ID
    override fun getComponent() = panel
    override fun getPresentation(): StatusBarWidget.WidgetPresentation? = null

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        timer.start()
        refresh()
    }

    override fun dispose() {
        timer.stop()
        pendingRefresh?.stop()
        statusBar = null
    }

    private fun refresh() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val next = ObservatoryCli.usageJson(null, project.basePath)?.let { parseUsageSnap(it) }
            ApplicationManager.getApplication().invokeLater { apply(next) } // Swing text is EDT-only
        }
    }

    // The statusline's hue scheme, as HTML hexes readable on the current theme.
    // ROUND like the statusline — 28.9999 truncated to 28 disagreed with every other surface.
    private fun hueHex(pct: Double): String = when {
        pct >= 80 -> if (JBColor.isBright()) "#C7222A" else "#F14C4C"
        pct >= 50 -> if (JBColor.isBright()) "#9A6700" else "#E2C08D"
        else -> if (JBColor.isBright()) "#1A7F37" else "#89D185"
    }
    private fun greyHex(): String = if (JBColor.isBright()) "#6E6E6E" else "#8A8A8A"
    private fun fgHex(): String = if (JBColor.isBright()) "#1F1F1F" else "#FFFFFF" // "time in white" (dark themes)



    private fun human(n: Double): String {
        val v = n.toLong()
        if (v >= 1_000_000_000) { val b = (v % 1_000_000_000) / 100_000_000; return if (b > 0) "${v / 1_000_000_000}.${b}B" else "${v / 1_000_000_000}B" }
        if (v >= 1_000_000) { val d = (v % 1_000_000) / 100_000; return if (d > 0) "${v / 1_000_000}.${d}M" else "${v / 1_000_000}M" }
        if (v >= 1000) return "${v / 1000}k"
        return v.toString()
    }

    private fun until(ms: Long?): String {
        if (ms == null || ms <= 0) return ""
        val d = (ms - System.currentTimeMillis()) / 1000
        if (d <= 0) return "now"
        if (d >= 86400) return "${d / 86400}d ${(d % 86400) / 3600}h"
        if (d >= 3600) return "${d / 3600}h ${(d % 3600) / 60}m"
        return "${d / 60}m"
    }

    /** One window chunk, `label: N% reset` — the shape the TUI and VS Code draw: grey label, colored
     *  share, white time. No bar glyph. */
    private fun chunk(label: String, pct: Double?, reset: Long?): String {
        if (pct == null) return ""
        val u = until(reset)
        return "<font color='${greyHex()}'>$label:</font> <font color='${hueHex(pct)}'>${Math.round(pct)}%</font>" +
            (if (u.isNotEmpty()) " <font color='${fgHex()}'>$u</font>" else "")
    }

    private fun agentHtml(icon: String, iconHex: String, chunks: List<String>, machine: String? = null): String {
        val live = chunks.filter { it.isNotEmpty() }
        if (live.isEmpty()) return ""
        val sep = " <font color='${greyHex()}'>·</font> "
        // A saved machine's reading names that machine beside the icon, as the terminal app's bar does.
        val from = machine?.let { " <font color='${greyHex()}'>(${escHtml(plainLabel(it))})</font>" } ?: ""
        return "<html><font color='$iconHex'>$icon</font>$from " + live.joinToString(sep) + "</html>"
    }

    private fun tipLine(label: String, pct: Double?, reset: Long?, est: Double?, tot: Double?): String {
        if (pct == null) return ""
        val bits = mutableListOf("${pct.toInt()}%")
        val u = until(reset)
        if (u.isNotEmpty()) bits.add("resets in $u")
        if (est != null && est > 0) bits.add("~${human(est)}" + (if (tot != null && tot > 0) " of ~${human(tot)}" else ""))
        return "<br>$label " + bits.joinToString(" · ")
    }

    /** Dollars as the Claude Code status line writes them (core's usdText): printf's rounding, an exact half to the even
     *  digit, which BigDecimal of the double's exact value gives, and no locale's decimal comma. */
    private fun musd(v: Double): String {
        fun fix(x: Double, d: Int) = java.math.BigDecimal(x).setScale(d, java.math.RoundingMode.HALF_EVEN).toPlainString()
        return if (v >= 1000) "$" + fix(v / 1000, 1) + "k" else if (v >= 100) "$${v.toLong()}" else "$" + fix(v, if (v >= 10) 0 else 1)
    }

    /** A month chunk ended with its dollar figure, which drops with the chunk. */
    private fun withUsd(chunk: String, usd: String?): String =
        if (chunk.isEmpty() || usd == null) chunk else "$chunk <font color='${fgHex()}'>${escHtml(usd)}</font>"

    private fun apply(s: UsageSnap?) {
        if (project.isDisposed) return
        // A plan with no quota percentages at all (Enterprise/API) still has SPEND — a bare
        // spend chunk keeps the widget alive instead of vanishing.
        val moChunk = if (s != null && s.monthPct == null && s.fivePct == null && s.weekPct == null && s.monthUsd != null)
            "<font color='${greyHex()}'>mo:</font> <font color='${fgHex()}'>${escHtml(s.monthUsd)}</font>"
        else if (s != null) withUsd(chunk("mo", s.monthPct, s.monthReset), s.monthUsd) else ""
        // wk · mo, as the TUI's one-line readout and the VS Code status bar show them. The account's
        // per-model weekly cap (its "Fable" row) has no chunk: the tooltip names it.
        val claude = if (s == null) "" else agentHtml(
            "✳", "#D97757",
            listOf(chunk("wk", s.weekPct, s.weekReset), moChunk),
            s.machineBarNote,
        )
        // gpt's month now mirrors claude's: when core reports an allowance (gptMonthTokTotal), show a
        // % via the SAME chunk() helper — same threshold colors, same reset formatting — as every other
        // window (core: monthTok / monthTokTotal * 100, capped at 100). Without an allowance yet
        // (gptMonthTokTotal null/0), fall back to the bare local-token count + reset. A month measured at 0
        // (a new cycle) with an allowance is a share, 0%; only an unmeasured month hides.
        val gptMo = if (s?.gptMonthTok == null) "" else {
            val gptMonthTotal = s.gptMonthTokTotal ?: 0.0
            if (gptMonthTotal > 0.0) chunk("mo", Math.min(100.0, s.gptMonthTok / gptMonthTotal * 100.0), s.gptMonthReset)
            else if (s.gptMonthTok <= 0.0) ""
            else {
                val gmu = until(s.gptMonthReset)
                "<font color='${greyHex()}'>mo:</font> <font color='${fgHex()}'>${human(s.gptMonthTok)}${if (gmu.isNotEmpty()) " $gmu" else ""}</font>"
            }
        }
        val gpt = if (s == null) "" else agentHtml(
            "⬡", "#3B9EFF", // gpt's icon is BLUE, its own colour like claude's orange ✳ — not white
            // wk · mo — the same windows claude shows.
            listOf(
                chunk("wk", s.gptWeekPct, s.gptWeekReset),
                withUsd(gptMo, s.gptMonthUsd),
            ),
        )
        claudeLabel.text = claude
        claudeLabel.isVisible = claude.isNotEmpty()
        if (s != null) {
            // The figure the bar shows: the charge Claude Code reported, or the estimate against its projected budget.
            fun spent(usd: String?, tot: Double?): String =
                if (usd == null) "" else if (!usd.startsWith("~")) "<br>mo ${escHtml(usd)} spent, as Claude Code reported it"
                else "<br>mo ${escHtml(usd)} spent" + (if (tot != null && tot > 0) " of ~" + musd(tot) + " (4 weekly cycles)" else "") + ", estimated at today’s API list prices"
            claudeLabel.toolTipText = "<html>OAK: Claude plan usage — the statusline’s own readout." +
                tipLine("wk", s.weekPct, s.weekReset, s.weekTok, s.weekTotal) +
                tipLine(s.fableLabel ?: "Fable", s.fablePct, s.fableReset, null, null) +
                tipLine("mo", s.monthPct, s.monthReset, null, null) +
                spent(s.monthUsd, s.monthCostTotal) +
                // When it was measured there: a machine that stops answering keeps its last reading, however old.
                (s.machineTipNote?.let {
                    val at = s.machineTipAt?.let { ms -> " at ${com.cellobservatory.observatory.ui.stats.atTime(ms)}" } ?: ""
                    if (s.machineUnmatched) "<br>measured on a saved machine (${escHtml(plainLabel(it))})$at; this machine has no Claude Code login to match its account with"
                    else "<br>measured on a saved machine signed in to the same Claude account (${escHtml(plainLabel(it))})$at"
                } ?: "") +
                // The saved machines whose own usage the estimates and the month add to this machine's.
                (s.measuredMachines?.let { "<br>estimates include usage measured on ${escHtml(plainLabel(it))}" } ?: "") +
                (s.usageFreshness?.let { "<br>${escHtml(it)}" } ?: "") +
                "<br>Click for the Stats panel.</html>"
        }
        gptLabel.text = gpt
        gptLabel.isVisible = gpt.isNotEmpty()
        gptLabel.toolTipText = "<html>OAK: GPT plan usage — reported Codex quota and account usage." +
            (if (s != null) tipLine("wk", s.gptWeekPct, s.gptWeekReset, null, null) else "") +
            (if (s?.gptMonthTok != null) "<br>mo ${human(s.gptMonthTok)} tokens · bill cycle · ${until(s.gptMonthReset)}" else "") +
            (s?.gptMonthUsd?.let { "<br>mo ${escHtml(it)} spent, estimated at today’s API list prices" } ?: "") +
            (s?.gptMeasuredMachines?.let { "<br>estimates include usage measured on ${escHtml(plainLabel(it))}" } ?: "") +
            (s?.gptUsageFreshness?.let { "<br>${escHtml(it)}" } ?: "") +
            "<br>Click for the Stats panel.</html>"
        claudeBox.isVisible = claude.isNotEmpty()
        gptBox.isVisible = gpt.isNotEmpty()
        refreshLabel.isVisible = claude.isNotEmpty() || gpt.isNotEmpty()
        gap.isVisible = claude.isNotEmpty() && gpt.isNotEmpty()
        panel.isVisible = claude.isNotEmpty() || gpt.isNotEmpty()
        panel.revalidate()
        panel.repaint()
        statusBar?.updateWidget(USAGE_WIDGET_ID)
    }
}
