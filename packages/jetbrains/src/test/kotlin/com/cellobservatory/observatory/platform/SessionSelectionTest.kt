package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files

class SessionSelectionTest : BasePlatformTestCase() {
    fun testAnAnsweredEmptyCliListingCannotFallBackToAMirror() {
        val cfg = Files.createTempDirectory("oak-selection-cfg")
        val oldPin = ObservatorySettings.instance.state.session
        ClaudePaths.configDirOverride = cfg
        ObservatorySettings.instance.state.session = null
        try {
            val root = project.basePath!!
            val dir = ClaudePaths.projectDir(root)
            Files.createDirectories(dir)
            Files.writeString(dir.resolve("fixture-mirror.jsonl"), """{"type":"assistant","cwd":"/remote/workspace","message":{"role":"assistant","content":[]}}
            """)
            val service = ObservatoryService.getInstance(project)
            val field = service.javaClass.getDeclaredField("sessionsFetch").apply { isAccessible = true }
            val slot = field.get(service)
            val value = slot.javaClass.getDeclaredField("value").apply { isAccessible = true }
            value.set(slot, SessionsResult(null, emptyList()))
            assertNull("Core's empty result must stay empty", service.currentSession())
            value.set(slot, SessionsResult("fixture-local", emptyList()))
            assertEquals("Core's positive selection is used", "fixture-local", service.currentSession())
        } finally {
            ObservatorySettings.instance.state.session = oldPin
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        }
    }
}
