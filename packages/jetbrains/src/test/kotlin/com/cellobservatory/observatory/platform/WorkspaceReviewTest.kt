package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.ui.UIUtil
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

class WorkspaceReviewTest : ObservatoryPlatformTestCase() {
    private lateinit var dir: Path
    private var previousConfig: String? = null
    private var previousPath: Path? = null
    private var previousSession: String? = null
    private var previousGrouped = false
    private var previousCollapsed = mutableListOf<String>()
    private val notices = mutableListOf<String>()
    private var lifetime: com.intellij.openapi.Disposable? = null

    override fun setUp() {
        super.setUp()
        dir = Files.createTempDirectory("oak-workspace-review")
        val state = ObservatorySettings.instance.state
        previousConfig = state.configDir; previousPath = ClaudePaths.configDirOverride; previousSession = state.session
        previousGrouped = state.overviewGroupedNav; previousCollapsed = state.collapsedColumns.toMutableList()
        state.configDir = dir.toString(); ClaudePaths.configDirOverride = dir; state.session = null
        state.overviewGroupedNav = false; state.collapsedColumns = mutableListOf("fleet", "tasks")
        Files.createDirectories(Path.of(project.basePath!!))
        val file = dir.resolve("synthetic.kt"); Files.writeString(file, "new\n")
        val session = "synthetic-workspace"
        val hash = "a".repeat(64)
        Files.createDirectories(ClaudePaths.storeDir(session).resolve("blobs"))
        Files.writeString(ClaudePaths.blobPath(session, hash), "new\n")
        Files.writeString(ClaudePaths.logPath(session), """{"id":1,"ts":1,"tool":"Write","file":"$file","beforeBlob":null,"afterBlob":"$hash","status":"pending"}""" + "\n")
        Files.createDirectories(ClaudePaths.storeDir("synthetic-empty"))
        Files.writeString(ClaudePaths.logPath("synthetic-empty"), "")
        val transcripts = Files.createDirectories(ClaudePaths.projectDir(project.basePath!!))
        for (id in listOf(session, "synthetic-empty")) Files.writeString(transcripts.resolve("$id.jsonl"),
            """{"type":"user","cwd":"${project.basePath}","sessionId":"$id","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"Synthetic workspace request"}}""" + "\n")
        val check = com.cellobservatory.observatory.core.ObservatoryCli.run(listOf("review", "--no-patch", "--json", "--session", session), project.basePath)
        assertTrue("seeded review: ${check.stdout} ${check.stderr}", check.ok && com.cellobservatory.observatory.model.ReviewParser.parse(check.stdout) != null)
        project.messageBus.connect(testRootDisposable).subscribe(com.intellij.notification.Notifications.TOPIC, object : com.intellij.notification.Notifications {
            override fun notify(notification: com.intellij.notification.Notification) { notices.add(notification.content) }
        })
        val windows = ToolWindowManager.getInstance(project)
        for ((name, factory) in listOf("Observatory Traces" to ObservatoryToolWindowFactory(), "Observatory Timeline" to ObservatoryTimelineFactory(), "Observatory Dashboards" to ObservatoryDashboardsFactory())) {
            val window = windows.registerToolWindow(name) {}
            factory.createToolWindowContent(project, window)
        }
    }
    override fun tearDown() {
        try {
            lifetime?.let { Disposer.dispose(it) }
            FileEditorManager.getInstance(project).openFiles.filterIsInstance<ReviewAllVirtualFile>().forEach { FileEditorManager.getInstance(project).closeFile(it) }
            val state = ObservatorySettings.instance.state
            state.configDir = previousConfig; ClaudePaths.configDirOverride = previousPath; state.session = previousSession
            state.overviewGroupedNav = previousGrouped; state.collapsedColumns = previousCollapsed
            dir.toFile().deleteRecursively()
        } finally { super.tearDown() }
    }
    private fun pump(predicate: () -> Boolean) {
        val end = System.currentTimeMillis() + 10000
        while (!predicate() && System.currentTimeMillis() < end) { UIUtil.dispatchAllInvocationEvents(); Thread.sleep(10) }
        assertTrue("workspace handoff acted on: $notices", predicate())
    }
    private fun request(session: String = "synthetic-workspace", expires: Long = System.currentTimeMillis() + 600000): Path {
        val mailbox = Files.createDirectories(dir.resolve("editor-review"))
        val id = UUID.randomUUID()
        val file = mailbox.resolve("$id.json")
        Files.writeString(mailbox.resolve("$id.tmp"), """{"id":"$id","editor":"jetbrains","session":"$session","workspace":"${project.basePath}","action":"workspace","expiresAt":$expires}""")
        Files.move(mailbox.resolve("$id.tmp"), file)
        return file
    }
    private fun start() {
        val cls = RemoteEditorReview::class.java
        lifetime = cls.getMethod("start", com.intellij.openapi.project.Project::class.java).invoke(RemoteEditorReview, project) as? com.intellij.openapi.Disposable
    }
    private fun stacked() = FileEditorManager.getInstance(project).openFiles.filterIsInstance<ReviewAllVirtualFile>().singleOrNull()
    fun testActivationPinsAndOpensStackedAndGroupedDashboards() {
        request(); start()
        pump { stacked() != null && ObservatorySettings.instance.state.overviewGroupedNav }
        assertEquals("synthetic-workspace", ObservatorySettings.instance.state.session)
        val file = stacked()!!
        assertEquals(listOf(1), file.specs.map { it.rec.id })
        val provider = ReviewAllEditorProvider()
        assertTrue(provider.accept(project, file))
        val editor = provider.createEditor(project, file)
        try { assertTrue(editor is ReviewAllEditor) } finally { Disposer.dispose(editor) }
        assertFalse(ObservatorySettings.instance.state.collapsedColumns.contains("fleet"))
        assertFalse(ObservatorySettings.instance.state.collapsedColumns.contains("tasks"))
    }
    fun testRunningWindowWatchesAndConsumesOnce() {
        start(); request()
        pump { stacked() != null }
        val first = stacked(); RemoteEditorReview.consume(project)
        repeat(30) { UIUtil.dispatchAllInvocationEvents(); Thread.sleep(10) }
        assertSame(first, stacked())
        request(); pump { stacked() !== first }
    }
    fun testFocusFallbackAndEmptyAndExpired() {
        start()
        val mailbox = dir.resolve("editor-review")
        Files.deleteIfExists(mailbox) // invalidates the directory watch; focus must recover
        request("synthetic-empty")
        val frame = java.lang.reflect.Proxy.newProxyInstance(javaClass.classLoader, arrayOf(com.intellij.openapi.wm.IdeFrame::class.java)) { _, method, _ -> if (method.name == "getProject") project else null } as com.intellij.openapi.wm.IdeFrame
        ApplicationManager.getApplication().messageBus.syncPublisher(com.intellij.openapi.application.ApplicationActivationListener.TOPIC).applicationActivated(frame)
        pump { notices.any { it.contains("Nothing pending") } }
        assertNull(stacked()); assertEquals("synthetic-empty", ObservatorySettings.instance.state.session)
        request("synthetic-expired", 1)
        RemoteEditorReview.consume(project)
        repeat(30) { UIUtil.dispatchAllInvocationEvents(); Thread.sleep(10) }
        assertEquals("synthetic-empty", ObservatorySettings.instance.state.session)
    }
    fun testWorkspaceDispatchIncludesLayoutExactlyOnce() {
        val calls = mutableListOf<String>()
        val request = com.google.gson.JsonParser.parseString("""{"session":"synthetic","action":"workspace","prompt":"ignored"}""").asJsonObject
        val method = RemoteEditorReview::class.java.methods.first { it.name.startsWith("dispatch") && it.parameterCount == 6 }
        method.invoke(RemoteEditorReview, request, { s: String -> calls.add("pin:$s"); Unit }, { _: String, _: Int -> fail("edit") },
            { _: String, _: String -> fail("file") }, { s: String, prompt: String? -> calls.add("stacked:$s:$prompt"); Unit }, { calls.add("layout"); Unit })
        assertEquals(listOf("pin:synthetic", "stacked:synthetic:null", "layout"), calls)
    }
    fun testLayoutRevealsEveryPlacedWindowOnce() {
        val calls = mutableListOf<String>()
        val windows = ToolWindowManager.getInstance(project)
        val review = windows.getToolWindow("Observatory Traces")!!
        review.contentManager.setSelectedContent(review.contentManager.contents.last())
        val anchors = listOf("Observatory Traces", "Observatory Timeline", "Observatory Dashboards").map { windows.getToolWindow(it)!!.anchor }
        val activate: (String, Runnable?) -> Unit = { id, after -> calls.add(id); after?.run() }
        val terminal: () -> Unit = { calls.add("Terminal") }
        val method = RemoteEditorReview::class.java.methods.first { it.name.startsWith("revealWorkspace") && it.parameterCount == 3 }
        method.invoke(RemoteEditorReview, project, activate, terminal)
        assertEquals(listOf("Observatory Traces", "Terminal", "Observatory Timeline", "Observatory Dashboards"), calls)
        assertEquals("Review", review.contentManager.selectedContent?.displayName)
        assertEquals(anchors, listOf("Observatory Traces", "Observatory Timeline", "Observatory Dashboards").map { windows.getToolWindow(it)!!.anchor })
        assertTrue(ObservatorySettings.instance.state.overviewGroupedNav)
        assertFalse(ObservatorySettings.instance.state.collapsedColumns.contains("fleet"))
    }
    fun testTerminalReusesNamedTab() {
        val windows = ToolWindowManager.getInstance(project)
        val window = windows.registerToolWindow("Terminal") {}
        val cls = Class.forName("com.cellobservatory.observatory.ui.WorkspaceTerminal")
        val instance = cls.getConstructor(com.intellij.openapi.project.Project::class.java).newInstance(project)
        val open = cls.methods.single { it.name == "open" && it.parameterCount == 1 }
        var created = 0
        val create: (String, String?, String) -> Unit = { name, cwd, command ->
            assertEquals("OAK", name); assertEquals(project.basePath, cwd); assertEquals("oak", command)
            created++
            window.contentManager.addContent(com.intellij.ui.content.ContentFactory.getInstance().createContent(javax.swing.JPanel(), "OAK", false))
        }
        open.invoke(instance, create); open.invoke(instance, create)
        assertEquals(1, created); assertEquals("OAK", window.contentManager.selectedContent?.displayName)
    }
}
