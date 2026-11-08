plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.quasar.mobile"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.quasar.mobile"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
        ndk { abiFilters += listOf("arm64-v8a") }
        externalNativeBuild { cmake { arguments += listOf("-DANDROID_STL=c++_shared") } }
    }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt") } }
    sourceSets["main"].jniLibs.srcDir("libnode/bin")   // libnode.so (nodejs-mobile) кладёт сборка
    // Ядра лежат как libXXX.so и запускаются как программы: их нужно распаковывать на диск
    packaging { jniLibs { useLegacyPackaging = true } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    // Одна и та же подпись у каждой сборки: новая версия ставится поверх старой без удаления (настройки и серверы остаются)
    signingConfigs {
        getByName("debug") {
            storeFile = file("../quasar-release.keystore"); storePassword = "quasar123"; keyAlias = "quasar"; keyPassword = "quasar123"
        }
    }
    buildTypes { release { isMinifyEnabled = false } }
}
