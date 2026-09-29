package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ObservatoryCli
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

/**
 * The batch must answer with EXACTLY what the individual command answers, and must degrade to individual
 * spawns against a CLI that has no `views`. Neither property is visible to a unit test of the parsers:
 * both are about how many processes we start and whether the answers survive being batched.
 */
class ViewBatchTest : BasePlatformTestCase() {

    private fun cliOnPath(): Boolean = runCatching {
        ProcessBuilder("oak", "--version").start().waitFor() == 0
    }.getOrDefault(false)

    fun testBatchedViewsMatchTheirOwnCommands() {
        if (!cliOnPath()) {
            println("SKIPPED ViewBatchTest: `oak` is not on PATH")
            return
        }
        val home = File(System.getProperty("java.io.tmpdir"), "obs-batch-home-${System.nanoTime()}")
        val work = File(System.getProperty("java.io.tmpdir"), "obs-batch-ws-${System.nanoTime()}")
        home.mkdirs(); work.mkdirs()
        fun cli(vararg args: String): String {
            val pb = ProcessBuilder(listOf("oak") + args).directory(work).redirectErrorStream(false)
            pb.environment()["HOME"] = home.absolutePath
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            p.waitFor()
            return out
        }
        try {
            cli("demo", "--fast")
            val session = Regex("demo-[0-9a-f]{8}").find(cli("sessions", "--json"))?.value
            assertNotNull("the replay produced a demo session to read", session)

            // Every view the batch serves, compared against the command it stands in for.
            val batched = cli("views", "--session", session!!, "--root", work.absolutePath, "--json")
            val obj = com.google.gson.JsonParser.parseString(batched).asJsonObject
            for (view in listOf("changemap", "prompts", "processes", "sessions", "risk", "egress")) {
                val single = cli(view, "--session", session, "--root", work.absolutePath, "--json").trim()
                assertTrue("$view answered on its own", single.isNotEmpty())
                val fromBatch = obj.get(view)
                assertNotNull("$view is present in the batch", fromBatch)
                assertEquals(
                    "$view: batching must not change the answer",
                    com.google.gson.JsonParser.parseString(single),
                    fromBatch,
                )
            }
        } finally {
            runCatching { cli("demo", "--clean") }
            home.deleteRecursively(); work.deleteRecursively()
        }
    }

    /**
     * The UN-BATCHED path must still answer. `sessionsJson(dir, null)` deliberately skips the batch —
     * the Switch-Session picker names no session, and building the other seven views to answer a list
     * would cost more than the list is worth — so this is the path a caller takes when the batch is not
     * available to it.
     *
     * The first version of this test asserted `out == null || out.contains("sessions")`. The `null` arm
     * satisfies it, so it passed on precisely the failure it claimed to guard, against a store that was
     * empty anyway. It now seeds a REAL store — via the `configDir` override, so the user's own
     * ~/.claude is never touched — and demands a payload naming the session it just created.
     */
    fun testTheUnbatchedPathStillAnswers() {
        if (!cliOnPath()) {
            println("SKIPPED ViewBatchTest: `oak` is not on PATH")
            return
        }
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        val prevCfg = settings.configDir
        val cfg = File(System.getProperty("java.io.tmpdir"), "obs-cfg-${System.nanoTime()}")
        val work = File(System.getProperty("java.io.tmpdir"), "obs-unbatched-ws-${System.nanoTime()}")
        cfg.mkdirs(); work.mkdirs()
        try {
            settings.configDir = cfg.absolutePath
            // A real replay through the real pipeline, into the throwaway config dir.
            val pb = ProcessBuilder("oak", "demo", "--fast").directory(work)
            pb.environment()["CLAUDE_CONFIG_DIR"] = cfg.absolutePath
            pb.redirectErrorStream(true)
            val p = pb.start(); p.inputStream.readBytes(); p.waitFor()

            val out = ObservatoryCli.sessionsJson(work.absolutePath, null)
            assertNotNull("the un-batched sessions path returned nothing at all", out)
            assertTrue("…and it names no demo session: $out", out!!.contains("demo-"))
        } finally {
            settings.configDir = prevCfg
            runCatching {
                val pb = ProcessBuilder("oak", "demo", "--clean").directory(work)
                pb.environment()["CLAUDE_CONFIG_DIR"] = cfg.absolutePath
                pb.start().waitFor()
            }
            work.deleteRecursively(); cfg.deleteRecursively()
        }
    }

}
