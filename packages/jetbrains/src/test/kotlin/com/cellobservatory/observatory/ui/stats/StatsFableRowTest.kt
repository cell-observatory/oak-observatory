package com.cellobservatory.observatory.ui.stats

import com.intellij.openapi.util.Disposer
import com.cellobservatory.observatory.platform.ObservatoryPlatformTestCase

/**
 * The account's per-model weekly cap (its "Fable" row) is a Stats row whenever the account reports one,
 * on a plan with no 5h/wk windows too, as VS Code's panel and the shell status line show it. The
 * no-window layout dropped it here alone. Read through the panel's own parser and the rows the section
 * paints.
 */
class StatsFableRowTest : ObservatoryPlatformTestCase() {

    /** The Claude tab's rows for [json], or the GPT tab's for [gpt]. */
    private fun rows(json: String, gpt: Boolean = false): List<Any> {
        val panel = StatsPanel(project)
        try {
            val usage = StatsPanel::class.java.getDeclaredMethod("parseUsage", String::class.java).apply { isAccessible = true }.invoke(panel, json)
            assertNotNull("control: the usage JSON parses", usage)
            val bars = Class.forName("com.cellobservatory.observatory.ui.stats.UsageBars").getDeclaredConstructor().apply { isAccessible = true }.newInstance()
            val usageClass = Class.forName("com.cellobservatory.observatory.ui.stats.Usage")
            val rows = bars.javaClass.getDeclaredMethod("rows", usageClass, Boolean::class.javaPrimitiveType).apply { isAccessible = true }
                .invoke(bars, usage, gpt) as List<*>
            return rows.filterNotNull()
        } finally {
            Disposer.dispose(panel)
        }
    }

    private fun Any.get(name: String): Any? = javaClass.getDeclaredMethod(name).apply { isAccessible = true }.invoke(this)

    /** The Claude tab's row labels for [json]. */
    private fun labels(json: String): List<String> = rows(json).map { it.get("getLabel") as String }

    fun testAPlanWithNoRollingWindowsStillListsTheCapItsAccountReports() {
        assertEquals(listOf("ctx", "fable", "mo", "$"), labels(
            """{"claudeAccount":{"rollingLimits":false,"fablePct":42,"fableLabel":"Fable","monthTokens":1200000,"monthCost":18.0}}"""))
        // Control: no cap reported, no row.
        assertEquals(listOf("ctx", "mo", "$"), labels(
            """{"claudeAccount":{"rollingLimits":false,"monthTokens":1200000,"monthCost":18.0}}"""))
    }

    fun testAPlanWithRollingWindowsListsTheCapBeforeTheWeek() {
        assertEquals(listOf("ctx", "5h", "fable", "wk", "mo", "$"), labels(
            """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":10,"weekPct":20,"fablePct":42,"fableLabel":"Fable"}}"""))
    }

    fun testAFiveHourWindowThatHasEndedKeepsItsRowAtZeroWithNoCountdown() {
        // A 5-hour window whose reset has passed, with no newer one reported, is over: `oak usage --json` gives it a
        // share of 0 and no reset. Its row stays, at 0% with no countdown above its bar.
        fun fiveHour(json: String) = rows(json).first { it.get("getLabel") == "5h" }.let { it.get("getPct") to it.get("getTime") }
        assertEquals(0.0 to null, fiveHour(
            """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":0,"fiveReset":null,"weekPct":20},"claudeFivePct":0,"claudeFiveReset":null}"""))
        // Control: a running window keeps its countdown.
        val running = fiveHour(
            """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":10,"weekPct":20},"claudeFivePct":10,"claudeFiveReset":${System.currentTimeMillis() + 3_600_000L}}""")
        assertEquals(10.0, running.first)
        assertTrue("control: a countdown above the bar — $running", (running.second as String?)?.isNotEmpty() == true)
    }

    fun testAnEndedFiveHourWindowKeepsItsBudgetButNoReadsAndGptsKeepsItsRow() {
        // `oak usage --json` for an ended 5-hour window: a share of 0, no reset, no token estimate and no cache reads (the
        // ended window's), its budget kept, against which it reads ~0. The week beside it keeps its reads.
        val claude = rows(
            """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":0,"fiveReset":null,"fiveTokens":null,"fiveTotal":6000000,
                 "fiveReads":null,"weekPct":22,"weekTotal":30000000,"weekReads":90000000},
                 "claudeFivePct":0,"claudeFiveReset":null,"claudeWeekPct":22,"claudeWeekTokens":6600000}""")
        val five = claude.first { it.get("getLabel") == "5h" }
        assertEquals(listOf(0.0, "~0", "6M", "", null), listOf("getPct", "getSpent", "getTotal", "getCached", "getTime").map { five.get(it) })
        assertEquals("control: the week's reads", "+90M↺", claude.first { it.get("getLabel") == "wk" }.get("getCached"))
        // GPT's ended window keeps its row at 0% with no countdown; a plan with no 5-hour window has none.
        val gpt = rows("""{"gptFivePct":0,"gptFiveReset":null,"gptWeekPct":30}""", gpt = true).first { it.get("getLabel") == "5h" }
        assertEquals(listOf(0.0, null), listOf(gpt.get("getPct"), gpt.get("getTime")))
        assertTrue("no 5-hour window, no row", rows("""{"gptWeekPct":30}""", gpt = true).none { it.get("getLabel") == "5h" })
    }

    /** The usage section's height once it paints [json]'s Claude rows. */
    private fun height(json: String): Int {
        val panel = StatsPanel(project)
        try {
            val usage = StatsPanel::class.java.getDeclaredMethod("parseUsage", String::class.java).apply { isAccessible = true }.invoke(panel, json)
            val bars = Class.forName("com.cellobservatory.observatory.ui.stats.UsageBars").getDeclaredConstructor().apply { isAccessible = true }.newInstance() as javax.swing.JComponent
            val usageClass = Class.forName("com.cellobservatory.observatory.ui.stats.Usage")
            bars.javaClass.getDeclaredMethod("update", usageClass).apply { isAccessible = true }.invoke(bars, usage)
            return bars.preferredSize.height
        } finally {
            Disposer.dispose(panel)
        }
    }

    fun testAnAccountWithNoFiveHourLimitHasNoFiveHourRowAndNoGap() {
        // An account with no five-hour limit (its newest usage answer carries no 5h window, as a verified Ultra account's
        // does): `oak usage --json` gives no 5h share and says when the account said so (`fiveNoneAt`). The 5h row goes,
        // and the section is a row shorter, so no blank row is left where it was.
        val none = """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":null,"fiveNoneAt":1793400000000,"weekPct":20,"fablePct":42,"fableLabel":"Fable"},
                       "claudeFivePct":null,"claudeWeekPct":20}"""
        // Control: a 5h share not reported yet keeps its row, as a placeholder.
        val unknown = """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":null,"weekPct":20,"fablePct":42,"fableLabel":"Fable"},"claudeFivePct":null,"claudeWeekPct":20}"""
        assertEquals(listOf("ctx", "fable", "wk", "mo", "$"), labels(none))
        assertEquals(listOf("ctx", "5h", "fable", "wk", "mo", "$"), labels(unknown))
        assertEquals("one row shorter", height(unknown) - com.intellij.util.ui.JBUI.scale(22), height(none))
    }
}
