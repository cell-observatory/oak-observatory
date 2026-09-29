package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.services.OldPluginRetirement
import com.cellobservatory.observatory.services.OldPluginRetirement.Outcome
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

/**
 * The rename's migration on the JetBrains side: the pre-rename plugin (`com.cell-observatory.claude-
 * observatory`) is disabled when it is installed next to OAK, exactly once, and never brought back. The
 * startup skips this in unit-test runs, so the retirement is driven here with the platform calls swapped
 * for a fake old plugin the test can watch.
 */
class OldPluginRetirementTest : BasePlatformTestCase() {

    private val real = Triple(OldPluginRetirement.installed, OldPluginRetirement.disabled, OldPluginRetirement.disable)

    override fun tearDown() {
        try {
            OldPluginRetirement.installed = real.first
            OldPluginRetirement.disabled = real.second
            OldPluginRetirement.disable = real.third
        } finally {
            super.tearDown()
        }
    }

    fun testAnEnabledOldPluginIsDisabledOnceAndLeftDisabled() {
        var enabled = true
        var disables = 0
        OldPluginRetirement.installed = { true }
        OldPluginRetirement.disabled = { !enabled }
        OldPluginRetirement.disable = { disables++; enabled = false }
        assertEquals("an old plugin beside OAK is disabled", Outcome.DISABLED, OldPluginRetirement.retire())
        assertEquals(1, disables)
        // The run after the restart finds it disabled: no second disable, no second notice, no loop.
        assertEquals(Outcome.ALREADY_DISABLED, OldPluginRetirement.retire())
        assertEquals("disabled once, never again", 1, disables)
        assertFalse("…and nothing enabled it again", enabled)
    }

    fun testARefusedDisableIsReportedAndAbsentIsQuiet() {
        OldPluginRetirement.installed = { true }
        OldPluginRetirement.disabled = { false }
        OldPluginRetirement.disable = { error("the platform refused") }
        assertEquals("a disable that throws is REFUSED, so the reader is told to uninstall it by hand", Outcome.REFUSED, OldPluginRetirement.retire())
        OldPluginRetirement.installed = { false }
        assertEquals(Outcome.ABSENT, OldPluginRetirement.retire())
    }

    fun testTheRealPlatformCallsAnswerAndNothingEnablesTheOldId() {
        // Control: the default seams really ask the platform; this test IDE has no old plugin installed.
        assertEquals(Outcome.ABSENT, OldPluginRetirement.retire())
        // Never reinstalled: this plugin has no installer of its own (updates go through the CLI), and no
        // source enables or installs a plugin, the old id included.
        val src = File("src/main/kotlin")
        assertTrue("control: the plugin sources are readable from the test's working directory", src.isDirectory)
        val offenders = src.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .filter { f -> f.readText().let { it.contains("enableById") || it.contains("PluginInstaller") || it.contains("installAndEnable") } }
            .map { it.name }.toList()
        assertEquals("no source enables or installs a plugin", emptyList<String>(), offenders)
    }
}
