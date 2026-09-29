// OAK for JetBrains IDEs (PyCharm, IntelliJ, …).
// Front-end only: all store mutations go through the `oak` CLI (see packages/cli);
// cheap reads come straight off the on-disk store. Platform-only dependency → runs in every
// JetBrains IDE, and on the Gateway/remote-dev backend (where ~/.claude lives).
plugins {
    id("java")
    kotlin("jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.18.1"
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

// Keep the root license and notices beside the plugin's jars in every prepared sandbox and distribution
// (the notices point at LICENSE, as the npm tarball and the .vsix both ship it).
tasks.named<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>("prepareSandbox") {
    from(listOf(rootProject.file("../../THIRD_PARTY_NOTICES.md"), rootProject.file("../../LICENSE"))) {
        into(pluginName)
    }
}

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

// The headless-IDE tests drive the real `oak` CLI, and the plugin under test prefers an INSTALLED one to
// PATH. Point them at this tree's build (npm's workspace bin link) and run the test JVM against a
// throwaway HOME, so a run neither tests the installed CLI nor reads the developer's transcripts and
// writes caches into their real store. herdr's socket points nowhere, as it does under `npm test`, and
// there is no display and no session bus, as on CI: a draft the CLI keeps on the clipboard never reaches
// the desktop, and the headless IDE does not connect to the developer's D-Bus.
tasks.test {
    val home = layout.buildDirectory.dir("test-home").get().asFile
    val bin = rootProject.file("../../node_modules/.bin")
    doFirst { home.deleteRecursively(); home.mkdirs() }
    environment("HOME", home.path)
    environment("USERPROFILE", home.path)
    environment("CLAUDE_CONFIG_DIR", home.resolve(".claude").path)
    environment("CODEX_HOME", home.resolve(".codex").path)
    environment("CLAUDE_OBSERVATORY_BIN", bin.resolve(if (System.getProperty("os.name").startsWith("Windows")) "oak.cmd" else "oak").path)
    val pathKey = environment.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH" // `Path` on Windows
    environment(pathKey, bin.path + File.pathSeparator + environment[pathKey]?.toString().orEmpty())
    environment("HERDR_SOCKET_PATH", home.resolve("no-herdr.sock").path)
    listOf("HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS").forEach { environment.remove(it) }
    systemProperty("java.util.prefs.userRoot", home.resolve(".java").path)
}
