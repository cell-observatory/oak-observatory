package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.ui.ReviewPanel

class EditorRemotingTest : ObservatoryPlatformTestCase() {
    // Reflection lets this same behavioral test run against the pre-handoff plugin for the negative control.
    private fun remote(method: String, vararg args: Any?): Any? {
        val cls = Class.forName("com.cellobservatory.observatory.ui.RemoteEditorReview")
        return cls.methods.first { (it.name == method || it.name.startsWith(method + "$")) && it.parameterCount == args.size }
            .invoke(cls.getField("INSTANCE").get(null), *args)
    }
    fun testReviewHasNoReplyComposer() {
        val panel = ReviewPanel(project)
        fun names(c: java.awt.Container): List<String> = listOf(c.javaClass.simpleName) + c.components.filterIsInstance<java.awt.Container>().flatMap { names(it) }
        assertFalse(names(panel).toString(), names(panel).contains("ReplyComposer"))
    }
    fun testGatewayDocumentedLinkAndFallback() {
        val cls = Class.forName("com.cellobservatory.observatory.ui.RemoteEditorReview")
        val instance = cls.getField("INSTANCE").get(null)
        val method = cls.getMethod("gatewayLink", String::class.java, String::class.java, Int::class.javaPrimitiveType, String::class.java, String::class.java)
        val link = method.invoke(instance, "lab-a", "fixture", 2222, "/opt/idea backend", "/home/fixture/project a") as String
        assertEquals("jetbrains-gateway://connect#idePath=%2Fopt%2Fidea%20backend&projectPath=%2Fhome%2Ffixture%2Fproject%20a&host=lab-a&port=2222&user=fixture&type=ssh&deploy=false", link)
        assertNull(method.invoke(instance, "lab-a", "fixture", 22, null, "/home/fixture/project"))
        val fallback = cls.getMethod("fallback", String::class.java, String::class.java, String::class.java).invoke(instance, "lab-a", "/home/fixture/project", "synthetic").toString()
        assertTrue(fallback, fallback.contains("Remote Development") && fallback.contains("SSH") && fallback.contains("/home/fixture/project") && fallback.contains("synthetic"))
    }

