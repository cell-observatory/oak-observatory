package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.BackgroundProcess
import com.cellobservatory.observatory.model.ProcessesParser
import com.cellobservatory.observatory.model.ProcessesResult
import com.cellobservatory.observatory.model.ProcessSummary
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.google.gson.JsonParser
import com.intellij.ui.components.JBList
import java.io.File
import java.nio.file.Files
import javax.swing.JTabbedPane

class ProcessDashboardTest : ObservatoryPlatformTestCase() {
    fun testEmptyProcessAnswerKeepsThePanelWithActiveOnlyEnabled() {
        val cfg = ObservatorySettings.instance.state
        val old = cfg.overviewActiveOnly
        try {
            cfg.overviewActiveOnly = true
            val panel = ChangeMapPanel(project)
            val paint = ChangeMapPanel::class.java.getDeclaredMethod("repaintProcesses", ProcessesResult::class.java).apply { isAccessible = true }
            paint.invoke(panel, ProcessesResult("empty", ProcessSummary(0, 0, 0), emptyList()))
            val list = ChangeMapPanel::class.java.getDeclaredField("processesList").apply { isAccessible = true }.get(panel) as JBList<*>
            assertNotNull(panel.selectNavTab("processes"))
            assertEquals("No shells in this session", list.emptyText.text)
        } finally { cfg.overviewActiveOnly = old }
    }

    // A saved machine that did not answer: the panel says why, as the terminal app does, and never tells the reader to
    // update the CLI on PATH, which answered (review 2026-11-05).
    fun testSavedMachineProcessesFailureSaysWhy() {
        if (System.getProperty("os.name").startsWith("Windows")) return
        val dir = Files.createTempDirectory("oak-process-failure").toFile()
        val cfg = ObservatorySettings.instance.state
        val oldBin = cfg.observatoryBin
        val service = ObservatoryService.getInstance(project)
        val oldPin = service.remotePin
        try {
            cfg.observatoryBin = File(dir, "oak").apply {
                writeText("#!/bin/sh\necho 'oak: no saved machine \"nosuchbox\"' >&2\nexit 1\n")
                setExecutable(true)
            }.path
            var why: String? = "unset"
            assertNull(ObservatoryCli.onMachine("nosuchbox") { ObservatoryCli.processesJson("parent", project.basePath) { why = it } })
            assertTrue("$why", why?.contains("no saved machine \"nosuchbox\"") == true)
            service.remotePin = ObservatoryService.RemotePin("parent", "nosuchbox")
            service.processes(force = true)
            val deadline = System.currentTimeMillis() + 10000
            while (service.processesFailure() == null && System.currentTimeMillis() < deadline) Thread.sleep(20)
            val panel = ChangeMapPanel(project)
            ChangeMapPanel::class.java.getDeclaredMethod("repaintProcesses", ProcessesResult::class.java).apply { isAccessible = true }.invoke(panel, null)
            val list = ChangeMapPanel::class.java.getDeclaredField("processesList").apply { isAccessible = true }.get(panel) as JBList<*>
            assertTrue(list.emptyText.text, list.emptyText.text.startsWith("Processes unavailable: ") && "no saved machine \"nosuchbox\"" in list.emptyText.text)
            // On this machine the CLI on PATH is the one that did not answer.
            why = "unset"
            assertNull(ObservatoryCli.onMachine(null) { ObservatoryCli.processesJson("parent", project.basePath) { why = it } })
            assertNull(why)
        } finally {
            service.remotePin = oldPin
            cfg.observatoryBin = oldBin
            dir.deleteRecursively()
        }
    }

