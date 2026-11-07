package com.cellobservatory.observatory.ui.stats

import com.intellij.openapi.util.Disposer
import com.cellobservatory.observatory.platform.ObservatoryPlatformTestCase

/**
 * Where this machine has no current share of the Claude account, the figures are a saved machine's reading of it,
 * and the usage section's note names that machine beside the cache's last refresh, on the claude tab. GPT's
 * figures are always this machine's own, so the gpt tab's note names none. Read through the panel's own parser.
 */
class StatsMachineNoteTest : ObservatoryPlatformTestCase() {

    fun testAccountUsageFreshnessReachesBothTabs() {
        val stamp = "Usage received — build-box: 2026-11-04T12:00:00.000Z (stale; unreachable)"
        val json = """{"claudeAccount":{"usageFreshness":"$stamp"},"gptUsageFreshness":"$stamp"}"""
        for (tab in listOf("claude", "gpt")) assertEquals(stamp, note(json, tab))
    }

    private fun parsed(json: String): Any {
        val panel = StatsPanel(project)
        try {
            val usage = StatsPanel::class.java.getDeclaredMethod("parseUsage", String::class.java).apply { isAccessible = true }.invoke(panel, json)
            assertNotNull("control: the usage JSON parses", usage)
            return usage!!
        } finally {
            Disposer.dispose(panel)
        }
    }

    private val usageClass get() = Class.forName("com.cellobservatory.observatory.ui.stats.Usage")
    private val panelKt get() = Class.forName("com.cellobservatory.observatory.ui.stats.StatsPanelKt")

    private fun note(json: String, tab: String): String =
        panelKt.getDeclaredMethod("usageStamp", usageClass, String::class.java).apply { isAccessible = true }.invoke(null, parsed(json), tab) as String

    /** The footnote under the claude tab's rows: "as of" a time, when the reading shown is over five minutes old. */
    private fun foot(json: String): String =
        panelKt.getDeclaredMethod("footNote", usageClass).apply { isAccessible = true }.invoke(null, parsed(json)) as String

    fun testTheNoteNamesTheSavedMachineOnTheClaudeTab() {
        val at = System.currentTimeMillis()
        val json = """{"claudeAccount":{"cachedAtMs":$at,"machineNote":"build-box"}}"""
        assertTrue(note(json, "claude"), Regex("^updated \\S.* · measured on build-box$").matches(note(json, "claude")))
        assertTrue(note(json, "gpt"), Regex("^updated \\S[^·]*$").matches(note(json, "gpt")))
        val own = note("""{"claudeAccount":{"cachedAtMs":$at,"machineNote":""}}""", "claude")
        assertTrue("control: this machine's own reading still has its stamp — $own", own.startsWith("updated "))
        assertFalse(own, own.contains("measured on"))
    }

    fun testASavedMachinesReadingSaysWhenThatMachineMeasuredIt() {
        // The machine answered two days ago and not since, while this machine's cache was refreshed a minute ago: the
        // cache's time made a days-old reading look current.
        val now = System.currentTimeMillis()
        val measured = now - 2 * 86_400_000L
        fun usage(cachedAt: Long, machine: String) =
            """{"claudeAccount":{"statuslineCache":true,"cachedAtMs":$cachedAt,"machineNote":"build-box"$machine}}"""
        val old = usage(now - 60_000, ""","machineAt":$measured""")
        assertFalse("control: a time on another day carries its date — ${atTime(measured)}", Regex("^\\d\\d:\\d\\d$").matches(atTime(measured)))
        assertTrue(note(old, "claude"), note(old, "claude").endsWith(" · measured on build-box at ${atTime(measured)}"))
        assertEquals("the footnote dates the reading by that machine's measurement", "as of ${atTime(measured)}", foot(old))
        // A saved machine's reading a minute old is current, however old this machine's cache.
        assertEquals("", foot(usage(now - 3_600_000, ""","machineAt":${now - 60_000}""")))
        // This machine's own reading: a minute old needs no "as of", an hour old gets one, as before.
        val own = """{"claudeAccount":{"statuslineCache":true,"cachedAtMs":${now - 60_000},"machineNote":""}}"""
        assertEquals("", foot(own))
        assertEquals("as of ${atTime(now - 3_600_000)}", foot(own.replace("${now - 60_000}", "${now - 3_600_000}")))
    }

    fun testAReadingFromBothMachinesIsDatedByTheOlderOfThem() {
        // This machine's own 5-hour share, from a cache an hour old, beside a saved machine's week a minute old: the
        // hour-old share is still shown, so the footnote still says so.
        val now = System.currentTimeMillis()
        val mixed = """{"claudeAccount":{"statuslineCache":true,"cachedAtMs":${now - 3_600_000},"fiveHourPct":9,"fiveMachine":null,""" +
            """"weekPct":22,"weekMachine":"build-box","machineNote":"build-box: wk","machineAt":${now - 60_000}}}"""
        assertEquals("as of ${atTime(now - 3_600_000)}", foot(mixed))
        // Control: with every window from the saved machine, this machine's cache time dates none of them.
        assertEquals("", foot(mixed.replace("\"fiveMachine\":null", "\"fiveMachine\":\"build-box\"").replace("build-box: wk", "build-box")))
    }

