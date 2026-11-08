package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `oak sync`'s answers as this plugin reads them: its status (`sync status --json`), a run (`sync now --json`) and setup
 * (`sync setup --json`), each in the CLI's shape (synthetic values), and the words the surfaces show for them. The platform
 * test (SyncSurfaceTest) drives the same through this tree's CLI.
 */
class SyncModelTest {
    private val at = System.currentTimeMillis() - 30_000

    private fun status(last: String = "null", backup: String = "null", conflicts: String = "[]", key: String = """{"present":false}""", setUp: Boolean = true, running: Boolean = false) =
        """{"syncStatus":1,"setUp":$setUp,"auto":true,"running":$running,"last":$last,"backup":$backup,"placements":{},"exclude":{"machines":["old-box"],"projects":["git:github.com/u/r"]},
            "conflicts":$conflicts,"index":[],"cache":{"files":0,"bytes":0,"capMB":2048},"key":$key}"""

    private val oneConflict = """[{"id":"c0ffee000001","family":"plans","name":"m.md","from":"build-box","host":"h1","at":$at,"peerSha256":null,"peerSize":11,
        "copy":"/h/.claude/claude-observatory/sync/conflicts/build-box/plans/m.md","localSha256":null,"reason":"overlap","file":"/h/.claude/plans/m.md"}]"""

    @Test
    fun `a machine that never chose to sync is shown nothing, and anything but a status reads as null`() {
        val v = SyncStatusParser.parse(status(setUp = false))!!
        assertFalse("no run, no backup, no conflict: not in use", v.inUse)
        assertTrue("a backup chosen is in use before any run", SyncStatusParser.parse(status(setUp = false, backup = """{"kind":"machine","label":"nas"}"""))!!.inUse)
        assertTrue("an open conflict is in use", SyncStatusParser.parse(status(setUp = false, conflicts = oneConflict))!!.inUse)
        assertNull(SyncStatusParser.parse("""{"syncNow":1}"""))
        assertNull(SyncStatusParser.parse("not json"))
        assertNull(SyncStatusParser.parse(""))
        assertNull(SyncStatusParser.parse(null))
    }

    @Test
    fun `the last run a machine a line in the CLI's words, the conflicts with both files, and the backup's state`() {
        val last = """{"at":$at,"durationMs":800,"status":"partial","warnings":["memory on laptop is a link: skipped"],"machines":[
            {"label":"build-box","host":"h1","status":"ok","pulled":{"files":2,"bytes":2048},"conflicts":1,"errors":[],"text":"2 files, 2KB"},
            {"label":"laptop","host":"h2","status":"unreachable","detail":"connect timed out","errors":[],"text":"could not be reached over ssh: connect timed out"},
            {"label":"old-box","status":"excluded","errors":[],"text":"not asked: excluded from sync here (`oak sync include` brings it back)"},
            {"label":"backup (/mnt/share)","status":"refused","detail":"the folder's record is another machine's","errors":[],"text":"failed: the folder's record is another machine's","record":"other"}]}"""
        val v = SyncStatusParser.parse(status(last = last, backup = """{"kind":"folder","path":"/mnt/share"}""", conflicts = oneConflict,
            key = """{"present":true,"fingerprint":"ab12-cd34"}"""))!!
        assertEquals(listOf("2 files, 2KB", "could not be reached over ssh: connect timed out", "not asked: excluded from sync here (`oak sync include` brings it back)", "failed: the folder's record is another machine's"), v.lines.map { it.said })
        assertEquals("a machine left out on purpose is no failure", listOf(false, true, false, true), v.lines.map { it.failed })
        assertTrue(v.failed)
        assertEquals("other", v.backupLine?.record)
        assertNull("a line a run left for a folder no longer the backup says nothing of the backup now",
            v.copy(backupPath = "/mnt/other").backupLine)
        assertEquals("the encrypted folder /mnt/share, key ab12-cd34", v.backupText)
        assertEquals(listOf("old-box"), v.excludeMachines)
        assertEquals(listOf("git:github.com/u/r"), v.excludeProjects)
        val c = v.conflicts.single()
        assertEquals("/h/.claude/plans/m.md", c.file)
        assertEquals("/h/.claude/claude-observatory/sync/conflicts/build-box/plans/m.md", c.copy)
        assertEquals("edit your file or delete the copy", c.resolution)
        assertEquals("a conflict needs the reader first", "OAK sync: 1 conflict", syncItemText(v))
        assertEquals(listOf(
            "OAK sync · last run ${relTime(at)} (partial) · background on",
            "build-box: 2 files, 2KB",
            "laptop: could not be reached over ssh: connect timed out",
            "old-box: not asked: excluded from sync here (`oak sync include` brings it back)",
            "backup (/mnt/share): failed: the folder's record is another machine's",
            "backup: the encrypted folder /mnt/share, key ab12-cd34",
            "1 open conflict: the Overview's Sessions tab has it",
            "warning: memory on laptop is a link: skipped",
            "Click for its actions and settings.",
        ), syncTooltipLines(v))
    }

