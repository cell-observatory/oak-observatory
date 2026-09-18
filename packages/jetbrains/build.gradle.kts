// Claude Observatory for JetBrains IDEs (PyCharm, IntelliJ, …).
// Front-end only: all store mutations go through the `claude-observatory` CLI (see packages/cli);
// cheap reads come straight off the on-disk store. Platform-only dependency → runs in every
// JetBrains IDE, and on the Gateway/remote-dev backend (where ~/.claude lives).
plugins {
    id("java")
    kotlin("jvm") version "2.4.10"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.cell-observatory"
version = "0.10.0-dev.0" // keep in lockstep with the monorepo/vscode version (see root package.json)

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // Compile against the canonical platform baseline; the plugin declares only
        // com.intellij.modules.platform so it loads in PyCharm CE/Pro and every other JetBrains IDE.
        intellijIdeaCommunity("2025.2")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
}

kotlin { jvmToolchain(21) }

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "252"
            untilBuild = provider { null }
        }
    }

    // Binary compatibility against the IDEs people actually run. The plugin COMPILES against 2025.2 but
    // declares no untilBuild, so it loads into every later build too — and a platform API that changed
    // signature since then is a NoSuchMethodError at runtime that the compiler, the unit tests and CI all
    // pass straight over. `./gradlew verifyPlugin` is the only check that sees it.
    pluginVerification {
        // Fail on the things that BREAK — a call that no longer resolves, a missing dependency, a
        // malformed plugin, or an override-only API invoked (unsupported, and silently fatal on an IDE
        // update). Deprecated/experimental usages are reported but do not fail: they are warnings about
        // the future, and the internal-API entries are Kotlin-generated bridge methods for the
        // ToolWindowFactory interface, which cannot be removed without not implementing the interface.
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.MISSING_DEPENDENCIES,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.OVERRIDE_ONLY_API_USAGES,
        )
        ides {
            // The baseline we compile against, and the newest IDE a reader is plausibly on. PyCharm is
            // named explicitly because that is what this plugin is used in most.
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity, "2025.2")
            // PyCharm Community stopped being published separately at 2025.3; `PyCharm` is the unified one.
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.PyCharm, "2026.1")
        }
    }
}
