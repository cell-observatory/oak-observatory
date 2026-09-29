package com.cellobservatory.observatory.ui

import com.intellij.openapi.util.IconLoader
import com.intellij.ui.BadgeIconSupplier
import javax.swing.Icon

/** The observatory microscope, themed via currentColor. 13px for gutter/tree/row use. */
object Icons {
    @JvmField
    val Microscope = IconLoader.getIcon("/icons/observatory13.svg", Icons::class.java)

    /** Double-checkmark ("accept all"), matching VS Code's `$(check-all)`. Themed via currentColor. */
    @JvmField
    val CheckAll = IconLoader.getIcon("/icons/checkAll.svg", Icons::class.java)

    /** Double-✗ ("reject scope"), matching VS Code's `$(close-all)` — the reject mirror of [CheckAll]. */
    @JvmField
    val CloseAll = IconLoader.getIcon("/icons/closeAll.svg", Icons::class.java)

    /** Claude-coral ✨ sparkle — the "Agent edited here" gutter marker (parity with the VS Code star). */
    @JvmField
    val Star = IconLoader.getIcon("/icons/star.svg", Icons::class.java)

    /** The tool-window stripe glyph (13x13 palette-recolored per theme, per plugin.xml). */
    private val ToolWindowBase = IconLoader.getIcon("/icons/toolWindowObservatory.svg", Icons::class.java)

    /** Stripe icon with a dot badge while edits are pending (parity with VS Code's title count). */
    fun toolWindowIcon(pending: Int): Icon =
        if (pending > 0) BadgeIconSupplier(ToolWindowBase).infoIcon else ToolWindowBase
}
