package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.model.compactBytes
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.cellobservatory.observatory.ui.EditsTreePanel
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.notification.Notification
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Container
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.CellRendererPane
import javax.swing.JLabel
import javax.swing.JList

/**
 * The store-folder affordances, driven over the REAL panels in a headless IDE. The
 * file-manager reveal is stubbed, so each test sees exactly which folder a click asked for and no run
 * spawns a real file manager; the CLI is pointed at /bin/false, so no panel reads the real store.
 */
class StoreFolderRevealTest : BasePlatformTestCase() {

    private lateinit var cfg: Path
    private lateinit var realOpen: (File) -> Unit
    private var savedPin: String? = null
    private var savedBin: String? = null
    private val opened = mutableListOf<File>()
    private val warnings = mutableListOf<String>()

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-store-reveal-cfg")
        ClaudePaths.configDirOverride = cfg
        val st = ObservatorySettings.instance.state
        savedPin = st.session
        savedBin = st.observatoryBin
        st.session = null
        st.observatoryBin = "/bin/false"
        realOpen = ReviewOps.openFolder
        ReviewOps.openFolder = { opened += it }
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) {
                if (notification.type == NotificationType.WARNING) warnings += notification.content
            }
        })
    }

    override fun tearDown() {
        try {
            ReviewOps.openFolder = realOpen
            val st = ObservatorySettings.instance.state
            st.session = savedPin
            st.observatoryBin = savedBin
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    private fun storeFor(id: String): File = Files.createDirectories(ClaudePaths.storeDir(id)).toFile()

    fun testTheSharedRevealOpensTheFolderAndSaysWhenThereIsNone() {
        val store = storeFor("fixture-session")
        ReviewOps.revealStoreFolder(project, store.path)
        assertEquals("an existing store folder is handed to the file manager", listOf(store), opened)
        ReviewOps.revealStoreFolder(project, ClaudePaths.storeDir("fixturegone").toString())
        ReviewOps.revealStoreFolder(project, "")
        assertEquals("a missing folder and no session open nothing", listOf(store), opened)
        assertTrue("a missing folder is SAID: $warnings", warnings.any { it.contains("fixtureg has no store folder yet") })
        assertTrue("no session is SAID: $warnings", warnings.any { it.contains("No session is selected") })
    }

    fun testARowsStoreSizeOpensThatFolderEvenWhenTheClickBeatsTheRepaint() {
        val store = storeFor("fixture-session")
        val row = SessionRow(
            "fixture-session", "Fixture session", System.currentTimeMillis(), current = false,
            edits = 1, pending = 0, files = 1, storeBytes = 4096, storePath = store.path, workspace = "~/fixture",
        )
        // Not disposed: like every panel the IDE builds, it lives as long as the project's service.
        val panel = ChangeMapPanel(project)
        val repaint = ChangeMapPanel::class.java.getDeclaredMethod("repaintSessions", SessionsResult::class.java)
            .apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val list = ChangeMapPanel::class.java.getDeclaredField("sessionsList").apply { isAccessible = true }
            .get(panel) as JList<Any>
        list.setSize(900, 400)
        // Every refresh re-fills the list, and the list UI's layout pass then parks the renderer inside
        // its INVISIBLE CellRendererPane until the next paint. A click landing in between is this case.
        repaint.invoke(panel, SessionsResult(null, listOf(row)))
        val index = (0 until list.model.size).first { list.model.getElementAt(it) == row }
        val cell = list.getCellBounds(index, index)
        val renderer = list.cellRenderer.getListCellRendererComponent(list, row, index, list.isSelectedIndex(index), false) as Container
        assertTrue(
            "control: the layout pass parked the renderer under an invisible CellRendererPane",
            renderer.parent is CellRendererPane && !renderer.parent.isVisible,
        )
        renderer.setBounds(0, 0, cell.width, cell.height)
        renderer.doLayout()
        val size = renderer.components.single { (it as? JLabel)?.text == compactBytes(row.storeBytes) }
        val click = MouseEvent(
            list, MouseEvent.MOUSE_CLICKED, System.currentTimeMillis(), 0,
            cell.x + size.x + size.width / 2, cell.y + size.y + size.height / 2, 1, false, MouseEvent.BUTTON1,
        )
        list.mouseListeners.forEach { it.mouseClicked(click) }
        assertEquals("the size opens THAT row's store folder", listOf(store), opened)
        assertNull("…instead of switching the review to the row", ObservatorySettings.instance.state.session)
        // After a paint the list UI has taken the renderer back out; the same click still lands.
        val img = BufferedImage(900, 400, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        list.paint(g)
        g.dispose()
        list.mouseListeners.forEach { it.mouseClicked(click) }
        assertEquals("and again once the list has painted", listOf(store, store), opened)
        assertNull(ObservatorySettings.instance.state.session)
    }

    fun testTheReviewToolbarStoreButtonOpensTheReviewedSessionsFolder() {
        val store = storeFor("fixture-toolbar-session")
        ObservatorySettings.instance.state.session = "fixture-toolbar-session"
        val panel = EditsTreePanel(project, EditsTreePanel.Mode.DIFFS)
        val action = EditsTreePanel::class.java.getDeclaredField("storeAction").apply { isAccessible = true }
            .get(panel) as AnAction
        action.actionPerformed(
            AnActionEvent.createFromDataContext("StoreFolderRevealTest", null, SimpleDataContext.getProjectContext(project)),
        )
        assertEquals("the toolbar button opens the reviewed session's store folder", listOf(store), opened)
    }

    /** The Timeline chip's row runs inside a popup this harness cannot drive, so its route is pinned here:
     *  each store affordance goes through the ONE helper tested above, never the platform's reveal
     *  directly — a direct call skips the missing-folder check and fails silently. */
    fun testEveryStoreAffordanceGoesThroughTheOneHelper() {
        val ui = File("src/main/kotlin/com/cellobservatory/observatory/ui")
        assertTrue("control: the plugin sources are readable from the test's working directory", ui.isDirectory)
        for (name in listOf("ChangeMapPanel.kt", "EditsTreePanel.kt", "TimelineSessionAction.kt")) {
            val src = File(ui, name).readText()
            assertTrue("$name routes through ReviewOps.revealStoreFolder", src.contains("ReviewOps.revealStoreFolder("))
            assertFalse("$name does not call the platform reveal itself", src.contains("RevealFileAction"))
        }
    }
}
