package com.cellobservatory.observatory.platform

import com.intellij.openapi.actionSystem.KeyboardShortcut
import com.intellij.openapi.keymap.KeymapManager
import javax.swing.KeyStroke

/**
 * The review keys, as the IDE's own keymaps resolve them: one prefix (ctrl+alt+X, ⌥⌘X on macOS), then the
 * letter, the terminal app's where it has one. The prefix is asserted free in the platform's keymaps, which is
 * the check that ruled out ctrl+alt+O (Optimize Imports; ⌥⌘O is Go to Symbol).
 */
class KeymapChordTest : ObservatoryPlatformTestCase() {

    private val chords = mapOf(
        "ClaudeObservatory.ReviewNext" to "N",
        "ClaudeObservatory.ReviewPrev" to "P",
        "ClaudeObservatory.KeepAtCursor" to "A",
        "ClaudeObservatory.UndoAtCursor" to "U",
        "ClaudeObservatory.KeepOpenFile" to "shift A",
        "ClaudeObservatory.UndoOpenFile" to "shift D",
        "ClaudeObservatory.DiffPrevRevision" to "OPEN_BRACKET",
        "ClaudeObservatory.DiffNextRevision" to "CLOSE_BRACKET",
        "ClaudeObservatory.AddReviewComment" to "C",
        "ClaudeObservatory.NextAttention" to "H",
    )

    private fun check(keymapName: String, prefix: String) {
        val keymap = KeymapManager.getInstance().getKeymap(keymapName)
        assertNotNull("the $keymapName keymap is loaded", keymap)
        val first = KeyStroke.getKeyStroke(prefix)
        for ((id, second) in chords) {
            val want = KeyboardShortcut(first, KeyStroke.getKeyStroke(second))
            val got = keymap!!.getShortcuts(id).toList()
            assertTrue("$id is $prefix then $second in $keymapName: was $got", got.contains(want))
            assertEquals("$id has no other default shortcut in $keymapName: $got", 1, got.size)
        }
        // Everything that starts with the prefix is ours: no platform action shares it.
        val sharing = keymap!!.getActionIds(first).toList().filterNot { it.startsWith("ClaudeObservatory.") }
        assertEquals("$prefix is OAK's alone in $keymapName", emptyList<String>(), sharing)
    }

    fun testDefaultKeymap() = check("\$default", "ctrl alt X")

    fun testMacKeymap() = check("Mac OS X 10.5+", "meta alt X")

    fun testTheCheckCanFail() {
        // Positive control: the same lookup finds the platform's own ctrl+alt+O.
        val keymap = KeymapManager.getInstance().getKeymap("\$default")!!
        assertTrue(keymap.getActionIds(KeyStroke.getKeyStroke("ctrl alt O")).toList().contains("OptimizeImports"))
    }
}