    fun testNativeDiffUsesBothRemoteSides() {
        val method = com.cellobservatory.observatory.ui.Diffs.javaClass.getMethod("remoteRequest", com.intellij.openapi.project.Project::class.java, String::class.java, Int::class.javaPrimitiveType, String::class.java)
        val r = method.invoke(com.cellobservatory.observatory.ui.Diffs, project, "lab-a", 7,
            """{"file":"/remote/a.kt","before":"old","after":"new","patch":"patch"}""") as com.intellij.diff.requests.SimpleDiffRequest
        assertEquals("old", (r.contents[0] as com.intellij.diff.contents.DocumentContent).document.text)
        assertEquals("new", (r.contents[1] as com.intellij.diff.contents.DocumentContent).document.text)
        assertNull(method.invoke(com.cellobservatory.observatory.ui.Diffs, project, "lab-a", 7, """{"patch":"patch"}"""))
    }
    fun testReceiverDispatchesToTheRequestedSession() {
        for (action in listOf("edit", "file", "all")) {
            val calls = mutableListOf<String>()
            val r = com.google.gson.JsonParser.parseString("""{"session":"synthetic","action":"$action","edit":7,"file":"/remote/a.kt","prompt":"ask-2"}""").asJsonObject
            remote("dispatch", r,
                { s: String -> calls.add("select:$s"); Unit }, { s: String, id: Int -> calls.add("edit:$s:$id"); Unit },
                { s: String, file: String -> calls.add("file:$s:$file"); Unit }, { s: String, prompt: String? -> calls.add("all:$s:$prompt"); Unit }, { Unit })
            assertEquals("select:synthetic", calls.first())
            assertEquals(2, calls.size)
            assertEquals(when(action) { "edit" -> "edit:synthetic:7"; "file" -> "file:synthetic:/remote/a.kt"; else -> "all:synthetic:ask-2" }, calls.last())
        }
    }
    fun testGatewayFallbackAfterWritingRequestOnTheSavedMachine() {
        val dir = java.nio.file.Files.createTempDirectory("oak-gateway-fake").toFile()
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        val oldBin = settings.observatoryBin
        val messages = mutableListOf<String>()
        val oldDialog = com.intellij.openapi.ui.TestDialogManager.setTestDialog(com.intellij.openapi.ui.TestDialog { message -> messages.add(message); 0 })
        settings.observatoryBin = java.io.File(dir, "oak").apply {
            writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${dir.path}/calls'
case "${'$'}1 ${'$'}2" in
'machine list') echo '[{"label":"lab-a","target":"fixture@alias","enabled":true}]';;
'editor-review info') echo '{"workspace":"/home/fixture/project","installed":true,"idePath":null}';;
'editor-review connection') echo '{"host":"lab-a","user":"fixture","port":2222}';;
'review --no-patch') echo '{"units":[]}';;
*) echo '{}';;
esac
""")
            setExecutable(true)
        }.path
        try {
            project.basePath?.let { java.io.File(it).mkdirs() }
            remote("open", project, "lab-a", "synthetic", 7, null, false, null)
            val end = System.currentTimeMillis() + 10000
            while (messages.isEmpty() && System.currentTimeMillis() < end) {
                com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
            }
            assertTrue(messages.toString(), messages.any { "link could not be built" in it && "fixture@alias" in it && "/home/fixture/project" in it && "SSH" in it })
            val calls = java.io.File(dir, "calls").readLines()
            assertTrue(calls.toString(), calls.any { it.startsWith("editor-review prepare ") && "--session synthetic" in it && "--edit 7" in it && it.endsWith("--machine lab-a") })
        } finally {
            settings.observatoryBin = oldBin
            com.intellij.openapi.ui.TestDialogManager.setTestDialog(oldDialog)
            dir.deleteRecursively()
        }
    }

    fun testMountedFileKeepsRemoteIdentityAndLocatesAgainstThatMachine() {
        val dir = java.nio.file.Files.createTempDirectory("oak-mounted-fake").toFile()
        val file = java.io.File(dir, "mapped.kt").apply { writeText("\nnew\n") }
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        val oldBin = settings.observatoryBin
        val service = com.cellobservatory.observatory.services.ObservatoryService.getInstance(project)
        settings.observatoryBin = java.io.File(dir, "oak").apply {
            writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${dir.path}/calls'
case "${'$'}1 ${'$'}2" in
'machine list') echo '[{"label":"lab-a","target":"fixture@alias","enabled":true}]';;
'editor-review info') echo '{"workspace":"/home/fixture/project","installed":false,"file":"/home/fixture/project/a.kt"}';;
'editor-review map') echo '{"file":"${file.path}"}';;
'review --no-patch') echo '{"units":[{"id":8,"file":"/home/fixture/project/a.kt","members":[7,8],"status":"pending"}]}';;
*) case "${'$'}1" in
views) echo '{"review":{"units":[{"id":7,"file":"/home/fixture/project/a.kt","members":[7],"status":"pending"}]},"tree":{"folders":[],"files":[]},"timeline":{"edits":[{"id":7,"ts":1,"tool":"Edit","file":"/home/fixture/project/a.kt","beforeBlob":null,"afterBlob":null,"status":"pending"}]}}';;
locate) cat > '${dir.path}/buffer'; echo '{"placements":[{"id":7,"lines":[1],"removed":[]}]}';;
*) echo '{}';;
esac;;
esac
""")
            setExecutable(true)
        }.path
        try {
            project.basePath?.let { java.io.File(it).mkdirs() }
            remote("open", project, "lab-a", "synthetic", 7, null, false, null)
            val end = System.currentTimeMillis() + 10000
            while (remote("mountedFile", project, file.path) == null && System.currentTimeMillis() < end) {
                com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
            }
            assertEquals("/home/fixture/project/a.kt", remote("fileKey", project, file.path))
            assertNull(remote("fileKey", project, "/home/fixture/project/a.kt"))
            val cache = com.cellobservatory.observatory.services.PlacementsCache.getInstance(project)
            var placements: List<com.cellobservatory.observatory.model.Placement>? = null
            while (placements.isNullOrEmpty() && System.currentTimeMillis() < end) {
                service.remoteReview()
                placements = cache.placementsFor(file.path, "\nnew\n", "1")
                com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
            }
            assertEquals(java.io.File(dir, "calls").readText(), listOf(1), placements?.firstOrNull()?.lines)
            val opened = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).selectedTextEditor
            assertEquals("chosen raw history edit opens at its mapped line", 1, opened?.caretModel?.logicalPosition?.line)
            val calls = java.io.File(dir, "calls").readLines()
            assertTrue(calls.toString(), calls.any { it.startsWith("locate --file /home/fixture/project/a.kt") && it.endsWith("--machine lab-a") })
            assertFalse(calls.toString(), calls.any { it.startsWith("editor-review prepare") || it.startsWith("install-extensions") })
            assertEquals("\nnew\n", file.readText())
        } finally {
            service.remotePin = null
            settings.observatoryBin = oldBin
            dir.deleteRecursively()
        }
    }
}
