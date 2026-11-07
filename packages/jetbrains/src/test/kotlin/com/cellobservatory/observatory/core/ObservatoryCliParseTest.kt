package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port-fidelity for `undo/redo --json` (core's UndoResult): the CLI adds fields additively and this
 * plugin deserializes by name with silent fallbacks — these fixtures pin every field the conflict
 * dialogs branch on, so a TS-side rename cannot silently drop the named-dependent offer.
 */
class ObservatoryCliParseTest {

    @Test
    fun `parseUndo reads the named-dependent conflict payload`() {
        val json = """{"ok":false,"status":"conflict","message":"edit #4 overlaps later work: unit #5 depends on it. Undo both with `oak undo --ids 5,4`, or --force to restore the whole file.","dependents":[5],"closure":[5,4]}"""
        val r = ObservatoryCli.parseUndo(ObservatoryCli.CliResult(1, json, ""))
        assertFalse(r.ok)
        assertTrue(r.conflict)
        assertEquals(listOf(5), r.dependents)
        assertEquals(listOf(5, 4), r.closure)
    }

    @Test
    fun `parseUndo without the additive fields answers empty lists, not nulls`() {
        val r = ObservatoryCli.parseUndo(
            ObservatoryCli.CliResult(0, """{"ok":true,"status":"undone","message":"undid edit #1"}""", "")
        )
        assertTrue(r.ok)
        assertEquals("undone", r.status)
        assertEquals(emptyList<Int>(), r.dependents)
        assertEquals(emptyList<Int>(), r.closure)
    }

    @Test
    fun `a scope payload's unrecorded report is read by name, and its absence is null`() {
        // Files an undo/redo rewrote whose status the store could not record: the toast must carry the
        // CLI's sentence (the ids and the command that records them), never a plain success.
        val message = "reverted 2 edits on disk, but the store stayed busy for 10 s, so edits #3, #4 are not recorded as reverted."
        val payload = """{"undone":2,"conflicts":0,"errors":0,"total":2,"ids":[3,4],"unrecorded":{"ids":[3,4],"commands":["oak undo --ids 3,4 --record-only --session s"],"message":"$message"}}"""
        val parse = { s: String -> com.google.gson.JsonParser.parseString(s).asJsonObject }
        assertEquals(message, ObservatoryCli.unrecordedOf(parse(payload)))
        assertEquals(null, ObservatoryCli.unrecordedOf(parse("""{"undone":1,"conflicts":0,"total":1}""")))
        assertEquals(null, ObservatoryCli.unrecordedOf(parse("""{"unrecorded":"not an object"}""")))
    }

    @Test
    fun `garbage stdout answers a structured error, never a throw`() {
        val r = ObservatoryCli.parseUndo(ObservatoryCli.CliResult(1, "not json", "boom"))
        assertFalse(r.ok)
        assertEquals("error", r.status)
        assertEquals("boom", r.message)
    }

    /** The version chip compares this plugin's own build as well as the CLI's, as VS Code compares its
     *  extension and the CLI: a plugin behind (or above) the channel lights the dot with the CLI current. */
    @Test
    fun `the version chip compares the plugin as well as the CLI`() {
        val base = """"current":"0.11.0","channel":"stable","latest":"0.11.0","updateAvailable":false,"stranded":false,"stableLatest":"0.11.0","devLatest":null"""
        val behind = ObservatoryCli.parseVersionCheck("""{$base,"compared":{"version":"0.10.0","reason":"update available"}}""")!!
        assertEquals("update available", behind.pluginReason)
        assertEquals(null, behind.cliReason)
        assertTrue("a plugin behind the channel lights the dot", behind.anyDiffers)
        assertFalse(behind.anyStranded)
        val above = ObservatoryCli.parseVersionCheck("""{$base,"compared":{"version":"0.12.0-dev.1","reason":"not on this channel"}}""")!!
        assertTrue("…and so does one above it", above.anyDiffers)
        assertTrue("…which Update moves down onto the channel", above.anyStranded)
        val same = ObservatoryCli.parseVersionCheck("""{$base,"compared":{"version":"0.11.0","reason":"current"}}""")!!
        assertFalse("every surface on the channel: no dot", same.anyDiffers)
        // A CLI that predates --compare answers without `compared`: the plugin is unknown, the CLI still counts.
        val older = ObservatoryCli.parseVersionCheck("""{"current":"0.10.0","channel":"stable","latest":"0.11.0","updateAvailable":true,"stranded":false,"stableLatest":"0.11.0","devLatest":null}""")!!
        assertEquals(null, older.pluginReason)
        assertEquals("update available", older.cliReason)
        assertTrue(older.anyDiffers)
        assertEquals(null, older.linked)
        // A CLI linked to a checkout: `oak update` leaves it alone, so the row names the link and no dot lights.
        val linked = ObservatoryCli.parseVersionCheck("""{"current":"0.11.0-dev.0","channel":"dev","latest":"0.11.0-dev.15","updateAvailable":false,"stranded":false,"stableLatest":"0.10.0","devLatest":"0.11.0-dev.15","linked":"/src/oak","compared":{"version":"0.11.0-dev.15","reason":"current"}}""")!!
        assertEquals("/src/oak", linked.linked)
        assertEquals("linked to a checkout", linked.cliReason)
        assertFalse(linked.anyDiffers)
        // …and the copy `oak machine add` pushed, which `oak machine add` updates.
        val copied = ObservatoryCli.parseVersionCheck("""{"current":"0.11.0-dev.0","channel":"dev","latest":"0.11.0-dev.15","updateAvailable":false,"stranded":false,"stableLatest":"0.10.0","devLatest":"0.11.0-dev.15","provisioned":true}""")!!
        assertEquals("copied by oak machine add", copied.cliReason)
        assertFalse(copied.anyDiffers)
        assertFalse(older.provisioned)
        // A local build (dev.0, which no release carries), of the CLI or of this plugin: offered nothing, so no
        // dot lights, and its row says so (the Update row too, through anyLocal).
        val local = ObservatoryCli.parseVersionCheck("""{"current":"0.11.0-dev.0","channel":"dev","latest":"0.11.0-dev.15","updateAvailable":false,"stranded":false,"stableLatest":"0.10.0","devLatest":"0.11.0-dev.15","local":true,"compared":{"version":"0.11.0-dev.0","reason":"local build"}}""")!!
        assertEquals("local build", local.cliReason)
        assertEquals("local build", local.pluginReason)
        assertFalse(local.anyDiffers)
        assertFalse(local.anyStranded)
        assertTrue(local.anyLocal)
        val plugin = ObservatoryCli.parseVersionCheck("""{$base,"compared":{"version":"0.11.0-dev.0","reason":"local build"}}""")!!
        assertEquals(null, plugin.cliReason)
        assertTrue("the plugin alone is a local build", plugin.anyLocal)
        assertFalse(plugin.anyDiffers)
        assertFalse("control: a release is no local build", same.anyLocal)
        assertFalse(older.local)
    }

    @Test
    fun `an update marks only this IDE's plugin as pending a restart`() {
        val dir = java.nio.file.Files.createTempDirectory("oak-plugins").toFile()
        try {
            val mine = java.io.File(dir, "PyCharm2026.1").apply { mkdirs() }
            val other = java.io.File(dir, "IntelliJIdea2026.1").apply { mkdirs() }
            fun row(d: java.io.File?, to: String, reason: String) =
                ObservatoryCli.UpdateSurface("jetbrains", "JetBrains", "0.10.0", to, reason, d?.path)
            val cli = ObservatoryCli.UpdateSurface("cli", "CLI", "0.10.0", "0.11.0", "behind")
            // Another IDE's row first: it is not this IDE's, whatever its order.
            val plan = listOf(cli, row(other, "0.11.0-other", "behind"), row(mine, "0.11.0", "behind"))
            assertEquals("0.11.0", ObservatoryCli.thisIdeRow(plan, mine.path + "/../" + mine.name)?.to)
            // This IDE current while another moves: no restart here.
            assertEquals(null, ObservatoryCli.thisIdeRow(listOf(row(other, "0.11.0", "behind"), row(mine, "0.11.0", "current")), mine.path))
            // An IDE the CLI did not list: nothing of its own to move.
            assertEquals(null, ObservatoryCli.thisIdeRow(listOf(row(other, "0.11.0", "behind")), mine.path))
            // A CLI that names no folder: the first JetBrains row that needs work, as before.
            assertEquals("0.11.0-a", ObservatoryCli.thisIdeRow(listOf(cli, row(null, "0.11.0-a", "behind"), row(null, "0.11.0-b", "behind")), mine.path)?.to)
            // The build in this IDE's folder, whatever the row's reason; never another IDE's, and unknown when
            // no row names the folder.
            fun onDisk(d: java.io.File?, from: String, reason: String) = ObservatoryCli.UpdateSurface("jetbrains", "JetBrains", from, "0.11.0", reason, d?.path)
            assertEquals("0.11.0", ObservatoryCli.thisIdeSurface(listOf(cli, onDisk(other, "0.9.0", "behind"), onDisk(mine, "0.11.0", "current")), mine.path + "/../" + mine.name)?.from)
            // …and its row, whose reason says a local build there is left alone.
            assertEquals("local", ObservatoryCli.thisIdeSurface(listOf(cli, onDisk(other, "0.11.0", "current"), onDisk(mine, "0.11.0-dev.0", "local")), mine.path)?.reason)
            assertEquals(null, ObservatoryCli.thisIdeSurface(listOf(onDisk(other, "0.11.0", "current")), mine.path))
            assertEquals(null, ObservatoryCli.thisIdeSurface(listOf(onDisk(null, "0.11.0", "current")), mine.path))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `the update plan reads this machine's surfaces and the repairs left to the user, never a saved machine's`() {
        val dir = java.nio.file.Files.createTempDirectory("oak-plugins").toFile()
        try {
            val mine = java.io.File(dir, "PyCharm2026.1").apply { mkdirs() }
            fun jb(d: String, reason: String) = """{"surface":"jetbrains","label":"JetBrains","from":"0.10.0","to":"0.11.0","reason":"$reason","actionable":true,"pluginsDir":${com.google.gson.JsonPrimitive(d)}}"""
            // The shape `oak update --json` prints: components and machines beside the surfaces, and a
            // saved machine's own plan (with ITS JetBrains row, and its own repair left to the user) nested
            // inside its row.
            val repair = "/w/team/.claude/settings.json is missing Stop — run `oak init --repair` there"
            val json = """{"channel":"stable","following":"stable","switching":false,"target":"0.11.0","degradedToStable":false,
                "surfaces":[{"surface":"cli","label":"CLI","from":"0.11.0","to":"0.11.0","reason":"current","actionable":true},
                  {"surface":"vscode","label":"Cursor","from":"0.10.0","to":"0.11.0","reason":"managed","actionable":true},
                  ${jb(mine.path, "current")}],
                "components":[{"id":"hooks","label":"Claude Code capture hooks","state":"update","detail":"8 of 9 events"},
                  {"id":"project-hooks","label":"Claude Code project hooks","state":"manual","detail":${com.google.gson.JsonPrimitive(repair)}}],
                "machines":[{"label":"build-box","target":"me@build-box","state":"update","detail":"JetBrains 0.10.0 → 0.11.0",
                  "plan":{"surfaces":[${jb(mine.path, "behind")}],"components":[{"id":"project-hooks","label":"Claude Code project hooks","state":"manual","detail":"/there/.claude/settings.json is missing Stop — run `oak init --repair` there"}],"upToDate":false}}],
                "upToDate":false}"""
            val plan = ObservatoryCli.parseUpdatePlan(json)!!
            assertEquals(listOf("cli", "vscode", "jetbrains"), plan.surfaces.map { it.surface })
            assertEquals("managed", plan.surfaces[1].reason)
            assertEquals("this IDE is current; a saved machine's row with the same folder is not this IDE's", null, ObservatoryCli.thisIdeRow(plan.surfaces, mine.path))
            assertEquals("this machine's repair, named; never the saved machine's, nor a component the update does", listOf(repair), plan.manual)
            // A CLI older than the components: surfaces alone, nothing left to the user.
            assertEquals(emptyList<String>(), ObservatoryCli.parseUpdatePlan("""{"surfaces":[${jb(mine.path, "current")}]}""")!!.manual)
            assertEquals(null, ObservatoryCli.parseUpdatePlan("not json"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a permission prompt pops up only when notify says it is still up, or does not say`() {
        fun cli(code: Int, out: String) = ObservatoryCli.CliResult(code, out, "")
        assertFalse("answered during its wait", ObservatoryCli.handStillUp(cli(0, """{"sent":false,"stillUp":false}""")))
        assertTrue("still up, posted by another surface", ObservatoryCli.handStillUp(cli(0, """{"sent":false,"stillUp":true}""")))
        // A CLI older than the field never waited, and a run that failed answers nothing: the hand pops.
        assertTrue(ObservatoryCli.handStillUp(cli(0, """{"sent":true}""")))
        assertTrue(ObservatoryCli.handStillUp(cli(1, "")))
        assertTrue(ObservatoryCli.handStillUp(cli(0, "not json")))
    }

    @Test
    fun `a store move that stood carries its notes, and only those`() {
        // What `oak store --move` prints on stderr beside its success: the IDE said only "Store moved", so neither what the
        // removal of the original left behind nor the edits that could not wait for the move reached the reader.
        val stderr = "note: /old could not be removed in full (EACCES); what is left there was not moved\n" +
            "warning: a line the move did not write\n" +
            "note: 2 edits could not wait for the move and were not captured; each is recorded as a capture gap in its session\n" +
            "note:   \n"
        assertEquals(
            listOf(
                "/old could not be removed in full (EACCES); what is left there was not moved",
                "2 edits could not wait for the move and were not captured; each is recorded as a capture gap in its session",
            ),
            ObservatoryCli.storeMoveNotes(stderr),
        )
        assertEquals(emptyList<String>(), ObservatoryCli.storeMoveNotes(""))
    }

    @Test
    fun `a store move that failed is a refusal, except one that moved but could not be recorded`() {
        assertEquals("Store not moved — /x is not empty", ObservatoryCli.storeMoveFailure("oak: /x is not empty"))
        assertEquals(
            "The store moved to /x, but prefs.json could not record it, so OAK looks for it where it was: busy",
            ObservatoryCli.storeMoveFailure("oak: the store moved to /x, but prefs.json could not record it, so OAK looks for it where it was: busy"),
        )
    }
}
