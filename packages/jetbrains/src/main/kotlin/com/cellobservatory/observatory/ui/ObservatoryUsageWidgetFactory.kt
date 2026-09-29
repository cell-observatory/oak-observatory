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
 *  `✳ ▰▰▱ 58% 5h 2h33m · ▰▱▱ 41% wk 4d · …  ⬡ …`. HTML labels carry the per-piece colors Swing
 *  cannot do in plain text. gpt shows 5h/wk (codex reports window percents only); claude adds
 *  the bill-cycle month. Refreshed once a minute off the EDT; click opens the Dashboards window.
 *  VS Code parity (its status items are single-color, so each window-chunk wears its hue there). */
class ObservatoryUsageWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = USAGE_WIDGET_ID
    override fun getDisplayName() = "OAK Usage"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = UsageWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

internal data class UsageSnap(
    val fivePct: Double?, val fiveReset: Long?, val fiveTok: Double?, val fiveTotal: Double?,
    val weekPct: Double?, val weekReset: Long?, val weekTok: Double?, val weekTotal: Double?,
    val fablePct: Double? = null, val fableReset: Long? = null, val fableLabel: String? = null,
    val gptFivePct: Double? = null, val gptFiveReset: Long? = null, val gptWeekPct: Double? = null, val gptWeekReset: Long? = null,
    val gptMonthTok: Double? = null, val gptMonthTokTotal: Double? = null, val gptMonthReset: Long? = null,
    val monthCost: Double? = null, val monthCostTotal: Double? = null,
    val monthPct: Double? = null, val monthReset: Long? = null,
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
        fivePct = num("claudeFivePct"), fiveReset = lng("claudeFiveReset"), fiveTok = num("claudeFiveTokens"), fiveTotal = num("claudeFiveTotal"),
        weekPct = num("claudeWeekPct"), weekReset = lng("claudeWeekReset"), weekTok = num("claudeWeekTokens"), weekTotal = num("claudeWeekTotal"),
        // The per-model weekly cap, flattened alongside the other account windows. Nested under
        // claudeAccount.fablePct it reaches the Stats panel only, and this widget reads top-level keys.
        fablePct = num("claudeFablePct"), fableReset = lng("claudeFableReset"), fableLabel = str("claudeFableLabel"),
        gptFivePct = num("gptFivePct"), gptFiveReset = lng("gptFiveReset"),
        gptWeekPct = num("gptWeekPct"), gptWeekReset = lng("gptWeekReset"),
        gptMonthTok = num("gptMonthTok"), gptMonthTokTotal = num("gptMonthTokTotal"), gptMonthReset = lng("gptMonthReset"),
        monthCost = num("claudeMonthCost"), monthCostTotal = num("claudeMonthCostTotal"),
        monthPct = num("claudeMonthPct"), monthReset = lng("claudeMonthReset"),
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

    private fun agentHtml(icon: String, iconHex: String, chunks: List<String>): String {
        val live = chunks.filter { it.isNotEmpty() }
        if (live.isEmpty()) return ""
        val sep = " <font color='${greyHex()}'>·</font> "
        return "<html><font color='$iconHex'>$icon</font> " + live.joinToString(sep) + "</html>"
    }

    private fun tipLine(label: String, pct: Double?, reset: Long?, est: Double?, tot: Double?): String {
        if (pct == null) return ""
        val bits = mutableListOf("${pct.toInt()}%")
        val u = until(reset)
        if (u.isNotEmpty()) bits.add("resets in $u")
        if (est != null && est > 0) bits.add("~${human(est)}" + (if (tot != null && tot > 0) " of ~${human(tot)}" else ""))
        return "<br>$label " + bits.joinToString(" · ")
    }

    private fun musd(v: Double): String =
        if (v >= 1000) "$" + String.format("%.1fk", v / 1000) else if (v >= 100) "$${v.toInt()}" else "$" + String.format("%.1f", v)

    private fun apply(s: UsageSnap?) {
        if (project.isDisposed) return
        // A plan with no quota percentages at all (Enterprise/API) still has SPEND — a bare
        // spend chunk keeps the widget alive instead of vanishing.
        val moChunk = if (s != null && s.monthPct == null && s.fivePct == null && s.weekPct == null && (s.monthCost ?: 0.0) > 0.0)
            "<font color='${greyHex()}'>mo:</font> <font color='${fgHex()}'>~${musd(s.monthCost!!)}</font>"
        else if (s != null) chunk("mo", s.monthPct, s.monthReset) else ""
        // 5h · wk · mo, as the TUI's one-line readout and the VS Code status bar show them. The account's
        // per-model weekly cap (its "Fable" row) has no chunk: the tooltip names it.
        val claude = if (s == null) "" else agentHtml(
            "✳", "#D97757",
            listOf(chunk("5h", s.fivePct, s.fiveReset), chunk("wk", s.weekPct, s.weekReset), moChunk),
        )
        // gpt's month now mirrors claude's: when core reports an allowance (gptMonthTokTotal), show a
        // % via the SAME chunk() helper — same threshold colors, same reset formatting — as every other
        // window (core: monthTok / monthTokTotal * 100, capped at 100). Without an allowance yet
        // (gptMonthTokTotal null/0), fall back to the bare local-token count + reset.
        val gptMo = if (s == null || (s.gptMonthTok ?: 0.0) <= 0.0) "" else {
            val gptMonthTotal = s.gptMonthTokTotal ?: 0.0
            if (gptMonthTotal > 0.0) chunk("mo", Math.min(100.0, s.gptMonthTok!! / gptMonthTotal * 100.0), s.gptMonthReset)
            else {
                val gmu = until(s.gptMonthReset)
                "<font color='${greyHex()}'>mo:</font> <font color='${fgHex()}'>${human(s.gptMonthTok!!)}${if (gmu.isNotEmpty()) " $gmu" else ""}</font>"
            }
        }
        val gpt = if (s == null) "" else agentHtml(
            "⬡", "#3B9EFF", // gpt's icon is BLUE, its own colour like claude's orange ✳ — not white
            // 5h · wk · mo — the same three windows claude shows. gpt's 5h was in the tooltip only even
            // though it is a real quota window; chunk() hides it when unset.
            listOf(
                chunk("5h", s.gptFivePct, s.gptFiveReset),
                chunk("wk", s.gptWeekPct, s.gptWeekReset),
                gptMo,
            ),
        )
        claudeLabel.text = claude
        claudeLabel.isVisible = claude.isNotEmpty()
        if (s != null) {
            fun spent(v: Double?, tot: Double?): String =
                if (v != null && v > 0) "<br>mo ~" + musd(v) + " spent" + (if (tot != null && tot > 0) " of ~" + musd(tot) + " (4 weekly cycles)" else "") + " — Claude Code’s own figures" else ""
            claudeLabel.toolTipText = "<html>OAK: Claude plan usage — the statusline’s own readout." +
                tipLine("5h", s.fivePct, s.fiveReset, s.fiveTok, s.fiveTotal) +
                tipLine("wk", s.weekPct, s.weekReset, s.weekTok, s.weekTotal) +
                tipLine(s.fableLabel ?: "Fable", s.fablePct, s.fableReset, null, null) +
                tipLine("mo", s.monthPct, s.monthReset, null, null) +
                spent(s.monthCost, s.monthCostTotal) +
                "<br>Click for the Stats panel.</html>"
        }
        gptLabel.text = gpt
        gptLabel.isVisible = gpt.isNotEmpty()
        gptLabel.toolTipText = "<html>OAK: GPT plan usage — reported Codex quota and measured local usage." +
            (if (s != null) tipLine("5h", s.gptFivePct, s.gptFiveReset, null, null) + tipLine("wk", s.gptWeekPct, s.gptWeekReset, null, null) else "") +
            (if (s?.gptMonthTok != null) "<br>mo ${human(s.gptMonthTok)} local tokens · UTC calendar month · ${until(s.gptMonthReset)}" else "") +
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
