package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.util.ui.UIUtil
import java.io.File
import java.nio.file.Files
import javax.swing.JList

class SavedMachinesTest : ObservatoryPlatformTestCase() {
    private lateinit var dir: File
    private var oldBin: String? = null
    private var oldActive = true
    override fun setUp() {
        super.setUp()
        dir = Files.createTempDirectory("oak-saved-machines").toFile()
        ClaudePaths.configDirOverride = dir.toPath()
        oldBin = ObservatorySettings.instance.state.observatoryBin
        oldActive = ObservatorySettings.instance.state.overviewActiveOnly
        val oak = File(dir, "oak").apply {
            writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${dir.path}/calls'
case "${'$'}1 ${'$'}2" in
  'machine list') printf '[{"label":"lab-a"},{"label":"lab-b"},{"label":"disabled","enabled":false}]';;
  'sessions --json')
    case "${'$'}*" in
      *--synced*) printf '{"sessions":[],"machines":[{"label":"index-box","host":"cccccccccccc","sessions":[{"id":"indexed-only","title":"Indexed synthetic","lastActiveMs":500}]}]}';;
      *--machine*) [ -f '${dir.path}/fail' ] && { echo 'oak: fixture connection refused' >&2; exit 255; }; sleep 1; printf '{"sessions":[{"id":"same-id","origin":"synced","title":"Remote work","lastActiveMs":1,"activeWorkers":[{"agentId":"w1","title":"Remote worker","phase":"working"}]}],"workers":[{"session":"same-id","title":"Remote work","state":"working","phase":"working","subagents":[{"agentId":"w1","description":"Remote worker","state":"working","phase":"working"}]}]}';;
      *) printf '{"sessions":[]}';;
    esac;;
  *) printf '{}';;
