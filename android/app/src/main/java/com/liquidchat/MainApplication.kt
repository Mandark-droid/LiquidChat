package com.liquidchat

import android.app.Application
import android.system.Os
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactNativeHost
import com.margelo.nitro.cactus.CactusPackage
import com.liquidchat.meetings.MeetingRecorderPackage
import com.liquidchat.platform.PlatformPackage

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              add(CactusPackage())
              add(SystemControlsPackage())
              add(AccessibilityBridgePackage())
              add(MeetingRecorderPackage())
              add(PlatformPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // Cactus keeps a 512-token attention window by default: in a longer prompt (a transcript
    // chunk, meeting notes) the model cannot see the start. Read when a model loads, so set first.
    runCatching { Os.setenv("CACTUS_KV_WINDOW_SIZE", "4096", false) }
    loadReactNative(this)
  }
}
