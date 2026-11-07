package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Timeline selector's row rule: live sessions only, the reviewed one pinned in and first.
 *
 * The 60 s window is core's `FLEET_ACTIVE_MS`, mirrored in Sessions.kt — so the boundary is pinned on both
 * sides here. A drift there would make the fleet's ● and this selector's ● mean different things about the
 * same session, which is precisely the kind of divergence nothing in a build reports.
 */
class SessionsRowsTest {

    private val now = 1_000_000_000L

    private fun row(id: String, agoMs: Long, title: String? = null) =
        SessionRow(id, title, now - agoMs, current = false, edits = 0, pending = 0, files = 0)

    @Test
    fun `the reviewed session comes first, then the live ones newest-conversation first`() {
        val rows = listOf(row("old", 10_000), row("newest", 1_000), row("mine", 5_000))
        val out = activeSessionRows(rows, currentId = "mine", nowMs = now)
        assertEquals(listOf("mine", "newest", "old"), out.map { it.id })
    }

    @Test
    fun `a session quiet for longer than the active window is dropped`() {
        val rows = listOf(row("live", 59_000), row("quiet", 61_000))
        assertEquals(listOf("live"), activeSessionRows(rows, currentId = null, nowMs = now).map { it.id })
    }

    @Test
    fun `the reviewed session is kept even when it has gone quiet`() {
        // Every panel is showing it; a selector that omitted it would let one click strand the reader.
        val rows = listOf(row("mine", 3 * 60 * 60_000), row("live", 5_000))
        assertEquals(listOf("mine", "live"), activeSessionRows(rows, currentId = "mine", nowMs = now).map { it.id })
    }

    @Test
    fun `a reviewed session absent from the payload adds no phantom row`() {
        // Synthesizing it is the caller's job (it knows the id); this function reports only what it was given.
        val rows = listOf(row("live", 5_000))
        assertEquals(listOf("live"), activeSessionRows(rows, currentId = "foreign", nowMs = now).map { it.id })
    }

    @Test
    fun `the reviewed session is never listed twice`() {
        val rows = listOf(row("mine", 5_000), row("other", 6_000))
        val out = activeSessionRows(rows, currentId = "mine", nowMs = now)
        assertEquals(out.size, out.map { it.id }.toSet().size)
    }

    @Test
    fun `isSessionActive pins the same boundary the filter uses`() {
        assertTrue(isSessionActive(now - 59_000, now))
        assertTrue(isSessionActive(now - 60_000, now)) // inclusive, matching the filter's <=
        assertFalse(isSessionActive(now - 61_000, now))
        // A synthesized row carries no recency at all; calling that "live" would put a ● on a guess.
        assertFalse(isSessionActive(0L, now))
    }

    @Test
    fun `local listing preserves CLI workspace order and all statistics`() {
        val result = SessionsParser.parse("""{"active":"fixture-local","sessions":[
          {"id":"fixture-local","title":"Native Codex title","workspace":"~/work/app","lastActiveMs":123,"tokens":700,"durationMs":60000,"model":"gpt-6","edits":0},
          {"id":"fixture-other","workspace":"~/work/other","lastActiveMs":456}
        ]}""")!!
        assertEquals(listOf("~/work/app", "~/work/other"), result.sessions.map { it.workspace })
        val first = result.sessions.first()
        assertEquals("Native Codex title", first.displayName)
        assertEquals(700L, first.tokens)
        assertEquals(60000L, first.durationMs)
        assertEquals("gpt-6", first.model)
        assertEquals(0, first.edits)
    }

    @Test
    fun `a row keeps the newest edit its listing counted, and a row from an older CLI leaves it unknown`() {
        // The delete confirmed from a row passes it on as `--seen-through`: an edit captured after the listing
        // is refused, even one that joined a change the count included. Absent is not 0,
        // which would say the listing saw no edit at all.
        val result = SessionsParser.parse("""{"sessions":[
          {"id":"fixture-counted","lastActiveMs":123,"edits":2,"pending":2,"lastEdit":12},
          {"id":"fixture-older-cli","lastActiveMs":456,"edits":2,"pending":2}
        ]}""")!!
        assertEquals(listOf(12L, null), result.sessions.map { it.lastEdit })
    }

    @Test
    fun `old remote and bridge rows cannot reappear in editor pickers`() {
        // The parser is the one guard: every row past it is a session on this machine.
        val result = SessionsParser.parse("""{"sessions":[
          {"id":"local","lastActiveMs":123},
          {"id":"remote","origin":"remote","paneId":"pane","kind":"codex"},
          {"id":"bridge","origin":"bridged","lastActiveMs":456}
        ]}""")!!
        assertEquals(listOf("local"), result.sessions.map { it.id })
    }

