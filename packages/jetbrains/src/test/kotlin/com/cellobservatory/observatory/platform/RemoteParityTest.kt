package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.actions.SearchConversationsAction
import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.ReviewParser
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.openapi.application.ApplicationManager
import com.intellij.testFramework.PlatformTestUtil
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

class RemoteParityTest : ObservatoryPlatformTestCase() {
    private lateinit var dir: File
    private var oldBin: String? = null
    override fun setUp() {
        super.setUp()
        dir = Files.createTempDirectory("oak-remote-parity").toFile()
        ClaudePaths.configDirOverride = dir.toPath()
        oldBin = ObservatorySettings.instance.state.observatoryBin
        ObservatorySettings.instance.state.observatoryBin = File(dir, "oak").apply {
            writeText("""#!/bin/sh
printf '%s | deadline=%s\n' "${'$'}*" "${'$'}OAK_MACHINE_TIMEOUT_MS" >> '${dir.path}/calls'
case "${'$'}1" in
machine) printf '[{"label":"lab-a"},{"label":"lab-b"},{"label":"disabled","enabled":false}]';;
search)
  machine=local
  case "${'$'}*" in *--machine\ lab-a*) machine=lab-a;; *--machine\ lab-b*) machine=lab-b;; esac
  touch '${dir.path}/started-'"${'$'}machine"
  n=0
  while [ ! -f '${dir.path}/started-local' ] || [ ! -f '${dir.path}/started-lab-a' ] || [ ! -f '${dir.path}/started-lab-b' ]; do
    n=${'$'}((n + 1)); [ "${'$'}n" -gt 200 ] && { echo 'searches were serialized' >&2; exit 1; }; sleep 0.01
  done
  [ "${'$'}machine" = lab-b ] && { echo offline >&2; exit 1; }
  printf '{"hits":[{"session":"same-id","snippet":"synthetic hit"}]}';;
prompt) sleep 0.1; if [ -f '${dir.path}/accept' ]; then printf '{"sent":true}'; else printf '{"sent":false,"reason":"agent blocked"}'; fi;;
views) printf '{}';;
sessions) printf '{"sessions":[]}';;
*) printf '{"kept":1,"cleared":1,"undone":1}';;
esac
""")
            setExecutable(true)
        }.path
        project.basePath?.let { File(it).mkdirs() }
    }
    override fun tearDown() {
        try {
            ObservatoryService.getInstance(project).remotePin = null
            ObservatorySettings.instance.state.observatoryBin = oldBin
            ClaudePaths.configDirOverride = null
            dir.deleteRecursively()
        } finally { super.tearDown() }
    }
    private fun waitFor(done: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!done() && System.currentTimeMillis() < end) { PlatformTestUtil.dispatchAllEventsInIdeEventQueue(); Thread.sleep(10) }
        assertTrue("background work completed", done())
    }
    private fun calls() = File(dir, "calls").takeIf { it.exists() }?.readLines().orEmpty()

    fun testSearchStartsEveryMachineBeforeWaitingAndOpensOnTheOwner() {
        val result = ApplicationManager.getApplication().executeOnPooledThread<ObservatoryCli.ConversationSearch> {
            ObservatoryCli.searchMachines("needle", project.basePath)
        }.get(15, TimeUnit.SECONDS)
        assertEquals(listOf(null, "lab-a"), result.hits.map { it.machine })
        assertTrue(result.errors.toString(), result.errors.single().contains("lab-b: offline"))
        assertFalse(calls().any { it.startsWith("search ") && it.contains("disabled") })
        assertTrue(calls().any { it.startsWith("search ") && it.contains("--machine lab-a") && it.endsWith("deadline=45000") })
        SearchConversationsAction().openHit(project, result.hits.last())
        assertEquals("lab-a", ObservatoryService.getInstance(project).currentMachine())
        assertEquals("same-id", ObservatoryService.getInstance(project).currentSession())
    }

    fun testContinuousReviewWaitsForActualResolutionAndStepsDisplayUnits() {
        fun review(status: String) = ReviewParser.parse("""{"units":[{"id":2,"members":[1,2],"file":"/remote/a","status":"$status"},{"id":4,"members":[3,4],"file":"/remote/b","status":"pending"}]}""")!!
        assertNull(ReviewOps.nextRemoteAfterResolve(review("pending"), 2))
        assertEquals(4, ReviewOps.nextRemoteAfterResolve(review("kept"), 2)?.id)
        assertEquals(4, ReviewOps.nextRemoteAfterResolve(review("undone"), 2)?.id)
    }
}
