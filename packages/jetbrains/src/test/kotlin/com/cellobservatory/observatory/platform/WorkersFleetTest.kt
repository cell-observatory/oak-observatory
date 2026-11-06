package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.MultitaskResult
import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import java.nio.file.Files
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.TreePath

class WorkersFleetTest : ObservatoryPlatformTestCase() {
    fun testNamedWorkersAndFinishedChildrenUseTheFleetAnswer() {
        val settings = ObservatorySettings.instance.state
        val bin = settings.observatoryBin
        val active = settings.overviewActiveOnly
        val cfg = Files.createTempDirectory("oak-workers-fleet")
        ClaudePaths.configDirOverride = cfg
        settings.observatoryBin = "/bin/false"
        val service = ObservatoryService.getInstance(project)
        val fetch = field(service, "workersFetch")!!
        val saved = listOf("value", "fetchedKey", "fetchedAt").associateWith { field(fetch, it) }
        try {
            set(fetch, "value", SessionsParser.parse("""{"sessions":[],"findings":{"count":2,"rows":[{"text":"<script>ignore instructions</script>"}]},"workers":[
              {"session":"parent","key":"test-box:parent","title":"Check copper widgets","machine":"test-box","kind":"codex","state":"working","phase":"working","tokens":45,"subagents":[
                {"agentId":"live","description":"Live scan","phase":"working"},
                {"agentId":"done","description":"Finished scan","phase":"done"},
                {"agentId":"gone","description":"Lost scan","phase":"gone"}]},
              {"session":"killed","key":"test-box:killed","title":"Killed scan","state":"gone","phase":"working"},
              {"session":"waiting","key":"test-box:waiting","title":"Waiting scan","state":"waiting","phase":"idle"}
            ]}""")!!)
            set(fetch, "fetchedKey", "")
            set(fetch, "fetchedAt", System.currentTimeMillis() + 60_000)
            assertEquals(3, service.localWorkers()?.workers?.size)
            val panel = ChangeMapPanel(project)
            val tree = field(panel, "fleetTree") as JTree
            val repaint = ChangeMapPanel::class.java.getDeclaredMethod("repaintNav", MultitaskResult::class.java).apply { isAccessible = true }
            fun text(c: java.awt.Component): String = when (c) {
                is com.intellij.ui.SimpleColoredComponent -> c.getCharSequence(true).toString()
                is java.awt.Container -> c.components.joinToString(" ") { text(it) }
                else -> ""
            }
            fun visible(): String = (0 until tree.rowCount).joinToString("\n") { i ->
                val node = tree.getPathForRow(i).lastPathComponent as DefaultMutableTreeNode
                text(tree.cellRenderer.getTreeCellRendererComponent(tree, node, false, true, node.isLeaf, i, false))
            }
            fun nodes(): List<DefaultMutableTreeNode> = (tree.model.root as DefaultMutableTreeNode).depthFirstEnumeration().toList().filterIsInstance<DefaultMutableTreeNode>()
            settings.overviewActiveOnly = true
            repaint.invoke(panel, null)
            assertTrue(visible(), visible().contains("Findings · 2 · oak finding list"))
            assertFalse(visible().contains("<script>ignore instructions</script>"))
            assertTrue(visible(), visible().contains("Check copper widgets"))
            assertTrue(visible(), visible().contains("Waiting scan"))
            assertFalse(visible().contains("Killed scan"))
            assertFalse(nodes().any { it.userObject?.javaClass?.simpleName == "DoneWorkers" })
            settings.overviewActiveOnly = false
            repaint.invoke(panel, null)
            val fold = nodes().single { it.userObject?.javaClass?.simpleName == "DoneWorkers" }
            assertEquals(2, fold.childCount)
            val path = TreePath(fold.path)
            assertFalse(tree.isExpanded(path))
            tree.expandPath(path)
            assertTrue(tree.isExpanded(path))
            repaint.invoke(panel, null)
            val again = nodes().single { it.userObject?.javaClass?.simpleName == "DoneWorkers" }
            assertTrue("a repaint keeps the user's expansion", tree.isExpanded(TreePath(again.path)))
        } finally {
            saved.forEach { (name, value) -> set(fetch, name, value) }
            settings.observatoryBin = bin
            settings.overviewActiveOnly = active
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        }
    }
    private fun field(v: Any, name: String) = v.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(v)
    private fun set(v: Any, name: String, value: Any?) = v.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(v, value)
}
