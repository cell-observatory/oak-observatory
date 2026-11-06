package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.MultitaskResult
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.intellij.testFramework.PlatformTestUtil
import java.io.File
import java.nio.file.Files
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.TreePath

/** A delegated worker keeps its parent session, workspace and machine through selection and the CLI read. */
class DelegatedWorkerLogTest : ObservatoryPlatformTestCase() {
    fun testSelectingADelegatedWorkerOpensItsLog() {
        if (System.getProperty("os.name").startsWith("Windows")) return
        val cfg = Files.createTempDirectory("oak-delegated-log")
        val oldBin = ObservatorySettings.instance.state.observatoryBin
        ClaudePaths.configDirOverride = cfg
        val calls = cfg.resolve("calls").toFile()
        ObservatorySettings.instance.state.observatoryBin = cfg.resolve("oak").toFile().apply {
            writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${calls.path}'
case "${'$'}1" in
machine) printf '[{"label":"lab-a"}]';;
fleet|sessions)
  case "${'$'}*" in *--machine*) cwd=/remote/work;; *) cwd='${cfg}';; esac
  printf '{"sessions":[],"workers":[{"session":"parent-a","title":"Synthetic task","worktree":"%s","kind":"claude","state":"working","phase":"working","subagents":[{"agentId":"worker-a","description":"Synthetic worker","state":"working","phase":"working"}]}]}' "${'$'}cwd";;
feed) printf '{"workerLogVersion":1,"ref":{"kind":"agent","id":"worker-a"},"title":"Synthetic worker","entries":[],"mode":"live","note":"Worker log"}';;
*) printf '{}';;
esac
""")
            setExecutable(true)
        }.path
        project.basePath?.let { File(it).mkdirs() }
        val service = ObservatoryService.getInstance(project)
        try {
            val cache = com.cellobservatory.observatory.core.SavedMachines
            cache.refresh()
            val readyBy = System.currentTimeMillis() + 10_000
            while ((service.localWorkers()?.workers?.none { it.worktree == cfg.toString() } != false || cache.snapshot().machines.none { it.listing?.workers != null }) && System.currentTimeMillis() < readyBy) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
            }
            val panel = ChangeMapPanel(project)
            for (machine in listOf(null, "lab-a")) {
                val cwd = if (machine == null) cfg.toString() else "/remote/work"
                panel.javaClass.getDeclaredMethod("repaintNav", MultitaskResult::class.java).apply { isAccessible = true }.invoke(panel, null)
                val tree = panel.javaClass.getDeclaredField("fleetTree").apply { isAccessible = true }.get(panel) as JTree
                val root = tree.model.root as DefaultMutableTreeNode
                val worker = root.depthFirstEnumeration().toList().filterIsInstance<DefaultMutableTreeNode>()
                    .single { node ->
                        val row = node.userObject
                        row?.javaClass?.simpleName == "SubRow" && row.javaClass.getDeclaredField("machine").apply { isAccessible = true }.get(row) == machine
                    }
                tree.selectionPath = TreePath(worker.path)
                val selected = service.selectedFeed?.ref
                assertEquals("the worker row must open its live log", "worker-a", selected?.id)
                assertEquals("parent-a", selected?.session)
                assertEquals(machine, selected?.machine)
                assertEquals(cwd, selected?.cwd)
                service.feed(selected!!, true)
                val deadline = System.currentTimeMillis() + 10_000
                var feed = service.feed(selected)
                while (feed == null && System.currentTimeMillis() < deadline) {
                    PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                    Thread.sleep(20)
                    feed = service.feed(selected)
                }
                assertEquals("Worker log", feed?.note)
                val request = calls.readLines().last { it.startsWith("feed ") }
                assertTrue(request, request.contains("--session parent-a") && request.contains("--id worker-a"))
                if (machine == null) {
                    assertFalse(request, request.contains("--machine"))
                    assertTrue(request, request.contains("--root $cwd"))
                } else {
                    assertTrue(request, request.contains("--machine lab-a"))
                    assertFalse(request, request.contains("--root"))
                }
            }
        } finally {
            service.remotePin = null
            service.selectedFeed = null
            ObservatorySettings.instance.state.observatoryBin = oldBin
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        }
    }
}
