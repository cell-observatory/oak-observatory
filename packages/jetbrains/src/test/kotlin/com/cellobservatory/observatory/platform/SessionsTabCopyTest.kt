package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.components.JBTabbedPane
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JLabel

/**
 * What the Sessions tab SAYS, read off the real panel. The listing is one machine's sessions grouped by
 * workspace; the tab's description and tooltip described the retired machine grouping ("this machine
 * first … remote panes … reviewed on that machine"), and a pinned session missing from the listing was
 * explained as "recorded for another workspace", which a machine-wide listing can no longer mean.
 */
class SessionsTabCopyTest : BasePlatformTestCase() {

    private lateinit var cfg: Path
    private var savedPin: String? = null
    private var savedBin: String? = null

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-sessions-copy-cfg")
        ClaudePaths.configDirOverride = cfg
        val st = ObservatorySettings.instance.state
        savedPin = st.session
        savedBin = st.observatoryBin
        st.observatoryBin = "/bin/false" // no panel refresh reads a real listing
    }

    override fun tearDown() {
        try {
            val st = ObservatorySettings.instance.state
            st.session = savedPin
            st.observatoryBin = savedBin
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    private fun row(id: String) = SessionRow(id, "Fixture $id", System.currentTimeMillis(), current = false, edits = 0, pending = 0, files = 0, workspace = "~/fixture")

    private fun painted(pin: String?, rows: List<SessionRow>): Pair<String, String?> {
        // A pin is kept only while its session exists here: a store folder, as a deleted or mirrored
        // session still has, is what makes it a real pin the listing leaves out.
        pin?.let { Files.createDirectories(ClaudePaths.storeDir(it)) }
        ObservatorySettings.instance.state.session = pin
        val panel = ChangeMapPanel(project)
        ChangeMapPanel::class.java.getDeclaredMethod("repaintSessions", SessionsResult::class.java)
            .apply { isAccessible = true }.invoke(panel, SessionsResult(null, rows))
        val desc = ChangeMapPanel::class.java.getDeclaredField("sessionsDesc").apply { isAccessible = true }.get(panel) as JLabel
        val tabs = ChangeMapPanel::class.java.getDeclaredField("navTabs").apply { isAccessible = true }.get(panel) as JBTabbedPane
        val sessionsTab = (0 until tabs.tabCount).first { tabs.getTitleAt(it).startsWith("Sessions") }
        return desc.text to tabs.getToolTipTextAt(sessionsTab)
    }

    fun testTheTabDescribesTheWorkspaceGroupingItShows() {
        val (desc, tip) = painted(null, listOf(row("fixture-a")))
        for (text in listOf(desc, tip.orEmpty())) {
            assertTrue("grouped by workspace, on this machine — $text", text.contains("Sessions on this machine, grouped by workspace"))
            assertFalse("no retired machine grouping — $text", Regex("grouped by machine|remote pane|reviewed on that machine").containsMatchIn(text))
        }
    }

    fun testAPinMissingFromTheListingIsExplainedAsUnlisted() {
        val (desc, _) = painted("fixture-gone", listOf(row("fixture-a")))
        assertTrue(
            "the pinned id is named, with the reasons a machine-wide listing can lack it — $desc",
            desc.contains("Reviewing fixture- — not in this machine’s session list (deleted, empty, or a copy mirrored from another machine)."),
        )
        assertFalse("never 'another workspace': the listing spans every workspace — $desc", desc.contains("another workspace"))
        // Control: a pin the listing does carry gets no such line.
        assertFalse(painted("fixture-a", listOf(row("fixture-a"))).first.contains("Reviewing"))
    }
}