    @Test
    fun `a row carries its workers still at it, grouped waiting first, never a finished one`() {
        // 0.11.0: each worker still at it rides its session's row; the Sessions tab groups them under it, those
        // waiting on a person first. A finished one (an older listing could carry it) belongs to no group.
        val result = SessionsParser.parse("""{"sessions":[
          {"id":"fixture-busy","lastActiveMs":123,"activeWorkers":[
            {"agentId":"a1","title":"Review brain code","phase":"working","model":"Opus 5.5","edits":3,"pending":1,"added":120,"removed":4,"tokens":1200000,"lastActiveMs":99},
            {"agentId":"a2","title":"Ask about scope","phase":"awaiting-input"},
            {"agentId":"a3","phase":"awaiting-permission","phaseConfidence":"heuristic"},
            {"agentId":"a4","title":"Done already","phase":"done"},
            {"title":"no id"}]},
          {"id":"fixture-older-cli","lastActiveMs":456}
        ]}""")!!
        val busy = result.sessions.first()
        assertEquals(listOf("a1", "a2", "a3", "a4"), busy.activeWorkers.map { it.agentId })
        assertEquals(ActiveWorker("a1", "Review brain code", "working", "Opus 5.5", 3, 1, 120, 4, 1_200_000L, 99L), busy.activeWorkers.first())
        assertEquals("a3", busy.activeWorkers[2].title)
        assertEquals(listOf("", "", "heuristic"), busy.activeWorkers.take(3).map { it.phaseConfidence })
        assertEquals(listOf("blocked" to listOf("a2", "a3"), "working" to listOf("a1")), workerGroups(busy).map { (st, ws) -> st to ws.map { it.agentId } })
        assertEquals(emptyList<ActiveWorker>(), result.sessions.last().activeWorkers)
        assertTrue(workerGroups(result.sessions.last()).isEmpty())
    }

    @Test
    fun `legacy rows without conversation recency are still refused`() {
        assertEquals(null, SessionsParser.parse("""{"sessions":[{"id":"legacy","lastMs":123}]}"""))
    }

    // 0.11.0: `oak sessions --json --synced` adds every other machine's sessions the local index holds, under its label.
    @Test
    fun `other machines' sessions parse by machine, with when oak sync brought them, and a listing without them has none`() {
        val json = """{"active":null,"sessions":[{"id":"here","lastActiveMs":5}],"machines":[
            {"label":"build-box","host":"b0b0b0b0b0b0","syncedAt":1800000000000,"publishedAt":1799999990000,"sessions":[
              {"id":"remote-one","origin":"synced","machine":"build-box","title":"Tune it","lastActiveMs":7,"edits":2,"pending":1,"workspace":"~/remote","agent":"codex"},
              {"id":"","origin":"synced","lastActiveMs":8}]},
            {"label":"","host":"c0c0c0c0c0c0","syncedAt":null,"sessions":[]}]}"""
        val machines = SessionsParser.machines(json)
        assertEquals(listOf("build-box", "c0c0c0c0c0c0"), machines.map { it.label })
        assertEquals(listOf(1_800_000_000_000L, null), machines.map { it.syncedAt })
        assertEquals(listOf("remote-one"), machines[0].sessions.map { it.id })
        assertEquals("codex", machines[0].sessions[0].agent)
        assertEquals(1, machines[0].sessions[0].pending)
        assertEquals(listOf("here"), SessionsParser.parse(json)!!.sessions.map { it.id })
        assertTrue(SessionsParser.machines("""{"active":null,"sessions":[]}""").isEmpty())
        assertTrue(SessionsParser.machines("not json").isEmpty())
    }

    // 0.11.0: the listing carries other machines' raised hands (`syncedHands`), each on its machine.
    @Test
    fun `other machines' raised hands parse with their machine, a malformed one is dropped, and a listing without them has none`() {
        val json = """{"active":null,"sessions":[{"id":"here","lastActiveMs":5}],"syncedHands":[
            {"id":"remote-wait","title":"Profile it","agent":"codex","workspace":"~/app","machine":"build-box","host":"aaaaaaaaaaaa","kind":"permission","message":"Bash","ts":9,"syncedAt":10,"origin":"synced"},
            {"id":"no-host","kind":"input","ts":9},
            {"id":"no-machine","host":"bbbbbbbbbbbb","kind":"input","message":"","ts":3}]}"""
        val hands = SessionsParser.parse(json)!!.syncedHands
        assertEquals(listOf("remote-wait", "no-machine"), hands.map { it.id })
        assertEquals(SyncedHand("remote-wait", "Profile it", "codex", "~/app", "build-box", "aaaaaaaaaaaa", SessionAttention("permission", "Bash", 9), 10), hands[0])
        assertEquals("bbbbbbbbbbbb", hands[1].machine)
        assertEquals("session no-machi", hands[1].displayName)
        assertEquals(listOf("here"), SessionsParser.parse(json)!!.sessions.map { it.id })
        assertTrue(SessionsParser.parse("""{"active":null,"sessions":[]}""")!!.syncedHands.isEmpty())
    }
}