    @Test
    fun `the item says a failure, the clock time of the last run, or the run going on now`() {
        val failed = """{"at":$at,"status":"failed","warnings":[],"machines":[{"label":"laptop","status":"unreachable","detail":"no route","errors":[],"text":"could not be reached over ssh: no route"}]}"""
        assertEquals("OAK sync: failed ${relTime(at)}", syncItemText(SyncStatusParser.parse(status(last = failed))!!))
        val ok = """{"at":$at,"status":"ok","warnings":[],"machines":[{"label":"laptop","status":"ok","errors":[],"text":"0 files, 0B"}]}"""
        assertEquals("OAK sync ${relTime(at)}", syncItemText(SyncStatusParser.parse(status(last = ok))!!))
        assertTrue("an exact clock time, not an age", Regex("""^OAK sync (\d\d:\d\d:\d\d|[A-Z][a-z]{2} \d+ \d\d:\d\d)$""").matches(syncItemText(SyncStatusParser.parse(status(last = ok))!!)))
        assertEquals("OAK sync: running now", syncItemText(SyncStatusParser.parse(status(last = ok, running = true))!!))
        assertEquals("a diverged session is resolved only by deleting its copy", "delete the copy to keep yours",
            SyncStatusParser.parse(status(conflicts = oneConflict.replace("\"overlap\"", "\"diverged\"")))!!.conflicts.single().resolution)
    }

    @Test
    fun `a run says what it pulled, the conflicts it left, and each machine that failed`() {
        val run = SyncNowParser.parse("""{"syncNow":1,"status":"partial","done":[{"action":"pulled","bytes":1024},{"action":"pulled","bytes":1024},{"action":"conflict","bytes":11},{"action":"skipped","bytes":0}],
            "machines":[{"label":"build-box","status":"ok","errors":[]},{"label":"laptop","status":"unreachable","detail":"no route","errors":[]}]}""")!!
        assertEquals("pulled 2 files, 2KB; 1 conflict, in the Overview's Sessions tab; laptop: no route", run.text)
        assertTrue(run.failed)
        assertEquals(SyncRunSaid("nothing to pull", false), SyncNowParser.parse("""{"syncNow":1,"status":"ok","done":[],"machines":[]}"""))
        assertEquals("its warnings, as the CLI prints them", SyncRunSaid("nothing to pull; warning: there is no saved machine to sync with", false),
            SyncNowParser.parse("""{"syncNow":1,"status":"ok","done":[],"machines":[],"warnings":["there is no saved machine to sync with"]}"""))
        assertEquals(SyncRunSaid("another oak sync is running on this machine; it pulls the same", false), SyncNowParser.parse("""{"syncNow":1,"status":"busy"}"""))
        assertNull(SyncNowParser.parse("""{"syncStatus":1}"""))
    }

