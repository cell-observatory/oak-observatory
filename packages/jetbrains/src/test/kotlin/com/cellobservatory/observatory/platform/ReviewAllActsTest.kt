package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.ui.ReviewAllEditor
import com.cellobservatory.observatory.ui.ReviewAllSpec
import com.cellobservatory.observatory.ui.ReviewAllVirtualFile
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import java.awt.Component
import java.awt.Container
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import javax.swing.JButton
import javax.swing.JLabel

/**
 * The stacked tab's action rows are STATUS-AWARE (parity with the VS Code stacked
 * page): pending verbs at build, then a verdict plus the one remaining verb once the store says the
 * record was decided — kept → ↺ Revert, reverted → ↻ Redo — whichever surface decided it. Drives the
 * REAL editor component against a real on-disk store; no CLI is needed because the row sync reads
 * the store directly.
 */
class ReviewAllActsTest : BasePlatformTestCase() {

    private lateinit var cfg: java.nio.file.Path
    private val session = "acts-test"
    private val shaA = "a".repeat(64)
    private val shaB = "b".repeat(64)

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("obs-acts-cfg")
        ClaudePaths.configDirOverride = cfg
        Files.createDirectories(ClaudePaths.storeDir(session).resolve("blobs"))
        Files.writeString(ClaudePaths.blobPath(session, shaA), "one\n")
        Files.writeString(ClaudePaths.blobPath(session, shaB), "two\n")
        Files.writeString(
            ClaudePaths.logPath(session),
            """{"id":1,"ts":1,"tool":"Edit","file":"/w/a.txt","beforeBlob":"$shaA","afterBlob":"$shaB","status":"pending"}""" + "\n",
        )
    }

    override fun tearDown() {
        try {
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    /** Every button/label text under [c] — how a reader sees the action row, not how we store it. */
    private fun texts(c: Component): List<String> = buildList {
        fun walk(comp: Component) {
            if (comp is JButton) add(comp.text ?: "")
            if (comp is JLabel) add(comp.text ?: "")
            if (comp is Container) comp.components.forEach(::walk)
        }
        walk(c)
    }

    /** Editors under [c] — a UNIFIED (stacked) diff embeds ONE, a side-by-side diff embeds TWO. */
    private fun editors(c: Component): Int {
        var n = 0
        fun walk(comp: Component) {
            if (comp is com.intellij.openapi.editor.impl.EditorComponentImpl) n++
            if (comp is Container) comp.components.forEach(::walk)
        }
        walk(c)
        return n
    }

    /** The tab OPENS stacked (one inline reading column) and its bar genuinely switches views —
     *  the platform reads FORCE_DIFF_TOOL from the processor context IN ITS CONSTRUCTOR, so the
     *  old createRequestPanel + request-user-data route was ignored and every block rendered
     *  side-by-side whatever the toggle said (field failure, 2026-08-20). */
    fun testStackedEmbedsOneEditorAndTheToggleSwitchesToTwo() {
        val rec = EditRecord(1, 1, "Edit", "/w/a.txt", shaA, shaB, "pending")
        val vf = ReviewAllVirtualFile(session, listOf(ReviewAllSpec(rec, "a.txt", 2)), "t")
        val editor = ReviewAllEditor(project, vf)
        try {
            val pump = { pred: () -> Boolean ->
                val deadline = System.currentTimeMillis() + 15_000
                while (System.currentTimeMillis() < deadline && !pred()) {
                    UIUtil.dispatchAllInvocationEvents()
                    Thread.sleep(20)
                }
            }
            pump { editors(editor.component) > 0 }
            assertEquals("STACKED must embed the unified viewer: ONE editor per block", 1, editors(editor.component))
            assertTrue("Spotlight is ON by default",
                texts(editor.component).any { it == "Spotlight on" })
            // The bar's own switch — a real click on the real button.
            var btn: javax.swing.JButton? = null
            fun find(c: Component) {
                if (c is javax.swing.JButton && c.text == "Side by side") btn = c
                if (c is Container) c.components.forEach(::find)
            }
            find(editor.component)
            assertNotNull("the bar offers the Side by side switch", btn)
            btn!!.doClick()
            pump { editors(editor.component) == 2 }
            assertEquals("side by side = TWO editors per block", 2, editors(editor.component))
        } finally {
            Disposer.dispose(editor)
        }
    }

    fun testDecidedBlocksReskinToVerdictPlusRemainingVerb() {
        val rec = EditRecord(1, 1, "Edit", "/w/a.txt", shaA, shaB, "pending")
        val vf = ReviewAllVirtualFile(session, listOf(ReviewAllSpec(rec, "a.txt", 2)), "t")
        val editor = ReviewAllEditor(project, vf)
        try {
            // addPage reads blobs on a pooled thread, then builds on the EDT — pump until built.
            val deadline = System.currentTimeMillis() + 15_000
            while (System.currentTimeMillis() < deadline && texts(editor.component).none { it == "✓ Keep" }) {
                UIUtil.dispatchAllInvocationEvents()
                Thread.sleep(20)
            }
            val before = texts(editor.component)
            assertTrue("the pending block offers ✓ Keep (got: $before)", before.any { it == "✓ Keep" })
            assertTrue("…and ✗ Undo", before.any { it == "✗ Undo" })
            assertFalse("…and no per-row Chat (dropped by request, 2026-08-20)", before.any { it.contains("Chat") })
            // The icon-width fallback: a narrow pane shows the glyphs alone —
            // the verb pair never clips away — and widening brings the words back.
            editor.syncCompact(200)
            val narrow = texts(editor.component)
            assertTrue("narrow: Keep is its glyph (got: $narrow)", narrow.any { it == "✓" })
            assertTrue("narrow: Undo is its glyph", narrow.any { it == "✗" })
            assertFalse("narrow: no worded verbs", narrow.any { it == "✓ Keep" || it == "✗ Undo" })
            editor.syncCompact(2000)
            assertTrue("wide again: the words return", texts(editor.component).any { it == "✓ Keep" })
            // The store decides the record — exactly what the Review tab, the CLI, or the block's own
            // button would append — and the sync re-skins the row from disk.
            Files.writeString(
                ClaudePaths.logPath(session),
                """{"op":"status","id":1,"status":"kept","ts":2}""" + "\n",
                StandardOpenOption.APPEND,
            )
            editor.syncActs()
            val kept = texts(editor.component)
            assertTrue("a kept block wears its verdict (got: $kept)", kept.any { it == "✓ kept" })
            assertTrue("…and offers ↺ Revert", kept.any { it == "↺ Revert" })
            assertFalse("…and the pending verbs are gone", kept.any { it == "✓ Keep" })
            // Reverted → the forward verb.
            Files.writeString(
                ClaudePaths.logPath(session),
                """{"op":"status","id":1,"status":"undone","ts":3}""" + "\n",
                StandardOpenOption.APPEND,
            )
            editor.syncActs()
            val undone = texts(editor.component)
            assertTrue("a reverted block wears its verdict", undone.any { it == "✗ reverted" })
            assertTrue("…and offers ↻ Redo", undone.any { it == "↻ Redo" })
            assertFalse("…and Revert is gone", undone.any { it == "↺ Revert" })
        } finally {
            Disposer.dispose(editor)
        }
    }
}
