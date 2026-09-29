package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ClaudePathsTest {
    @Test
    fun `mangleCwd replaces every non-alphanumeric char with a dash`() {
        assertEquals("-Users-dev-Github", ClaudePaths.mangleCwd("/Users/dev/Github"))
        assertEquals("-a-b-proj-x", ClaudePaths.mangleCwd("/a b/proj-x"))
        // non-ASCII letters mangle char-per-char, same as the TS regex ([^a-zA-Z0-9] -> '-')
        assertEquals("-Users-caf--proj", ClaudePaths.mangleCwd("/Users/café/proj"))
    }

    @Test
    fun `mangleCwd shortens a long name the way Claude Code does, matching core`() {
        // The expected suffixes are core's mangleCwd output for the same paths: one hash positive, one negative.
        val deep = "/work/" + (0 until 12).joinToString("/") { "fixture-nested-directory-$it" }
        val slug = deep.replace(Regex("[^a-zA-Z0-9]"), "-")
        assertEquals(slug.substring(0, 200) + "-f3tbqi", ClaudePaths.mangleCwd(deep))
        assertEquals(slug.substring(0, 200) + "-gk8rif", ClaudePaths.mangleCwd("$deep/alpha"))
    }

}