    fun testAMachineLabelShowsWithoutControlCharacters() {
        // herdr's label is whatever was typed into it: ESC, BEL and TAB, bidi controls and zero-width characters are
        // dropped from the note.
        val json = """{"claudeAccount":{"cachedAtMs":${System.currentTimeMillis()},"machineNote":"build\u001b[2J\u202e\u200b\u2066box\u2069\u200f\ufeff\u0007\t"}}"""
        assertTrue(note(json, "claude"), note(json, "claude").endsWith(" · measured on build[2Jbox"))
    }

    fun testAnEmojiFamilyInALabelKeepsItsJoiners() {
        val family = "lab \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"
        val json = """{"claudeAccount":{"cachedAtMs":${System.currentTimeMillis()},"machineNote":"$family"}}"""
        assertTrue(note(json, "claude"), note(json, "claude").endsWith(" · measured on $family"))
    }

    fun testTheNoteNamesTheMachinesTheEstimatesInclude() {
        // The estimates add what the saved machines of the account measured of their own turns (core's machineMeasured):
        // the note names them on the claude tab, as plain text, and never on the gpt tab, whose figures are this
        // machine's own.
        val at = System.currentTimeMillis()
        val json = """{"claudeAccount":{"cachedAtMs":$at,"machineNote":"","machineMeasured":{"five":null,"week":null,"month":null,"machines":"build-box, lab\u202e-box"}}}"""
        assertTrue(note(json, "claude"), Regex("^updated \\S.* · estimates include usage measured on build-box, lab-box$").matches(note(json, "claude")))
        assertTrue(note(json, "gpt"), Regex("^updated \\S[^·]*$").matches(note(json, "gpt")))
        val none = note("""{"claudeAccount":{"cachedAtMs":$at,"machineMeasured":null}}""", "claude")
        assertFalse("control: estimates of this machine alone name none — $none", none.contains("estimates include"))
    }

    fun testTheNoteKeepsTheCapsMachine() {
        // The Stats panel shows the per-model cap, so a cap from a saved machine is named with its window, from the full
        // note (machineNote), never the status bar's (machineBarNote), which names none for it.
        val json = """{"claudeAccount":{"cachedAtMs":${System.currentTimeMillis()},"machineNote":"build-box: fable","machineBarNote":""}}"""
        assertTrue(note(json, "claude"), note(json, "claude").endsWith(" · measured on build-box: fable"))
    }

    fun testTheNoteWrapsInANarrowDockRatherThanLosingItsEnd() {
        // The note ends with the saved machines' names. As a label beside the section's title it was cut there, with an
        // ellipsis, in the default dock (the Stats pane is a fifth of the window): it wraps under the title instead, whole.
        val text = "updated 14:02 · measured on build-box at 13:58 · estimates include usage measured on build-box, lab-box"
        val section = Class.forName("com.cellobservatory.observatory.ui.stats.FoldSection")
            .getDeclaredConstructor(String::class.java, String::class.java, List::class.java, javax.swing.JComponent::class.java)
            .apply { isAccessible = true }
            .newInstance("probe", "USAGE", listOf(javax.swing.JPanel()), null) as javax.swing.JComponent
        section.javaClass.getDeclaredMethod("setNote", String::class.java).apply { isAccessible = true }.invoke(section, text)
        fun find(c: java.awt.Component): javax.swing.JTextArea? =
            c as? javax.swing.JTextArea ?: (c as? java.awt.Container)?.components?.firstNotNullOfOrNull { find(it) }
        val shown = find(section)
        assertNotNull("the note is drawn by a text area", shown)
        assertTrue("…that wraps", shown!!.lineWrap)
        assertEquals("…the whole note", text, shown.text)
        // Laid out as the Stats stack lays a section out: the pane's width, and the section's own height at that width.
        // Off screen nothing revalidates, so each pass drops the layouts' cached sizes first, as a revalidate would.
        fun invalidate(c: java.awt.Component) {
            if (c is java.awt.Container) { c.invalidate(); c.components.forEach { invalidate(it) } }
        }
        fun layout(c: java.awt.Component) {
            if (c is java.awt.Container) { c.doLayout(); c.components.forEach { layout(it) } }
        }
        fun linesAt(width: Int): Int {
            repeat(3) { invalidate(section); section.setSize(width, section.preferredSize.height); layout(section) }
            return shown.height / shown.getFontMetrics(shown.font).height
        }
        val narrow = linesAt(200)
        assertTrue("a narrow dock: the note takes more than one line — $narrow", narrow >= 2)
        assertEquals("control: a wide dock, one line", 1, linesAt(4000))
    }
    fun testGptNamesTheDatabaseMachinesAndLocalFallback() {
        for (machines in listOf("work-box, build-box", "this machine alone")) {
            assertEquals("estimates include usage measured on $machines", note("""{"gptMeasuredMachines":"$machines"}""", "gpt"))
        }
    }

}
