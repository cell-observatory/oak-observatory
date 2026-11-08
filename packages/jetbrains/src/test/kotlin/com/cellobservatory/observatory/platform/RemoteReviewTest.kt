package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.testFramework.PlatformTestUtil
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

class RemoteReviewTest : ObservatoryPlatformTestCase() {
    private lateinit var dir: File
    private var oldBin: String? = null
    private var oldDialog: com.intellij.openapi.ui.TestDialog? = null
    override fun setUp() {
        super.setUp()
        oldDialog = com.intellij.openapi.ui.TestDialogManager.setTestDialog(com.intellij.openapi.ui.TestDialog { 0 })
        dir = Files.createTempDirectory("oak-remote-review").toFile()
        ClaudePaths.configDirOverride = dir.toPath()
        oldBin = ObservatorySettings.instance.state.observatoryBin
        ObservatorySettings.instance.state.observatoryBin = File(dir, "oak").apply {
            writeText("""#!/bin/sh
printf '%s | deadline=%s\n' "${'$'}*" "${'$'}OAK_MACHINE_TIMEOUT_MS" >> '${dir.path}/calls'
case "${'$'}1" in
machine) printf '[]';;
query) exit 1;;
views) printf '{"prompts":{"source":"%s","prompts":[]},"changemap":{},"multitask":{},"processes":{},"observations":{},"risk":{},"egress":{}}' "${'$'}*";;
sessions) printf '{"sessions":[]}';;
*) printf '{"kept":1,"cleared":1,"text":"reply from remote","sent":true,"entries":[],"ref":{"kind":"session"}}';;
esac
""")
            setExecutable(true)
        }.path
        project.basePath?.let { File(it).mkdirs() }
        ObservatoryCli.invalidateViewBatch()
    }
    override fun tearDown() {
        try {
            com.intellij.openapi.ui.TestDialogManager.setTestDialog(oldDialog)
            ObservatoryService.getInstance(project).remotePin = null
            ObservatorySettings.instance.state.observatoryBin = oldBin
            ClaudePaths.configDirOverride = null
            ObservatoryCli.invalidateViewBatch()
            dir.deleteRecursively()
        } finally { super.tearDown() }
    }
    private fun <T> offEdt(f: () -> T): T = com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread<T> { f() }.get(30, TimeUnit.SECONDS)
    private fun calls() = File(dir, "calls").takeIf { it.exists() }?.readLines().orEmpty()

