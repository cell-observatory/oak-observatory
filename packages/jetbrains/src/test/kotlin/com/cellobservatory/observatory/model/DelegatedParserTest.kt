package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The agents OAK started from a brief, as multitask's `delegated` carries them (core delegated.ts): parsed, and their facts
 *  printed as the terminal app and VS Code print them. A CLI without the field parses to none. */
class DelegatedParserTest {
    private val base = """"collisions":[],"worktrees":[],"workflows":[],"summary":{"active":0,"conflicts":0}"""

    @Test
    fun parsesStateSinceErrorAndWorkers() {
        val since = java.time.LocalDate.now().atTime(13, 58, 7).atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
        val res = MultitaskParser.parse("""{"agents":[],$base,"delegated":[
            {"id":"fix1","title":"Fix the parser","kind":"claude","state":"working","since":$since,"model":"Opus 5.5","effort":"xhigh","machine":null,"tab":"t1",
             "tokens":125000,"cost":1.5,"workers":[{"id":"w1","title":"map the lexer","state":"working","model":"Sonnet"}]},
            {"id":"port2","remoteId":"port2","title":"Port the lexer","kind":"codex","state":"errored","since":$since,"machine":"build-box","tab":"rt1",
             "error":"Selected model is at capacity. Please try a different model.","tokens":null,"cost":null,"workers":[]}]}""")!!
        assertEquals(listOf("fix1", "port2"), res.delegated.map { it.id })
        val fix = res.delegated[0]
        assertEquals("since 13:58:07 · claude · Opus 5.5 xhigh · this machine · tab fix1 · 125k tok · $1.50", fix.facts(since))
        assertEquals(listOf(DelegatedWorkerRow("w1", "map the lexer", "working", "Sonnet")), fix.workers)
        assertEquals("working", fix.phase)
        val port = res.delegated[1]
        assertEquals("errored", port.phase)
        assertEquals("Selected model is at capacity. Please try a different model.", port.error)
        assertEquals("since 13:58:07 · codex · on build-box · tab port2", port.facts(since))
        assertNull(port.tokens)
    }

    @Test
    fun worktreeStateIsShownInWorkers() {
        val res = MultitaskParser.parse("""{"agents":[],$base,"delegated":[{"id":"agent-x","kind":"codex","worktree":{"state":{"files":3,"added":120,"removed":8,"merged":false}},"workers":[]}]}""")!!
        assertTrue(res.delegated.single().facts().contains("3 files · +120 −8 · not merged"))
    }

    @Test
    fun queuedRowsNameTheirDependencies() {
        val res = MultitaskParser.parse("""{"agents":[],$base,"delegated":[
            {"id":"q1","kind":"codex","state":"queued","since":1,"after":["fix1","port2"],"workers":[]}]}""")!!
        val row = res.delegated.single()
        assertEquals("queued", row.state)
        assertTrue(row.facts().contains("waiting on fix1, port2"))
        val worker = MultitaskParser.agent(com.google.gson.JsonParser.parseString("""{"state":"queued","after":["fix1"]}""").asJsonObject)
        assertTrue(MultitaskFilter.agentActive(worker))
    }

    @Test
    fun anOlderCliHasNone() {
        assertTrue(MultitaskParser.parse("""{"agents":[],$base}""")!!.delegated.isEmpty())
    }
}
