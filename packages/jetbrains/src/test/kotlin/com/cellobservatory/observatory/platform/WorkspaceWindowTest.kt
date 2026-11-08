package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.ide.impl.OpenProjectTask
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.testFramework.PlatformTestUtil
import java.nio.file.Files
import java.nio.file.Path

class WorkspaceWindowTest : ObservatoryPlatformTestCase() {
    private fun checkWindow(folder: String?, machine: String?, exists: Boolean?, expected: String) {
        val dir = Files.createTempDirectory("oak-workspace-window").toFile()
        val row = """{"id":"synthetic","lastActiveMs":1,"workspacePath":${folder?.let { com.google.gson.Gson().toJson(it) } ?: "null"},"workspaceExists":$exists}"""
        val settings = ObservatorySettings.instance.state
        val previous = settings.observatoryBin
        val calls = mutableListOf<String>()
        val messages = mutableListOf<String>()
        val dialog = TestDialogManager.setTestDialog(TestDialog { messages.add(it); 0 })
        // A saved machine oak sync keeps answers a bare listing from the local index (`~/…` paths, no workspaceExists);
        // only a read naming the session is asked there (review 2026-11-05).
        settings.observatoryBin = java.io.File(dir, "oak").apply {
            writeText("""#!/bin/sh
printf '%s\n' "${'$'}*" >> '${dir.path}/calls'
case "${'$'}1 ${'$'}2" in
'machine list') echo '[{"label":"lab","target":"fixture@alias","enabled":true}]';;
'sessions --json') case "${'$'}*" in *'--session synthetic'*) echo '{"sessions":[$row]}';; *) echo '{"sessions":[{"id":"synthetic","lastActiveMs":1,"workspacePath":"~/work"}]}';; esac;;
'editor-review prepare') echo '{"workspace":${folder?.let { com.google.gson.Gson().toJson(it) } ?: "null"},"request":{}}';;
'editor-review info') echo '{"idePath":"/opt/idea backend"}';;
'editor-review connection') echo '{"host":"lab","user":"fixture","port":2222}';;
*) exit 1;;
esac
""")
            setExecutable(true)
        }.path
        try {
            project.basePath?.let { java.io.File(it).mkdirs() }
            val cls = Class.forName("com.cellobservatory.observatory.ui.WorkspaceWindow")
            val method = cls.methods.single { it.name == "open" && it.parameterCount == 5 }
            val session = SessionsParser.parse("""{"sessions":[$row]}""")!!.sessions.single()
            fun prepared() {
                val line = java.io.File(dir, "calls").readLines().last()
                assertTrue(line, line.startsWith("editor-review prepare ") && "--action workspace" in line && "--session synthetic" in line && "--editor jetbrains" in line)
                assertEquals(machine != null, "--machine" in line)
                if (machine != null) assertTrue(line.endsWith("--machine $machine"))
            }
            val local: (Path, OpenProjectTask) -> Unit = { path, task -> prepared(); calls.add("local:$path:${task.forceOpenInNewFrame}") }
            val remote: (String) -> Unit = { prepared(); calls.add(it) }
            method.invoke(cls.getField("INSTANCE").get(null), project, session, machine, local, remote)
            val end = System.currentTimeMillis() + 10000
            while (calls.isEmpty() && messages.isEmpty() && System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10)
            }
            assertTrue((calls + messages).toString(), (calls + messages).any { expected in it })
            if (expected == "no workspace" || expected == "missing or unavailable") assertTrue(calls.isEmpty())
        } finally {
            settings.observatoryBin = previous
            TestDialogManager.setTestDialog(dialog)
            dir.deleteRecursively()
        }
    }
    fun testLocalProjectNewWindow() {
        val dir = Files.createTempDirectory("oak-local-project")
        try { checkWindow(dir.toString(), null, true, "local:$dir:true") } finally { Files.delete(dir) }
    }
    fun testRemoteGateway() = checkWindow("/remote/project a", "lab", true,
        "jetbrains-gateway://connect#idePath=%2Fopt%2Fidea%20backend&projectPath=%2Fremote%2Fproject%20a&host=lab&port=2222&user=fixture&type=ssh&deploy=false")
    fun testMissingLocal() = checkWindow("/synthetic/missing", null, false, "missing or unavailable")
    fun testMissingRemote() = checkWindow("/remote/gone", "lab", false, "missing or unavailable")
    fun testNoWorkspace() = checkWindow(null, null, null, "no workspace")
}
