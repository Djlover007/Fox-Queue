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
        // Wird in GitHub Actions mit der Laufnummer gesetzt (Version 1.0.<Lauf>)
        versionCode = (project.findProperty("appVersionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("appVersionName") as String?) ?: "1.0.0"
    }

    // Fester Schlüssel, damit Updates über die alte Version installiert werden können
    signingConfigs {
        create("fox") {
            // GitHub Actions: Schlüssel aus den Secrets (KEYSTORE_FILE/KEYSTORE_PASSWORD), sonst die Datei im Ordner
            val pass = System.getenv("KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() } ?: "foxqueue"
            storeFile = System.getenv("KEYSTORE_FILE")?.takeIf { it.isNotBlank() }?.let { file(it) } ?: file("foxqueue.keystore")
            storePassword = pass
            keyAlias = "foxqueue"
            keyPassword = pass
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

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
