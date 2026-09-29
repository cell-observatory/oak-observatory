package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.tour.TourController
import com.intellij.openapi.application.ApplicationManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

/**
 * Drives the REAL demo and the REAL guided tour inside a headless IDE — replay, every step, the actions a
 * step performs, and teardown — so the interactive feature can be verified without a human at a screen.
 *
 * It runs the actual `oak` CLI against a throwaway HOME, so the store, the transcripts and
 * the tour script are all genuine; nothing here is a stub. Skipped (not failed) when the CLI is not on
 * PATH, because that is an environment fact, not a defect — but it says so loudly rather than passing
 * silently, since a test that quietly tests nothing is worse than no test.
 */
class DemoTourDriveTest : BasePlatformTestCase() {

    private lateinit var home: File
    private lateinit var work: File
    private var prevHome: String? = null

    private fun cliOnPath(): Boolean = runCatching {
        ProcessBuilder("oak", "--version").start().waitFor() == 0
    }.getOrDefault(false)

    override fun setUp() {
        super.setUp()
        home = File(System.getProperty("java.io.tmpdir"), "obs-uitest-home-${System.nanoTime()}")
        work = File(System.getProperty("java.io.tmpdir"), "obs-uitest-ws-${System.nanoTime()}")
        home.mkdirs(); work.mkdirs()
    }

    override fun tearDown() {
        try {
            if (work.isDirectory) runCatching {
                ProcessBuilder("oak", "demo", "--clean").directory(work)
                    .also { it.environment()["HOME"] = home.absolutePath }.start().waitFor()
            }
            home.deleteRecursively(); work.deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    /** The whole interactive path: replay a demo, walk every tour step, and confirm nothing throws and
     *  each step actually resolves the control it names. */
    fun testTheTourWalksEveryStepAgainstARealDemo() {
        if (!cliOnPath()) {
            println("SKIPPED DemoTourDriveTest: `oak` is not on PATH in this environment")
            return
        }
        // The script itself comes from core, over the CLI — the same list both editors render.
        val steps = ObservatoryCli.demoTour(work.absolutePath, essentials = false)
        assertTrue("the CLI returned a tour script", steps.isNotEmpty())

        val tour = TourController.getInstance(project)
        // Walk EVERY step for real. Any step that throws — an unrecognized view, an anchor resolving
        // against a component that is not there, an action with no session behind it — fails here, which
        // is the whole point: this is the only test in the repo that executes the tour's own code.
        ApplicationManager.getApplication().invokeAndWait { tour.driveForTest(steps) }
        assertTrue("the tour is running after being driven", tour.running)
        // NOTE — what this test cannot see: `BasePlatformTestCase` registers NONE of the plugin's
        // declared tool windows (verified: all three come back null here), so whether the tour's window
        // actually appears is beyond it. `running` is only an index, so everything below would pass with
        // nothing on screen. That gap is covered instead by making the controller SAY so when it cannot
        // open its window, rather than running invisibly — see TourController.ensureToolWindow.
        for (i in 1 until steps.size) {
            ApplicationManager.getApplication().invokeAndWait { tour.next() }
            assertTrue("still running at step ${i + 1}/${steps.size} (${steps[i].id})", tour.running)
        }
        // Past the last step the tour finishes rather than throwing or wrapping.
        ApplicationManager.getApplication().invokeAndWait { tour.next() }
        assertFalse("the tour ended after its last step", tour.running)
    }

    /** The demo's own contract: a replay leaves a demo session, and `--clean` removes every trace. */
    fun testDemoReplayAndCleanupAreCompleteFromInsideTheIde() {
        if (!cliOnPath()) {
            println("SKIPPED DemoTourDriveTest: `oak` is not on PATH in this environment")
            return
        }
        fun cli(vararg args: String): String {
            val pb = ProcessBuilder(listOf("oak") + args).directory(work).redirectErrorStream(true)
            pb.environment()["HOME"] = home.absolutePath
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            p.waitFor()
            return out
        }
        cli("demo", "--fast")
        assertTrue("the replay seeded and marked its workspace",
            File(work, "observatory-demo/.observatory-demo").exists())
        val sessions = cli("sessions", "--json")
        assertTrue("a demo session is recorded", sessions.contains("demo-"))
        cli("demo", "--clean")
        assertFalse("clean removed the demo workspace", File(work, "observatory-demo").exists())
        assertFalse("clean removed the demo session", cli("sessions", "--json").contains("demo-"))
    }
}
