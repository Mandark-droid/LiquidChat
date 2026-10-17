package com.liquidchat

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.liquidchat.meetings.SharedAudio
import com.liquidchat.platform.LaunchPayload

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "LiquidChat"

  // The system "Bold text" setting (fontWeightAdjustment) widens glyphs at draw time, but
  // React Native measures text without it, so the last characters of every label get clipped.
  // A sparse override (only this field) is merged into every later configuration; replacing the
  // whole configuration instead froze the launch orientation, so dialogs drew off-screen after
  // rotating (this activity handles orientation changes itself and is never recreated).
  override fun attachBaseContext(newBase: Context) {
    super.attachBaseContext(newBase)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      applyOverrideConfiguration(Configuration().apply { fontWeightAdjustment = 0 })
    }
  }

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    // Routine notification tapped while the app was not running. Captured before React
    // starts so JS can never call consumeLaunchPayload() ahead of it. Skipped on
    // re-creation, where the system would redeliver the original intent.
    if (savedInstanceState == null) {
      LaunchPayload.capture(intent)
      SharedAudio.capture(this, intent)
    }
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // Routine notification tapped while the app was already running (singleTask).
    LaunchPayload.capture(intent)
    SharedAudio.capture(this, intent)
  }
}