esac
""")
            setExecutable(true)
        }
        ObservatorySettings.instance.state.observatoryBin = oak.path
    }
    override fun tearDown() {
        try {
            ObservatorySettings.instance.state.observatoryBin = oldBin
            ObservatorySettings.instance.state.overviewActiveOnly = oldActive
            ClaudePaths.configDirOverride = null
            dir.deleteRecursively()
        } finally { super.tearDown() }
    }

    fun testPopupListsBothSavedMachinesWithoutWaitingAndCoalescesReads() {
        val start = System.nanoTime()
        val popup = ReviewOps.chooseSessionPopup(project, emptyList())
        val firstMs = (System.nanoTime() - start) / 1_000_000
        println("saved machines: popup first render: ${firstMs}ms")
        try {
            assertTrue("EDT must not wait on two 1s machines: ${firstMs}ms", firstMs < 900)
            val list = UIUtil.findComponentOfType(popup.content, JList::class.java)!!
            fun labels() = (0 until list.model.size).map { list.model.getElementAt(it).toString() }
            val end = System.currentTimeMillis() + 8_000
            while (labels().count { it.contains("Remote work") } < 2 && System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                Thread.sleep(20)
            }
            println("saved machines: two delayed machines visible: ${(System.nanoTime() - start) / 1_000_000}ms")
            val rows = labels()
            assertTrue(rows.toString(), rows.any { it.contains("Remote work") && it.contains("on lab-a") })
            assertTrue(rows.toString(), rows.any { it.contains("Remote work") && it.contains("on lab-b") })
            val again = ReviewOps.chooseSessionPopup(project, emptyList())
            Disposer.dispose(again)
            val calls = File(dir, "calls").readLines().filter { it.contains("--machine") }
            assertEquals("one read per machine across consumers", 2, calls.size)
            assertFalse("Sessions alone must not run Workers: $calls", calls.any { it.contains("--workers") })
            assertFalse(calls.toString(), calls.any { it.contains("disabled") })
        } finally { Disposer.dispose(popup) }
    }
    fun testWorkersVisibilityUpgradesASessionsReadAndCoalescesWindows() {
        val cache = com.cellobservatory.observatory.core.SavedMachines
        var showing = false
        val pane = object : javax.swing.JPanel() { override fun isShowing() = showing }
        cache.watchWorkers(pane)
        fun until(ok: () -> Boolean) {
            val end = System.currentTimeMillis() + 8_000
            while (!ok() && System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
            }
            assertTrue(cache.snapshot().toString(), ok())
        }
        try {
            cache.refresh()
            until { cache.snapshot().machines.size == 2 && cache.snapshot().machines.all { !it.reading } }
            val first = File(dir, "calls").readLines().filter { it.contains("--machine") }
            assertEquals(2, first.size)
            assertTrue(first.toString(), first.none { it.contains("--workers") })
            showing = true
            cache.refresh()
            cache.refresh()
            until { cache.snapshot().machines.all { !it.reading && it.workersRead } }
            val reads = File(dir, "calls").readLines().filter { it.contains("--machine") }
            assertEquals("showing Workers upgrades without waiting for the Sessions cooldown", 4, reads.size)
            assertTrue(reads.toString(), reads.drop(2).all { it.contains("--workers") })
            assertTrue(cache.snapshot().machines.all { !it.listing?.workers.isNullOrEmpty() })
            showing = false
            cache.refresh()
            assertEquals(4, File(dir, "calls").readLines().count { it.contains("--machine") })
        } finally { showing = false }
    }

    fun testFailedRefreshRemovesRowsButRetainsLastReadAndShowsItsReason() {
        val cache = com.cellobservatory.observatory.core.SavedMachines
        cache.refresh()
        fun until(ok: () -> Boolean) {
            val end = System.currentTimeMillis() + 15_000
            while (!ok() && System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
            }
            assertTrue(cache.snapshot().toString(), ok())
        }
        until { cache.snapshot().machines.size == 2 && cache.snapshot().machines.all { it.listing != null } }
        val before = cache.snapshot().machines.map { it.readAt }
        File(dir, "fail").writeText("fail")
        until { cache.refresh(); cache.snapshot().machines.all { it.error != null } }
        val failed = cache.snapshot().machines
        assertEquals(before, failed.map { it.readAt })
        assertTrue(failed.toString(), failed.all { it.listing == null && it.status().contains("fixture connection refused") && it.status().contains("last read") })
    }

    fun testOverviewAndWorkersUseTheSharedListingsAndRemoteSelectionNamesItsMachine() {
        val cache = com.cellobservatory.observatory.core.SavedMachines
        cache.refresh()
        val end = System.currentTimeMillis() + 8_000
        while (cache.snapshot().machines.count { it.listing != null } < 2 && System.currentTimeMillis() < end) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
        }
        val panel = com.cellobservatory.observatory.ui.ChangeMapPanel(project)
        val type = panel.javaClass
        type.getDeclaredMethod("repaintSessions", com.cellobservatory.observatory.model.SessionsResult::class.java).apply { isAccessible = true }
            .invoke(panel, com.cellobservatory.observatory.model.SessionsResult(null, emptyList()))
        @Suppress("UNCHECKED_CAST")
        val list = type.getDeclaredField("sessionsList").apply { isAccessible = true }.get(panel) as JList<Any>
        val remote = (0 until list.model.size).filter { list.model.getElementAt(it).javaClass.simpleName == "RemoteSessionRow" }
        assertEquals("one remote session under each machine", 2, remote.size)
        list.selectedIndex = remote[1]
        val enter = javax.swing.KeyStroke.getKeyStroke(java.awt.event.KeyEvent.VK_ENTER, 0)
        list.getActionForKeyStroke(enter).actionPerformed(java.awt.event.ActionEvent(list, 0, "enter"))
        val service = com.cellobservatory.observatory.services.ObservatoryService.getInstance(project)
        try {
            assertEquals("lab-b", service.currentMachine())
            val action = com.cellobservatory.observatory.ui.TimelineSessionAction(project)
            val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromAnAction(action, null, "test", com.intellij.openapi.actionSystem.impl.SimpleDataContext.getProjectContext(project))
            action.update(event)
            assertTrue(event.presentation.text, event.presentation.text.contains("on lab-b"))
            type.getDeclaredMethod("repaintNav", com.cellobservatory.observatory.model.MultitaskResult::class.java).apply { isAccessible = true }.invoke(panel, null)
            val root = type.getDeclaredField("fleetRoot").apply { isAccessible = true }.get(panel) as javax.swing.tree.DefaultMutableTreeNode
            val nodes = root.depthFirstEnumeration().toList().map { (it as javax.swing.tree.DefaultMutableTreeNode).userObject }
            assertEquals("Workers lists both saved sessions", 2, nodes.count { it?.javaClass?.simpleName == "AgentRow" })
            assertEquals("and their own workers", 2, nodes.count { it?.javaClass?.simpleName == "SubRow" })
            val agents = nodes.filter { it?.javaClass?.simpleName == "AgentRow" }.map {
                it!!.javaClass.getDeclaredField("agent").apply { isAccessible = true }.get(it) as com.cellobservatory.observatory.model.RunningAgent
            }
            assertEquals(listOf("lab-b", "lab-a"), agents.map { it.remote })
            assertTrue(agents.all { it.title == "Remote work" && it.machine == it.remote })
        } finally { service.remotePin = null }
    }

    fun testSel1NewestRemoteBefore99LocalRowsAndStateAtTop() {
        val entries = (1..99).map { n -> com.cellobservatory.observatory.model.SessionRow(
            "local-$n", "Local $n", -n.toLong(), current = n == 1, edits = 0, pending = 0, files = 0) }
        val popup = ReviewOps.chooseSessionPopup(project, entries)
        try {
            val list = UIUtil.findComponentOfType(popup.content, JList::class.java)!!
            fun labels() = (0 until list.model.size).map { list.model.getElementAt(it).toString() }
            val end = System.currentTimeMillis() + 8_000
            while (labels().count { it.contains("Remote work") } < 2 && System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
            }
            val rows = labels()
            assertTrue(rows.toString(), rows.indexOfFirst { it.contains("Remote work") } < rows.indexOfFirst { it.contains("Local 1 ") })
            assertTrue(rows.toString(), rows.indexOfFirst { it.startsWith("lab-a —") } < rows.indexOfFirst { it.contains("Remote work") })
            val timeline = com.cellobservatory.observatory.ui.TimelineSessionAction(project).sessionPopup(entries, "local-1", System.currentTimeMillis(), null)
            try {
                val tl = UIUtil.findComponentOfType(timeline.content, JList::class.java)!!
                val labels = (0 until tl.model.size).map { tl.model.getElementAt(it).toString() }
                assertTrue(labels.toString(), labels.indexOfFirst { it.contains("Remote work") } < labels.indexOfFirst { it.contains("Local 1 ") })
            } finally { Disposer.dispose(timeline) }
        } finally { Disposer.dispose(popup) }
    }

    fun testSel1OverviewSearchSortAndIndexedMachines() {
        val row = { id: String, title: String, at: Long -> com.cellobservatory.observatory.model.SessionRow(id, title, at,
            current = false, edits = 0, pending = 0, files = 0) }
        val local = (1..99).map { row("local-$it", "Middle $it", 100 + it.toLong()) }
        val machine = com.cellobservatory.observatory.model.MachineListing("indexed-box", "cccccccccccc", 500, null,
            listOf(row("remote-new", "Alpha match", 300), row("remote-old", "Zulu match", 1)))
        val panel = com.cellobservatory.observatory.ui.ChangeMapPanel(project)
        val repaint = panel.javaClass.getDeclaredMethod("repaintSessions", com.cellobservatory.observatory.model.SessionsResult::class.java).apply { isAccessible = true }
        val list = panel.javaClass.getDeclaredField("sessionsList").apply { isAccessible = true }.get(panel) as JList<*>
        ObservatorySettings.instance.state.overviewActiveOnly = false
        val svc = com.cellobservatory.observatory.services.ObservatoryService.getInstance(project)
        val oldSort = ObservatorySettings.instance.state.overviewSort
        fun ids(): List<String> {
            repaint.invoke(panel, com.cellobservatory.observatory.model.SessionsResult(null, local, machines = listOf(machine)))
            return (0 until list.model.size).mapNotNull { i ->
                val v = list.model.getElementAt(i)
                if (v is com.cellobservatory.observatory.model.SessionRow) v.id
                else runCatching { (v.javaClass.getDeclaredField("session").apply { isAccessible = true }.get(v) as com.cellobservatory.observatory.model.SessionRow).id }.getOrNull()
            }
        }
        try {
            for ((sort, first) in listOf("time" to "remote-new", "time-asc" to "remote-old", "name" to "remote-new", "name-desc" to "remote-old")) {
                ObservatorySettings.instance.state.overviewSort = sort
                assertEquals(sort, first, ids().firstOrNull())
            }
            svc.setFilterQuery("match"); ObservatorySettings.instance.state.overviewSort = "time"
            assertEquals(listOf("remote-new", "remote-old"), ids())
            svc.setFilterQuery(""); ObservatorySettings.instance.state.overviewActiveOnly = true
            assertTrue("indexed snapshots do not claim live activity", ids().isEmpty())
        } finally { svc.setFilterQuery(""); ObservatorySettings.instance.state.overviewSort = oldSort; ObservatorySettings.instance.state.overviewActiveOnly = oldActive }
    }

    fun testSel1FailureReasonStaysAboveRows() {
        File(dir, "fail").writeText("fail")
        val entry = com.cellobservatory.observatory.model.SessionRow("local", "Local work", 1, current = false, edits = 0, pending = 0, files = 0)
        val popup = ReviewOps.chooseSessionPopup(project, listOf(entry))
        try {
            val list = UIUtil.findComponentOfType(popup.content, JList::class.java)!!
            fun labels() = (0 until list.model.size).map { list.model.getElementAt(it).toString() }
            val end = System.currentTimeMillis() + 8_000
            while (labels().none { it.contains("fixture connection refused") } && System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
            }
            val labels = labels()
            assertTrue(labels.toString(), labels.indexOfFirst { it.contains("fixture connection refused") } in 0 until labels.indexOfFirst { it.contains("Local work") })
        } finally { Disposer.dispose(popup) }
    }

    fun testSel1TimelineOrdersAllMachines() {
        val entries = (1..99).map { n -> com.cellobservatory.observatory.model.SessionRow("local-$n", "Local $n", -n.toLong(),
            current = n == 1, edits = 0, pending = 0, files = 0) }
        val indexed = com.cellobservatory.observatory.core.ObservatoryCli.syncedSessionsJson(project.basePath)?.let {
            com.cellobservatory.observatory.model.SessionsParser.parse(it)
        }!!
        val popup = com.cellobservatory.observatory.ui.TimelineSessionAction(project).sessionPopup(entries, "local-1", System.currentTimeMillis(), null, indexed.machines)
        try {
            val list = UIUtil.findComponentOfType(popup.content, JList::class.java)!!
            fun labels() = (0 until list.model.size).map { list.model.getElementAt(it).toString() }
            val end = System.currentTimeMillis() + 8_000
            while (labels().count { it.contains("Remote work") } < 2 && System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
            }
            val rows = labels()
            assertTrue(rows.toString(), rows.indexOfFirst { it.contains("Remote work") } < rows.indexOfFirst { it.contains("Local 1 ") })
            assertTrue(rows.toString(), rows.indexOfFirst { it.contains("Indexed synthetic") } in 0 until rows.indexOfFirst { it.contains("Remote work") })
        } finally { Disposer.dispose(popup) }
    }

}
