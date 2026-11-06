package com.cellobservatory.observatory.ui.stats

import com.intellij.openapi.util.Disposer
import com.cellobservatory.observatory.platform.ObservatoryPlatformTestCase
import com.intellij.util.ui.JBUI
import javax.swing.JComponent

/**
 * A month measured at 0 (a bill cycle that just rolled over with nothing run since) reads 0% in the month row on
 * either tab, as on the status bar and in VS Code's panel, and `~0` against its budget, with no dollar figure; a
 * month never measured has no share (Claude) or no row (GPT). Every other window at 0% with a budget reads `~0`
 * against it too. Read through the panel's own parser and the rows the section paints; the GPT tab's height must
 * still fit every row it paints.
 */
class StatsMonthRowTest : ObservatoryPlatformTestCase() {

    /** What the [gpt] or Claude tab paints for [json]. */
    private class Painted(
        /** The `mo` row as [share, spent, total], or null when the tab paints none. */
        val month: List<String>?,
        /** Whether a `$` row shows a dollar figure. */
        val dollar: Boolean,
        /** Whether the section is exactly as tall as the rows it paints (checked on the GPT tab). */
        val fits: Boolean,
        /** Every row the tab paints, by label, as [share, spent, total]. */
        val rows: Map<String, List<String>>,
    )

    private fun paint(json: String, gpt: Boolean): Painted {
        val panel = StatsPanel(project)
        try {
            val usage = StatsPanel::class.java.getDeclaredMethod("parseUsage", String::class.java).apply { isAccessible = true }.invoke(panel, json)
            assertNotNull("control: the usage JSON parses", usage)
            val bars = Class.forName("com.cellobservatory.observatory.ui.stats.UsageBars").getDeclaredConstructor().apply { isAccessible = true }.newInstance() as JComponent
            val usageClass = Class.forName("com.cellobservatory.observatory.ui.stats.Usage")
            bars.javaClass.getDeclaredMethod("setTab", String::class.java).apply { isAccessible = true }.invoke(bars, if (gpt) "gpt" else "claude")
            bars.javaClass.getDeclaredMethod("update", usageClass).apply { isAccessible = true }.invoke(bars, usage)
            val rows = (bars.javaClass.getDeclaredMethod("rows", usageClass, Boolean::class.javaPrimitiveType).apply { isAccessible = true }
                .invoke(bars, usage, gpt) as List<*>).filterNotNull()
            fun get(row: Any, name: String): Any? = row.javaClass.getDeclaredMethod(name).apply { isAccessible = true }.invoke(row)
            fun columns(row: Any) = listOf((get(row, "getPct") as Double?)?.let { p -> "${Math.round(p)}%" } ?: "—", get(row, "getSpent") as String, get(row, "getTotal") as String)
            val mo = rows.firstOrNull { get(it, "getLabel") == "mo" }
            return Painted(
                mo?.let { columns(it) },
                rows.any { get(it, "getLabel") == "$" && (get(it, "getSpent") as String).isNotEmpty() },
                // fitHeight: the GPT tab is its rows at a 22px pitch, plus 18px of column header and padding.
                !gpt || bars.preferredSize.height == JBUI.scale(18) + rows.size * JBUI.scale(22),
                rows.associate { get(it, "getLabel") as String to columns(it) },
            )
        } finally {
            Disposer.dispose(panel)
        }
    }

    fun testAClaudeMonthMeasuredAtZeroReadsZeroPercent() {
        val zero = paint("""{"claudeAccount":{"monthTokens":0,"monthTokensTotal":111423689}}""", gpt = false)
        assertEquals(listOf("0%", "~0", "111.4M"), zero.month)
        assertFalse("no dollar figure rides on the month", zero.dollar)
        assertEquals("never measured: no share", listOf("—", "", "111.4M"),
            paint("""{"claudeAccount":{"monthTokensTotal":111423689}}""", gpt = false).month)
        // With no 5h or weekly share in the cache (rollingLimits false) the month keeps its share, as in VS Code's panel.
        assertEquals("no rolling windows: the same share", listOf("0%", "~0", "111.4M"),
            paint("""{"claudeAccount":{"rollingLimits":false,"monthTokens":0,"monthTokensTotal":111423689}}""", gpt = false).month)
    }

    fun testAGptMonthMeasuredAtZeroReadsZeroPercent() {
        val zero = paint("""{"gptWeekPct":30,"gptMonthTok":0,"gptMonthTokTotal":4428571}""", gpt = true)
        assertEquals(listOf("0%", "~0", "4.4M"), zero.month)
        assertFalse("no dollar figure rides on the month", zero.dollar)
        assertTrue("the section is tall enough for the month row", zero.fits)
        val never = paint("""{"gptWeekPct":30}""", gpt = true)
        assertNull("never measured: no row", never.month)
        assertTrue("control: the height fits the rows without it", never.fits)
    }

    fun testEveryWindowAtZeroWithABudgetReadsTildeZeroAgainstIt() {
        // As the status line and the terminal app read `~0/<budget>`: the used column was empty, and on the 5h and wk rows
        // the budget too. A window at 0% with no budget leaves the columns empty, and a share above 0 keeps its figures.
        val claude = paint(
            """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":0,"fiveTotal":6000000,"weekPct":0,"weekTotal":30000000,
                 "fablePct":0,"fableTotal":2000000,"fableLabel":"Fable","monthTokens":0,"monthTokensTotal":128500000},
                 "claudeFivePct":0,"claudeWeekPct":0}""", gpt = false).rows
        assertEquals(
            listOf(listOf("0%", "~0", "6M"), listOf("0%", "~0", "2M"), listOf("0%", "~0", "30M"), listOf("0%", "~0", "128.5M")),
            listOf("5h", "fable", "wk", "mo").map { claude[it] },
        )
        val mixed = paint(
            """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":0,"weekPct":10,"weekTotal":30000000,"fablePct":0},
                 "claudeFivePct":0,"claudeWeekPct":10,"claudeWeekTokens":3000000}""", gpt = false).rows
        assertEquals(
            "no budget: ~0 alone, as the status line reads it; a share above 0 keeps its own",
            listOf(listOf("0%", "~0", ""), listOf("0%", "~0", ""), listOf("10%", "~3M", "30M")),
            listOf("5h", "fable", "wk").map { mixed[it] },
        )
        val gpt = paint("""{"gptWeekPct":0,"gptWeekTotal":1000000,"gptMonthTok":0,"gptMonthTokTotal":4428571}""", gpt = true).rows
        assertEquals(listOf(listOf("0%", "~0", "1M"), listOf("0%", "~0", "4.4M")), listOf("wk", "mo").map { gpt[it] })
    }
}
