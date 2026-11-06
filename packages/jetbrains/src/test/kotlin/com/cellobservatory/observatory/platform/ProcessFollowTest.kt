package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.testFramework.PlatformTestUtil
import java.nio.file.Files

class ProcessFollowTest : ObservatoryPlatformTestCase() {
    fun testProcessesFollowLiveOnBothMachines() {
        if (System.getProperty("os.name").startsWith("Windows")) return
        val dir = Files.createTempDirectory("oak-process-follow")
        val old = ObservatorySettings.instance.state.observatoryBin
        val calls = dir.resolve("calls").toFile()
        val snapshot = """{"processLogVersion":1,"ref":{"kind":"process","id":"shell-0"},"process":{"running":true},"title":"Build","mode":"live","running":true,"entries":[{"ts":0,"kind":"output","label":"APPENDED"}]}"""
        ObservatorySettings.instance.state.observatoryBin = dir.resolve("oak").toFile().apply {
            writeText("""#!/bin/sh
printf '%s %s\n' "${'$'}*" "${'$'}OAK_MACHINE_TIMEOUT_MS" >> '${calls.path}'
case "${'$'}*" in
  'processes --follow shell-0'*)
    printf '%s\n' '${snapshot.replace("APPENDED", "FIRST")}'
    sleep 0.2
    printf '%s\n' '$snapshot'
    ;;
  *) printf '{}';;
esac
""")
            setExecutable(true)
        }.path
        val service = ObservatoryService.getInstance(project)
        try {
            for (machine in listOf(null, "synthetic-box")) {
                val ref = ObservatoryService.FeedRef("parent", "process", "shell-0", machine = machine, cwd = dir.toString())
                val started = System.nanoTime()
                service.feed(ref, true)
                assertTrue("start must not block the EDT", (System.nanoTime() - started) / 1_000_000 < 150)
                val deadline = System.currentTimeMillis() + 8000
                var feed = service.feed(ref)
                while (feed?.entries?.lastOrNull()?.label != "APPENDED" && System.currentTimeMillis() < deadline) {
                    PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                    Thread.sleep(20)
                    feed = service.feed(ref)
                }
                assertEquals("APPENDED", feed?.entries?.lastOrNull()?.label)
                val request = calls.readLines().last { it.startsWith("processes ") }
                assertTrue(request, request.contains("--follow shell-0") && request.contains("--session parent"))
                if (machine != null) assertTrue(request, request.contains("--machine synthetic-box") && request.endsWith("45000") && !request.contains("--root"))
                else assertTrue(request, request.contains("--root $dir"))
            }
        } finally {
            service.selectedFeed = null
            ObservatorySettings.instance.state.observatoryBin = old
            dir.toFile().deleteRecursively()
        }
    }
}
