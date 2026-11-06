package com.cellobservatory.observatory.ui

import com.intellij.util.ui.tree.TreeUtil
import javax.swing.JTree
import javax.swing.tree.TreeModel
import javax.swing.tree.TreePath

/** Above this many nodes, expanding a tree costs more than the expansion is worth (0.8.8). */
private const val EXPAND_ALL_CAP = 300

/**
 * Expand a rebuilt tree, but only while it is small enough for expansion to be free.
 *
 * `TreeUtil.expandAll` walks and lays out every node; on a session with thousands of edits that is a
 * multi-hundred-millisecond pass on the EDT, repeated on every store change — the dominant cost of a
 * refresh in a long session. Past [EXPAND_ALL_CAP] nodes this expands the FIRST LEVEL only, which is
 * what a reader can actually scan; deeper levels open on click, and nothing is hidden or dropped.
 */
fun expandAllBounded(tree: JTree) {
    val model: TreeModel = tree.model
    val root = model.root ?: return
    if (countNodes(model, root, EXPAND_ALL_CAP) <= EXPAND_ALL_CAP) {
        TreeUtil.expandAll(tree)
        return
    }
    val rootPath = TreePath(root)
    tree.expandPath(rootPath)
    // Thousands of top-level files are already visible; opening each one defeats the bound.
    if (model.getChildCount(root) > EXPAND_ALL_CAP) return
    for (i in 0 until model.getChildCount(root)) {
        tree.expandPath(rootPath.pathByAddingChild(model.getChild(root, i)))
    }
}

/** Node count, stopping as soon as [cap] is passed — the exact size past the cap is not interesting. */
private fun countNodes(model: TreeModel, node: Any, cap: Int): Int {
    var n = 1
    for (i in 0 until model.getChildCount(node)) {
        n += countNodes(model, model.getChild(node, i), cap - n)
        if (n > cap) return n
    }
    return n
}
