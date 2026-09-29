package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `oak search --json` → the rows the chooser lists. A silent failure here is an action that shows nothing. */
class SearchParserTest {

    @Test
    fun `hits parse whole, in order`() {
        val json = """{"query":"hooks","terms":["hooks"],"hits":[
            {"session":"abc","title":"Fix hooks","agent":"claude","ts":1700000000000,"prompt":"fix the hooks","snippet":"fix the hooks","where":"prompt","score":3},
            {"session":"def","title":null,"agent":"codex","ts":1700000001000,"prompt":"why","snippet":"…the hooks fire…","where":"response","score":1}
        ],"sessions":2,"asks":2,"indexed":0,"ms":5}"""
        val hits = SearchParser.parse(json)
        assertEquals(2, hits.size)
        assertEquals("abc", hits[0].session)
        assertEquals("Fix hooks", hits[0].title)
        assertEquals("prompt", hits[0].where)
        assertEquals(null, hits[1].title)
        assertEquals("codex", hits[1].agent)
        assertEquals("response", hits[1].where)
        assertEquals(1700000001000L, hits[1].ts)
    }

    @Test
    fun `garbage, no hits, and a hit without a session read as empty`() {
        assertTrue(SearchParser.parse(null).isEmpty())
        assertTrue(SearchParser.parse("").isEmpty())
        assertTrue(SearchParser.parse("nope").isEmpty())
        assertTrue(SearchParser.parse("""{"hits":[]}""").isEmpty())
        assertTrue(SearchParser.parse("""{"hits":[{"title":"x"}]}""").isEmpty())
    }
}
