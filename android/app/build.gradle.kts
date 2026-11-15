plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "de.djlover007.foxqueue"
    compileSdk = 34

    defaultConfig {
        applicationId = "de.djlover007.foxqueue"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    // Fester Schlüssel, damit Updates über die alte Version installiert werden können
    signingConfigs {
        create("fox") {
            storeFile = file("foxqueue.keystore")
            storePassword = "foxqueue"
            keyAlias = "foxqueue"
            keyPassword = "foxqueue"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("fox")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("fox")
        }
    }

    // Gemeinsame Oberfläche aus ../../ui als Assets einbinden
    sourceSets["main"].assets.srcDirs("src/main/assets", "../../ui")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
