pluginManagement {
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://repo1.maven.org/maven2/") }
        maven { url = uri("https://plugins.gradle.org/m2/") }
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://repo1.maven.org/maven2/") }
    }
}
rootProject.name = "DuytaiAndroid"
include(":app")
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