    fun testReviewTreeListsRemoteEdits() {
        val service = ObservatoryService.getInstance(project)
        val units = (1..3000).joinToString(",") { """{"id":$it,"members":[$it],"file":"/remote/f$it.ts","rel":"f$it.ts","tool":"Edit","status":"pending","ts":1,"added":1,"removed":0}""" }
        val files = (1..3000).joinToString(",") { """{"file":"/remote/f$it.ts","rel":"f$it.ts","classes":[],"loose":[{"id":$it,"file":"/remote/f$it.ts","tool":"Edit","status":"pending","ts":1,"added":1,"removed":0,"beforeBlob":null,"afterBlob":null}]}""" }
        File(dir, "payload").writeText("""{"review":{"session":"same-id","units":[$units],"ids":[${(1..3000).joinToString(",")}],"summary":{"units":3000,"pending":3000}},"tree":{"folders":[],"files":[$files]},"timeline":{"edits":[$units]}}""")
        File(dir, "oak").writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${dir.path}/calls'
[ "${'$'}1" = diff ] && { echo 'synthetic patch unavailable' >&2; exit 1; }
[ -f '${dir.path}/fail' ] && { echo 'ssh: Connection refused' >&2; exit 255; }
case "${'$'}*" in
"machine list --json") printf '[{"label":"lab-a","target":"fixture@lab-a","enabled":true}]';;
editor-review*) echo 'synthetic editor handoff unavailable' >&2; exit 1;;
*--machine*) cat '${dir.path}/payload';;
*) printf '{}';;
esac
""")
        service.remotePin = ObservatoryService.RemotePin("same-id", "lab-a")
        val start = System.nanoTime()
        val panel = com.cellobservatory.observatory.ui.ReviewPanel(project)
        val end = System.currentTimeMillis() + 10_000
        while (service.editTree()?.files?.size != 3000 && System.currentTimeMillis() < end) {
            panel.refresh(); PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
        }
        assertEquals("remote tree populated: ${calls()}", 3000, service.editTree()?.files?.size)
        assertEquals("remote keyboard loop reaches a Review unit", 1, service.nextPendingEdit()?.id)
        assertEquals(2, service.nextPendingEdit()?.id)
        assertEquals(1, service.prevPendingEdit()?.id)
        service.selectRemoteReviewFile("/remote/f1.ts")
        val nav = com.cellobservatory.observatory.ui.ReviewNavBar(project)
        nav.navFile(1)
        val navEnd = System.currentTimeMillis() + 10_000
        while (calls().none { it.startsWith("editor-review info ") } && System.currentTimeMillis() < navEnd) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
        }
        assertEquals("/remote/f10.ts", service.selectedRemoteReviewFile())
        assertTrue(calls().toString(), calls().any { it.startsWith("editor-review info ") && it.contains("--edit 10") && it.endsWith("--machine lab-a") })
        nav.navFile(-1)
        assertEquals("/remote/f1.ts", service.selectedRemoteReviewFile())
        panel.refresh()
        val editsPanel = panel.javaClass.getDeclaredField("tree").apply { isAccessible = true }.get(panel)
        val tree = editsPanel.javaClass.getDeclaredField("tree").apply { isAccessible = true }.get(editsPanel) as javax.swing.JTree
        assertEquals(3000, (tree.model.root as javax.swing.tree.DefaultMutableTreeNode).childCount)
        fun paint() {
            panel.setSize(600, 900)
            fun layout(c: java.awt.Container) { c.doLayout(); c.components.filterIsInstance<java.awt.Container>().forEach { layout(it) } }
            layout(panel)
            val image = java.awt.image.BufferedImage(600, 900, java.awt.image.BufferedImage.TYPE_INT_ARGB)
            val graphics = image.createGraphics()
            try { panel.paint(graphics) } finally { graphics.dispose() }
        }
        paint()
        println("RV1 JetBrains first paint 3000: ${(System.nanoTime() - start) / 1_000_000.0} ms")
        val refreshStart = System.nanoTime()
        val success = service.remoteReview()!!.lastSuccess
        service.refresh(force = true)
        val until = System.currentTimeMillis() + 10_000
        while (service.remoteReview()?.lastSuccess == success && System.currentTimeMillis() < until) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
        }
        panel.refresh(); paint()
        assertEquals(3000, (tree.model.root as javax.swing.tree.DefaultMutableTreeNode).childCount)
        println("RV1 JetBrains refresh paint 3000: ${(System.nanoTime() - refreshStart) / 1_000_000.0} ms")
        service.selectRemoteReviewFile("/remote/f1.ts")
        val history = com.cellobservatory.observatory.ui.FileHistoryPanel(project)
        history.rebuild()
        val historyRoot = history.javaClass.getDeclaredField("root").apply { isAccessible = true }.get(history) as javax.swing.tree.DefaultMutableTreeNode
        assertEquals(1, historyRoot.childCount)
        assertEquals(1, (historyRoot.getChildAt(0) as javax.swing.tree.DefaultMutableTreeNode).userObject.let { it as com.cellobservatory.observatory.model.EditRecord }.id)
        File(dir, "fail").writeText("fail")
        service.refresh(force = true)
        val failEnd = System.currentTimeMillis() + 10_000
        while (service.remoteReview()?.error == null && System.currentTimeMillis() < failEnd) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
        }
        panel.refresh()
        assertTrue(service.remoteReview()?.error.orEmpty().contains("Connection refused"))
        assertTrue(service.remoteReview()!!.lastSuccess > 0)
        assertEquals(0, (tree.model.root as javax.swing.tree.DefaultMutableTreeNode).childCount)
        val head = panel.javaClass.getDeclaredField("head").apply { isAccessible = true }.get(panel) as javax.swing.JLabel
        assertTrue(head.text, head.text.contains("last successful read:"))
    }

    fun testRemoteReviewActionsAndOpeningNeverUseLocalFiles() {
        val service = ObservatoryService.getInstance(project)
        service.remotePin = ObservatoryService.RemotePin("same-id", "lab-a")
        val file = File(dir, "same-path.txt").apply { writeText("LOCAL MUST STAY") }
        val rec = com.cellobservatory.observatory.model.EditRecord(7, 1, "Edit", file.path, null, null, "pending")
        val asked = mutableListOf<String>()
        val previous = com.intellij.openapi.ui.TestDialogManager.setTestDialog(com.intellij.openapi.ui.TestDialog { message -> asked.add(message); com.intellij.openapi.ui.Messages.YES })
        try {
            ReviewOps.keepAll(project, "same-id", listOf(rec), "selected file")
            ReviewOps.undoOrRedo(project, "same-id", rec, false)
            ReviewOps.undoOrRedo(project, "same-id", rec.copy(status = "undone"), true)
            ReviewOps.undoAll(project, "same-id", listOf(rec), "file", file.path)
            ReviewOps.redoAll(project, "same-id", listOf(rec.copy(status = "undone")), "file", file.path)
            ReviewOps.remoteVerb(project, "same-id", "resolve", emptyList())
        } finally { com.intellij.openapi.ui.TestDialogManager.setTestDialog(previous) }
        val end = System.currentTimeMillis() + 10_000
        while (calls().count { it.startsWith("keep ") || it.startsWith("undo ") || it.startsWith("redo ") || it.startsWith("resolve ") } < 6 && System.currentTimeMillis() < end) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
        }
        val verbs = calls().filter { it.startsWith("keep ") || it.startsWith("undo ") || it.startsWith("redo ") || it.startsWith("resolve ") }
        assertEquals(6, verbs.size)
        assertTrue(verbs.toString(), verbs.all { "--machine lab-a" in it && "deadline=45000" in it })
        assertTrue(asked.toString(), asked.all { "on lab-a" in it })
        assertEquals("LOCAL MUST STAY", file.readText())
        // A failed patch read exercises the opening guard without opening a modal viewer in this headless IDE.
        File(dir, "oak").writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${dir.path}/calls'
echo 'remote patch unavailable' >&2
exit 1
""")
        com.cellobservatory.observatory.ui.Diffs.show(project, "same-id", rec)
        val diffEnd = System.currentTimeMillis() + 10_000
        while (calls().none { it.startsWith("diff 7 ") } && System.currentTimeMillis() < diffEnd) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
        }
        assertTrue(calls().toString(), calls().any { it == "diff 7 --contents --json --session same-id --machine lab-a" })
        assertEquals("LOCAL MUST STAY", file.readText())
    }

    fun testReadsAndReviewVerbsRouteToTheCapturedMachineAndCachesDoNotCrossHosts() {
        val first = offEdt { ObservatoryCli.onMachine("lab-a") { ObservatoryCli.promptsJson("same-id", project.basePath) } }
        val second = offEdt { ObservatoryCli.onMachine("lab-b") { ObservatoryCli.promptsJson("same-id", project.basePath) } }
        assertTrue("${first.orEmpty()} calls=${calls()}", first.orEmpty().contains("--machine lab-a"))
        assertTrue("${second.orEmpty()} calls=${calls()}", second.orEmpty().contains("--machine lab-b"))
        offEdt {
            ObservatoryCli.onMachine("lab-a") {
                ObservatoryCli.feedJson("same-id", "session", "", 60, project.basePath)
                ObservatoryCli.promptResponseJson("same-id", "p1", project.basePath)
                ObservatoryCli.observationsJson("same-id", project.basePath)
                ObservatoryCli.multitaskJson("same-id", project.basePath)
                ObservatoryCli.changemapJson("same-id", project.basePath)
                ObservatoryCli.taskKeep("same-id", "task-1", project.basePath)
                ObservatoryCli.taskUndo("same-id", "task-1", project.basePath)
                ObservatoryCli.taskClear("same-id", "task-1", project.basePath)
                ObservatoryCli.taskClearCompleted("same-id", project.basePath)
                ObservatoryCli.keep("same-id", 7, project.basePath)
                ObservatoryCli.undoScope("same-id", null, project.basePath)
                ObservatoryCli.resolveSession("same-id", project.basePath)
                ObservatoryCli.commentAdd("same-id", project.basePath, 7, 2, "Check boundary")
                ObservatoryCli.quoteLastReply("same-id", project.basePath)
                ObservatoryCli.prompt("same-id", "Please check", project.basePath, listOf("c1"))
                ObservatoryCli.run(listOf("diff", "7", "--patch", "--session", "same-id"), project.basePath)
            }
            ObservatoryCli.invalidateViewBatch()
            ObservatoryCli.promptsJson("same-id", dir.path)
        }
        val remote = calls().filter { it.contains("--machine") }
        assertTrue(remote.toString(), listOf("task-keep", "task-undo", "task-clear", "views", "feed", "prompts", "keep", "undo", "resolve", "comment", "quote", "prompt", "diff").all { verb -> remote.any { it.startsWith("$verb ") } })
        assertTrue(remote.toString(), remote.any { it.startsWith("comment mark-sent --ids c1 ") })
        assertTrue(remote.toString(), remote.all { !it.contains("--root") && it.endsWith("deadline=45000") })
        assertTrue("local cache remains local: ${calls()}", calls().any { it.startsWith("views ") && !it.contains("--machine") })
    }

    fun testRemotePinSurvivesAbsentLocalStoreAndAsyncActionKeepsItsOriginalHost() {
        val service = ObservatoryService.getInstance(project)
        ReviewOps.applyRemoteSessionChoice(project, "lab-a", "same-id")
        assertEquals("same-id", service.currentSession())
        assertEquals("lab-a", service.currentMachine())
        assertTrue("remote review must not read a local log", service.log().isEmpty())
        service.prompts(true)
        ReviewOps.keep(project, "same-id", 42, advance = false)
        ReviewOps.applyRemoteSessionChoice(project, "lab-b", "same-id")
        val end = System.currentTimeMillis() + 10_000
        while (calls().none { it.startsWith("keep 42 ") } && System.currentTimeMillis() < end) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(20)
        }
        assertTrue(calls().toString(), calls().any { it.startsWith("keep 42 ") && it.contains("--machine lab-a") })
        ReviewOps.applySessionChoice(project, null)
        assertNull(service.currentMachine())
    }
    fun testFeedIdentityChangesWhenTheSameSessionIdMovesToAnotherSelectedMachine() {
        val service = ObservatoryService.getInstance(project)
        val panel = com.cellobservatory.observatory.ui.FeedPanel(project)
        val key = panel.javaClass.getDeclaredField("subjectKey").apply { isAccessible = true }
        service.remotePin = ObservatoryService.RemotePin("same-id", "lab-a")
        panel.refresh()
        val first = key.get(panel)
        service.remotePin = ObservatoryService.RemotePin("same-id", "lab-b")
        panel.refresh()
        assertFalse("the old host's rendered feed must be retired", first == key.get(panel))
        assertTrue(key.get(panel).toString(), key.get(panel).toString().contains("lab-b"))
    }

}
