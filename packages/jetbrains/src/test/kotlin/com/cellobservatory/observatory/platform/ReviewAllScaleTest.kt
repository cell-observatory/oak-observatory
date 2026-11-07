package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.ui.ReviewAllEditor
import com.cellobservatory.observatory.ui.ReviewAllSpec
import com.cellobservatory.observatory.ui.ReviewAllVirtualFile
import com.intellij.openapi.util.Disposer
import com.intellij.util.ui.UIUtil
import java.awt.Container
import java.nio.file.Files
import javax.swing.JButton

class ReviewAllScaleTest : ObservatoryPlatformTestCase() {
    private fun buttons(c: Container): List<JButton> = c.components.flatMap { (if (it is JButton) listOf(it) else emptyList()) + (if (it is Container) buttons(it) else emptyList()) }
    private fun pump(until: () -> Boolean): Double {
        val end = System.nanoTime() + 20_000_000_000L
        var longest = 0.0
        while (!until() && System.nanoTime() < end) {
            val start = System.nanoTime()
            UIUtil.dispatchAllInvocationEvents()
            longest = maxOf(longest, (System.nanoTime() - start) / 1e6)
            Thread.sleep(2)
        }
        assertTrue("page finished", until())
        return longest
    }
    fun testLargeSessionPagesReleaseViewers() {
        val dir = Files.createTempDirectory("oak-stacked-scale")
        val old = ClaudePaths.configDirOverride
        ClaudePaths.configDirOverride = dir
        val session = "synthetic-scale"
        val a = "a".repeat(64); val b = "b".repeat(64)
        Files.createDirectories(ClaudePaths.storeDir(session).resolve("blobs"))
        Files.writeString(ClaudePaths.blobPath(session, a), (0..69).joinToString("\n") { "const v$it = $it;" })
        Files.writeString(ClaudePaths.blobPath(session, b), (0..69).joinToString("\n") { "${if (it < 18) "let" else "const"} v$it = $it;" })
        val specs = (1..2616).map { id ->
            val f = dir.resolve("files/${(id-1)%1293}.ts")
            if (id <= 361) { Files.createDirectories(f.parent); Files.writeString(f, "synthetic") }
            ReviewAllSpec(EditRecord(id, id.toLong(), "Edit", f.toString(), a, b, "pending"), f.toString(), 36)
        }
        Files.writeString(ClaudePaths.logPath(session), specs.joinToString("\n") { """{"id":${it.rec.id},"ts":${it.rec.ts},"tool":"Edit","file":"${it.rec.file}","beforeBlob":"$a","afterBlob":"$b","status":"pending"}""" })
        val start = System.nanoTime()
        var last = start
        var longest = 0.0
        var first = 0.0
        var peakHeap = 0L
        var editor: ReviewAllEditor? = null
        val pulse = javax.swing.Timer(1) {
            val now = System.nanoTime()
            longest = maxOf(longest, (now - last) / 1e6)
            last = now
            peakHeap = maxOf(peakHeap, java.lang.management.ManagementFactory.getMemoryMXBean().heapMemoryUsage.used)
            if (first == 0.0 && editor?.let { buttons(it.component as Container).any { b -> b.text == "✓ Keep" } } == true) first = (now - start) / 1e6
        }
        pulse.start()
        editor = ReviewAllEditor(project, ReviewAllVirtualFile(session, specs, "2616 change(s)"))
        try {
            pump { first > 0 && buttons(editor.component as Container).count { it.text == "✓ Keep" } == 10 }
            Thread.sleep(5); UIUtil.dispatchAllInvocationEvents()
            pulse.stop()
            val peakRss = runCatching { Files.readAllLines(java.nio.file.Path.of("/proc/self/status")).first { it.startsWith("VmHWM:") }.trim().split(Regex("\\s+"))[1].toDouble() / 1024 }.getOrNull()
            println("OA1 timing: firstMs=$first longestEdtMs=$longest peakHeapMiB=${peakHeap / 1048576.0} peakRssMiB=$peakRss")
            assertTrue("first block in about a second: $first", first < 1100)
            assertTrue("EDT yields within 200 ms: $longest", longest < 200)
            // The existing private page entry is driven as the button drives it.
            ReviewAllEditor::class.java.getDeclaredMethod("addPage").apply { isAccessible = true }.invoke(editor)
            pump { buttons(editor.component as Container).count { it.text == "✓ Keep" } >= 10 && buttons(editor.component as Container).any { it.toolTipText == "Keep #11" } }
            val keep = buttons(editor.component as Container).filter { it.text == "✓ Keep" }
            assertEquals("previous viewers must be released, not accumulated", 10, keep.size)
            assertTrue("page preserves order", keep.first().toolTipText == "Keep #11")
        } finally { pulse.stop(); Disposer.dispose(editor); ClaudePaths.configDirOverride = old; dir.toFile().deleteRecursively() }
    }
}
