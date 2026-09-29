plugins {
    // Auto-provision the JDK 21 toolchain (build.gradle.kts jvmToolchain(21)) when the machine
    // lacks one — CI's preinstalled Temurin 21 is auto-detected, so this only downloads locally.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}
rootProject.name = "oak-observatory-jetbrains"
