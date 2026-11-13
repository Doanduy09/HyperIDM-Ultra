plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.doanduy.duytai"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.doanduy.duytai"
        minSdk = 26
        targetSdk = 35
        versionCode = 750
        versionName = "7.5.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            val ksPath = System.getenv("DUYTAI_KEYSTORE_PATH") ?: "duytai-release.jks"
            storeFile = file(ksPath)
            storePassword = System.getenv("DUYTAI_KEYSTORE_PASSWORD") ?: "DuytaiSign#2026"
            keyAlias = System.getenv("DUYTAI_KEY_ALIAS") ?: "duytai"
            keyPassword = System.getenv("DUYTAI_KEY_PASSWORD") ?: "DuytaiSign#2026"
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
            enableV4Signing = true
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("junit:junit:4.13.2")
}
