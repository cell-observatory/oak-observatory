package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.nio.file.Files

/**
 * A draft reaches the CLI whatever it starts with. JetBrains passed `--text` and the draft as two
 * arguments, and the CLI reads a following token that starts with `--` as a missing value: a review
 * comment or prompt opening with a markdown rule ("---") or "--force is wrong here" failed as
 * "needs --text", and the prompt toast then dropped the CLI's reason. Runs this tree's CLI (the test
 * task pins it) against a demo store in a throwaway config dir.
 */
class DraftArgvTest : BasePlatformTestCase() {

    private lateinit var cfg: File
    private lateinit var work: File
    private var prevCfg: String? = null

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-draft-cfg").toFile()
        work = Files.createTempDirectory("oak-draft-ws").toFile()
        val st = ObservatorySettings.instance.state
        prevCfg = st.configDir
        st.configDir = cfg.absolutePath // the CLI's CLAUDE_CONFIG_DIR
        ClaudePaths.configDirOverride = cfg.toPath() // the plugin's own store reads
    }

    override fun tearDown() {
        try {
            ObservatorySettings.instance.state.configDir = prevCfg
            ClaudePaths.configDirOverride = null
            cfg.deleteRecursively()
            work.deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    fun testDraftsThatStartWithTwoDashesReachTheCli() {
        assertTrue("control: the demo replay seeded a session", ObservatoryCli.run(listOf("demo", "--fast"), work.absolutePath, timeoutMs = 120_000).ok)
        val session = Regex("demo-[0-9a-f]{8}").find(ObservatoryCli.run(listOf("sessions", "--json"), work.absolutePath).stdout)?.value
        assertNotNull("control: the listing names the demo session", session)
        val pending = StoreReader.readLog(session!!).first { it.pending }

        val note = "--- this rule came from the diff above"
        assertNull("a review comment starting with -- is stored", ObservatoryCli.commentAdd(session, work.absolutePath, pending.id, 0, note))
        val listed = ObservatoryCli.run(listOf("comment", "list", "--session", session, "--json"), work.absolutePath).stdout
        assertTrue("…with its text intact: $listed", listed.contains(note))

        // No herdr pane holds this session here, so nothing is sent; what matters is WHY.
        val failure = ObservatoryCli.prompt(session, "--- keep this draft", work.absolutePath)
        assertNotNull("with no live pane nothing is reported as sent", failure)
        assertFalse("the CLI read the draft instead of refusing a missing --text: $failure", failure!!.contains("needs --session"))
        assertTrue("…and its own reason reaches the toast: $failure", failure.isNotBlank())
    }
}
