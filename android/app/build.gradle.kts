import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cdmarin.clipsaver"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cdmarin.clipsaver"
        minSdk = 29
        targetSdk = 36
        // Release builds get their version from the tag (-PappVersion=v1.5 -> "1.5", code 10500);
        // local builds keep the fallback values
        val tagVersion = (findProperty("appVersion") as String?)?.removePrefix("v")
        versionName = tagVersion ?: "1.1"
        versionCode = tagVersion?.let { version ->
            val parts = version.split('.').map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)
            parts[0] * 10000 + parts[1] * 100 + parts[2]
        } ?: 2
    }

    // Fixed key so every build (local or GitHub Actions) can update the installed app.
    // Only meant for personal installs, not for publishing on Google Play.
    signingConfigs {
        create("clipsaver") {
            storeFile = file("clipsaver.keystore")
            storePassword = "clipsaver"
            keyAlias = "clipsaver"
            keyPassword = "clipsaver"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("clipsaver")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("clipsaver")
        }
    }

    // yt-dlp, Python and FFmpeg are native binaries, so build one APK per CPU type
    // (much smaller) plus a universal APK that works on any phone
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = true
        }
    }

    // youtubedl-android executes its binaries from the native library folder,
    // so they must be extracted on install
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    // Same web UI as the PC version
    sourceSets {
        getByName("main") {
            assets.srcDir("../../public")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.webkit:webkit:1.14.0")
}
