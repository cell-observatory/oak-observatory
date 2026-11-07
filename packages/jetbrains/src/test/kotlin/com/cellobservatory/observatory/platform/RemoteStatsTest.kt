package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.stats.StatsPanel
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import java.io.File
import java.nio.file.Files
import javax.swing.JLabel

/** Remote session totals and locally read account history have separate scopes. */
class RemoteStatsTest : ObservatoryPlatformTestCase() {
    fun testRemoteStatsReadsItsSelectedMachine() {
        if (System.getProperty("os.name").startsWith("Windows")) return
        val dir = Files.createTempDirectory("oak-remote-stats").toFile()
        val oldBin = ObservatorySettings.instance.state.observatoryBin
        ClaudePaths.configDirOverride = dir.toPath()
        val calls = File(dir, "calls")
        ObservatorySettings.instance.state.observatoryBin = File(dir, "oak").apply {
            writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${calls.path}'
case "${'$'}1" in
machine) printf '[]';;
query) exit 1;;
sessions) printf '{"sessions":[]}';;
views) printf '{"changemap":{},"prompts":{"prompts":[]},"multitask":{}}';;
usage) case " ${'$'}* " in
  *' --machine lab-b '*) touch '${dir.path}/started'; while [ ! -f '${dir.path}/release' ]; do sleep 0.02; done; printf '{"sessionTokens":{"available":true,"input":800}}'; touch '${dir.path}/finished';;
  *' --machine lab-c '*) exit 1;;
  *' --machine lab-a '*) printf '{"weekTokens":999,"sessionTokens":{"available":true,"input":900,"output":90,"total":990},"sessionTreeTokens":{"available":true,"input":1800,"output":180,"total":1980,"agents":1}}';;
  *) printf '{"weekTokens":55,"sessionTokens":{"available":true,"input":100,"output":10,"total":110}}';;
  esac;;
stats) printf '{"daily":[],"hourly":[]}';;
*) printf '{}';;
esac
""")
            setExecutable(true)
        }.path
        project.basePath?.let { File(it).mkdirs() }
        ObservatoryCli.invalidateViewBatch()
        val service = ObservatoryService.getInstance(project)
        service.remotePin = ObservatoryService.RemotePin("same-id", "lab-a")
        val panel = StatsPanel(project)
        try {
            panel.refresh(true)
            val usageField = panel.javaClass.getDeclaredField("usage").apply { isAccessible = true }
            val deadline = System.currentTimeMillis() + 10_000
            while (usageField.get(panel) == null && System.currentTimeMillis() < deadline) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                Thread.sleep(20)
            }
            val usage = usageField.get(panel)
            assertNotNull("the synthetic CLI must answer", usage)
            val tokens = usage.javaClass.getDeclaredMethod("getSessionTokens").apply { isAccessible = true }.invoke(usage)
            val input = tokens.javaClass.getDeclaredMethod("getInput").apply { isAccessible = true }.invoke(tokens)
            val label = (panel.javaClass.getDeclaredField("sessionLabel").apply { isAccessible = true }.get(panel) as JLabel).text
            val requests = calls.readLines().filter { it.startsWith("usage ") || it.startsWith("stats ") }
            assertEquals("remote session usage must come from lab-a", 900.0, input)
            assertTrue("remote Stats label must identify its machine: $label", label.contains("lab-a"))
            assertTrue(requests.toString(), requests.any { it.startsWith("usage ") && it.contains("--machine lab-a") })
            assertTrue(requests.toString(), requests.filter { it.startsWith("stats ") }.all { !it.contains("--machine") && !it.contains("--session same-id") })
            val tree = usage.javaClass.getDeclaredMethod("getSessionTreeTokens").apply { isAccessible = true }.invoke(usage)
            assertEquals(1800.0, tree.javaClass.getDeclaredMethod("getInput").apply { isAccessible = true }.invoke(tree))
            assertEquals("account usage stays local", 55.0, usage.javaClass.getDeclaredMethod("getWeekTok").apply { isAccessible = true }.invoke(usage))
            fun await(message: String, done: () -> Boolean) {
                val until = System.currentTimeMillis() + 10_000
                while (!done() && System.currentTimeMillis() < until) {
                    PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                    Thread.sleep(20)
                }
                assertTrue(message, done())
            }
            service.remotePin = ObservatoryService.RemotePin("same-id", "lab-b")
            panel.refresh(true)
            assertNull("switch clears the previous machine's tokens", usage.javaClass.getDeclaredMethod("getSessionTokens").apply { isAccessible = true }.invoke(usageField.get(panel)))
            await("delayed request started") { File(dir, "started").exists() }
            service.remotePin = ObservatoryService.RemotePin("same-id", "lab-c")
            panel.refresh(true)
            val running = panel.javaClass.getDeclaredField("usageRunning").apply { isAccessible = true }
            await("failed remote read finished") { !running.getBoolean(panel) }
            File(dir, "release").writeText("")
            await("old reply returned") { File(dir, "finished").exists() }
            // Drain the queued old response; it must not repopulate lab-c's unavailable totals.
            repeat(20) { PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20) }
            val current = usageField.get(panel)
            assertNull(current.javaClass.getDeclaredMethod("getSessionTokens").apply { isAccessible = true }.invoke(current))
            assertNull(current.javaClass.getDeclaredMethod("getSessionTreeTokens").apply { isAccessible = true }.invoke(current))
            assertTrue((panel.javaClass.getDeclaredField("sessionLabel").apply { isAccessible = true }.get(panel) as JLabel).text.contains("lab-c"))
        } finally {
            File(dir, "release").writeText("")
            Disposer.dispose(panel)
            service.remotePin = null
            ObservatorySettings.instance.state.observatoryBin = oldBin
            ClaudePaths.configDirOverride = null
            ObservatoryCli.invalidateViewBatch()
            dir.deleteRecursively()
        }
    }
}
