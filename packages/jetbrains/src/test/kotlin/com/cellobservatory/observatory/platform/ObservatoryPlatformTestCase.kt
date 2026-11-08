package com.cellobservatory.observatory.platform

import com.intellij.testFramework.LightPlatformTestCase
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** OAK panels and service caches live with the project; light fixtures otherwise reuse them across tests. */
abstract class ObservatoryPlatformTestCase : BasePlatformTestCase() {
    override fun tearDown() {
        try {
            super.tearDown()
        } finally {
            LightPlatformTestCase.closeAndDeleteProject()
        }
    }
}