    @Test
    fun `setup says what it set up, asks for the key or the record, and keeps its notes whole`() {
        val needs = SyncSetupParser.parse("""{"syncSetup":1,"needsKey":true,"folder":"/mnt/share","error":"/mnt/share holds a backup sealed under a key this machine does not have"}""")!!
        assertTrue(needs.needsKey)
        assertEquals("/mnt/share holds a backup sealed under a key this machine does not have", needs.error)
        assertNull("no key here", needs.keyHere)
        assertEquals("another key here, which a key brought for the folder replaces", "ab12-cd34",
            SyncSetupParser.parse("""{"syncSetup":1,"needsKey":true,"folder":"/mnt/share","error":"x","keyHere":"ab12-cd34"}""")!!.keyHere)
        val asks = SyncSetupParser.parse("""{"syncSetup":1,"backup":{"kind":"folder","path":"/mnt/share"},"key":{"fingerprint":"ab12-cd34","made":false,"imported":false},
            "record":{"state":"unclaimed","lastWrite":"last written by laptop at 2026-10-30 21:04"},"plan":null}""")!!
        assertTrue("a record this machine has not written: it asks", asks.asksRestore)
        assertEquals("the backup is the encrypted folder /mnt/share (key ab12-cd34)", asks.what)
        val claimed = SyncSetupParser.parse("""{"syncSetup":1,"backup":{"kind":"folder","path":"/mnt/share"},"key":null,
            "record":{"state":"unclaimed","lastWrite":"x","claimed":true},"plan":{"machines":[{"pulls":[{"bytes":1024},{"bytes":1024}]}]}}""")!!
        assertFalse("taken over: it asks no more", claimed.asksRestore)
        assertEquals(listOf("This machine took the folder’s record over: the next run restores its sessions from it.", "A first run here would pull 2 files, 2KB."), claimed.notes)
        val made = SyncSetupParser.parse("""{"syncSetup":1,"backup":{"kind":"machine","label":"nas"},"key":{"fingerprint":"ab12-cd34","made":true},"plan":null,"planError":"herdr is not installed"}""")!!
        assertEquals("the backup is nas", made.what)
        assertTrue(made.keyMade)
        // The advice names the setup that brings the key to a machine whose backup is still another folder, where
        // `oak sync key --from` alone refuses it.
        assertTrue(made.notes.first(), made.notes.first().endsWith("On each of your other machines, run oak sync setup --folder <the folder’s path there> --key-from <the label that machine saved this one under> --replace (a key that machine kept for another folder is kept beside this one), or set sync up there."))
        assertEquals("The first plan could not be made: herdr is not installed", made.notes.last())
        assertEquals("no backup: each session stays on the machine that made it", SyncSetupParser.parse("""{"syncSetup":1,"backup":null,"key":null,"plan":null}""")!!.what)
        // A plan made without the backup folder (the CLI's planError beside its plan) is no plan that could not be made: its
        // preview stands, with the reason, said once (the record's note already says why).
        val refused = SyncSetupParser.parse("""{"syncSetup":1,"backup":{"kind":"folder","path":"/mnt/share"},"key":null,
            "record":{"state":"unclaimed","lastWrite":"last written by laptop"},"plan":{"machines":[{"pulls":[]}]},"planError":"the backup folder holds a record under this machine's name"}""")!!
        assertEquals(listOf("The folder holds a record under this machine’s name that this machine has not written (last written by laptop): until this machine takes it over (oak sync setup --restore), nothing is restored from the folder or written to it.",
            "A first run here would pull nothing."), refused.notes)
        // Another machine's writer, or a copy of this one's (state `other`): the note above says the record is not this
        // machine's, and the plan says the reason the CLI gave, which names what to do in that case.
        val other = SyncSetupParser.parse("""{"syncSetup":1,"backup":{"kind":"folder","path":"/mnt/share"},"key":null,
            "record":{"state":"other","lastWrite":"last written by laptop"},"plan":{"machines":[{"pulls":[]}]},"planError":"another machine has a copy of this machine's sync state."}""")!!
        assertTrue(other.asksRestore)
        assertEquals("A first run here would pull nothing. The backup folder cannot be used: another machine has a copy of this machine's sync state.", other.notes.last())
        val unread = SyncSetupParser.parse("""{"syncSetup":1,"backup":{"kind":"folder","path":"/mnt/share"},"key":null,"plan":{"machines":[{"pulls":[{"bytes":1024}]}]},"planError":"/mnt/share cannot be read."}""")!!
        assertEquals(listOf("A first run here would pull 1 file, 1KB. The backup folder cannot be used: /mnt/share cannot be read."), unread.notes)
    }

    @Test
    fun `the machines and projects to choose are each saved machine, this project as the CLI keys it, and the projects excluded before`() {
        val v = SyncStatusParser.parse(status().replace("\"key\":{\"present\":false}}", "\"key\":{\"present\":false},\"project\":{\"folder\":\"/w/app\",\"key\":\"git:github.com/u/r\",\"excluded\":true}}"))!!
        assertEquals(SyncProject("/w/app", "git:github.com/u/r", true), v.project)
        assertEquals(listOf(
            SyncChoice("build-box", "build-box (saved machine)", true),
            SyncChoice("old-box", "old-box (saved machine)", false),
            SyncChoice("/w/app", "this project (/w/app)", false),
        ), syncChoices(listOf("build-box"), v))
        val other = v.copy(project = SyncProject("/w/other", "home:other", false))
        assertEquals("another project here: this one ticked, the excluded one listed by its key", listOf(
            SyncChoice("/w/other", "this project (/w/other)", true),
            SyncChoice("git:github.com/u/r", "git:github.com/u/r (project)", false),
        ), syncChoices(emptyList(), other).drop(1))
        assertEquals("no project named: none listed as this one", listOf("old-box (saved machine)", "git:github.com/u/r (project)"), syncChoices(emptyList(), v.copy(project = null)).map { it.text })
        assertTrue(syncChoices(emptyList(), null).isEmpty())
    }

    @Test
    fun `a delete says what the CLI says in each state`() {
        assertEquals(DeleteWords(false, "for good", "without its edits"), deleteWords(false))
        assertEquals(DeleteWords(true, "here (the backup folder keeps its copy)", "and the next oak sync now brings back what of its edits the backup folder holds"), deleteWords(true))
    }
}
