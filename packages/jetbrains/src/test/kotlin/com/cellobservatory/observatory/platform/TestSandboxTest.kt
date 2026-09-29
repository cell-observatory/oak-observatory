package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.nio.file.Paths

/**
 * The suite's own isolation (build.gradle.kts `tasks.test`). The headless IDE opens a project and the
 * plugin under test spawns `oak views --json` on its refresh tick; with the developer's HOME and the
 * installed CLI, one gradle run wrote change-map caches into the real store for a live session and read
 * every real transcript. Removing the sandbox fails here, by name, instead of quietly doing that again.
 */
class TestSandboxTest : BasePlatformTestCase() {

    fun testTheSuiteRunsAgainstAThrowawayHomeAndThisTreesCli() {
        val home = System.getenv("HOME")
        assertNotNull("the test task sets HOME", home)
        assertTrue("HOME is the build's throwaway dir, not the developer's — $home", File(home!!).path.replace('\\', '/').endsWith("/build/test-home"))
        assertFalse("…and is not the account's home", Paths.get(home) == Paths.get(System.getProperty("user.home")))
        assertTrue("the plugin reads the sandboxed config dir — ${ClaudePaths.configDir()}", ClaudePaths.configDir().startsWith(Paths.get(home)))
        assertTrue("Codex history is read from the sandbox — ${System.getenv("CODEX_HOME")}", System.getenv("CODEX_HOME")?.startsWith(home) == true)
        assertNull("no display, as on CI: a CLI child's clipboard write cannot reach the desktop", System.getenv("DISPLAY"))
        assertNull("no session bus, as on CI: the headless IDE cannot reach the developer's D-Bus", System.getenv("DBUS_SESSION_BUS_ADDRESS"))
        val pin = System.getenv("CLAUDE_OBSERVATORY_BIN")
        assertTrue("the CLI is pinned to this tree's workspace bin — $pin", pin != null && File(pin).path.replace('\\', '/').contains("/node_modules/.bin/oak"))
        assertTrue("this tree's CLI is built (run `npm run build` at the repo root first) — $pin", File(pin!!).exists())
        assertEquals("the plugin spawns this tree's CLI, never an installed one", pin, ObservatoryCli.resolveBin())
    }
}