    fun testLocalAndSavedMachineProcessesIncludingCodexEmptyAndFinishedSelection() {
        if (System.getProperty("os.name").startsWith("Windows")) return
        val dir = Files.createTempDirectory("oak-process-dashboard")
        val cfg = ObservatorySettings.instance.state
        val oldBin = cfg.observatoryBin
        val oldConfig = cfg.configDir
        val oldSession = cfg.session
        val oldActive = cfg.overviewActiveOnly
        val oldGrouped = cfg.overviewGroupedNav
        val service = ObservatoryService.getInstance(project)
        val oldPin = service.remotePin
        try {
            val fixture = File("../../test/fixtures/process-dashboard.cjs").canonicalFile
            val seed = ProcessBuilder("node", fixture.path, dir.toString(), project.basePath!!).redirectErrorStream(true).start()
            val text = seed.inputStream.bufferedReader().readText()
            assertEquals(text, 0, seed.waitFor())
            val fx = JsonParser.parseString(text).asJsonObject
            cfg.observatoryBin = fx.get("oak").asString
            cfg.configDir = fx.getAsJsonObject("local").get("home").asString + "/.claude"
            cfg.session = "parent"
            cfg.overviewActiveOnly = false
            val paint = ChangeMapPanel::class.java.getDeclaredMethod("repaintProcesses", ProcessesResult::class.java).apply { isAccessible = true }
            val field = ChangeMapPanel::class.java.getDeclaredField("processesList").apply { isAccessible = true }
            for (machine in listOf(null, "build-box")) {
                service.remotePin = machine?.let { ObservatoryService.RemotePin("parent", it) }
                fun read(session: String): ProcessesResult {
                    val r = ObservatoryCli.onMachine(machine) {
                        ObservatoryCli.run(listOf("processes", "--json", "--session", session), project.basePath)
                    }
                    assertTrue(r.stderr, r.ok)
                    return ProcessesParser.parse(r.stdout) ?: throw AssertionError(r.stdout)
                }
                for (grouped in listOf(false, true)) {
                    cfg.overviewGroupedNav = grouped
                    val panel = ChangeMapPanel(project)
                    val strip = panel.selectNavTab("processes") as? JTabbedPane
                    assertNotNull("Processes is mounted before the list answers", strip)
                    val start = System.nanoTime()
                    val result = read("parent")
                    paint.invoke(panel, result)
                    @Suppress("UNCHECKED_CAST")
                    val list = field.get(panel) as JBList<BackgroundProcess>
                    val ms = (System.nanoTime() - start) / 1_000_000.0
                    assertEquals(1000, list.model.size)
                    assertEquals(2, result.summary.running)
                    assertTrue("1,000-shell refresh took $ms ms", ms < 5000)
                    println("JetBrains ${machine ?: "local"} ${if (grouped) "grouped" else "tabs"} 1,000-shell read + render: $ms ms")
                    val titles = (0 until strip!!.tabCount).map { strip.getTitleAt(it) }
                    if (grouped) assertTrue(titles.single(), titles.single().startsWith("Sessions · Workers · Processes · Tasks · Workflows"))
                    else assertEquals(listOf("Sessions", "Workers", "Processes", "Tasks", "Workflows"), titles.map { it.substringBefore(' ') })
                    for (id in listOf("shell-0", "worker:shell-999")) {
                        paint.invoke(panel, result)
                        list.selectedIndex = (0 until list.model.size).first { list.model.getElementAt(it).id == id }
                        val ref = service.selectedFeed?.ref ?: throw AssertionError("Selecting $id must open the feed")
                        assertEquals("process", ref.kind)
                        assertEquals(id, ref.id)
                        service.feed(ref, true)
                        val expected = "${if (machine == null) "LOCAL" else "REMOTE"} OUTPUT ${if (id == "shell-0") 0 else 999}"
                        val deadline = System.currentTimeMillis() + 10000
                        while (service.feed(ref)?.entries?.any { it.label.contains(expected) } != true && System.currentTimeMillis() < deadline) {
                            Thread.sleep(20)
                        }
                        assertTrue("$id output on $machine", service.feed(ref)?.entries?.any { it.label.contains(expected) } == true)
                        service.selectedFeed = null
                    }
                    paint.invoke(panel, read("empty"))
                    assertEquals("No shells in this session", list.emptyText.text)
                    paint.invoke(panel, read("codex-shell"))
                    assertEquals("codex-123", list.model.getElementAt(0).id)
                    assertEquals("${if (machine == null) "local" else "remote"}-codex", list.model.getElementAt(0).command)
                }
            }
            val calls = File(fx.get("calls").asString).readLines().filter { it.startsWith("processes ") && it.contains("--machine build-box") }
            assertTrue("saved-machine list and follow calls", calls.size >= 4)
            assertTrue(calls.joinToString("\n"), calls.all { it.endsWith(" | 45000") && !it.contains("--root") })
            // Remote commands travel base64-encoded (core remoteShellCommand): read the ones the ssh log carried.
            val sent = Regex("printf %s ([A-Za-z0-9+/=]+) \\| base64 -D").findAll(File(fx.get("log").asString).readText())
                .joinToString("\n") { String(java.util.Base64.getDecoder().decode(it.groupValues[1])) }
            assertTrue(sent, sent.contains("processes"))
        } finally {
            service.selectedFeed = null
            service.remotePin = oldPin
            cfg.observatoryBin = oldBin
            cfg.configDir = oldConfig
            cfg.session = oldSession
            cfg.overviewActiveOnly = oldActive
            cfg.overviewGroupedNav = oldGrouped
            dir.toFile().deleteRecursively()
        }
    }
}
